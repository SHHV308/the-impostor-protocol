import type { Avatar, LeaderboardEntry } from '@impostor/shared';
import { applyMatch, defaultName, hashToken, newPublicId, newToken } from './progress.js';
import type { GuestRecord, MatchHistoryRow, MatchInput, Store } from './types.js';

/** Non-persistent store used for local development without a database and for tests. */
export class MemoryStore implements Store {
  private guests = new Map<string, GuestRecord>();
  private byHash = new Map<string, string>();
  private matches = new Map<string, MatchHistoryRow[]>();
  private seq = 0;

  async createGuest() {
    const token = newToken();
    const guest: GuestRecord = {
      id: `g${++this.seq}`, publicId: newPublicId(), displayName: defaultName(), avatar: 'visor',
      xp: 0, gamesPlayed: 0, wins: 0, stats: {}, achievements: [],
    };
    this.guests.set(guest.id, guest);
    this.byHash.set(hashToken(token), guest.id);
    return { guest, token };
  }

  async findByToken(token: string) {
    const id = this.byHash.get(hashToken(token));
    return id ? this.guests.get(id) ?? null : null;
  }

  async updateProfile(guestId: string, name: string, avatar: Avatar) {
    const g = this.guests.get(guestId)!;
    g.displayName = name; g.avatar = avatar;
    return g;
  }

  async recordMatch(m: MatchInput) {
    const unlockedBy = new Map<string, string[]>();
    for (const p of m.players) {
      const g = this.guests.get(p.guestId);
      if (!g) continue;
      const { next, unlocked } = applyMatch(g, new Set(g.achievements.map((a) => a.key)), p, m);
      Object.assign(g, next);
      for (const key of unlocked) g.achievements.push({ key, unlockedAt: new Date() });
      unlockedBy.set(g.id, unlocked);
      const rows = this.matches.get(g.id) ?? [];
      rows.unshift({ roomCode: m.roomCode, environment: m.environment, winner: m.winner, role: p.role, won: p.won, xpEarned: p.xp, endedAt: new Date() });
      this.matches.set(g.id, rows);
    }
    return unlockedBy;
  }

  async leaderboard(limit: number): Promise<LeaderboardEntry[]> {
    return [...this.guests.values()].filter((g) => g.gamesPlayed > 0).sort((a, b) => b.xp - a.xp).slice(0, limit)
      .map((g, i) => ({ rank: i + 1, displayName: g.displayName, xp: g.xp, wins: g.wins, gamesPlayed: g.gamesPlayed, avatar: g.avatar }));
  }

  async history(guestId: string, limit: number) { return (this.matches.get(guestId) ?? []).slice(0, limit); }
  async close() {}
}
