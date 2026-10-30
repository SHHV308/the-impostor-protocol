import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C2S, ROOM_CODE_ALPHABET } from '@impostor/shared';
import { solve } from '../unit/helpers.js';
import { TestPlayer, crewOf, impostorsOf, sleep, startServer, startedMatch, until, type TestServer } from './harness.js';

let srv: TestServer;
const opened: TestPlayer[] = [];
beforeAll(async () => { srv = await startServer(); });
afterAll(async () => { opened.forEach((p) => p.socket.close()); await srv.close(); });

const mk = async (name: string) => { const p = await TestPlayer.create(srv, name); opened.push(p); return p; };
async function match(n: number, settings: Record<string, unknown> = {}) {
  const m = await startedMatch(srv, n, settings);
  opened.push(...m.players);
  await until(() => m.players.every((p) => p.snap), 3000);
  srv.skip(2000); // clear the role-reveal freeze
  await sleep(150);
  return m;
}
const publicView = (s: any) => JSON.stringify({ players: s.players.map((p: any) => ({ pid: p.pid, name: p.name, color: p.color })), phase: s.phase, env: s.env });

describe('guest sessions and auth', () => {
  it('issues an httpOnly cookie and rejects sockets without one', async () => {
    const res = await fetch(`${srv.base}/api/session`, { method: 'POST' });
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    const { io } = await import('socket.io-client');
    const s = io(srv.base, { transports: ['websocket'], reconnection: false });
    const err = await new Promise<Error>((r) => s.once('connect_error', r));
    expect(err.message).toBe('unauthorized');
    s.close();
  });
  it('reuses the same profile for a returning cookie', async () => {
    const a = await fetch(`${srv.base}/api/session`, { method: 'POST' });
    const cookie = a.headers.getSetCookie()[0]!.split(';')[0]!;
    const first = ((await a.json()) as any).profile;
    const b = await fetch(`${srv.base}/api/session`, { method: 'POST', headers: { cookie } });
    expect(((await b.json()) as any).profile.publicId).toBe(first.publicId);
  });
  it('exposes a health check', async () => {
    const r = await fetch(`${srv.base}/api/health`);
    expect(((await r.json()) as any).status).toBe('ok');
  });
});

