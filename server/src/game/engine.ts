import {
  COOLDOWNS, DURATIONS, FACTION_OF, RANGES, TICK_MS, XP, bodyFits, dist, getMap, roomAt, stepMove,
} from '@impostor/shared';
import type {
  Avatar, ChallengeAnswer, EnvironmentId, Faction, GameEvent, GameSnapshot, GameSummary, MapDef, MeetingView,
  PrivateState, PublicPlayer, Rect, Role, SabotageDef, SabotageView, StationDef, Vec,
} from '@impostor/shared';
import { generateChallenge, verifyAnswer, type Challenge, type Rng } from './missions.js';
import type { Difficulty } from '@impostor/shared';

export class GameError extends Error {}

export type Target =
  | { to: 'all' }
  | { to: 'pid'; pid: string }
  | { to: 'impostors' }
  | { to: 'near'; x: number; y: number; r: number };

export interface EngineHooks {
  now(): number;
  rng: Rng;
  emit(target: Target, event: GameEvent): void;
  onEnd?(result: EngineResult): void;
}

export interface EngineConfig {
  env: EnvironmentId;
  matchMs: number;
  threshold: number;
  tasksPerPlayer: number;
  /** Overrides for meeting/reveal timers (tests, FAST_TIMERS). */
  timings?: Partial<{ discussion: number; voting: number; results: number; roleReveal: number }>;
}

export interface PlayerInit { pid: string; guestId: string; name: string; avatar: Avatar; color: string }

export interface PlayerResult {
  pid: string; guestId: string; name: string; role: Role; faction: Faction; alive: boolean; won: boolean;
  xp: number; missions: number; kills: number; repairs: number; saves: number; detectiveHits: number; sabotages: number;
}
export interface EngineResult {
  summary: GameSummary; players: PlayerResult[]; startedAt: number;
  criticalWin: boolean; bodiesReported: number; totalKills: number;
}

interface Task { missionId: string; done: boolean; decoy: boolean }
interface ActiveChallengeState { missionId: string; startedAt: number; challenge: Challenge; difficulty: Difficulty; decoy: boolean }
interface Body { id: string; x: number; y: number; victimPid: string }
interface LogEntry { t: number; name: string; room: string }

interface P extends PlayerInit {
  role: Role; faction: Faction;
  x: number; y: number; intent: Vec; dir: 1 | -1;
  alive: boolean; connected: boolean;
  tasks: Task[];
  cd: Record<string, number>;
  channel: { stationId: string; endsAt: number } | null;
  challenge: ActiveChallengeState | null;
  retryAt: number;
  emergencyLeft: number;
  protectedUntil: number | null; protectedBy: string | null; lastProtectedPid: string | null;
  disguiseAs: string | null; disguiseUntil: number | null;
  investigatedRound: number;
  lastRoom: string | null;
  trapSince: number | null;
  xpKeys: Set<string>;
  xp: number; missions: number; kills: number; repairs: number; saves: number; detectiveHits: number; sabotages: number;
}

interface Sabotage {
  def: SabotageDef;
  endsAt: number;
  stations: { id: string; fixed: boolean }[];
  sealedRoom?: string;
  traps?: { x: number; y: number; r: number }[];
}

interface Meeting {
  phase: 'discussion' | 'voting' | 'results';
  startedAt: number;
  endsAt: number;
  callerPid: string;
  reason: 'body' | 'emergency';
  bodyName?: string;
  votes: Map<string, string>;
  results?: NonNullable<MeetingView['results']>;
}

const CREW_SPECIALS: Role[] = ['detective', 'engineer', 'medic', 'security'];

/** Pure role assignment. 4-7 players: 1 impostor; 8-10: 2 impostors (one of each variant). */
export function assignRoles(n: number, rng: Rng): Role[] {
  const shuffle = <T,>(a: T[]) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j]!, r[i]!]; } return r; };
  const impostorCount = n >= 8 ? 2 : 1;
  const impostors: Role[] = impostorCount === 2 ? ['impostor', 'shapeshifter'] : [rng() < 0.5 ? 'impostor' : 'shapeshifter'];
  const crewCount = n - impostorCount;
  const specials = shuffle(CREW_SPECIALS).slice(0, Math.min(CREW_SPECIALS.length, crewCount - 1));
  const crew: Role[] = [...specials, ...Array<Role>(crewCount - specials.length).fill('crew')];
  return shuffle([...impostors, ...crew]);
}

export class GameEngine {
  readonly map: MapDef;
  readonly startedAt: number;
  phase: 'playing' | 'meeting' | 'ended' = 'playing';
  private players = new Map<string, P>();
  private bodies: Body[] = [];
  private bodySeq = 0;
  private sabotage: Sabotage | null = null;
  private sabotageSeq = 0;
  private meeting: Meeting | null = null;
  private round = 0;
  private logs: LogEntry[] = [];
  private lastTick: number;
  private matchEndsAt: number;
  readonly frozenUntil: number;
  private emergencyReadyAt: number;
  private bodiesReported = 0;
  private totalKills = 0;
  private criticalWin = false;
  private result: EngineResult | null = null;
  private timing: Required<NonNullable<EngineConfig['timings']>>;
  private sealedRects: Rect[] = [];

