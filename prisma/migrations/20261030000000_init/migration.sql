-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatar" TEXT NOT NULL DEFAULT 'visor',
    "xp" INTEGER NOT NULL DEFAULT 0,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Achievement" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "roomCode" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "winner" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "playerCount" INTEGER NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "teamScore" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchPlayer" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "faction" TEXT NOT NULL,
    "alive" BOOLEAN NOT NULL,
    "won" BOOLEAN NOT NULL,
    "xpEarned" INTEGER NOT NULL,
    "missions" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MatchPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guest_publicId_key" ON "Guest"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "Guest_tokenHash_key" ON "Guest"("tokenHash");

-- CreateIndex
CREATE INDEX "Guest_xp_idx" ON "Guest"("xp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Achievement_guestId_key_key" ON "Achievement"("guestId", "key");

-- CreateIndex
CREATE INDEX "MatchPlayer_guestId_idx" ON "MatchPlayer"("guestId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchPlayer_matchId_guestId_key" ON "MatchPlayer"("matchId", "guestId");

-- AddForeignKey
ALTER TABLE "Achievement" ADD CONSTRAINT "Achievement_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPlayer" ADD CONSTRAINT "MatchPlayer_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPlayer" ADD CONSTRAINT "MatchPlayer_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