describe('rooms and matchmaking', () => {
  it('generates six-character codes from the safe alphabet', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const p = await mk(`Host${i}`);
      const r = await p.emit<{ code: string }>(C2S.createRoom, { name: `Host${i}`, avatar: 'visor', isPublic: false });
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.code).toHaveLength(6); expect([...r.code].every((c) => ROOM_CODE_ALPHABET.includes(c))).toBe(true); codes.add(r.code); }
    }
    expect(codes.size).toBe(12);
  });

  it('validates codes, names, capacity and in-progress rooms', async () => {
    const host = await mk('Hosty');
    const created = await host.emit<{ code: string }>(C2S.createRoom, { name: 'Hosty', avatar: 'visor', isPublic: false });
    const code = (created as any).code as string;
    const x = await mk('Xavier');
    expect(await x.emit(C2S.joinRoom, { code: 'ABC', name: 'Xavier', avatar: 'visor' })).toMatchObject({ ok: false });
    expect(await x.emit(C2S.joinRoom, { code: 'ZZZZZZ', name: 'Xavier', avatar: 'visor' })).toMatchObject({ ok: false, error: 'No room with that code' });
    expect(await x.emit(C2S.joinRoom, { code, name: 'hosty', avatar: 'visor' })).toMatchObject({ ok: false, error: expect.stringMatching(/taken/) });
    expect(await x.emit(C2S.joinRoom, { code, name: '<script>', avatar: 'visor' })).toMatchObject({ ok: false });
    expect(await x.emit(C2S.joinRoom, { code: code.toLowerCase(), name: 'Xavier', avatar: 'visor' })).toMatchObject({ ok: true });
    for (let i = 0; i < 8; i++) {
      const p = await mk(`Fill${i}`);
      expect(await p.emit(C2S.joinRoom, { code, name: `Fill${i}`, avatar: 'visor' })).toMatchObject({ ok: true });
    }
    expect(srv.room(code).size).toBe(10);
    const late = await mk('Late');
    expect(await late.emit(C2S.joinRoom, { code, name: 'Late', avatar: 'visor' })).toMatchObject({ ok: false, error: expect.stringMatching(/full/) });
  });

  it('rejects joining a match in progress', async () => {
    const m = await match(4);
    const late = await mk('Latecomer');
    expect(await late.emit(C2S.joinRoom, { code: m.code, name: 'Latecomer', avatar: 'visor' })).toMatchObject({ ok: false, error: expect.stringMatching(/in progress/) });
  });

  it('matches public players together and keeps private rooms out of matchmaking', async () => {
    const priv = await mk('PrivHost');
    await priv.emit(C2S.createRoom, { name: 'PrivHost', avatar: 'visor', isPublic: false });
    const a = await mk('PubA'), b = await mk('PubB');
    await a.emit(C2S.matchmake, { name: 'PubA', avatar: 'visor' });
    await b.emit(C2S.matchmake, { name: 'PubB', avatar: 'bolt' });
    await until(() => a.room && b.room && a.room.players.length === 2);
    expect(a.code).toBe(b.code);
    expect(a.code).not.toBe(priv.code);
    expect(a.room!.settings.isPublic).toBe(true);
  });

  it('only the host may change settings, which are validated', async () => {
    const host = await mk('SetHost'), g = await mk('SetGuest');
    const code = ((await host.emit<{ code: string }>(C2S.createRoom, { name: 'SetHost', avatar: 'visor', isPublic: false })) as any).code;
    await g.emit(C2S.joinRoom, { code, name: 'SetGuest', avatar: 'visor' });
    expect(await g.emit(C2S.settings, { environment: 'lab' })).toMatchObject({ ok: false });
    expect(await host.emit(C2S.settings, { matchMinutes: 5 })).toMatchObject({ ok: false });
    expect(await host.emit(C2S.settings, { matchMinutes: 15, environment: 'cyber', missionThreshold: 70 })).toMatchObject({ ok: true });
    await until(() => g.room?.settings.environment === 'cyber');
    expect(g.room!.settings.matchMinutes).toBe(15);
  });

  it('refuses to start without enough ready players', async () => {
    const host = await mk('LoneHost');
    await host.emit(C2S.createRoom, { name: 'LoneHost', avatar: 'visor', isPublic: false });
    expect(await host.emit(C2S.start)).toMatchObject({ ok: false, error: expect.stringMatching(/At least 4/) });
    const ps = [await mk('R1'), await mk('R2'), await mk('R3')];
    for (const p of ps) await p.emit(C2S.joinRoom, { code: host.code, name: p.name, avatar: 'visor' });
    expect(await host.emit(C2S.start)).toMatchObject({ ok: false, error: expect.stringMatching(/ready/) });
  });
});