  constructor(private cfg: EngineConfig, inits: PlayerInit[], private hooks: EngineHooks) {
    this.map = getMap(cfg.env);
    const now = hooks.now();
    this.timing = {
      discussion: DURATIONS.discussion, voting: DURATIONS.voting, results: DURATIONS.results, roleReveal: DURATIONS.roleReveal,
      ...cfg.timings,
    };
    this.startedAt = now;
    this.lastTick = now;
    this.frozenUntil = now + this.timing.roleReveal;
    this.matchEndsAt = this.frozenUntil + cfg.matchMs;
    this.emergencyReadyAt = this.frozenUntil + 15_000;

    const roles = assignRoles(inits.length, hooks.rng);
    inits.forEach((init, i) => {
      const role = roles[i]!;
      const faction = FACTION_OF[role];
      const spawn = this.spawnPoint(i, inits.length);
      const impostorSide = faction === 'impostor';
      this.players.set(init.pid, {
        ...init, role, faction, x: spawn.x, y: spawn.y, intent: { x: 0, y: 0 }, dir: 1,
        alive: true, connected: true, tasks: [], cd: {}, channel: null, challenge: null, retryAt: 0,
        emergencyLeft: 1, protectedUntil: null, protectedBy: null, lastProtectedPid: null,
        disguiseAs: null, disguiseUntil: null, investigatedRound: -1, lastRoom: roomAt(this.map, spawn.x, spawn.y),
        trapSince: null, xpKeys: new Set(),
        xp: 0, missions: 0, kills: 0, repairs: 0, saves: 0, detectiveHits: 0, sabotages: 0,
      });
      const p = this.players.get(init.pid)!;
      if (impostorSide) {
        p.cd.kill = this.frozenUntil + COOLDOWNS.killInitial;
        p.cd.sabotage = this.frozenUntil + COOLDOWNS.sabotageInitial;
      }
      p.tasks = this.pickTasks(impostorSide);
    });

    const mates = (p: P) => [...this.players.values()].filter((o) => o.faction === 'impostor' && o.pid !== p.pid).map((o) => ({ pid: o.pid, name: o.name }));
    hooks.emit({ to: 'all' }, { type: 'match_start', env: cfg.env });
    for (const p of this.players.values()) {
      hooks.emit({ to: 'pid', pid: p.pid }, { type: 'role_reveal', role: p.role, faction: p.faction, mates: p.faction === 'impostor' ? mates(p) : [] });
    }
  }

  // ---------------------------------------------------------------- setup helpers

  private spawnPoint(i: number, n: number): Vec {
    const a = (i / n) * Math.PI * 2;
    return { x: this.map.spawn.x + Math.cos(a) * 36, y: this.map.spawn.y + Math.sin(a) * 36 };
  }

  private pickTasks(decoy: boolean): Task[] {
    const ids = this.map.missions.map((m) => m.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(this.hooks.rng() * (i + 1)); [ids[i], ids[j]] = [ids[j]!, ids[i]!]; }
    return ids.slice(0, this.cfg.tasksPerPlayer).map((missionId) => ({ missionId, done: false, decoy }));
  }

  // ---------------------------------------------------------------- queries

  private get now() { return this.hooks.now(); }
  has(pid: string) { return this.players.has(pid); }
  isAlive(pid: string) { return this.players.get(pid)?.alive ?? false; }
  get meetingPhase() { return this.meeting?.phase ?? null; }
  roleOf(pid: string): Role | undefined { return this.players.get(pid)?.role; }
  livingCount(f?: Faction) { return [...this.players.values()].filter((p) => p.alive && (!f || p.faction === f)).length; }
  get ended() { return this.phase === 'ended'; }
  getResult() { return this.result; }

  progress(): number {
    let done = 0, total = 0;
    for (const p of this.players.values()) {
      if (p.faction !== 'crew') continue;
      for (const t of p.tasks) { if (t.done) { done++; total++; } else if (p.alive) total++; }
    }
    return total === 0 ? 100 : (done / total) * 100;
  }

  private appearance(p: P): { name: string; avatar: Avatar; color: string } {
    if (p.disguiseAs && p.disguiseUntil && p.disguiseUntil > this.now) {
      const t = this.players.get(p.disguiseAs);
      if (t) return { name: t.name, avatar: t.avatar, color: t.color };
    }
    return { name: p.name, avatar: p.avatar, color: p.color };
  }

  private station(id: string): StationDef | undefined { return this.map.stations.find((s) => s.id === id); }
  private get(pid: string): P {
    const p = this.players.get(pid);
    if (!p) throw new GameError('Not in this match');
    return p;
  }
  private actingPlayer(pid: string): P {
    const p = this.get(pid);
    if (this.phase !== 'playing') throw new GameError('Not possible right now');
    if (this.now < this.frozenUntil) throw new GameError('The match has not started yet');
    if (!p.alive) throw new GameError('Eliminated players cannot do that');
    return p;
  }
  private award(p: P, amount: number, reason: string, key: string) {
    if (p.xpKeys.has(key)) return;
    p.xpKeys.add(key);
    p.xp += amount;
    this.hooks.emit({ to: 'pid', pid: p.pid }, { type: 'xp', amount, reason });
  }

  // ---------------------------------------------------------------- input

  setIntent(pid: string, x: number, y: number) {
    const p = this.get(pid);
    if (this.phase !== 'playing' || this.now < this.frozenUntil || !p.alive) { p.intent = { x: 0, y: 0 }; return; }
    const m = Math.hypot(x, y);
    p.intent = m > 1 ? { x: x / m, y: y / m } : { x, y };
  }

