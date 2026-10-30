import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayerResult } from '../../server/src/game/engine.js';
import { PrismaStore } from '../../server/src/store/prisma.js';
import type { MatchInput } from '../../server/src/store/types.js';

const PORT = 54329;
const url = `postgresql://postgres:testpw@127.0.0.1:${PORT}/impostor?schema=public`;
let pg: EmbeddedPostgres;
let dir: string;
let db: PrismaClient;
let store: PrismaStore;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'impostor-pg-'));
  pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'testpw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('impostor');
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url }, shell: true, stdio: 'pipe' });
  db = new PrismaClient({ datasourceUrl: url });
  store = new PrismaStore(db);
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const result = (guestId: string, o: Partial<PlayerResult> = {}): PlayerResult => ({
  pid: `p-${guestId}`, guestId, name: 'X', role: 'crew', faction: 'crew', alive: true, won: true,
  xp: 115, missions: 4, kills: 0, repairs: 0, saves: 0, detectiveHits: 0, sabotages: 0, ...o,
});
const match = (players: PlayerResult[], o: Partial<MatchInput> = {}): MatchInput => ({
  roomCode: 'ABC234', environment: 'space', winner: 'crew', reason: 'missions', durationSec: 300, teamScore: 900,
  startedAt: new Date(Date.now() - 300_000), criticalWin: false, bodiesReported: 0, totalKills: 0, players, ...o,
});

describe('PrismaStore against PostgreSQL', () => {
  it('stores only a hash of the guest token and authenticates with the raw one', async () => {
    const { guest, token } = await store.createGuest();
    expect(guest.publicId).toHaveLength(12);
    expect((await store.findByToken(token))?.id).toBe(guest.id);
    expect(await store.findByToken('not-a-token')).toBeNull();
    const rows = await db.$queryRawUnsafe<{ tokenHash: string }[]>('SELECT "tokenHash" FROM "Guest" WHERE id = $1', guest.id);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });

  it('persists XP, stats, achievements, history and the leaderboard across a restart', async () => {
    const a = await store.createGuest();
    const b = await store.createGuest();
    const unlocked = await store.recordMatch(match([
      result(a.guest.id, { missions: 4 }),
      result(b.guest.id, { role: 'impostor', faction: 'impostor', won: false, xp: 10, missions: 0 }),
    ]));
    expect(unlocked.get(a.guest.id)).toEqual(expect.arrayContaining(['first_mission', 'crew_hero']));
    expect(unlocked.get(b.guest.id)).toEqual([]);

    // a brand-new client/store instance = a server restart
    const restarted = new PrismaStore(new PrismaClient({ datasourceUrl: url }));
    const ga = (await restarted.findByToken(a.token))!;
    expect(ga.xp).toBe(115);
    expect(ga.gamesPlayed).toBe(1);
    expect(ga.wins).toBe(1);
    expect(ga.stats.missions).toBe(4);
    expect(ga.achievements.map((x) => x.key).sort()).toEqual(['crew_hero', 'first_mission']);
    expect((await restarted.findByToken(b.token))!.xp).toBe(10);

    const board = await restarted.leaderboard(10);
    expect(board[0]!.xp).toBeGreaterThanOrEqual(board[1]!.xp);
    expect(board.some((e) => e.displayName === ga.displayName && e.xp === 115)).toBe(true);
    const hist = await restarted.history(a.guest.id, 5);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ roomCode: 'ABC234', won: true, xpEarned: 115 });
    await restarted.close();
  });

  it('never re-awards an achievement and accumulates across matches', async () => {
    const { guest, token } = await store.createGuest();
    await store.recordMatch(match([result(guest.id)]));
    const second = await store.recordMatch(match([result(guest.id)], { roomCode: 'DEF567' }));
    expect(second.get(guest.id)).toEqual([]);
    const g = (await store.findByToken(token))!;
    expect(g.xp).toBe(230);
    expect(g.gamesPlayed).toBe(2);
    expect(g.achievements.filter((x) => x.key === 'first_mission')).toHaveLength(1);
  });

  it('updates a guest profile', async () => {
    const { guest } = await store.createGuest();
    const updated = await store.updateProfile(guest.id, 'Nova', 'halo');
    expect(updated).toMatchObject({ displayName: 'Nova', avatar: 'halo' });
  });
});
