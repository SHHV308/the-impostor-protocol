import { io, type Socket } from 'socket.io-client';
import { useSyncExternalStore } from 'react';
import {
  C2S, S2C,
  type Ack, type Avatar, type ChatMessage, type GameEvent, type GameSnapshot, type GameSummary, type Profile, type RoomState,
} from '@impostor/shared';
import { audio } from '../audio';

export interface Toast { id: number; text: string; kind: 'info' | 'xp' | 'good' | 'bad'; until: number }
export interface LogEntry { id: number; ability: string; data: unknown; t: number }

export interface State {
  connected: boolean;
  everConnected: boolean;
  profile: Profile | null;
  roomState: RoomState | null;
  snapshot: GameSnapshot | null;
  summary: GameSummary | null;
  chat: ChatMessage[];
  toasts: Toast[];
  log: LogEntry[];
  closedReason: string | null;
  myXp: number;
}

let state: State = {
  connected: false, everConnected: false, profile: null, roomState: null, snapshot: null, summary: null,
  chat: [], toasts: [], log: [], closedReason: null, myXp: 0,
};
const listeners = new Set<() => void>();
const events: GameEvent[] = [];
let uid = 1;
let serverOffset = 0; // serverTime - localTime
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export const snapshotBuffer: GameSnapshot[] = [];

function syncDebug() {
  (window as unknown as Record<string, unknown>).__IMPOSTOR__ = {
    roomState: state.roomState, snapshot: state.snapshot, events, chat: state.chat, socketId: socket.id ?? null,
    summary: state.summary,
  };
}
function emitChange() {
  syncDebug();
  listeners.forEach((l) => l());
}
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emitChange();
}

export const socket: Socket = io({ withCredentials: true, autoConnect: false });
export const getState = () => state;
export const serverNow = () => Date.now() + serverOffset;

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => sel(state),
  );
}

function toast(text: string, kind: Toast['kind'] = 'info', ms = 3500) {
  const t: Toast = { id: uid++, text, kind, until: Date.now() + ms };
  set({ toasts: [...state.toasts.filter((x) => x.until > Date.now()), t] });
  setTimeout(() => set({ toasts: state.toasts.filter((x) => x.until > Date.now()) }), ms + 50);
}
export const pushToast = toast;

function onEvent(e: GameEvent) {
  events.push(e);
  if (events.length > 200) events.shift();
  switch (e.type) {
    case 'role_reveal': audio.sfx('reveal'); break;
    case 'mission_done': audio.sfx('mission'); toast('Mission complete', 'good'); break;
    case 'mission_failed': audio.sfx('fail'); toast(`Mission failed: ${e.reason}`, 'bad'); break;
    case 'sabotage': audio.sfx('sabotage'); toast(`SABOTAGE: ${e.name}`, 'bad', 5000); break;
    case 'sabotage_end': toast(e.resolved ? `${e.name} resolved` : `${e.name} ended`, e.resolved ? 'good' : 'info'); break;
    case 'repair_done': audio.sfx('mission'); break;
    case 'you_died': audio.sfx('eliminate'); toast('You are out. You are now spectating.', 'bad', 6000); break;
    case 'kill_ok': audio.sfx('eliminate'); toast(`${e.victimName} eliminated`, 'info'); break;
    case 'kill_blocked': toast('Target was protected!', 'bad'); break;
    case 'protect_saved': toast(`Your protection saved ${e.targetName}`, 'good'); break;
    case 'env_death': audio.sfx('eliminate'); toast(`${e.name} was caught by the environment`, 'bad', 5000); break;
    case 'scream': audio.sfx('scream'); break;
    case 'meeting_start': audio.sfx('meeting'); break;
    case 'meeting_results': audio.sfx('reveal'); break;
    case 'noise': toast('You hear a noise nearby...', 'info'); break;
    case 'xp': toast(`+${e.amount} XP · ${e.reason}`, 'xp'); set({ myXp: state.myXp + e.amount }); break;
    case 'achievement': toast(`Achievement unlocked: ${e.title}`, 'good', 6000); break;
    case 'notice': toast(e.text); break;
    case 'ability_result':
      set({ log: [{ id: uid++, ability: e.ability, data: e.data, t: Date.now() }, ...state.log].slice(0, 12) });
      break;
    case 'game_over': {
      const mine = state.snapshot?.you.faction;
      audio.sfx(mine && mine === e.summary.winner ? 'victory' : 'defeat');
      set({ summary: e.summary });
      break;
    }
    default: break;
  }
  syncDebug();
}