  setConnected(pid: string, connected: boolean) {
    const p = this.players.get(pid);
    if (!p) return;
    p.connected = connected;
    if (!connected) p.intent = { x: 0, y: 0 };
  }

  /** A player who never returned within the reconnect window. */
  abandon(pid: string) {
    const p = this.players.get(pid);
    if (!p || !p.alive || this.phase === 'ended') return;
    this.eliminate(p, 'disconnect', false);
    this.checkWin();
  }

  // ---------------------------------------------------------------- missions

  private difficultyNow(): Difficulty {
    const total = this.matchEndsAt - this.frozenUntil;
    const frac = (this.now - this.frozenUntil) / total;
    return frac < 0.33 ? 1 : frac < 0.66 ? 2 : 3;
  }

  startMission(pid: string, missionId: string) {
    const p = this.actingPlayer(pid);
    if (p.challenge) throw new GameError('Finish or cancel your current mission first');
    if (this.now < p.retryAt) throw new GameError('Mission console is rebooting');
    const task = p.tasks.find((t) => t.missionId === missionId);
    if (!task) throw new GameError('That mission is not assigned to you');
    if (task.done) throw new GameError('Already completed');
    const st = this.map.stations.find((s) => s.missionId === missionId)!;
    if (dist(p, st) > RANGES.interact) throw new GameError('Move closer to the console');
    const def = this.map.missions.find((m) => m.id === missionId)!;
    const difficulty = this.difficultyNow();
    p.challenge = { missionId, startedAt: this.now, challenge: generateChallenge(def.kind, difficulty, this.hooks.rng), difficulty, decoy: task.decoy };
    p.intent = { x: 0, y: 0 };
  }

  cancelMission(pid: string) {
    const p = this.get(pid);
    p.challenge = null;
  }

  submitMission(pid: string, missionId: string, answer: ChallengeAnswer): { correct: boolean } {
    const p = this.actingPlayer(pid);
    const c = p.challenge;
    if (!c || c.missionId !== missionId) throw new GameError('No active mission');
    const st = this.map.stations.find((s) => s.missionId === missionId)!;
    if (dist(p, st) > RANGES.missionSubmit) { p.challenge = null; throw new GameError('You moved away from the console'); }
    p.challenge = null;
    const elapsed = this.now - c.startedAt;
    if (elapsed < c.challenge.minMs || !verifyAnswer(c.challenge, answer)) {
      p.retryAt = this.now + COOLDOWNS.missionRetry;
      this.hooks.emit({ to: 'pid', pid }, { type: 'mission_failed', reason: elapsed < c.challenge.minMs ? 'too_fast' : 'wrong' });
      return { correct: false };
    }
    const task = p.tasks.find((t) => t.missionId === missionId)!;
    task.done = true;
    if (!c.decoy) {
      p.missions++;
      this.award(p, XP.mission, 'Mission complete', `mission:${missionId}`);
    }
    this.hooks.emit({ to: 'pid', pid }, { type: 'mission_done', missionId });
    this.checkWin();
    return { correct: true };
  }

  // ---------------------------------------------------------------- sabotage & repair

  triggerSabotage(pid: string, sabotageId: string) {
    const p = this.actingPlayer(pid);
    if (p.faction !== 'impostor') throw new GameError('Only impostors can sabotage');
    if (this.sabotage) throw new GameError('A sabotage is already active');
    if ((p.cd.sabotage ?? 0) > this.now) throw new GameError('Sabotage is recharging');
    const def = this.map.sabotages.find((s) => s.id === sabotageId);
    if (!def) throw new GameError('Unknown sabotage');
    const rng = this.hooks.rng;
    const pickRooms = (n: number, exclude: string[] = []) => {
      const pool = this.map.rooms.filter((r) => !exclude.includes(r.id));
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
      return pool.slice(0, n);
    };
    const now = this.now;
    let sab: Sabotage;
    switch (def.kind) {
      case 'critical':
        sab = { def, endsAt: now + DURATIONS.criticalSabotage, stations: pickRooms(2).map((r) => ({ id: `rs_${r.id}`, fixed: false })) };
        break;
      case 'locked_doors': {
        const [sealed] = pickRooms(1);
        const [fix] = pickRooms(1, [sealed!.id]);
        sab = { def, endsAt: now + DURATIONS.lockedDoors, sealedRoom: sealed!.id, stations: [{ id: `rs_${fix!.id}`, fixed: false }] };
        break;
      }
      case 'env_trap': {
        const rooms = pickRooms(2);
        const traps = rooms.map((r) => this.trapSpot(r)).filter((t): t is { x: number; y: number; r: number } => !!t);
        const [fix] = pickRooms(1);
        sab = { def, endsAt: now + DURATIONS.envTrap, traps, stations: [{ id: `rs_${fix!.id}`, fixed: false }] };
        break;
      }
      default: {
        const dur = def.kind === 'lights_out' ? DURATIONS.lightsOut : def.kind === 'comms_blackout' ? DURATIONS.commsBlackout : DURATIONS.fakeAlerts;
        const [fix] = pickRooms(1);
        sab = { def, endsAt: now + dur, stations: [{ id: `rs_${fix!.id}`, fixed: false }] };
      }
    }
    this.sabotage = sab;
    this.sealedRects = sab.sealedRoom ? [this.map.rooms.find((r) => r.id === sab.sealedRoom)!] : [];
    p.cd.sabotage = now + COOLDOWNS.sabotage;
    p.sabotages++;
    if (p.sabotages <= 3) this.award(p, XP.sabotage, 'Sabotage', `sab:${++this.sabotageSeq}`);
    this.hooks.emit({ to: 'all' }, { type: 'sabotage', id: def.id, name: def.name, kind: def.kind, critical: def.kind === 'critical', endsAt: sab.endsAt });
  }

