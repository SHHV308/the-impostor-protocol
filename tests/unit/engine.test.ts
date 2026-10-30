import { describe, expect, it } from 'vitest';
import { RANGES, bodyFits, roomAt } from '@impostor/shared';
import { GameError } from '../../server/src/game/engine.js';
import { makeEngine, solve, type Harness } from './helpers.js';

const kill = (h: Harness, killer: string, victim: string) => {
  h.meet(killer, victim);
  return h.engine.useAbility(killer, { ability: 'kill', targetPid: victim });
};
const readyKill = (h: Harness) => h.advance(26_000);

function doMission(h: Harness, pid: string, taskIdx = 0) {
  const task = h.engine.snapshotFor(pid).you.tasks[taskIdx]!;
  h.engine.debugTeleport(pid, task.x, task.y + 5);
  h.engine.startMission(pid, task.missionId);
  const payload = h.engine.snapshotFor(pid).you.mission!.payload;
  h.advance(6500);
  return h.engine.submitMission(pid, task.missionId, solve(payload));
}

function reportAndOpenVoting(h: Harness, reporter: string) {
  const body = h.engine.snapshotFor(reporter).bodies[0]!;
  h.engine.debugTeleport(reporter, body.x + 20, body.y);
  h.engine.reportBody(reporter, body.id);
  h.advance(5100);
}

describe('missions', () => {
  it('validates completion on the server and awards XP exactly once', () => {
    const h = makeEngine(5); h.start();
    const crew = h.crewPids()[0]!;
    const before = h.engine.progress();
    expect(doMission(h, crew)).toEqual({ correct: true });
    expect(h.engine.progress()).toBeGreaterThan(before);
    const xp = h.eventsFor(crew, 'xp');
    expect(xp).toHaveLength(1);
    // the same mission cannot be started or submitted again
    const task = h.engine.snapshotFor(crew).you.tasks[0]!;
    expect(task.done).toBe(true);
    expect(() => h.engine.startMission(crew, task.missionId)).toThrow(GameError);
    expect(() => h.engine.submitMission(crew, task.missionId, [1])).toThrow(GameError);
  });

  it('rejects wrong answers and impossibly fast answers', () => {
    const h = makeEngine(5); h.start();
    const crew = h.crewPids()[0]!;
    const task = h.engine.snapshotFor(crew).you.tasks[0]!;
    h.engine.debugTeleport(crew, task.x, task.y + 5);
    h.engine.startMission(crew, task.missionId);
    const payload = h.engine.snapshotFor(crew).you.mission!.payload;
    expect(h.engine.submitMission(crew, task.missionId, solve(payload))).toEqual({ correct: false }); // instant bot
    expect(() => h.engine.startMission(crew, task.missionId)).toThrow(/rebooting/);
    h.advance(3100);
    h.engine.startMission(crew, task.missionId);
    h.advance(6500);
    expect(h.engine.submitMission(crew, task.missionId, [9, 9, 9, 9, 9, 9, 9, 9, 9])).toEqual({ correct: false });
    expect(h.engine.progress()).toBe(0);
  });

  it('refuses unassigned, out-of-range and fabricated submissions', () => {
    const h = makeEngine(5); h.start();
    const crew = h.crewPids()[0]!;
    expect(() => h.engine.submitMission(crew, 'space_m0', [1])).toThrow(/No active mission/);
    const mine = new Set(h.engine.snapshotFor(crew).you.tasks.map((t) => t.missionId));
    const foreign = h.engine.map.missions.find((m) => !mine.has(m.id))!;
    expect(() => h.engine.startMission(crew, foreign.id)).toThrow(/not assigned/);
    const task = h.engine.snapshotFor(crew).you.tasks[0]!;
    expect(() => h.engine.startMission(crew, task.missionId)).toThrow(/closer/);
  });

  it('gives impostors decoy tasks that do not move the crew meter', () => {
    const h = makeEngine(5); h.start();
    const imp = h.impostorPids()[0]!;
    expect(h.engine.snapshotFor(imp).you.tasks.every((t) => t.decoy)).toBe(true);
    expect(doMission(h, imp)).toEqual({ correct: true });
    expect(h.engine.progress()).toBe(0);
    expect(h.eventsFor(imp, 'xp')).toHaveLength(0);
  });

  it('scales difficulty through the match', () => {
    const h = makeEngine(5); h.start();
    const crew = h.crewPids()[0]!;
    const task = (i: number) => h.engine.snapshotFor(crew).you.tasks[i]!;
    h.engine.debugTeleport(crew, task(0).x, task(0).y + 5);
    h.engine.startMission(crew, task(0).missionId);
    expect(h.engine.snapshotFor(crew).you.mission!.difficulty).toBe(1);
    h.engine.cancelMission(crew);
    h.advance(9 * 60_000);
    h.engine.debugTeleport(crew, task(1).x, task(1).y + 5);
    h.engine.startMission(crew, task(1).missionId);
    expect(h.engine.snapshotFor(crew).you.mission!.difficulty).toBe(3);
  });

  it('crew win when the shared meter reaches the threshold', () => {
    const h = makeEngine(4, { tasks: 3 }); h.start();
    for (const c of h.crewPids()) for (let i = 0; i < 3; i++) doMission(h, c, i);
    expect(h.engine.phase).toBe('ended');
    expect(h.result()!.summary).toMatchObject({ winner: 'crew', reason: 'missions' });
  });

  it('honours a configurable lower threshold', () => {
    const h = makeEngine(4, { tasks: 4, threshold: 50 }); h.start();
    const [a, b, c] = h.crewPids();
    for (const p of [a!, b!, c!]) for (let i = 0; i < 2; i++) doMission(h, p, i);
    expect(h.result()?.summary.reason).toBe('missions');
  });
});

