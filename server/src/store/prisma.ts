import { PrismaClient, type Prisma } from '@prisma/client';
import type { Avatar, LeaderboardEntry } from '@impostor/shared';
import { applyMatch, defaultName, hashToken, newPublicId, newToken } from './progress.js';
import type { GuestRecord, MatchHistoryRow, MatchInput, Store } from './types.js';

type GuestWithAch = Prisma.GuestGetPayload<{ include: { achievements: true } }>;

const toRecord = (g: GuestWithAch): GuestRecord => ({
  id: g.id, publicId: g.publicId, displayName: g.displayName, avatar: g.avatar as Avatar,
  xp: g.xp, gamesPlayed: g.gamesPlayed, wins: g.wins,
  stats: (g.stats ?? {}) as Record<string, number>,
  achievements: g.achievements.map((a) => ({ key: a.key, unlockedAt: a.unlockedAt })),
});

export class PrismaStore implements Store {
  constructor(private db: PrismaClient = new PrismaClient()) {}

  async createGuest() {
    const token = newToken();
    const g = await this.db.guest.create({
      data: { publicId: newPublicId(), tokenHash: hashToken(token), displayName: defaultName() },
      include: { achievements: true },
    });
    return { guest: toRecord(g), token };
  }

  async findByToken(token: string) {
    const g = await this.db.guest.findUnique({ where: { tokenHash: hashToken(token) }, include: { achievements: true } });
    if (!g) return null;
    void this.db.guest.update({ where: { id: g.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
    return toRecord(g);
  }

  async updateProfile(guestId: string, name: string, avatar: Avatar) {
    const g = await this.db.guest.update({ where: { id: guestId }, data: { displayName: name, avatar }, include: { achievements: true } });
    return toRecord(g);
  }

  async recordMatch(m: MatchInput) {
    const unlockedBy = new Map<string, string[]>();
    await this.db.$transaction(async (tx) => {
      const match = await tx.match.create({
        data: {
          roomCode: m.roomCode, environment: m.environment, winner: m.winner, reason: m.reason, playerCount: m.players.length,
          durationSec: m.durationSec, teamScore: m.teamScore, startedAt: m.startedAt,
        },
      });
      for (const p of m.players) {
        const g = await tx.guest.findUnique({ where: { id: p.guestId }, include: { achievements: true } });
        if (!g) continue;
        const { next, unlocked } = applyMatch(
          { xp: g.xp, gamesPlayed: g.gamesPlayed, wins: g.wins, stats: (g.stats ?? {}) as Record<string, number> },
          new Set(g.achievements.map((a) => a.key)), p, m,
        );
        await tx.guest.update({ where: { id: g.id }, data: { xp: next.xp, gamesPlayed: next.gamesPlayed, wins: next.wins, stats: next.stats } });
        if (unlocked.length) await tx.achievement.createMany({ data: unlocked.map((key) => ({ guestId: g.id, key })), skipDuplicates: true });
        await tx.matchPlayer.create({
          data: {
            matchId: match.id, guestId: g.id, name: p.name, role: p.role, faction: p.faction, alive: p.alive, won: p.won,
            xpEarned: p.xp, missions: p.missions, kills: p.kills,
          },
        });
        unlockedBy.set(g.id, unlocked);
      }
    });
    return unlockedBy;
  }

  async leaderboard(limit: number): Promise<LeaderboardEntry[]> {
    const rows = await this.db.guest.findMany({ where: { gamesPlayed: { gt: 0 } }, orderBy: [{ xp: 'desc' }, { wins: 'desc' }], take: limit });
    return rows.map((g, i) => ({ rank: i + 1, displayName: g.displayName, xp: g.xp, wins: g.wins, gamesPlayed: g.gamesPlayed, avatar: g.avatar as Avatar }));
  }

  async history(guestId: string, limit: number): Promise<MatchHistoryRow[]> {
    const rows = await this.db.matchPlayer.findMany({ where: { guestId }, include: { match: true }, orderBy: { match: { endedAt: 'desc' } }, take: limit });
    return rows.map((r) => ({ roomCode: r.match.roomCode, environment: r.match.environment, winner: r.match.winner, role: r.role, won: r.won, xpEarned: r.xpEarned, endedAt: r.match.endedAt }));
  }

  async close() { await this.db.$disconnect(); }
}