  private trapSpot(room: Rect): { x: number; y: number; r: number } | null {
    for (let i = 0; i < 40; i++) {
      const x = room.x + room.w * (0.15 + this.hooks.rng() * 0.7);
      const y = room.y + room.h * (0.2 + this.hooks.rng() * 0.6);
      const nearStation = this.map.stations.some((s) => dist(s, { x, y }) < 90);
      if (!nearStation && bodyFits(this.map, x, y, 40)) return { x, y, r: 48 };
    }
    return null;
  }

  private endSabotage(resolved: boolean) {
    if (!this.sabotage) return;
    const name = this.sabotage.def.name;
    this.sabotage = null;
    this.sealedRects = [];
    for (const p of this.players.values()) p.trapSince = null;
    this.hooks.emit({ to: 'all' }, { type: 'sabotage_end', resolved, name });
  }

  startRepair(pid: string, stationId: string) {
    const p = this.actingPlayer(pid);
    if (p.faction !== 'crew') throw new GameError('Impostors cannot repair');
    const sab = this.sabotage;
    const target = sab?.stations.find((s) => s.id === stationId && !s.fixed);
    if (!sab || !target) throw new GameError('Nothing to repair there');
    const st = this.station(stationId)!;
    if (dist(p, st) > RANGES.repair) throw new GameError('Move closer to the repair console');
    p.challenge = null;
    p.intent = { x: 0, y: 0 };
    p.channel = { stationId, endsAt: this.now + (p.role === 'engineer' ? DURATIONS.repairEngineer : DURATIONS.repairNormal) };
  }

  cancelRepair(pid: string) { this.get(pid).channel = null; }

  private finishRepair(p: P) {
    const ch = p.channel!;
    p.channel = null;
    const sab = this.sabotage;
    const target = sab?.stations.find((s) => s.id === ch.stationId && !s.fixed);
    if (!sab || !target) return;
    target.fixed = true;
    p.repairs++;
    this.award(p, XP.repair, 'Repair', `repair:${this.sabotageSeq}:${ch.stationId}`);
    this.hooks.emit({ to: 'all' }, { type: 'repair_done', stationId: ch.stationId });
    if (sab.stations.every((s) => s.fixed)) this.endSabotage(true);
  }

  // ---------------------------------------------------------------- abilities