describe('elimination', () => {
  it('enforces cooldown, range, faction and living-state rules', () => {
    const h = makeEngine(10); h.start();
    const [imp, ally] = h.impostorPids();
    const [victim, far] = h.crewPids();
    h.meet(imp!, victim!);
    expect(() => h.engine.useAbility(imp!, { ability: 'kill', targetPid: victim })).toThrow(/recharging/);
    readyKill(h);
    h.meet(imp!, victim!);
    h.engine.debugTeleport(far!, h.engine.debugPlayer(imp!).x + RANGES.kill + 60, h.engine.debugPlayer(imp!).y);
    expect(() => h.engine.useAbility(imp!, { ability: 'kill', targetPid: far })).toThrow(/range/);
    h.meet(imp!, ally!);
    expect(() => h.engine.useAbility(imp!, { ability: 'kill', targetPid: ally })).toThrow(/ally/);
    expect(() => h.engine.useAbility(victim!, { ability: 'kill', targetPid: imp })).toThrow(/role/);
    expect(h.engine.useAbility(imp!, { ability: 'kill', targetPid: victim })).toEqual({ blocked: false });
    expect(h.engine.isAlive(victim!)).toBe(false);
    expect(() => h.engine.useAbility(imp!, { ability: 'kill', targetPid: far })).toThrow(/recharging/);
  });

  it('hides the victim role and faction publicly and keeps killer identity private', () => {
    const h = makeEngine(7); h.start(); readyKill(h);
    const imp = h.impostorPids()[0]!;
    const victim = h.crewPids()[0]!;
    kill(h, imp, victim);
    const witness = h.crewPids()[1]!;
    const snap = JSON.stringify(h.engine.snapshotFor(witness));
    expect(snap).not.toContain(h.engine.roleOf(victim)!.length ? `"role":"${h.engine.roleOf(victim)}"` : '');
    const publicEvents = JSON.stringify(h.events.filter((e) => e.target.to === 'all' || e.target.to === 'near'));
    expect(publicEvents).not.toContain(imp);
    expect(h.eventsFor(victim, 'you_died')).toHaveLength(1);
    // the ghost is hidden from the living but a spectator sees it
    expect(h.engine.snapshotFor(witness).players.find((p) => p.pid === victim)).toBeUndefined();
    expect(h.engine.snapshotFor(victim).players.find((p) => p.pid === victim)?.anim).toBe('dead');
    expect(h.engine.snapshotFor(witness).bodies).toHaveLength(1);
  });

  it('medic protection blocks one elimination, pays XP, and cannot repeat on the same player', () => {
    const h = makeEngine(10); h.start(); readyKill(h);
    const [medic] = h.byRole('medic');
    const imp = h.byRole('impostor')[0] ?? h.byRole('shapeshifter')[0]!;
    const target = h.crewPids().find((p) => p !== medic)!;
    h.meet(medic!, target);
    h.engine.useAbility(medic!, { ability: 'protect', targetPid: target });
    expect(() => h.engine.useAbility(medic!, { ability: 'protect', targetPid: target })).toThrow(/recharging/);
    h.advance(31_000);
    expect(() => h.engine.useAbility(medic!, { ability: 'protect', targetPid: target })).toThrow(/same player/);
    h.meet(imp, target);
    expect(h.engine.useAbility(imp, { ability: 'kill', targetPid: target })).toEqual({ blocked: true });
    expect(h.engine.isAlive(target)).toBe(true);
    expect(h.eventsFor(medic!, 'protect_saved')).toHaveLength(1);
    expect(h.eventsFor(medic!, 'xp').length).toBeGreaterThan(0);
    // protection is consumed
    readyKill(h);
    h.meet(imp, target);
    expect(h.engine.useAbility(imp, { ability: 'kill', targetPid: target })).toEqual({ blocked: false });
  });

  it('eliminated players cannot act, vote or be seen to act', () => {
    const h = makeEngine(7); h.start(); readyKill(h);
    const imp = h.impostorPids()[0]!;
    const [victim, other] = h.crewPids();
    kill(h, imp, victim!);
    expect(h.engine.snapshotFor(victim!).spectating).toBe(true);
    expect(() => h.engine.startMission(victim!, h.engine.snapshotFor(victim!).you.tasks[0]!.missionId)).toThrow(/Eliminated/);
    expect(() => h.engine.callEmergency(victim!)).toThrow(/Eliminated/);
    h.engine.setIntent(victim!, 1, 0);
    const before = h.engine.debugPlayer(victim!);
    h.advance(1000);
    expect(h.engine.debugPlayer(victim!).x).toBe(before.x);
    reportAndOpenVoting(h, other!);
    expect(() => h.engine.vote(victim!, 'skip')).toThrow(/Eliminated/);
  });
});

