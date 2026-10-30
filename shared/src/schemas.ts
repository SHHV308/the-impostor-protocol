import { z } from 'zod';
import { AVATARS, ENVIRONMENTS, LIMITS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './constants.js';

export const nameSchema = z
  .string()
  .trim()
  .min(LIMITS.nameMin, 'Name is too short')
  .max(LIMITS.nameMax, 'Name is too long')
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'Name may only contain letters, numbers, spaces, _ . -');

export const avatarSchema = z.enum(AVATARS);

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(ROOM_CODE_LENGTH)
  .refine((s) => [...s].every((c) => ROOM_CODE_ALPHABET.includes(c)), 'Invalid room code');

const pid = z.string().min(1).max(32);

export const schemas = {
  createRoom: z.object({ name: nameSchema, avatar: avatarSchema, isPublic: z.boolean().default(false) }),
  joinRoom: z.object({ code: roomCodeSchema, name: nameSchema, avatar: avatarSchema }),
  matchmake: z.object({ name: nameSchema, avatar: avatarSchema }),
  settings: z.object({
    environment: z.enum([...ENVIRONMENTS, 'random']).optional(),
    matchMinutes: z.number().int().min(LIMITS.matchMinutesMin).max(LIMITS.matchMinutesMax).optional(),
    missionThreshold: z.number().int().min(LIMITS.thresholdMin).max(LIMITS.thresholdMax).optional(),
    tasksPerPlayer: z.number().int().min(LIMITS.tasksPerPlayerMin).max(LIMITS.tasksPerPlayerMax).optional(),
    isPublic: z.boolean().optional(),
  }).strict(),
  ready: z.object({ ready: z.boolean() }),
  profile: z.object({ name: nameSchema, avatar: avatarSchema }),
  chat: z.object({ text: z.string().trim().min(1).max(LIMITS.chatLength) }),
  move: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }),
  missionStart: z.object({ missionId: z.string().min(1).max(64) }),
  missionSubmit: z.object({
    missionId: z.string().min(1).max(64),
    answer: z.union([
      z.array(z.number()).max(64),
      z.array(z.boolean()).max(64),
      z.number(),
      z.string().max(32),
    ]),
  }),
  ability: z.object({
    ability: z.enum(['kill', 'investigate', 'protect', 'inspect', 'check_logs', 'disguise', 'plant_evidence', 'distract']),
    targetPid: pid.optional(),
    roomId: z.string().max(64).optional(),
    stationId: z.string().max(64).optional(),
  }),
  sabotage: z.object({ sabotageId: z.string().min(1).max(64) }),
  repair: z.object({ stationId: z.string().min(1).max(64) }),
  report: z.object({ bodyId: z.string().min(1).max(64) }),
  vote: z.object({ target: z.union([pid, z.literal('skip')]) }),
};

export type Schemas = typeof schemas;
