import type { Avatar, LeaderboardEntry } from '@impostor/shared';
import type { PlayerResult } from '../game/engine.js';

export interface GuestRecord {
  id: string; // internal; never sent to other clients
  publicId: string;
  displayName: string;
  avatar: Avatar;
  xp: number;
  gamesPlayed: number;
  wins: number;
  stats: Record<string, number>;
  achievements: { key: string; unlockedAt: Date }[];
}

export interface MatchInput {
  roomCode: string;
  environment: string;
  winner: string;
  reason: string;
  durationSec: number;
  teamScore: number;
  startedAt: Date;
  criticalWin: boolean;
  bodiesReported: number;
  totalKills: number;
  players: PlayerResult[];
}

export interface MatchHistoryRow {
  roomCode: string; environment: string; winner: string; role: string; won: boolean; xpEarned: number; endedAt: Date;
}

export interface Store {
  createGuest(): Promise<{ guest: GuestRecord; token: string }>;
  findByToken(token: string): Promise<GuestRecord | null>;
  updateProfile(guestId: string, name: string, avatar: Avatar): Promise<GuestRecord>;
  /** Persist a finished match. Returns newly unlocked achievement keys per guestId. */
  recordMatch(m: MatchInput): Promise<Map<string, string[]>>;
  leaderboard(limit: number): Promise<LeaderboardEntry[]>;
  history(guestId: string, limit: number): Promise<MatchHistoryRow[]>;
  close(): Promise<void>;
}