describe('meetings and voting', () => {
  it('runs report -> discussion -> voting -> simultaneous reveal; ejecting the impostor wins for crew', () => {
    const h = makeEngine(5); h.start(); readyKill(h);
    const imp = h.impostorPids()[0]!;
    const [victim, a, b] = h.crewPids();
    kill(h, imp, victim!);
    const body = h.engine.snapshotFor(a!).bodies[0]!;
    h.engine.debugTeleport(a!, body.x + 20, body.y);
    h.engine.reportBody(a!, body.id);
    expect(h.engine.phase).toBe('meeting');
    expect(h.engine.snapshotFor(a!).meeting?.phase).toBe('discussion');
    // movement is frozen, voting is closed during discussion
    h.engine.setIntent(a!, 1, 0);
    const pos = h.engine.debugPlayer(a!);
    h.advance(1000);
    expect(h.engine.debugPlayer(a!)).toEqual(pos);
    expect(() => h.engine.vote(a!, imp)).toThrow(/not open/);
    h.advance(4200);
    expect(h.engine.snapshotFor(a!).meeting?.phase).toBe('voting');

    h.engine.vote(a!, imp);
    const mid = h.engine.snapshotFor(b!).meeting!;
    expect(mid.voted).toEqual([a]);
    expect(JSON.stringify(mid)).not.toContain(`"target"`); // nobody's choice is visible yet
    expect(mid.results).toBeUndefined();
    expect(() => h.engine.vote(a!, 'skip')).toThrow(/already voted/);
    expect(() => h.engine.vote(b!, 'nobody')).toThrow(/Invalid/);
    expect(() => h.engine.vote(b!, b!)).toThrow(/yourself/);
    h.engine.vote(b!, imp);
    h.engine.vote(imp, a!);
    expect(h.engine.snapshotFor(a!).meeting?.phase).toBe('voting'); // one living player has not voted yet
    h.engine.vote(h.crewPids().find((p) => ![victim, a, b].includes(p))!, imp);
    expect(h.engine.snapshotFor(a!).meeting?.phase).toBe('results');
    expect(h.engine.snapshotFor(a!).meeting?.results).toMatchObject({ ejected: imp, tie: false });
    h.advance(2100);
    expect(h.result()!.summary).toMatchObject({ winner: 'crew', reason: 'impostors_voted' });
    // the end-of-match reveal now lists every real role
    expect(h.result()!.summary.players.find((p) => p.pid === imp)!.role).toMatch(/impostor|shapeshifter/);
  });

  it('ties and skips eject nobody', () => {
    for (const mode of ['tie', 'skip'] as const) {
      const h = makeEngine(7); h.start(); h.advance(16_000);
      const [c1, c2, c3, c4] = h.crewPids();
      h.engine.debugTeleport(c1!, h.engine.map.stations.find((s) => s.id === 'emergency')!.x, h.engine.map.stations.find((s) => s.id === 'emergency')!.y + 20);
      h.engine.callEmergency(c1!);
      h.advance(5100);
      const alive = h.pids;
      if (mode === 'tie') { h.engine.vote(c1!, c2!); h.engine.vote(c2!, c1!); for (const p of alive.filter((x) => x !== c1 && x !== c2)) h.engine.vote(p, 'skip'); }
      else { for (const p of alive) h.engine.vote(p, p === c1 ? 'skip' : c3 === p ? 'skip' : 'skip'); }
      const res = h.engine.snapshotFor(c4!).meeting!.results!;
      expect(res.ejected).toBeNull();
      h.advance(2100);
      expect(h.engine.phase).toBe('playing');
      expect(h.pids.every((p) => h.engine.isAlive(p))).toBe(true);
    }
  });

  it('emergency button needs range, has per-player limit and a post-meeting cooldown', () => {
    const h = makeEngine(5); h.start();
    const c = h.crewPids()[0]!;
    expect(() => h.engine.callEmergency(c)).toThrow(/recharging/);
    h.advance(16_000);
    expect(() => h.engine.callEmergency(c)).toThrow(/Go to the emergency/);
    const em = h.engine.map.stations.find((s) => s.id === 'emergency')!;
    h.engine.debugTeleport(c, em.x, em.y + 20);
    h.engine.callEmergency(c);
    h.advance(5100);
    for (const p of h.pids) h.engine.vote(p, 'skip');
    h.advance(2100);
    h.advance(21_000);
    h.engine.debugTeleport(c, em.x, em.y + 20);
    expect(() => h.engine.callEmergency(c)).toThrow(/no emergency meetings left/);
  });

  it('only the report range works and a body cannot be reported from afar', () => {
    const h = makeEngine(5); h.start(); readyKill(h);
    const imp = h.impostorPids()[0]!;
    const [victim, a] = h.crewPids();
    kill(h, imp, victim!);
    const body = h.engine.snapshotFor(a!).bodies[0]!;
    h.engine.debugTeleport(a!, body.x + 500, body.y);
    expect(() => h.engine.reportBody(a!, body.id)).toThrow(/closer/);
    expect(() => h.engine.reportBody(a!, 'body999')).toThrow(/No such body/);
  });

  it('closes voting at the deadline and counts absent voters as skips', () => {
    const h = makeEngine(5); h.start(); h.advance(16_000);
    const em = h.engine.map.stations.find((s) => s.id === 'emergency')!;
    const c = h.crewPids()[0]!;
    h.engine.debugTeleport(c, em.x, em.y + 20);
    h.engine.callEmergency(c);
    h.advance(5100);
    h.engine.vote(c, 'skip');
    h.advance(5100);
    expect(h.engine.snapshotFor(c).meeting?.phase).toBe('results');
    expect(() => h.engine.vote(h.crewPids()[1]!, 'skip')).toThrow(/not open/);
  });
});