function onSnapshot(s: GameSnapshot) {
  const off = s.now - Date.now();
  serverOffset = snapshotBuffer.length === 0 ? off : serverOffset * 0.9 + off * 0.1;
  snapshotBuffer.push(s);
  if (snapshotBuffer.length > 12) snapshotBuffer.shift();
  state = { ...state, snapshot: s };
  syncDebug();
  // throttle React updates; the canvas reads the buffer directly
  const phaseKey = `${s.phase}|${s.meeting?.phase}`;
  const prev = (onSnapshot as unknown as { last?: string }).last;
  (onSnapshot as unknown as { last?: string }).last = phaseKey;
  if (prev !== phaseKey) { listeners.forEach((l) => l()); return; }
  if (!notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = null; listeners.forEach((l) => l()); }, 80);
}

socket.on('connect', () => set({ connected: true, everConnected: true }));
socket.on('disconnect', () => set({ connected: false }));
socket.on(S2C.roomState, (rs: RoomState) => {
  const wasPlaying = state.roomState?.phase === 'playing' || state.roomState?.phase === 'ended';
  if (rs.phase === 'lobby') {
    snapshotBuffer.length = 0;
    set({ roomState: rs, snapshot: null, summary: null, log: [], closedReason: null, ...(wasPlaying ? { chat: [] } : {}) });
    audio.setScene('menu');
  } else {
    set({ roomState: rs, closedReason: null });
  }
});
socket.on(S2C.snapshot, onSnapshot);
socket.on(S2C.event, onEvent);
socket.on(S2C.chat, (m: ChatMessage) => set({ chat: [...state.chat, m].slice(-150) }));
socket.on(S2C.kicked, (reason: string) => {
  snapshotBuffer.length = 0;
  set({ roomState: null, snapshot: null, summary: null, chat: [], closedReason: String(reason || 'Room closed') });
});

// ---------- API ----------
export function emit<T = Record<string, never>>(event: string, payload?: unknown): Promise<Ack<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server did not respond' }), 8000);
    const cb = (res: Ack<T>) => { clearTimeout(timer); resolve(res ?? { ok: false, error: 'No response' }); };
    if (payload === undefined) socket.emit(event, cb); else socket.emit(event, payload, cb);
  });
}
export const sendMove = (x: number, y: number) => { socket.volatile.emit(C2S.move, { x, y }); };

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function startSession(): Promise<void> {
  try {
    const { profile } = await api<{ profile: Profile }>('/api/session', 'POST');
    set({ profile });
  } catch { /* offline: still try the socket */ }
  socket.connect();
}
export async function saveProfile(name: string, avatar: Avatar) {
  try {
    const { profile } = await api<{ profile: Profile }>('/api/profile', 'POST', { name, avatar });
    set({ profile });
  } catch { /* non-fatal */ }
}
export const refreshProfile = async () => {
  try { const { profile } = await api<{ profile: Profile }>('/api/session', 'POST'); set({ profile }); } catch { /* ignore */ }
};
export const fetchLeaderboard = () => api<{ entries: import('@impostor/shared').LeaderboardEntry[] }>('/api/leaderboard');
export const fetchHistory = () =>
  api<{ matches: { roomCode: string; environment: string; winner: string; role: string; won: boolean; xpEarned: number; endedAt: string }[] }>('/api/me/history');

export async function leaveRoom() {
  await emit(C2S.leave);
  snapshotBuffer.length = 0;
  set({ roomState: null, snapshot: null, summary: null, chat: [], log: [] });
  audio.setScene('menu');
}
export const clearClosed = () => set({ closedReason: null });
