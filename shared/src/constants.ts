export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const PLAYER_RADIUS = 14;
export const MOVE_SPEED = 190; // px per second
export const WORLD_W = 1600;
export const WORLD_H = 1000;

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 10;
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECONNECT_GRACE_MS = 60_000;

export const AVATARS = ['visor', 'antenna', 'helmet', 'goggles', 'hood', 'crest', 'halo', 'bolt'] as const;
export const PLAYER_COLORS = [
  '#ff5470', '#38bdf8', '#a3e635', '#fbbf24', '#c084fc',
  '#fb923c', '#2dd4bf', '#f472b6', '#94a3b8', '#e2e8f0',
] as const;

export const ENVIRONMENTS = ['space', 'lab', 'cyber', 'bunker'] as const;

export const RANGES = {
  interact: 110,
  missionSubmit: 190,
  kill: 100,
  report: 130,
  investigate: 130,
  protect: 130,
  disguise: 400,
  repair: 100,
  inspect: 160,
  scream: 320,
  lightsOutVision: 260,
} as const;

export const COOLDOWNS = {
  killInitial: 15_000,
  kill: 25_000,
  sabotageInitial: 20_000,
  sabotage: 35_000,
  distract: 30_000,
  investigate: 15_000,
  inspect: 12_000,
  protect: 30_000,
  logs: 15_000,
  disguise: 40_000,
  plantEvidence: 60_000,
  missionRetry: 3_000,
  emergencyAfterMeeting: 20_000,
} as const;

export const DURATIONS = {
  protection: 40_000,
  disguise: 15_000,
  repairNormal: 3_000,
  repairEngineer: 1_500,
  criticalSabotage: 45_000,
  lightsOut: 25_000,
  commsBlackout: 25_000,
  lockedDoors: 20_000,
  envTrap: 25_000,
  fakeAlerts: 25_000,
  trapKill: 1_200,
  discussion: 60_000,
  voting: 30_000,
  results: 8_000,
  roleReveal: 6_000,
  logWindow: 90_000,
} as const;

export const LIMITS = {
  tasksPerPlayerMin: 3,
  tasksPerPlayerMax: 7,
  matchMinutesMin: 10,
  matchMinutesMax: 15,
  thresholdMin: 50,
  thresholdMax: 100,
  chatLength: 200,
  nameMin: 2,
  nameMax: 16,
  roomInactiveMs: 30 * 60_000,
  emptyRoomMs: 2 * 60_000,
} as const;

export const XP = {
  mission: 20,
  repair: 25,
  investigate: 5,
  protectSave: 40,
  kill: 30,
  sabotage: 10,
  correctVote: 30,
  survive: 15,
  win: 50,
  loss: 10,
  reportBody: 10,
} as const;
