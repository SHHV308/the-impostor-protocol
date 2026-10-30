import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  ENVIRONMENTS, MAX_PLAYERS, MIN_PLAYERS, PLAYER_COLORS, RECONNECT_GRACE_MS, S2C, dist,
} from '@impostor/shared';
import type { Avatar, ChatMessage, EnvironmentId, GameEvent, LobbyPlayer, RoomState, Settings } from '@impostor/shared';
import { GameEngine, GameError, type EngineResult, type PlayerInit, type Target } from './game/engine.js';
import type { Store } from './store/types.js';

export class RoomError extends Error {}

export interface RoomDeps {
  io: Server;
  store: Store;
  now: () => number;
  rng: () => number;
  fastTimers: boolean;
  onClose: (code: string) => void;
}

interface Member {
  pid: string; guestId: string; name: string; avatar: Avatar; color: string;
  ready: boolean; socketId: string | null; connected: boolean; left: boolean;
  graceTimer: NodeJS.Timeout | null;
  chatTimes: number[];
}

const DEFAULT_SETTINGS: Settings = { environment: 'random', matchMinutes: 12, missionThreshold: 100, tasksPerPlayer: 5, isPublic: false };
const norm = (s: string) => s.trim().toLowerCase();

export class Room {
  readonly code: string;
  phase: RoomState['phase'] = 'lobby';
  settings: Settings;
  hostPid = '';
  lastActivity: number;
  private members = new Map<string, Member>();
  private engine: GameEngine | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private chatLog: ChatMessage[] = [];
  private startedAt = 0;
  private env: EnvironmentId = 'space';

  constructor(code: string, isPublic: boolean, private d: RoomDeps) {
    this.code = code;
    this.settings = { ...DEFAULT_SETTINGS, isPublic };
    this.lastActivity = d.now();
  }

  // ---------------------------------------------------------------- membership

  get size() { return [...this.members.values()].filter((m) => !m.left).length; }
  get isFull() { return this.size >= MAX_PLAYERS; }
  get hasConnected() { return [...this.members.values()].some((m) => m.connected && !m.left); }
  get hostConnected() { return this.members.get(this.hostPid)?.connected ?? false; }
  memberByGuest(guestId: string) { return [...this.members.values()].find((m) => m.guestId === guestId && !m.left); }
  private touch() { this.lastActivity = this.d.now(); }

  /** Validate that a brand-new player may join with this name. */
  canJoin(name: string, guestId: string): void {
    if (this.memberByGuest(guestId)) return;
    if (this.phase !== 'lobby') throw new RoomError('That match is already in progress');
    if (this.isFull) throw new RoomError('That room is full');
    if ([...this.members.values()].some((m) => !m.left && norm(m.name) === norm(name))) throw new RoomError('That name is already taken in this room');
  }