  useAbility(pid: string, a: { ability: string; targetPid?: string; roomId?: string; stationId?: string }): unknown {
    const p = this.actingPlayer(pid);
    const now = this.now;
    const ready = (k: string) => { if ((p.cd[k] ?? 0) > now) throw new GameError('Ability is recharging'); };
    const target = () => {
      if (!a.targetPid || a.targetPid === pid) throw new GameError('Choose another player');
      const t = this.players.get(a.targetPid);
      if (!t || !t.alive) throw new GameError('Invalid target');
      return t;
    };
    const inRange = (t: P, r: number) => { if (dist(p, t) > r) throw new GameError('Target is out of range'); };
    const needRole = (...roles: Role[]) => { if (!roles.includes(p.role)) throw new GameError('Your role cannot do that'); };

    switch (a.ability) {
      case 'kill': {
        needRole('impostor', 'shapeshifter');
        ready('kill');
        const t = target();
        if (t.faction === 'impostor') throw new GameError('You cannot eliminate your ally');
        inRange(t, RANGES.kill);
        p.cd.kill = now + COOLDOWNS.kill;
        if (t.protectedUntil && t.protectedUntil > now) {
          const medic = t.protectedBy ? this.players.get(t.protectedBy) : undefined;
          t.protectedUntil = null; t.protectedBy = null;
          this.hooks.emit({ to: 'pid', pid }, { type: 'kill_blocked', reason: 'protected' });
          if (medic) {
            medic.saves++;
            this.award(medic, XP.protectSave, 'Protected a crewmate', `save:${medic.saves}`);
            this.hooks.emit({ to: 'pid', pid: medic.pid }, { type: 'protect_saved', targetName: t.name });
          }
          return { blocked: true };
        }
        const victimName = t.name;
        this.eliminate(t, 'eliminated', true);
        p.kills++; this.totalKills++;
        this.award(p, XP.kill, 'Elimination', `kill:${t.pid}`);
        this.hooks.emit({ to: 'pid', pid }, { type: 'kill_ok', victimName });
        this.checkWin();
        return { blocked: false };
      }
      case 'investigate': {
        needRole('detective');
        ready('investigate');
        if (p.investigatedRound === this.round) throw new GameError('You already investigated this round');
        const t = target();
        inRange(t, RANGES.investigate);
        p.investigatedRound = this.round;
        p.cd.investigate = now + COOLDOWNS.investigate;
        const suspicious = t.faction === 'impostor' ? this.hooks.rng() < 0.8 : this.hooks.rng() < 0.15;
        if (t.faction === 'impostor' && suspicious) p.detectiveHits++;
        this.award(p, XP.investigate, 'Investigation', `inv:${this.round}`);
        const data = { targetName: this.appearance(t).name, suspicious };
        this.hooks.emit({ to: 'pid', pid }, { type: 'ability_result', ability: 'investigate', data });
        return data;
      }
      case 'protect': {
        needRole('medic');
        ready('protect');
        const t = target();
        inRange(t, RANGES.protect);
        if (p.lastProtectedPid === t.pid) throw new GameError('You cannot protect the same player twice in a row');
        t.protectedUntil = now + DURATIONS.protection; t.protectedBy = pid;
        p.lastProtectedPid = t.pid;
        p.cd.protect = now + COOLDOWNS.protect;
        const data = { targetName: this.appearance(t).name, until: t.protectedUntil };
        this.hooks.emit({ to: 'pid', pid }, { type: 'ability_result', ability: 'protect', data });
        return data;
      }
      case 'inspect': {
        needRole('engineer');
        ready('inspect');
        const st = a.stationId ? this.station(a.stationId) : undefined;
        if (!st || st.type !== 'repair') throw new GameError('Inspect a repair console');
        if (dist(p, st) > RANGES.inspect) throw new GameError('Move closer to the equipment');
        p.cd.inspect = now + COOLDOWNS.inspect;
        const sab = this.sabotage;
        const entry = sab?.stations.find((s) => s.id === st.id);
        const data = {
          station: st.id, room: this.map.rooms.find((r) => r.id === st.room)?.name,
          status: entry && !entry.fixed ? 'damaged' : 'operational',
          sabotage: sab ? {
            name: sab.def.name, remainingMs: Math.max(0, sab.endsAt - now),
            remaining: sab.stations.filter((s) => !s.fixed).map((s) => this.map.rooms.find((r) => `rs_${r.id}` === s.id)?.name),
          } : null,
        };
        this.hooks.emit({ to: 'pid', pid }, { type: 'ability_result', ability: 'inspect', data });
        return data;
      }
      case 'check_logs': {
        needRole('security');
        ready('check_logs');
        const st = this.station('security')!;
        if (dist(p, st) > RANGES.inspect) throw new GameError('Go to the security console');
        if (this.sabotage && (this.sabotage.def.kind === 'lights_out' || this.sabotage.def.kind === 'comms_blackout')) throw new GameError('Monitoring systems are offline');
        p.cd.check_logs = now + COOLDOWNS.logs;
        const entries = this.logs.filter((l) => l.t >= now - DURATIONS.logWindow).slice(-12)
          .map((l) => ({ agoSec: Math.round((now - l.t) / 1000), name: l.name, room: l.room }));
        const data = { entries };
        this.hooks.emit({ to: 'pid', pid }, { type: 'ability_result', ability: 'check_logs', data });
        return data;
      }
      case 'disguise': {
        needRole('shapeshifter');
        ready('disguise');
        const t = target();
        inRange(t, RANGES.disguise);
        p.disguiseAs = t.pid; p.disguiseUntil = now + DURATIONS.disguise;
        p.cd.disguise = now + COOLDOWNS.disguise;
        const data = { as: t.name, until: p.disguiseUntil };
        this.hooks.emit({ to: 'pid', pid }, { type: 'ability_result', ability: 'disguise', data });
        return data;
      }
      case 'plant_evidence': {
        needRole('shapeshifter');
        ready('plant_evidence');
        const t = target();
        if (t.faction === 'impostor') throw new GameError('Choose a crew member to frame');
        p.cd.plant_evidence = now + COOLDOWNS.plantEvidence;
        const room = this.nearestRoom(p);
        this.pushLog({ t: now, name: this.appearance(t).name, room: room.name });
        const data = { framed: t.name, room: room.name };
        this.hooks.emit({ to: 'pid', pid }, { type: 'ability_result', ability: 'plant_evidence', data });
        return data;
      }
      case 'distract': {
        needRole('impostor', 'shapeshifter');
        ready('distract');
        const room = this.map.rooms.find((r) => r.id === a.roomId);
        if (!room) throw new GameError('Choose a room');
        p.cd.distract = now + COOLDOWNS.distract;
        this.hooks.emit({ to: 'all' }, { type: 'noise', room: room.name, x: room.x + room.w / 2, y: room.y + room.h / 2 });
        return { room: room.name };
      }
      default:
        throw new GameError('Unknown ability');
    }
  }

  private nearestRoom(p: Vec) {
    return this.map.rooms.reduce((best, r) => (dist(p, { x: r.x + r.w / 2, y: r.y + r.h / 2 }) < dist(p, { x: best.x + best.w / 2, y: best.y + best.h / 2 }) ? r : best));
  }

  private pushLog(l: LogEntry) { this.logs.push(l); if (this.logs.length > 80) this.logs.shift(); }

  // ---------------------------------------------------------------- elimination

  private eliminate(p: P, cause: 'eliminated' | 'trap' | 'voted' | 'disconnect', leaveBody: boolean) {
    p.alive = false;
    p.intent = { x: 0, y: 0 };
    p.channel = null; p.challenge = null; p.protectedUntil = null; p.trapSince = null;
    if (leaveBody) {
      this.bodies.push({ id: `body${++this.bodySeq}`, x: p.x, y: p.y, victimPid: p.pid });
      this.hooks.emit({ to: 'near', x: p.x, y: p.y, r: RANGES.scream }, { type: 'scream', x: p.x, y: p.y });
    }
    this.hooks.emit({ to: 'pid', pid: p.pid }, { type: 'you_died', cause });
  }