describe('win conditions', () => {
  it('impostors win on parity', () => {
    const h = makeEngine(4); h.start();
    const imp = h.impostorPids()[0]!;
    const [a, b] = h.crewPids();
    readyKill(h); kill(h, imp, a!);
    expect(h.engine.phase).toBe('playing');
    readyKill(h); kill(h, imp, b!);
    expect(h.result()!.summary).toMatchObject({ winner: 'impostor', reason: 'parity' });
  });

  it('impostors win when a critical sabotage expires', () => {
    const h = makeEngine(6); h.start(); h.advance(21_000);
    const imp = h.impostorPids()[0]!;
    h.engine.triggerSabotage(imp, 'oxygen_leak');
    const sab = h.engine.snapshotFor(imp).sabotage!;
    expect(sab).toMatchObject({ critical: true });
    expect(sab.stations).toHaveLength(2);
    h.advance(44_000);
    expect(h.engine.phase).toBe('playing');
    h.advance(2000);
    expect(h.result()!.summary).toMatchObject({ winner: 'impostor', reason: 'sabotage' });
    expect(h.result()!.criticalWin).toBe(true);
  });

  it('impostors win when the match timer expires without the crew finishing', () => {
    const h = makeEngine(6, { matchMs: 60_000 }); h.start();
    h.advance(61_000);
    expect(h.result()!.summary).toMatchObject({ winner: 'impostor', reason: 'timer' });
  });

  it('crew still win a mission finish that lands before the timer', () => {
    const h = makeEngine(4, { tasks: 3, matchMs: 5 * 60_000 }); h.start();
    for (const c of h.crewPids()) for (let i = 0; i < 3; i++) doMission(h, c, i);
    expect(h.result()!.summary.winner).toBe('crew');
  });

  it('a disconnected player who never returns is eliminated and can trigger parity', () => {
    const h = makeEngine(4); h.start();
    const [a, b] = h.crewPids();
    h.engine.abandon(a!);
    h.engine.abandon(b!);
    expect(h.result()!.summary).toMatchObject({ winner: 'impostor', reason: 'parity' });
  });

  it('only awards XP once per event and tallies a team score', () => {
    const h = makeEngine(4, { tasks: 3 }); h.start();
    for (const c of h.crewPids()) for (let i = 0; i < 3; i++) doMission(h, c, i);
    const r = h.result()!;
    expect(r.summary.teamScore).toBeGreaterThan(0);
    for (const p of r.players.filter((x) => x.faction === 'crew')) expect(p.xp).toBe(3 * 20 + 15 + 50);
  });
});