describe('starting a match', () => {
  it('runs a four-player game with one impostor and private roles', async () => {
    const { players } = await match(4);
    expect(impostorsOf(players)).toHaveLength(1);
    expect(crewOf(players)).toHaveLength(3);
    for (const p of players) {
      expect(p.hasEvent('role_reveal')).toBe(true);
      expect(p.events.filter((e) => e.type === 'role_reveal')).toHaveLength(1);
    }
  });

  it('runs a ten-player game with two different impostor variants and unique special roles', async () => {
    const { players } = await match(10);
    const imps = impostorsOf(players);
    expect(imps).toHaveLength(2);
    expect(new Set(imps.map((p) => p.role)).size).toBe(2);
    const specials = crewOf(players).map((p) => p.role).filter((r) => r !== 'crew');
    expect(new Set(specials).size).toBe(specials.length);
    expect(specials.length).toBe(4);
    for (const i of imps) expect(i.snap!.you.mates).toHaveLength(1);
    for (const c of crewOf(players)) expect(c.snap!.you.mates).toHaveLength(0);
  });

  it('keeps roles private while all players see the same public state', async () => {
    const { players } = await match(10);
    await sleep(200);
    // compare snapshots with the same server instant: positions are static so public parts match
    const views = new Set(players.map((p) => publicView(p.snap)));
    expect(views.size).toBe(1);
    for (const p of players) {
      const { you, ...rest } = p.snap as any;
      const text = JSON.stringify(rest);
      expect(text).not.toMatch(/"role"|"faction"|shapeshifter|detective|medic/);
      // no role_reveal events about anybody else
      const reveals = p.events.filter((e) => e.type === 'role_reveal') as any[];
      expect(reveals).toHaveLength(1);
      expect(reveals[0].role).toBe(you.role);
    }
  });

  it('end-to-end: the server integrates movement from intents and ignores forged input', async () => {
    const { players } = await match(5);
    const p = players[1]!;
    const start = p.snap!.players.find((x) => x.pid === p.pid)!;
    expect(await p.emit(C2S.move, { x: 9999, y: 0 })).toMatchObject({ ok: false }); // schema bound
    p.socket.emit(C2S.move, { x: 1, y: 0 });
    await sleep(600);
    p.socket.emit(C2S.move, { x: 0, y: 0 });
    await sleep(150);
    const end = p.snap!.players.find((x) => x.pid === p.pid)!;
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    expect(moved).toBeGreaterThan(30);
    expect(moved).toBeLessThan(190 * 0.9); // cannot exceed server speed
    // other clients see the same position
    const seen = players[2]!.snap!.players.find((x) => x.pid === p.pid)!;
    expect(Math.hypot(seen.x - end.x, seen.y - end.y)).toBeLessThan(15);
  });

  it('players move simultaneously and stay on the floor', async () => {
    const { players, room } = await match(8);
    for (const p of players) p.socket.emit(C2S.move, { x: Math.random() - 0.5, y: Math.random() - 0.5 });
    await sleep(1500);
    for (const p of players) {
      const me = room.game.debugPlayer(p.pid);
      expect(Number.isFinite(me.x)).toBe(true);
    }
    const spread = new Set(players.map((p) => `${Math.round(p.snap!.players.find((x) => x.pid === p.pid)!.x / 5)}`));
    expect(spread.size).toBeGreaterThan(1);
  });
});

