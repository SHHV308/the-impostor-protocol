import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { C2S, S2C } from '@impostor/shared';
import type { Ack, ChatMessage, GameEvent, GameSnapshot, Profile, RoomState } from '@impostor/shared';
import { createApp } from '../../server/src/app.js';
import { MemoryStore } from '../../server/src/store/memory.js';
import type { Room } from '../../server/src/room.js';

export async function startServer() {
  const store = new MemoryStore();
  let skew = 0;
  const srv = createApp({ store, rateLimits: false, fastTimers: true, now: () => Date.now() + skew });
  await new Promise<void>((r) => srv.http.listen(0, r));
  const base = `http://127.0.0.1:${(srv.http.address() as AddressInfo).port}`;
  const room = (code: string) => srv.manager.get(code) as Room;
  /** Jump the server's game clock forward (cooldowns, timers) without waiting. */
  const skip = (ms: number) => { skew += ms; };
  return { ...srv, store, base, room, skip };
}
export type TestServer = Awaited<ReturnType<typeof startServer>>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => T | undefined | false, ms = 4000, what = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

export class TestPlayer {
  socket!: Socket;
  room: RoomState | null = null;
  snap: GameSnapshot | null = null;
  snaps: GameSnapshot[] = [];
  events: GameEvent[] = [];
  chat: ChatMessage[] = [];
  closed: string | null = null;
  profile!: Profile;
  cookie = '';

  constructor(public srv: TestServer, public name: string) {}

  static async create(srv: TestServer, name: string) {
    const p = new TestPlayer(srv, name);
    const res = await fetch(`${srv.base}/api/session`, { method: 'POST' });
    p.cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0]!;
    p.profile = ((await res.json()) as { profile: Profile }).profile;
    await p.connect();
    return p;
  }

  async connect() {
    this.socket = io(this.srv.base, { transports: ['websocket'], extraHeaders: { cookie: this.cookie }, forceNew: true, reconnection: false });
    this.socket.on(S2C.roomState, (s: RoomState) => { this.room = s; });
    this.socket.on(S2C.snapshot, (s: GameSnapshot) => { this.snap = s; if (this.snaps.length < 400) this.snaps.push(s); });
    this.socket.on(S2C.event, (e: GameEvent) => this.events.push(e));
    this.socket.on(S2C.chat, (m: ChatMessage) => this.chat.push(m));
    this.socket.on(S2C.kicked, (r: string) => { this.closed = r; });
    await new Promise<void>((resolve, reject) => { this.socket.once('connect', () => resolve()); this.socket.once('connect_error', reject); });
  }

  emit<T = Record<string, unknown>>(event: string, payload?: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => this.socket.emit(event, payload, (r: Ack<T>) => resolve(r)));
  }
  get pid() { return this.room!.youPid; }
  get code() { return this.room!.code; }
  get role() { return this.snap?.you.role; }
  disconnect() { this.socket.disconnect(); }
  hasEvent(type: string) { return this.events.some((e) => e.type === type); }
  profileNow = async () => ((await (await fetch(`${this.srv.base}/api/session`, { method: 'POST', headers: { cookie: this.cookie } })).json()) as { profile: Profile }).profile;
}

/** Create a room with n players, all ready, and start the match. */
export async function startedMatch(srv: TestServer, n: number, settings: Record<string, unknown> = {}) {
  const players: TestPlayer[] = [];
  for (let i = 0; i < n; i++) players.push(await TestPlayer.create(srv, `Player${i}`));
  const host = players[0]!;
  const created = await host.emit<{ code: string }>(C2S.createRoom, { name: host.name, avatar: 'visor', isPublic: false });
  if (!created.ok) throw new Error(created.error);
  for (const p of players.slice(1)) {
    const r = await p.emit(C2S.joinRoom, { code: created.code, name: p.name, avatar: 'helmet' });
    if (!r.ok) throw new Error(r.error);
  }
  if (Object.keys(settings).length) await host.emit(C2S.settings, settings);
  for (const p of players.slice(1)) await p.emit(C2S.ready, { ready: true });
  const s = await host.emit(C2S.start);
  if (!s.ok) throw new Error(s.error);
  await until(() => players.every((p) => p.snap), 4000, 'first snapshots');
  const room = srv.room(created.code);
  return { players, host, code: created.code, room };
}

export const crewOf = (ps: TestPlayer[]) => ps.filter((p) => p.snap?.you.faction === 'crew');
export const impostorsOf = (ps: TestPlayer[]) => ps.filter((p) => p.snap?.you.faction === 'impostor');