describe('sabotage', () => {
  const trigger = (h: Harness, id: string) => {
    h.advance(21_000);
    const imp = h.impostorPids()[0]!;
    h.engine.triggerSabotage(imp, id);
    return imp;
  };

  it('is impostor-only, cooldown-gated and exclusive', () => {
    const h = makeEngine(6); h.start();
    const imp = h.impostorPids()[0]!;
    expect(() => h.engine.triggerSabotage(imp, 'oxygen_leak')).toThrow(/recharging/);
    h.advance(21_000);
    expect(() => h.engine.triggerSabotage(h.crewPids()[0]!, 'oxygen_leak')).toThrow(/Only impostors/);
    expect(() => h.engine.triggerSabotage(imp, 'bogus')).toThrow(/Unknown/);
    h.engine.triggerSabotage(imp, 'power_failure');
    expect(() => h.engine.triggerSabotage(imp, 'oxygen_leak')).toThrow(/already active/);
  });

  it('critical sabotage is repaired by crew at both consoles, faster for the Engineer', () => {
    const h = makeEngine(10); h.start();
    trigger(h, 'oxygen_leak');
    const [engineer] = h.byRole('engineer');
    const normal = h.byRole('crew')[0]!;
    const sab = h.engine.snapshotFor(normal).sabotage!;
    expect(() => h.engine.startRepair(normal, sab.stations[0]!.id)).toThrow(/closer/);
    h.engine.debugTeleport(engineer!, sab.stations[0]!.x, sab.stations[0]!.y - 10);
    h.engine.startRepair(engineer!, sab.stations[0]!.id);
    h.advance(1600);
    expect(h.engine.snapshotFor(engineer!).sabotage!.stations[0]!.fixed).toBe(true);
    h.engine.debugTeleport(normal, sab.stations[1]!.x, sab.stations[1]!.y - 10);
    h.engine.startRepair(normal, sab.stations[1]!.id);
    h.advance(1600);
    expect(h.engine.snapshotFor(normal).sabotage!.stations[1]!.fixed).toBe(false); // slower than the engineer
    h.advance(1600);
    expect(h.engine.snapshotFor(normal).sabotage).toBeNull();
    expect(h.eventsFor(engineer!, 'sabotage_end').at(-1)).toMatchObject({ resolved: true });
    expect(h.eventsFor(engineer!, 'xp').length).toBeGreaterThan(0);
  });

  it('moving cancels a repair; impostors cannot repair', () => {
    const h = makeEngine(6); h.start();
    const imp = trigger(h, 'oxygen_leak');
    const c = h.crewPids()[0]!;
    const st = h.engine.snapshotFor(c).sabotage!.stations[0]!;
    h.engine.debugTeleport(c, st.x, st.y - 10);
    h.engine.startRepair(c, st.id);
    h.engine.setIntent(c, 1, 0);
    h.advance(4000);
    expect(h.engine.snapshotFor(c).sabotage!.stations[0]!.fixed).toBe(false);
    expect(() => h.engine.startRepair(imp, st.id)).toThrow(/Impostors/);
  });

  it('power failure limits crew vision on the server but not impostors or spectators', () => {
    const h = makeEngine(7); h.start();
    const imp = trigger(h, 'power_failure');
    const [a, b] = h.crewPids();
    h.engine.debugTeleport(a!, h.engine.map.rooms[0]!.x + 80, h.engine.map.rooms[0]!.y + 80);
    h.engine.debugTeleport(b!, h.engine.map.rooms[5]!.x + 80, h.engine.map.rooms[5]!.y + 80);
    const sa = h.engine.snapshotFor(a!);
    expect(sa.lightsOut).toBe(true);
    expect(sa.players.find((p) => p.pid === b)).toBeUndefined();
    expect(h.engine.snapshotFor(imp).players.find((p) => p.pid === b)).toBeDefined();
  });

  it('communications blackout hides progress from crew; fake alerts inflate it', () => {
    const h = makeEngine(6, { env: 'cyber' }); h.start();
    const crew = h.crewPids()[0]!;
    doMission(h, crew);
    const real = h.engine.progress();
    expect(h.engine.snapshotFor(crew).progress).toBeCloseTo(real);
    h.advance(21_000);
    const imp = h.impostorPids()[0]!;
    h.engine.triggerSabotage(imp, 'comms_blackout');
    expect(h.engine.snapshotFor(crew).progress).toBeNull();
    expect(h.engine.snapshotFor(crew).commsBlackout).toBe(true);
    expect(h.engine.snapshotFor(imp).progress).toBeCloseTo(real);
    h.advance(26_000);
    h.advance(10_000);
    h.engine.triggerSabotage(imp, 'fake_alerts');
    expect(h.engine.snapshotFor(crew).progress).toBeCloseTo(Math.min(100, real + 25));
    expect(h.engine.snapshotFor(imp).progress).toBeCloseTo(real);
  });

  it('locked doors seal a room against entry', () => {
    const h = makeEngine(6); h.start();
    trigger(h, 'locked_doors');
    const c = h.crewPids()[0]!;
    const sealed = h.engine.snapshotFor(c).sabotage!.sealedRoom!;
    const room = h.engine.map.rooms.find((r) => r.id === sealed)!;
    // find a floor spot just outside the sealed room and push toward its centre
    let spot: { x: number; y: number; dx: number; dy: number } | null = null;
    for (let t = 0; t < 360 && !spot; t++) {
      const a = (t / 360) * Math.PI * 2;
      const cx = room.x + room.w / 2, cy = room.y + room.h / 2;
      const rx = room.w / 2 + 30, ry = room.h / 2 + 30;
      const x = cx + Math.cos(a) * rx * 1.0001, y = cy + Math.sin(a) * ry * 1.0001;
      const outside = x < room.x - 20 || x > room.x + room.w + 20 || y < room.y - 20 || y > room.y + room.h + 20;
      if (outside && bodyFits(h.engine.map, x, y) && !h.engine.map.rooms.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h)) {
        spot = { x, y, dx: cx - x, dy: cy - y };
      }
    }
    expect(spot).not.toBeNull();
    h.engine.debugTeleport(c, spot!.x, spot!.y);
    h.engine.setIntent(c, spot!.dx, spot!.dy);
    h.advance(3000);
    const p = h.engine.debugPlayer(c);
    expect(roomAt(h.engine.map, p.x, p.y)).not.toBe(sealed);
  });

  it('environmental traps eliminate players who linger and leave a body', () => {
    const h = makeEngine(6); h.start();
    trigger(h, 'engine_malfunction');
    const victim = h.crewPids()[0]!;
    const trap = h.engine.snapshotFor(victim).sabotage!.traps![0]!;
    h.engine.debugTeleport(victim, trap.x, trap.y);
    h.advance(900);
    expect(h.engine.isAlive(victim)).toBe(true);
    h.advance(600);
    expect(h.engine.isAlive(victim)).toBe(false);
    expect(h.eventsFor(victim, 'env_death')).toHaveLength(1);
    expect(h.engine.snapshotFor(h.crewPids()[1]!).bodies).toHaveLength(1);
  });

  it('disables the emergency button during a critical sabotage', () => {
    const h = makeEngine(6); h.start();
    trigger(h, 'oxygen_leak');
    const c = h.crewPids()[0]!;
    const em = h.engine.map.stations.find((s) => s.id === 'emergency')!;
    h.engine.debugTeleport(c, em.x, em.y + 20);
    expect(() => h.engine.callEmergency(c)).toThrow(/critical/);
  });

  it('a body report cancels non-critical sabotage', () => {
    const h = makeEngine(7); h.start();
    const imp = trigger(h, 'power_failure');
    const victim = h.crewPids()[0]!, reporter = h.crewPids()[1]!;
    kill(h, imp, victim);
    reportAndOpenVoting(h, reporter);
    expect(h.engine.snapshotFor(reporter).sabotage).toBeNull();
  });

  it('pauses a critical countdown while the meeting runs', () => {
    const h = makeEngine(7); h.start(); h.advance(21_000);
    const imp = h.impostorPids()[0]!;
    const victim = h.crewPids()[0]!, reporter = h.crewPids()[1]!;
    kill(h, imp, victim);
    h.engine.triggerSabotage(imp, 'oxygen_leak');
    const before = h.engine.snapshotFor(reporter).sabotage!.endsAt;
    reportAndOpenVoting(h, reporter);
    for (const p of h.pids.filter((x) => h.engine.isAlive(x))) h.engine.vote(p, 'skip');
    h.advance(2100);
    expect(h.engine.phase).toBe('playing');
    const after = h.engine.snapshotFor(reporter).sabotage!.endsAt;
    expect(after - before).toBeGreaterThanOrEqual(7000); // discussion + results, voting closed early
  });
});