  // ---------------------------------------------------------------- meetings

  reportBody(pid: string, bodyId: string) {
    const p = this.actingPlayer(pid);
    const body = this.bodies.find((b) => b.id === bodyId);
    if (!body) throw new GameError('No such body');
    if (dist(p, body) > RANGES.report) throw new GameError('Move closer to the body');
    this.bodiesReported++;
    this.award(p, XP.reportBody, 'Reported a body', `rep:${bodyId}`);
    this.startMeeting('body', p, this.players.get(body.victimPid)!.name);
  }

  callEmergency(pid: string) {
    const p = this.actingPlayer(pid);
    if (p.emergencyLeft <= 0) throw new GameError('You have no emergency meetings left');
    if (this.now < this.emergencyReadyAt) throw new GameError('The emergency button is recharging');
    if (this.sabotage?.def.kind === 'critical') throw new GameError('Emergency button disabled during a critical sabotage');
    if (dist(p, this.station('emergency')!) > RANGES.interact) throw new GameError('Go to the emergency button');
    p.emergencyLeft--;
    this.startMeeting('emergency', p);
  }

  private startMeeting(reason: 'body' | 'emergency', caller: P, bodyName?: string) {
    const now = this.now;
    this.phase = 'meeting';
    this.meeting = { phase: 'discussion', startedAt: now, endsAt: now + this.timing.discussion, callerPid: caller.pid, reason, bodyName, votes: new Map() };
    for (const p of this.players.values()) {
      p.intent = { x: 0, y: 0 }; p.channel = null; p.challenge = null; p.disguiseAs = null; p.disguiseUntil = null; p.trapSince = null;
    }
    if (this.sabotage && this.sabotage.def.kind !== 'critical') this.endSabotage(false);
    this.hooks.emit({ to: 'all' }, { type: 'meeting_start', reason, callerName: caller.name, bodyName });
  }

  vote(pid: string, target: string) {
    const p = this.get(pid);
    const m = this.meeting;
    if (this.phase !== 'meeting' || !m || m.phase !== 'voting') throw new GameError('Voting is not open');
    if (!p.alive) throw new GameError('Eliminated players cannot vote');
    if (m.votes.has(pid)) throw new GameError('You already voted');
    if (target !== 'skip') {
      const t = this.players.get(target);
      if (!t || !t.alive) throw new GameError('Invalid vote target');
      if (target === pid) throw new GameError('You cannot vote for yourself');
    }
    m.votes.set(pid, target);
    this.hooks.emit({ to: 'all' }, { type: 'vote_cast', pid });
    this.maybeCloseVoting();
  }

  private maybeCloseVoting() {
    const m = this.meeting;
    if (!m || m.phase !== 'voting') return;
    const voters = [...this.players.values()].filter((p) => p.alive && p.connected);
    if (voters.every((p) => m.votes.has(p.pid))) this.resolveVotes();
  }

  private resolveVotes() {
    const m = this.meeting!;
    const tally: Record<string, number> = {};
    const votes: { voter: string; target: string }[] = [];
    for (const [voter, target] of m.votes) { tally[target] = (tally[target] ?? 0) + 1; votes.push({ voter, target }); }
    const top = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter((k) => tally[k] === top);
    const tie = leaders.length > 1;
    const skipTop = !tie && leaders[0] === 'skip';
    const ejectedPid = top > 0 && !tie && !skipTop ? leaders[0]! : null;
    m.results = { tally, votes, ejected: ejectedPid, tie, skipTop };
    m.phase = 'results';
    m.endsAt = this.now + this.timing.results;
    let ejectedName: string | null = null;
    if (ejectedPid) {
      const e = this.players.get(ejectedPid)!;
      ejectedName = e.name;
      for (const v of votes) {
        const voter = this.players.get(v.voter)!;
        if (v.target === ejectedPid && e.faction === 'impostor') this.award(voter, XP.correctVote, 'Voted out an impostor', `vote:${ejectedPid}`);
      }
      this.eliminate(e, 'voted', false);
    }
    this.hooks.emit({ to: 'all' }, { type: 'meeting_results', ejectedName, tie });
  }

  private endMeeting() {
    const m = this.meeting!;
    const now = this.now;
    const length = now - m.startedAt;
    this.meeting = null;
    this.phase = 'playing';
    this.round++;
    this.bodies = [];
    this.matchEndsAt += length;
    if (this.sabotage) this.sabotage.endsAt += length;
    this.emergencyReadyAt = now + COOLDOWNS.emergencyAfterMeeting;
    const living = [...this.players.values()].filter((p) => p.alive);
    living.forEach((p, i) => {
      const s = this.spawnPoint(i, living.length);
      p.x = s.x; p.y = s.y; p.lastRoom = roomAt(this.map, s.x, s.y);
      p.protectedUntil = null; p.protectedBy = null;
      if (p.faction === 'impostor') p.cd.kill = Math.max(p.cd.kill ?? 0, now + COOLDOWNS.killInitial);
    });
    this.checkWin();
  }

