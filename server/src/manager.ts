import { randomInt } from 'node:crypto';
import type { Server } from 'socket.io';
import { LIMITS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@impostor/shared';
import type { Avatar } from '@impostor/shared';
import { Room, RoomError, type RoomDeps } from './room.js';
import type { Store } from './store/types.js';

export interface ManagerOptions {
  io: Server; store: Store; now?: () => number; rng?: () => number; fastTimers?: boolean;
}

/**
 * Owns every live room. State lives in this process' memory (single instance); the
 * guest->room index and Room objects are the seams to swap for Redis + the Socket.IO
 * Redis adapter if the service is ever scaled horizontally.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private guestRoom = new Map<string, string>();
  private deps: RoomDeps;
  private sweeper: NodeJS.Timeout;

  constructor(o: ManagerOptions) {
    this.deps = {
      io: o.io, store: o.store, now: o.now ?? Date.now, rng: o.rng ?? Math.random, fastTimers: o.fastTimers ?? false,
      onClose: (code) => this.scheduleClose(code),
    };
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  get roomCount() { return this.rooms.size; }
  get(code: string) { return this.rooms.get(code); }
  roomOf(guestId: string): Room | undefined {
    const code = this.guestRoom.get(guestId);
    const room = code ? this.rooms.get(code) : undefined;
    if (code && (!room || !room.memberByGuest(guestId))) { this.guestRoom.delete(guestId); return undefined; }
    return room;
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) c += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  private guard(guestId: string) {
    const cur = this.roomOf(guestId);
    if (!cur) return;
    if (cur.phase === 'lobby') { const m = cur.memberByGuest(guestId)!; cur.leave(m.pid); this.guestRoom.delete(guestId); return; }
    throw new RoomError(`You are still in room ${cur.code}. Rejoin it or leave it first.`);
  }

  create(guestId: string, name: string, avatar: Avatar, isPublic: boolean, socketId: string): Room {
    this.guard(guestId);
    const room = new Room(this.newCode(), isPublic, this.deps);
    this.rooms.set(room.code, room);
    room.join(guestId, name, avatar, socketId);
    this.guestRoom.set(guestId, room.code);
    return room;
  }

  join(guestId: string, code: string, name: string, avatar: Avatar, socketId: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('No room with that code');
    const existing = this.roomOf(guestId);
    if (existing && existing.code !== code) this.guard(guestId);
    room.join(guestId, name, avatar, socketId);
    this.guestRoom.set(guestId, code);
    return room;
  }

  matchmake(guestId: string, name: string, avatar: Avatar, socketId: string): Room {
    this.guard(guestId);
    const candidates = [...this.rooms.values()]
      .filter((r) => r.publicOpen)
      .filter((r) => { try { r.canJoin(name, guestId); return true; } catch { return false; } })
      .sort((a, b) => b.playerCount - a.playerCount);
    const room = candidates[0] ?? new Room(this.newCode(), true, this.deps);
    this.rooms.set(room.code, room);
    room.join(guestId, name, avatar, socketId);
    this.guestRoom.set(guestId, room.code);
    return room;
  }

  /** Called when a socket (re)connects: put the guest back in its room if it has one. */
  reattach(guestId: string, socketId: string): Room | undefined {
    const room = this.roomOf(guestId);
    const m = room?.memberByGuest(guestId);
    if (room && m) room.attach(m, socketId);
    return room;
  }

  leave(guestId: string) {
    const room = this.roomOf(guestId);
    const m = room?.memberByGuest(guestId);
    if (room && m) room.leave(m.pid);
    this.guestRoom.delete(guestId);
  }

  onDisconnect(guestId: string, socketId: string) { this.roomOf(guestId)?.onSocketDisconnect(socketId); }

  private scheduleClose(code: string) {
    // Rooms with nobody connected are kept briefly so reconnecting players are not stranded.
    setTimeout(() => {
      const r = this.rooms.get(code);
      if (r && !r.hasConnected) this.destroy(code, 'The room was closed');
    }, LIMITS.emptyRoomMs).unref();
  }

  private destroy(code: string, reason: string) {
    const r = this.rooms.get(code);
    if (!r) return;
    for (const g of r.guestIds()) if (this.guestRoom.get(g) === code) this.guestRoom.delete(g);
    r.close(reason);
    this.rooms.delete(code);
  }

  sweep() {
    const now = this.deps.now();
    for (const [code, r] of this.rooms) {
      if (r.idleFor(now) > LIMITS.roomInactiveMs || (!r.hasConnected && r.idleFor(now) > LIMITS.emptyRoomMs)) this.destroy(code, 'The room expired from inactivity');
    }
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const code of [...this.rooms.keys()]) this.destroy(code, 'Server shutting down');
  }
}
