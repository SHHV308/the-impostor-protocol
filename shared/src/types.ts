import type { AVATARS, ENVIRONMENTS } from './constants.js';

export type EnvironmentId = (typeof ENVIRONMENTS)[number];
export type Avatar = (typeof AVATARS)[number];
export type Role = 'detective' | 'engineer' | 'medic' | 'security' | 'crew' | 'impostor' | 'shapeshifter';
export type Faction = 'crew' | 'impostor';
export type MissionCategory = 'logic' | 'repair' | 'hacking' | 'investigation';
export type MiniGameKind = 'sequence' | 'circuit' | 'calibrate' | 'decode' | 'network' | 'odd_one' | 'pattern';
export type SabotageKind = 'critical' | 'lights_out' | 'comms_blackout' | 'locked_doors' | 'env_trap' | 'fake_alerts';
export type Difficulty = 1 | 2 | 3;

export const FACTION_OF: Record<Role, Faction> = {
  detective: 'crew', engineer: 'crew', medic: 'crew', security: 'crew', crew: 'crew',
  impostor: 'impostor', shapeshifter: 'impostor',
};

export interface Settings {
  environment: EnvironmentId | 'random';
  matchMinutes: number;
  missionThreshold: number; // percent of crew tasks that must be done
  tasksPerPlayer: number;
  isPublic: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Vec { x: number; y: number }

// ---------- map description ----------
export interface RoomDef extends Rect { id: string; name: string }
export type StationType = 'mission' | 'repair' | 'emergency' | 'security';
export interface StationDef { id: string; type: StationType; x: number; y: number; room: string; missionId?: string }
export interface MissionDef { id: string; name: string; category: MissionCategory; kind: MiniGameKind; room: string }
export interface SabotageDef { id: string; name: string; kind: SabotageKind; blurb: string }
export interface MapDef {
  id: EnvironmentId;
  name: string;
  tagline: string;
  palette: { bg: string; floor: string; wall: string; accent: string; accent2: string; danger: string };
  rooms: RoomDef[];
  corridors: Rect[];
  obstacles: Rect[];
  stations: StationDef[];
  missions: MissionDef[];
  sabotages: SabotageDef[];
  spawn: Vec;
}

// ---------- lobby ----------
export interface LobbyPlayer {
  pid: string; name: string; avatar: Avatar; color: string;
  ready: boolean; isHost: boolean; connected: boolean;
}
export interface RoomState {
  code: string;
  phase: 'lobby' | 'playing' | 'ended';
  settings: Settings;
  players: LobbyPlayer[];
  hostPid: string;
  youPid: string;
  maxPlayers: number;
  minPlayers: number;
}
export interface ChatMessage {
  id: string; pid: string; name: string; color: string; text: string; t: number;
  channel: 'room' | 'meeting' | 'spectator' | 'system';
}

// ---------- in-game snapshots ----------
export type Anim = 'idle' | 'walk' | 'channel' | 'dead';
export interface PublicPlayer {
  pid: string; name: string; avatar: Avatar; color: string;
  x: number; y: number; dir: 1 | -1; anim: Anim;
  alive: boolean; connected: boolean; disguised: boolean; protectedFx: boolean;
}
export interface BodyView { id: string; x: number; y: number; victimPid: string; name: string; color: string }
export interface StationView { id: string; type: StationType; x: number; y: number; fixed?: boolean }
export interface SabotageView {
  id: string; name: string; kind: SabotageKind; critical: boolean;
  endsAt: number; // server epoch ms (deadline for critical, expiry otherwise)
  stations: { id: string; x: number; y: number; fixed: boolean }[];
  sealedRoom?: string;
  traps?: { x: number; y: number; r: number }[];
}
export interface MeetingView {
  phase: 'discussion' | 'voting' | 'results';
  endsAt: number;
  callerPid: string;
  reason: 'body' | 'emergency';
  bodyName?: string;
  voted: string[]; // who has voted (not for whom)
  results?: { tally: Record<string, number>; votes: { voter: string; target: string }[]; ejected: string | null; tie: boolean; skipTop: boolean };
}
export interface TaskView { missionId: string; name: string; category: MissionCategory; room: string; done: boolean; decoy: boolean; x: number; y: number }
export interface PrivateState {
  pid: string;
  role: Role;
  faction: Faction;
  alive: boolean;
  tasks: TaskView[];
  cooldowns: Record<string, number>; // ability -> epoch ms ready
  mates: { pid: string; name: string }[]; // fellow impostors, impostors only
  channel: { kind: 'repair'; stationId: string; endsAt: number } | null;
  emergencyLeft: number;
  protectedUntil: number | null;
  disguiseUntil: number | null;
  mission: ActiveChallenge | null;
}
export interface GameSnapshot {
  now: number;
  phase: 'playing' | 'meeting' | 'ended';
  env: EnvironmentId;
  players: PublicPlayer[];
  bodies: BodyView[];
  progress: number | null; // percent, null = hidden (blackout)
  threshold: number;
  endsAt: number; // match deadline
  sabotage: SabotageView | null;
  commsBlackout: boolean;
  lightsOut: boolean;
  meeting: MeetingView | null;
  you: PrivateState;
  spectating: boolean;
  frozenUntil: number; // role reveal freeze
}

// ---------- mini-game payloads ----------
export type ChallengePayload =
  | { kind: 'sequence'; pads: number; seq: number[]; showMs: number }
  | { kind: 'circuit'; colors: string[]; right: string[] }
  | { kind: 'calibrate'; label: string; target: number; tolerance: number }
  | { kind: 'decode'; cipher: string; shift: number }
  | { kind: 'network'; packets: number[] }
  | { kind: 'odd_one'; cols: number; grid: string[] }
  | { kind: 'pattern'; cols: number; pattern: boolean[]; showMs: number };
export interface ActiveChallenge { missionId: string; difficulty: Difficulty; startedAt: number; payload: ChallengePayload; decoy: boolean }
export type ChallengeAnswer = number[] | number | string | boolean[];

// ---------- events ----------
export type GameEvent =
  | { type: 'match_start'; env: EnvironmentId }
  | { type: 'role_reveal'; role: Role; faction: Faction; mates: { pid: string; name: string }[] }
  | { type: 'scream'; x: number; y: number }
  | { type: 'you_died'; cause: 'eliminated' | 'trap' | 'voted' | 'disconnect' }
  | { type: 'kill_ok'; victimName: string }
  | { type: 'kill_blocked'; reason: 'protected' }
  | { type: 'protect_saved'; targetName: string }
  | { type: 'env_death'; name: string }
  | { type: 'meeting_start'; reason: 'body' | 'emergency'; callerName: string; bodyName?: string }
  | { type: 'vote_cast'; pid: string }
  | { type: 'meeting_results'; ejectedName: string | null; tie: boolean }
  | { type: 'sabotage'; id: string; name: string; kind: SabotageKind; critical: boolean; endsAt: number }
  | { type: 'sabotage_end'; resolved: boolean; name: string }
  | { type: 'repair_done'; stationId: string }
  | { type: 'mission_done'; missionId: string }
  | { type: 'mission_failed'; reason: string }
  | { type: 'ability_result'; ability: string; data: unknown }
  | { type: 'noise'; room: string; x: number; y: number }
  | { type: 'xp'; amount: number; reason: string }
  | { type: 'achievement'; key: string; title: string }
  | { type: 'game_over'; summary: GameSummary }
  | { type: 'notice'; text: string };

export interface SummaryPlayer {
  pid: string; name: string; color: string; avatar: Avatar;
  role: Role; faction: Faction; alive: boolean; xp: number; missions: number; kills: number; won: boolean;
}
export interface GameSummary {
  winner: Faction;
  reason: 'missions' | 'impostors_voted' | 'parity' | 'sabotage' | 'timer' | 'abandoned';
  durationSec: number;
  teamScore: number;
  progress: number;
  players: SummaryPlayer[];
}

// ---------- profile ----------
export interface Profile {
  publicId: string; displayName: string; avatar: Avatar;
  xp: number; level: number; gamesPlayed: number; wins: number;
  achievements: { key: string; title: string; unlockedAt: string }[];
  stats: Record<string, number>;
}
export interface LeaderboardEntry { rank: number; displayName: string; xp: number; wins: number; gamesPlayed: number; avatar: Avatar }

export type Ack<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string };