  // ---------------------------------------------------------------- win conditions

  private checkWin() {
    if (this.phase === 'ended') return;
    const impostors = this.livingCount('impostor');
    const crew = this.livingCount('crew');
    if (impostors === 0) return this.end('crew', 'impostors_voted');
    if (this.progress() >= this.cfg.threshold) return this.end('crew', 'missions');
    if (impostors >= crew) return this.end('impostor', 'parity');
    if (this.sabotage?.def.kind === 'critical' && this.phase === 'playing' && this.now >= this.sabotage.endsAt) {
      this.criticalWin = true;
      return this.end('impostor', 'sabotage');
    }
    if (this.phase === 'playing' && this.now >= this.matchEndsAt) return this.end('impostor', 'timer');
  }

  private end(winner: Faction, reason: GameSummary['reason']) {
    this.phase = 'ended';
    this.meeting = null;
    for (const p of this.players.values()) { p.intent = { x: 0, y: 0 }; p.channel = null; p.challenge = null; }
    const progress = this.progress();
    for (const p of this.players.values()) {
      const won = p.faction === winner;
      if (p.alive) this.award(p, XP.survive, 'Survived', 'survive');
      this.award(p, won ? XP.win : XP.loss, won ? 'Victory' : 'Participation', 'result');
    }
    const aliveCrew = this.livingCount('crew');
    const kills = this.totalKills;
    const teamScore = winner === 'crew' ? Math.round(progress * 5 + aliveCrew * 40 + 200) : Math.round(kills * 100 + this.livingCount('impostor') * 50 + 200);
    const players = [...this.players.values()];
    const summary: GameSummary = {
      winner, reason, teamScore, progress: Math.round(progress),
      durationSec: Math.round((this.now - this.startedAt) / 1000),
      players: players.map((p) => ({
        pid: p.pid, name: p.name, color: p.color, avatar: p.avatar, role: p.role, faction: p.faction,
        alive: p.alive, xp: p.xp, missions: p.missions, kills: p.kills, won: p.faction === winner,
      })),
    };
    this.result = {
      summary, startedAt: this.startedAt, criticalWin: this.criticalWin && winner === 'impostor',
      bodiesReported: this.bodiesReported, totalKills: this.totalKills,
      players: players.map((p) => ({
        pid: p.pid, guestId: p.guestId, name: p.name, role: p.role, faction: p.faction, alive: p.alive, won: p.faction === winner,
        xp: p.xp, missions: p.missions, kills: p.kills, repairs: p.repairs, saves: p.saves, detectiveHits: p.detectiveHits, sabotages: p.sabotages,
      })),
    };
    this.hooks.emit({ to: 'all' }, { type: 'game_over', summary });
    this.hooks.onEnd?.(this.result);
  }

  // ---------------------------------------------------------------- simulation

  tick() {
    const now = this.now;
    const dt = Math.min((now - this.lastTick) / 1000, TICK_MS * 2 / 1000);
    this.lastTick = now;
    if (this.phase === 'ended') return;

    if (this.phase === 'meeting') {
      const m = this.meeting!;
      if (now >= m.endsAt) {
        if (m.phase === 'discussion') { m.phase = 'voting'; m.endsAt = now + this.timing.voting; }
        else if (m.phase === 'voting') this.resolveVotes();
        else this.endMeeting();
      } else if (m.phase === 'voting') this.maybeCloseVoting();
      return;
    }

    if (now < this.frozenUntil) return;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const moving = Math.hypot(p.intent.x, p.intent.y) > 0.01;
      if (moving) {
        if (p.channel) p.channel = null;
        if (p.challenge) p.challenge = null;
        const next = stepMove(this.map, p, p.intent, dt, this.sealedRects);
        if (next.x !== p.x || next.y !== p.y) {
          if (next.x !== p.x) p.dir = next.x > p.x ? 1 : -1;
          p.x = next.x; p.y = next.y;
          const room = roomAt(this.map, p.x, p.y);
          if (room && room !== p.lastRoom) {
            p.lastRoom = room;
            this.pushLog({ t: now, name: this.appearance(p).name, room: this.map.rooms.find((r) => r.id === room)!.name });
          }
        }
      }
      if (p.channel && now >= p.channel.endsAt) this.finishRepair(p);
      if (p.protectedUntil && p.protectedUntil <= now) { p.protectedUntil = null; p.protectedBy = null; }
      if (p.disguiseUntil && p.disguiseUntil <= now) { p.disguiseAs = null; p.disguiseUntil = null; }
    }

