import { createHash, randomBytes } from 'node:crypto';
import type { PlayerResult } from '../game/engine.js';
import type { MatchInput } from './types.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const newPublicId = () => randomBytes(6).toString('hex');
export const defaultName = () => `Guest-${randomBytes(2).toString('hex').toUpperCase()}`;

export interface Progress { xp: number; gamesPlayed: number; wins: number; stats: Record<string, number> }

const bump = (s: Record<string, number>, k: string, n: number) => { if (n) s[k] = (s[k] ?? 0) + n; };

/**
 * Fold one finished match into a guest's lifetime progress and work out which achievements
 * this match newly unlocks. Pure so both store implementations (and tests) share it.
 * XP always comes from the server-side engine result, never from a client.
 */
export function applyMatch(prev: Progress, have: Set<string>, p: PlayerResult, m: MatchInput): { next: Progress; unlocked: string[] } {
  const stats = { ...prev.stats };
  bump(stats, 'missions', p.missions);
  bump(stats, 'kills', p.kills);
  bump(stats, 'repairs', p.repairs);
  bump(stats, 'saves', p.saves);
  bump(stats, 'detectiveHits', p.detectiveHits);
  bump(stats, 'sabotages', p.sabotages);
  if (p.role === 'engineer') bump(stats, 'engineerRepairs', p.repairs);
  bump(stats, p.faction === 'crew' ? (p.won ? 'crewWins' : 'crewLosses') : (p.won ? 'impostorWins' : 'impostorLosses'), 1);

  const next: Progress = {
    xp: prev.xp + p.xp, gamesPlayed: prev.gamesPlayed + 1, wins: prev.wins + (p.won ? 1 : 0), stats,
  };

  const others = m.players.length - 1;
  const deadOthers = m.players.filter((o) => o.pid !== p.pid && !o.alive).length;
  const earned: Record<string, boolean> = {
    first_mission: (stats.missions ?? 0) >= 1,
    master_detective: (stats.detectiveHits ?? 0) >= 3,
    perfect_sabotage: p.faction === 'impostor' && p.won && m.criticalWin,
    last_survivor: p.alive && others > 0 && deadOthers >= Math.ceil(others / 2),
    trusted_engineer: (stats.engineerRepairs ?? 0) >= 3,
    impostor_victory: p.faction === 'impostor' && p.won,
    crew_hero: p.faction === 'crew' && p.won && p.missions >= 4,
    no_evidence: p.faction === 'impostor' && p.won && m.totalKills >= 1 && m.bodiesReported === 0,
  };
  const unlocked = Object.keys(earned).filter((k) => earned[k] && !have.has(k));
  return { next, unlocked };
}
