import { PLAYER_COLORS } from '@impostor/shared';
import type { ChallengePayload, ChallengeAnswer, EnvironmentId, GameEvent, Role } from '@impostor/shared';
import { GameEngine, type EngineResult, type Target } from '../../server/src/game/engine.js';

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Harness extends ReturnType<typeof makeEngine> {}

export function makeEngine(n: number, o: { env?: EnvironmentId; seed?: number; threshold?: number; tasks?: number; matchMs?: number } = {}) {
  let t = 1_000_000;
  const events: { target: Target; event: GameEvent }[] = [];
  let result: EngineResult | null = null;
  const pids = Array.from({ length: n }, (_, i) => `p${i}`);
  const engine = new GameEngine(
    { env: o.env ?? 'space', matchMs: o.matchMs ?? 12 * 60_000, threshold: o.threshold ?? 100, tasksPerPlayer: o.tasks ?? 5, timings: { discussion: 5000, voting: 5000, results: 2000, roleReveal: 1000 } },
    pids.map((pid, i) => ({ pid, guestId: `g${i}`, name: `Player${i}`, avatar: 'visor' as const, color: PLAYER_COLORS[i]! })),
    { now: () => t, rng: mulberry32(o.seed ?? 7), emit: (target, event) => events.push({ target, event }), onEnd: (r) => { result = r; } },
  );
  const advance = (ms: number) => { for (let i = 0; i < Math.ceil(ms / 50); i++) { t += 50; engine.tick(); } };
  const start = () => advance(1100);
  const byRole = (role: Role) => pids.filter((p) => engine.roleOf(p) === role);
  const crewPids = () => pids.filter((p) => engine.roleOf(p) !== 'impostor' && engine.roleOf(p) !== 'shapeshifter');
  const impostorPids = () => pids.filter((p) => engine.roleOf(p) === 'impostor' || engine.roleOf(p) === 'shapeshifter');
  const eventsFor = (pid: string, type?: string) =>
    events.filter((e) => (e.target.to === 'all' || (e.target.to === 'pid' && e.target.pid === pid)) && (!type || e.event.type === type)).map((e) => e.event);
  /** Put `b` right next to `a`. */
  const meet = (a: string, b: string) => { const p = engine.debugPlayer(a); engine.debugTeleport(b, p.x + 30, p.y); };
  return { engine, events, advance, start, byRole, crewPids, impostorPids, eventsFor, meet, now: () => t, pids, result: () => result };
}

/** Solve a mini-game from its public payload (what an honest client can do). */
export function solve(p: ChallengePayload): ChallengeAnswer {
  switch (p.kind) {
    case 'sequence': return p.seq;
    case 'circuit': return p.colors.map((c) => p.right.indexOf(c));
    case 'calibrate': return p.target;
    case 'decode': return [...p.cipher].map((c) => String.fromCharCode(((c.charCodeAt(0) - 65 - p.shift + 26) % 26) + 65)).join('');
    case 'network': return [...p.packets].sort((a, b) => a - b);
    case 'odd_one': { const common = p.grid[0] === p.grid[1] ? p.grid[0] : p.grid[2]; return p.grid.findIndex((g) => g !== common); }
    case 'pattern': return p.pattern;
  }
}