    const sab = this.sabotage;
    if (sab) {
      if (sab.traps) {
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          const inTrap = sab.traps.some((t) => dist(p, t) < t.r);
          if (!inTrap) { p.trapSince = null; continue; }
          p.trapSince ??= now;
          if (now - p.trapSince >= DURATIONS.trapKill) {
            this.eliminate(p, 'trap', true);
            this.hooks.emit({ to: 'all' }, { type: 'env_death', name: p.name });
          }
        }
      }
      if (sab.def.kind !== 'critical' && now >= sab.endsAt) this.endSabotage(false);
    }
    this.checkWin();
  }

  // ---------------------------------------------------------------- views

  snapshotFor(pid: string): GameSnapshot {
    const me = this.get(pid);
    const now = this.now;
    const sab = this.sabotage;
    const spectator = !me.alive;
    const seesAll = spectator || me.faction === 'impostor' || this.phase !== 'playing' || sab?.def.kind !== 'lights_out';
    const visible = (o: Vec) => seesAll || o === me || dist(me, o) <= RANGES.lightsOutVision;
    const showDisguise = me.faction === 'impostor';

    const players: PublicPlayer[] = [];
    for (const p of this.players.values()) {
      if (p.pid !== pid && !visible(p)) continue;
      if (!p.alive && this.phase === 'playing' && p.pid !== pid && !spectator) continue; // ghosts are hidden from the living
      const look = this.appearance(p);
      players.push({
        pid: p.pid, ...look, x: p.x, y: p.y, dir: p.dir,
        anim: !p.alive ? 'dead' : p.channel ? 'channel' : Math.hypot(p.intent.x, p.intent.y) > 0.01 ? 'walk' : 'idle',
        alive: p.alive, connected: p.connected,
        disguised: showDisguise && p.pid === pid && !!p.disguiseAs,
        // only the medic sees the shield on their protectee
        protectedFx: me.role === 'medic' && p.protectedBy === pid && !!p.protectedUntil && p.protectedUntil > now,
      });
    }
    const bodies = this.bodies.filter((b) => visible(b)).map((b) => {
      const v = this.players.get(b.victimPid)!;
      return { id: b.id, x: b.x, y: b.y, victimPid: v.pid, name: v.name, color: v.color };
    });

    let progress: number | null = this.progress();
    if (!spectator && me.faction === 'crew' && sab) {
      if (sab.def.kind === 'comms_blackout') progress = null;
      else if (sab.def.kind === 'fake_alerts') progress = Math.min(100, progress + 25);
    }

    const sabView: SabotageView | null = sab ? {
      id: sab.def.id, name: sab.def.name, kind: sab.def.kind, critical: sab.def.kind === 'critical', endsAt: sab.endsAt,
      stations: sab.stations.map((s) => { const st = this.station(s.id)!; return { id: s.id, x: st.x, y: st.y, fixed: s.fixed }; }),
      sealedRoom: sab.sealedRoom, traps: sab.traps,
    } : null;

    const m = this.meeting;
    const meeting: MeetingView | null = m ? {
      phase: m.phase, endsAt: m.endsAt, callerPid: m.callerPid, reason: m.reason, bodyName: m.bodyName,
      voted: [...m.votes.keys()], results: m.phase === 'results' ? m.results : undefined,
    } : null;

    const abilityKeys = this.abilityKeys(me.role);
    const you: PrivateState = {
      pid, role: me.role, faction: me.faction, alive: me.alive,
      tasks: me.tasks.map((t) => {
        const def = this.map.missions.find((x) => x.id === t.missionId)!;
        const st = this.map.stations.find((s) => s.missionId === t.missionId)!;
        return { missionId: t.missionId, name: def.name, category: def.category, room: this.map.rooms.find((r) => r.id === def.room)!.name, done: t.done, decoy: t.decoy, x: st.x, y: st.y };
      }),
      cooldowns: Object.fromEntries(abilityKeys.map((k) => [k, me.cd[k] ?? 0])),
      mates: me.faction === 'impostor' ? [...this.players.values()].filter((o) => o.faction === 'impostor' && o.pid !== pid).map((o) => ({ pid: o.pid, name: o.name })) : [],
      channel: me.channel ? { kind: 'repair', stationId: me.channel.stationId, endsAt: me.channel.endsAt } : null,
      emergencyLeft: me.emergencyLeft,
      protectedUntil: me.role === 'medic' ? this.medicTargetUntil(me) : null,
      disguiseUntil: me.disguiseUntil,
      mission: me.challenge ? { missionId: me.challenge.missionId, difficulty: me.challenge.difficulty, startedAt: me.challenge.startedAt, payload: me.challenge.challenge.payload, decoy: me.challenge.decoy } : null,
    };

    return {
      now, phase: this.phase, env: this.cfg.env, players, bodies, progress, threshold: this.cfg.threshold,
      endsAt: this.matchEndsAt, sabotage: sabView,
      commsBlackout: !spectator && me.faction === 'crew' && sab?.def.kind === 'comms_blackout',
      lightsOut: !seesAll, meeting, you, spectating: spectator, frozenUntil: this.frozenUntil,
    };
  }

  private medicTargetUntil(medic: P): number | null {
    const t = medic.lastProtectedPid ? this.players.get(medic.lastProtectedPid) : undefined;
    return t?.protectedBy === medic.pid && t.protectedUntil ? t.protectedUntil : null;
  }

  private abilityKeys(role: Role): string[] {
    switch (role) {
      case 'impostor': return ['kill', 'sabotage', 'distract'];
      case 'shapeshifter': return ['kill', 'sabotage', 'distract', 'disguise', 'plant_evidence'];
      case 'detective': return ['investigate'];
      case 'medic': return ['protect'];
      case 'engineer': return ['inspect'];
      case 'security': return ['check_logs'];
      default: return [];
    }
  }

  /** Test/diagnostic helper: positions are server truth. */
  debugPlayer(pid: string) { const p = this.get(pid); return { x: p.x, y: p.y, role: p.role, alive: p.alive }; }
  /** Used only by tests to put a player somewhere valid. */
  debugTeleport(pid: string, x: number, y: number) { const p = this.get(pid); p.x = x; p.y = y; }
}