describe('gameplay over sockets', () => {
  it('selects, plays and completes a mission with server validation', async () => {
    const { players, room } = await match(5);
    const c = crewOf(players)[0]!;
    const task = c.snap!.you.tasks[0]!;
    // forged: submit without starting
    expect(await c.emit(C2S.missionSubmit, { missionId: task.missionId, answer: 1 })).toMatchObject({ ok: false });
    // too far from the console
    expect(await c.emit(C2S.missionStart, { missionId: task.missionId })).toMatchObject({ ok: false });
    room.game.debugTeleport(c.pid, task.x, task.y + 5);
    expect(await c.emit(C2S.missionStart, { missionId: task.missionId })).toMatchObject({ ok: true });
    const ch = await until(() => c.snap?.you.mission ?? undefined, 2000, 'challenge in snapshot');
    expect(JSON.stringify(ch)).not.toMatch(/"answer"/);
    const before = c.snap!.progress!;
    srv.skip(7000);
    expect(await c.emit(C2S.missionSubmit, { missionId: task.missionId, answer: solve(ch.payload) })).toMatchObject({ ok: true, correct: true });
    await until(() => c.snap!.progress! > before, 2000, 'progress to rise');
    expect(c.hasEvent('mission_done')).toBe(true);
  });

  it('impostor eliminates, crew reports, everyone votes simultaneously and the result is revealed', async () => {
    const { players, room } = await match(5);
    srv.skip(16_000);
    await sleep(150);
    const [imp] = impostorsOf(players);
    const [victim, reporter, ...rest] = crewOf(players);
    const pos = room.game.debugPlayer(imp!.pid);
    room.game.debugTeleport(victim!.pid, pos.x + 30, pos.y);
    const k = await imp!.emit(C2S.ability, { ability: 'kill', targetPid: victim!.pid });
    expect(k).toMatchObject({ ok: true, data: { blocked: false } });
    await until(() => victim!.hasEvent('you_died'), 2000);
    expect(reporter!.hasEvent('you_died')).toBe(false);
    // the killer is not named in anything the witnesses received
    expect(JSON.stringify(reporter!.events)).not.toContain(imp!.pid);
    const body = await until(() => reporter!.snap?.bodies[0], 2000, 'body');
    expect(body.victimPid).toBe(victim!.pid);
    expect(JSON.stringify(body)).not.toMatch(/role|faction/);
    // a dead player can chat only with spectators
    expect(await victim!.emit(C2S.chat, { text: 'boo' })).toMatchObject({ ok: true });
    await sleep(100);
    expect(reporter!.chat.some((m) => m.text === 'boo')).toBe(false);
    expect(await reporter!.emit(C2S.chat, { text: 'too early' })).toMatchObject({ ok: false });

    room.game.debugTeleport(reporter!.pid, body.x + 20, body.y);
    expect(await reporter!.emit(C2S.report, { bodyId: body.id })).toMatchObject({ ok: true });
    await until(() => players.every((p) => p.snap?.phase === 'meeting'), 2000, 'meeting');
    expect(await reporter!.emit(C2S.chat, { text: 'it was dark' })).toMatchObject({ ok: true });
    await until(() => imp!.chat.some((m) => m.text === 'it was dark'));
    expect(victim!.chat.some((m) => m.text === 'it was dark')).toBe(true); // spectators may read
    srv.skip(5000);
    await until(() => reporter!.snap?.meeting?.phase === 'voting', 2000, 'voting phase');
    expect(await victim!.emit(C2S.vote, { target: 'skip' })).toMatchObject({ ok: false });
    expect(await reporter!.emit(C2S.vote, { target: imp!.pid })).toMatchObject({ ok: true });
    expect(await reporter!.emit(C2S.vote, { target: 'skip' })).toMatchObject({ ok: false });
    await until(() => imp!.snap?.meeting?.voted.includes(reporter!.pid));
    expect(JSON.stringify(imp!.snap!.meeting)).not.toContain('"target"');
    for (const c of rest) await c.emit(C2S.vote, { target: imp!.pid });
    await imp!.emit(C2S.vote, { target: reporter!.pid });
    const res = await until(() => reporter!.snap?.meeting?.results, 2000, 'results');
    expect(res.ejected).toBe(imp!.pid);
    await until(() => reporter!.snap?.phase === 'ended', 7000, 'game end');
    const over = reporter!.events.find((e) => e.type === 'game_over') as any;
    expect(over.summary.winner).toBe('crew');
    // full reveal only now
    expect(over.summary.players.find((p: any) => p.pid === imp!.pid).role).toMatch(/impostor|shapeshifter/);
  });

  it('only the host can rematch, and a rematch returns everyone to the lobby', async () => {
    const { players, host } = await match(4);
    const [imp] = impostorsOf(players);
    // end the game: every crew member leaves -> parity
    for (const c of crewOf(players).filter((c) => c !== host).slice(0, 2)) await c.emit(C2S.leave);
    await until(() => imp!.snap?.phase === 'ended' || host.snap?.phase === 'ended', 3000, 'game end');
    const guest = players.find((p) => p !== host && p.room?.phase === 'ended')!;
    if (guest) expect(await guest.emit(C2S.rematch)).toMatchObject({ ok: false });
    expect(await host.emit(C2S.rematch)).toMatchObject({ ok: true });
    await until(() => host.room?.phase === 'lobby');
    expect(host.room!.players.length).toBeGreaterThanOrEqual(2);
    expect(host.room!.players.every((p) => !p.ready || p.isHost)).toBe(true);
  });
});