  join(guestId: string, name: string, avatar: Avatar, socketId: string): Member {
    const existing = this.memberByGuest(guestId);
    if (existing) { this.attach(existing, socketId); return existing; }
    this.canJoin(name, guestId);
    const used = new Set([...this.members.values()].filter((m) => !m.left).map((m) => m.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    const m: Member = {
      pid: randomUUID().slice(0, 8), guestId, name, avatar, color, ready: false, socketId, connected: true, left: false,
      graceTimer: null, chatTimes: [],
    };
    this.members.set(m.pid, m);
    if (!this.hostPid) this.hostPid = m.pid;
    this.touch();
    this.sendJoinState(m);
    this.broadcastState();
    this.systemChat(`${m.name} joined`);
    return m;
  }

  /** (Re)connect a socket to an existing member, e.g. after a refresh or network drop. */
  attach(m: Member, socketId: string) {
    if (m.graceTimer) { clearTimeout(m.graceTimer); m.graceTimer = null; }
    m.socketId = socketId;
    m.connected = true;
    this.engine?.setConnected(m.pid, true);
    this.touch();
    this.sendJoinState(m);
    this.broadcastState();
  }

  private sendJoinState(m: Member) {
    if (!m.socketId) return;
    this.d.io.to(m.socketId).emit(S2C.roomState, this.stateFor(m));
    for (const c of this.chatLog.slice(-30)) this.d.io.to(m.socketId).emit(S2C.chat, c);
    if (this.engine) this.sendSnapshot(m);
  }

  onSocketDisconnect(socketId: string) {
    const m = [...this.members.values()].find((x) => x.socketId === socketId);
    if (!m || m.left) return;
    m.connected = false; m.socketId = null;
    this.engine?.setConnected(m.pid, false);
    if (m.pid === this.hostPid) this.transferHost();
    this.broadcastState();
    m.graceTimer = setTimeout(() => this.expire(m), RECONNECT_GRACE_MS);
  }

  private expire(m: Member) {
    m.graceTimer = null;
    if (m.connected) return;
    this.remove(m, 'disconnect');
  }

  leave(pid: string) {
    const m = this.members.get(pid);
    if (m) this.remove(m, 'left');
  }

  private remove(m: Member, why: 'left' | 'disconnect') {
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.connected = false;
    if (this.phase === 'playing') {
      m.left = true; m.socketId = null;
      this.engine?.abandon(m.pid);
    } else {
      this.members.delete(m.pid);
    }
    if (why === 'left') this.systemChat(`${m.name} left`);
    if (m.pid === this.hostPid) this.transferHost();
    if (!this.hasConnected) this.d.onClose(this.code);
    this.broadcastState();
  }

  private transferHost() {
    const next = [...this.members.values()].find((m) => m.connected && !m.left && m.pid !== this.hostPid);
    if (!next) return;
    this.hostPid = next.pid;
    next.ready = true;
    this.systemChat(`${next.name} is now the host`);
  }

  // ---------------------------------------------------------------- lobby actions

  private requireMember(pid: string): Member {
    const m = this.members.get(pid);
    if (!m || m.left) throw new RoomError('You are not in this room');
    return m;
  }
  private requireHost(pid: string) { if (pid !== this.hostPid) throw new RoomError('Only the host can do that'); }

  updateSettings(pid: string, patch: Partial<Settings>) {
    this.requireMember(pid); this.requireHost(pid);
    if (this.phase !== 'lobby') throw new RoomError('Settings are locked during a match');
    this.settings = { ...this.settings, ...patch };
    this.touch(); this.broadcastState();
  }

  setReady(pid: string, ready: boolean) {
    const m = this.requireMember(pid);
    if (this.phase !== 'lobby') throw new RoomError('Not in the lobby');
    m.ready = ready; this.touch(); this.broadcastState();
  }

  setProfile(pid: string, name: string, avatar: Avatar) {
    const m = this.requireMember(pid);
    if (this.phase !== 'lobby') throw new RoomError('You can only change your look in the lobby');
    if ([...this.members.values()].some((o) => o.pid !== pid && !o.left && norm(o.name) === norm(name))) throw new RoomError('That name is already taken in this room');
    m.name = name; m.avatar = avatar; this.touch(); this.broadcastState();
  }

  start(pid: string) {
    this.requireMember(pid); this.requireHost(pid);
    if (this.phase !== 'lobby') throw new RoomError('A match is already running');
    const active = [...this.members.values()].filter((m) => !m.left);
    if (active.length < MIN_PLAYERS) throw new RoomError(`At least ${MIN_PLAYERS} players are needed`);
    if (active.some((m) => !m.connected)) throw new RoomError('Waiting for a disconnected player');
    if (active.some((m) => m.pid !== this.hostPid && !m.ready)) throw new RoomError('Everyone must be ready');

    this.env = this.settings.environment === 'random'
      ? ENVIRONMENTS[Math.floor(this.d.rng() * ENVIRONMENTS.length)]!
      : this.settings.environment;
    const inits: PlayerInit[] = active.map((m) => ({ pid: m.pid, guestId: m.guestId, name: m.name, avatar: m.avatar, color: m.color }));
    this.startedAt = this.d.now();
    const fast = this.d.fastTimers;
    this.phase = 'playing';
    this.chatLog = [];
    this.engine = new GameEngine(
      {
        env: this.env, matchMs: this.settings.matchMinutes * 60_000, threshold: this.settings.missionThreshold,
        tasksPerPlayer: this.settings.tasksPerPlayer,
        timings: fast ? { discussion: 4000, voting: 15_000, results: 3000, roleReveal: 1500 } : undefined,
      },
      inits,
      { now: this.d.now, rng: this.d.rng, emit: (t, e) => this.route(t, e), onEnd: (r) => void this.finish(r) },
    );
    this.tickTimer = setInterval(() => this.tick(), 50);
    this.touch();
    this.broadcastState();
  }

  rematch(pid: string) {
    this.requireMember(pid); this.requireHost(pid);
    if (this.phase !== 'ended') throw new RoomError('The match is not over');
    for (const m of [...this.members.values()]) {
      if (!m.connected || m.left) { if (m.graceTimer) clearTimeout(m.graceTimer); this.members.delete(m.pid); } else m.ready = m.pid === this.hostPid;
    }
    this.engine = null;
    this.phase = 'lobby';
    this.chatLog = [];
    this.touch(); this.broadcastState();
  }

  // ---------------------------------------------------------------- game plumbing

  private tick() {
    const e = this.engine;
    if (!e) return;
    try { e.tick(); } catch (err) { console.error('engine tick failed', err); }
    for (const m of this.members.values()) if (m.connected && m.socketId && e.has(m.pid)) this.sendSnapshot(m);
    if (e.ended && this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  private sendSnapshot(m: Member) {
    if (!this.engine || !this.engine.has(m.pid) || !m.socketId) return;
    const snap = this.engine.snapshotFor(m.pid);
    // 20Hz state is disposable, but the closing snapshot has nothing after it to repair a drop
    (this.engine.ended ? this.d.io.to(m.socketId) : this.d.io.to(m.socketId).volatile).emit(S2C.snapshot, snap);
  }

  private route(target: Target, event: GameEvent) {
    const e = this.engine;
    const send = (m: Member) => { if (m.socketId) this.d.io.to(m.socketId).emit(S2C.event, event); };
    for (const m of this.members.values()) {
      if (!m.connected) continue;
      switch (target.to) {
        case 'all': send(m); break;
        case 'pid': if (m.pid === target.pid) send(m); break;
        case 'impostors': if (e?.roleOf(m.pid) === 'impostor' || e?.roleOf(m.pid) === 'shapeshifter') send(m); break;
        case 'near': {
          const p = e?.has(m.pid) ? e.debugPlayer(m.pid) : null;
          if (p && (!p.alive || dist(p, target) <= target.r)) send(m);
          break;
        }
      }
    }
  }

  private async finish(r: EngineResult) {
    this.phase = 'ended';
    this.broadcastState();
    try {
      const unlocked = await this.d.store.recordMatch({
        roomCode: this.code, environment: this.env, winner: r.summary.winner, reason: r.summary.reason,
        durationSec: r.summary.durationSec, teamScore: r.summary.teamScore, startedAt: new Date(r.startedAt),
        criticalWin: r.criticalWin, bodiesReported: r.bodiesReported, totalKills: r.totalKills, players: r.players,
      });
      for (const p of r.players) {
        const keys = unlocked.get(p.guestId) ?? [];
        const m = this.members.get(p.pid);
        if (!m?.socketId) continue;
        for (const key of keys) this.d.io.to(m.socketId).emit(S2C.event, { type: 'achievement', key, title: key } satisfies GameEvent);
      }
    } catch (err) {
      console.error('failed to persist match', err);
    }
  }

  // ---------------------------------------------------------------- input from sockets

  input(pid: string, x: number, y: number) { this.requireMember(pid); this.engine?.setIntent(pid, x, y); this.touch(); }
  get game(): GameEngine { if (!this.engine || this.phase !== 'playing') throw new GameError('No match is running'); return this.engine; }

  chat(pid: string, text: string) {
    const m = this.requireMember(pid);
    const now = this.d.now();
    m.chatTimes = m.chatTimes.filter((t) => now - t < 5000);
    if (m.chatTimes.length >= 5) throw new RoomError('You are sending messages too quickly');
    m.chatTimes.push(now);

    let channel: ChatMessage['channel'] = 'room';
    if (this.phase === 'playing' && this.engine) {
      const alive = this.engine.isAlive(pid);
      if (!alive) channel = 'spectator';
      else if (this.engine.meetingPhase === 'discussion' || this.engine.meetingPhase === 'voting') channel = 'meeting';
      else throw new RoomError('Chat is only open during meetings');
    }
    const msg: ChatMessage = { id: randomUUID().slice(0, 8), pid, name: m.name, color: m.color, text, t: now, channel };
    if (channel === 'room') this.chatLog.push(msg);
    if (this.chatLog.length > 80) this.chatLog.shift();
    for (const o of this.members.values()) {
      if (!o.socketId) continue;
      // spectator messages only reach other spectators
      if (channel === 'spectator' && this.engine?.isAlive(o.pid)) continue;
      this.d.io.to(o.socketId).emit(S2C.chat, msg);
    }
    this.touch();
  }

  private systemChat(text: string) {
    if (this.phase === 'playing') return;
    const msg: ChatMessage = { id: randomUUID().slice(0, 8), pid: '', name: 'System', color: '#94a3b8', text, t: this.d.now(), channel: 'system' };
    this.chatLog.push(msg);
    for (const o of this.members.values()) if (o.socketId) this.d.io.to(o.socketId).emit(S2C.chat, msg);
  }

  // ---------------------------------------------------------------- state

  private stateFor(viewer: Member): RoomState {
    const players: LobbyPlayer[] = [...this.members.values()].filter((m) => !m.left).map((m) => ({
      pid: m.pid, name: m.name, avatar: m.avatar, color: m.color, ready: m.ready, isHost: m.pid === this.hostPid, connected: m.connected,
    }));
    return {
      code: this.code, phase: this.phase, settings: this.settings, players, hostPid: this.hostPid,
      youPid: viewer.pid, maxPlayers: MAX_PLAYERS, minPlayers: MIN_PLAYERS,
    };
  }

  broadcastState() {
    for (const m of this.members.values()) if (m.socketId && m.connected) this.d.io.to(m.socketId).emit(S2C.roomState, this.stateFor(m));
  }

  /** Tell everyone the room is gone and stop timers. */
  close(reason: string) {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const m of this.members.values()) {
      if (m.graceTimer) clearTimeout(m.graceTimer);
      if (m.socketId) this.d.io.to(m.socketId).emit(S2C.kicked, reason);
    }
    this.members.clear();
  }

  guestIds(): string[] { return [...this.members.values()].filter((m) => !m.left).map((m) => m.guestId); }
  get publicOpen() { return this.settings.isPublic && this.phase === 'lobby' && !this.isFull && this.hostConnected; }
  get playerCount() { return this.size; }
  /** Active (non-expired) rooms stay alive while anyone is connected or within grace. */
  idleFor(now: number) { return now - this.lastActivity; }
}