describe('role abilities', () => {
  it('detective gets a limited clue once per round and never an exact role', () => {
    const h = makeEngine(10); h.start();
    const [det] = h.byRole('detective');
    const target = h.crewPids().find((p) => p !== det)!;
    h.meet(det!, target);
    const res = h.engine.useAbility(det!, { ability: 'investigate', targetPid: target }) as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual(['suspicious', 'targetName']);
    h.advance(16_000);
    expect(() => h.engine.useAbility(det!, { ability: 'investigate', targetPid: target })).toThrow(/already investigated/);
  });

  it('security officer reads movement logs only at the console', () => {
    const h = makeEngine(10); h.start();
    const [sec] = h.byRole('security');
    h.advance(5000);
    expect(() => h.engine.useAbility(sec!, { ability: 'check_logs' })).toThrow(/console/);
    const st = h.engine.map.stations.find((s) => s.id === 'security')!;
    const mover = h.crewPids().find((p) => p !== sec)!;
    const other = h.engine.map.rooms.find((r) => r.id !== st.room && r.id !== h.engine.map.rooms[1]!.id)!;
    h.engine.debugTeleport(mover, other.x + 60, other.y + 60);
    h.engine.setIntent(mover, 1, 0);
    h.advance(300);
    h.engine.setIntent(mover, 0, 0);
    h.engine.debugTeleport(sec!, st.x, st.y);
    const data = h.engine.useAbility(sec!, { ability: 'check_logs' }) as { entries: unknown[] };
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('engineer inspects a console for repair info', () => {
    const h = makeEngine(10); h.start(); h.advance(21_000);
    const [eng] = h.byRole('engineer');
    const imp = h.impostorPids()[0]!;
    h.engine.triggerSabotage(imp, 'oxygen_leak');
    const st = h.engine.snapshotFor(eng!).sabotage!.stations[0]!;
    h.engine.debugTeleport(eng!, st.x, st.y - 10);
    const d = h.engine.useAbility(eng!, { ability: 'inspect', stationId: st.id }) as { status: string };
    expect(d.status).toBe('damaged');
  });

  it('shapeshifter disguise changes public appearance only temporarily and hides it from crew', () => {
    const h = makeEngine(10); h.start();
    const [ss] = h.byRole('shapeshifter');
    const victim = h.crewPids()[0]!;
    h.meet(ss!, victim);
    h.engine.useAbility(ss!, { ability: 'disguise', targetPid: victim });
    const crewView = h.engine.snapshotFor(h.crewPids()[1]!).players.find((p) => p.pid === ss)!;
    expect(crewView.name).toBe(`Player${h.pids.indexOf(victim)}`);
    expect(crewView.disguised).toBe(false);
    h.advance(16_000);
    expect(h.engine.snapshotFor(h.crewPids()[1]!).players.find((p) => p.pid === ss)!.name).toBe(`Player${h.pids.indexOf(ss!)}`);
    expect(() => h.engine.useAbility(ss!, { ability: 'disguise', targetPid: victim })).toThrow(/recharging/);
  });

  it('rejects abilities used by the wrong role', () => {
    const h = makeEngine(10); h.start(); h.advance(21_000);
    const c = h.byRole('crew')[0]!;
    for (const ability of ['kill', 'investigate', 'protect', 'disguise', 'plant_evidence']) {
      expect(() => h.engine.useAbility(c, { ability, targetPid: h.pids.find((p) => p !== c) })).toThrow(/role/);
    }
  });

  it('nobody can act during the role reveal freeze', () => {
    const h = makeEngine(5);
    const c = h.crewPids()[0]!;
    expect(() => h.engine.startMission(c, h.engine.snapshotFor(c).you.tasks[0]!.missionId)).toThrow(/not started/);
  });
});