describe('disconnects, host transfer and persistence', () => {
  it('lets a disconnected player rejoin the same match as the same player', async () => {
    const { players } = await match(5);
    const p = players[2]!;
    const pid = p.pid;
    const role = p.snap!.you.role;
    p.disconnect();
    await until(() => players[1]!.room?.players.find((x) => x.pid === pid)?.connected === false, 2000, 'disconnect flag');
    const again = new TestPlayer(srv, p.name);
    again.cookie = p.cookie;
    await again.connect();
    opened.push(again);
    await until(() => again.room && again.snap, 2000, 'state restore');
    expect(again.pid).toBe(pid);
    expect(again.snap!.you.role).toBe(role);
    await until(() => players[1]!.room?.players.find((x) => x.pid === pid)?.connected === true);
  });

  it('transfers host privileges when the host disconnects', async () => {
    const host = await mk('H1'), g = await mk('H2');
    const code = ((await host.emit<{ code: string }>(C2S.createRoom, { name: 'H1', avatar: 'visor', isPublic: false })) as any).code;
    await g.emit(C2S.joinRoom, { code, name: 'H2', avatar: 'visor' });
    host.disconnect();
    await until(() => g.room?.hostPid === g.pid, 2000, 'host transfer');
    expect(await g.emit(C2S.settings, { environment: 'bunker' })).toMatchObject({ ok: true });
  });

  it('persists XP and stats for guests after a match and never trusts clients', async () => {
    const { players } = await match(4, { tasksPerPlayer: 3 });
    const crew = crewOf(players);
    // crew finish every task honestly over the socket
    const room = srv.manager.roomOf((await srv.store.findByToken(players[0]!.cookie.split('=')[1]!))!.id)!;
    for (const c of crew) {
      for (const t of c.snap!.you.tasks) {
        room.game.debugTeleport(c.pid, t.x, t.y + 5);
        expect(await c.emit(C2S.missionStart, { missionId: t.missionId })).toMatchObject({ ok: true });
        const ch = await until(() => c.snap?.you.mission ?? undefined, 2000);
        srv.skip(7000);
        const r = await c.emit<{ correct: boolean }>(C2S.missionSubmit, { missionId: t.missionId, answer: solve(ch.payload) });
        expect(r).toMatchObject({ ok: true, correct: true });
        await until(() => !c.snap?.you.mission || c.snap.you.tasks.find((x) => x.missionId === t.missionId)?.done, 2000);
      }
    }
    await until(() => players.every((p) => p.hasEvent('game_over')), 3000, 'game over');
    await sleep(200);
    for (const c of crew) {
      const prof = await c.profileNow();
      expect(prof.xp).toBeGreaterThanOrEqual(3 * 20 + 15 + 50);
      expect(prof.gamesPlayed).toBe(1);
      expect(prof.wins).toBe(1);
      expect(prof.achievements.map((a) => a.key)).toContain('first_mission');
    }
    const imp = impostorsOf(players)[0]!;
    expect((await imp.profileNow()).xp).toBe(25); // participation 10 + survived 15
    const board = (await (await fetch(`${srv.base}/api/leaderboard`)).json()) as any;
    expect(board.entries.length).toBeGreaterThanOrEqual(4);
    expect(board.entries[0].xp).toBeGreaterThanOrEqual(board.entries.at(-1).xp);
    expect(JSON.stringify(board)).not.toMatch(/token|publicId|guestId/);
  });
});

describe('abuse protection', () => {
  it('rate limits chat spam and rejects oversized or malformed payloads', async () => {
    const host = await mk('Spammer');
    await host.emit(C2S.createRoom, { name: 'Spammer', avatar: 'visor', isPublic: false });
    const results: boolean[] = [];
    for (let i = 0; i < 9; i++) results.push((await host.emit(C2S.chat, { text: `m${i}` })).ok);
    expect(results.filter((r) => !r).length).toBeGreaterThan(0);
    expect(await host.emit(C2S.chat, { text: 'x'.repeat(500) })).toMatchObject({ ok: false });
    expect(await host.emit(C2S.ability, { ability: 'nuke' })).toMatchObject({ ok: false });
    expect(await host.emit(C2S.settings, { isAdmin: true })).toMatchObject({ ok: false });
    expect(await host.emit(C2S.missionSubmit, { missionId: 'x', answer: { evil: true } })).toMatchObject({ ok: false });
  });
  it('rejects game actions from players who are not in a room or match', async () => {
    const p = await mk('Nobody');
    expect(await p.emit(C2S.vote, { target: 'skip' })).toMatchObject({ ok: false });
    expect(await p.emit(C2S.sabotage, { sabotageId: 'oxygen_leak' })).toMatchObject({ ok: false });
  });
});
