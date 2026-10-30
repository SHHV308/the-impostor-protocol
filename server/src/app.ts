import { createServer as createHttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { Server, type Socket } from 'socket.io';
import type { ZodType } from 'zod';
import { ACHIEVEMENTS, C2S, levelFromXp, schemas } from '@impostor/shared';
import type { Ack, Profile } from '@impostor/shared';
import { GameError } from './game/engine.js';
import { RoomManager } from './manager.js';
import { RoomError } from './room.js';
import { RateLimiter } from './ratelimit.js';
import type { GuestRecord, Store } from './store/types.js';

export const COOKIE = 'ip_guest';

export interface AppOptions {
  store: Store;
  clientDir?: string;
  clientOrigin?: string;
  production?: boolean;
  fastTimers?: boolean;
  rateLimits?: boolean;
  now?: () => number;
  rng?: () => number;
}

export const toProfile = (g: GuestRecord): Profile => ({
  publicId: g.publicId, displayName: g.displayName, avatar: g.avatar, xp: g.xp, level: levelFromXp(g.xp),
  gamesPlayed: g.gamesPlayed, wins: g.wins, stats: g.stats,
  achievements: g.achievements.map((a) => ({ key: a.key, title: ACHIEVEMENTS[a.key]?.title ?? a.key, unlockedAt: a.unlockedAt.toISOString() })),
});

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createApp(opts: AppOptions) {
  const { store } = opts;
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:', 'data:'], connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"],
        upgradeInsecureRequests: opts.production ? [] : null,
      },
    },
    strictTransportSecurity: opts.production ? undefined : false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  app.use(express.json({ limit: '4kb' }));

  const limited = opts.rateLimits !== false;
  const api = express.Router();
  if (limited) api.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
  const createLimiter = limited
    ? rateLimit({ windowMs: 10 * 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many new guest profiles from this address' } })
    : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

  const guestFrom = async (req: express.Request) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token ? store.findByToken(token) : null;
  };

  api.get('/health', (_req, res) => res.json({ status: 'ok', rooms: manager.roomCount, uptime: Math.round(process.uptime()) }));

  api.post('/session', async (req, res, next) => {
    try {
      let guest = await guestFrom(req);
      if (!guest) {
        await new Promise<void>((resolve, reject) => createLimiter(req, res, (e?: unknown) => (e ? reject(e) : resolve())));
        if (res.headersSent) return;
        const created = await store.createGuest();
        guest = created.guest;
        res.cookie(COOKIE, created.token, {
          httpOnly: true, sameSite: 'lax', secure: !!opts.production, maxAge: 365 * 24 * 3600 * 1000, path: '/',
        });
      }
      res.json({ profile: toProfile(guest) });
    } catch (e) { next(e); }
  });

  api.post('/profile', async (req, res, next) => {
    try {
      const guest = await guestFrom(req);
      if (!guest) return void res.status(401).json({ error: 'No session' });
      const parsed = schemas.profile.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid profile' });
      res.json({ profile: toProfile(await store.updateProfile(guest.id, parsed.data.name, parsed.data.avatar)) });
    } catch (e) { next(e); }
  });

  api.get('/leaderboard', async (_req, res, next) => {
    try { res.json({ entries: await store.leaderboard(20) }); } catch (e) { next(e); }
  });

  api.get('/me/history', async (req, res, next) => {
    try {
      const guest = await guestFrom(req);
      if (!guest) return void res.status(401).json({ error: 'No session' });
      res.json({ matches: await store.history(guest.id, 20) });
    } catch (e) { next(e); }
  });
  app.use('/api', api);

  const clientDir = opts.clientDir;
  if (clientDir && existsSync(clientDir)) {
    app.use(express.static(clientDir, { index: false, maxAge: opts.production ? '1h' : 0 }));
    // SPA fallback for routes only; a missing file (anything with an extension) is a real 404
    app.get(/^\/(?!api|socket\.io)[^.]*$/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });

  const http = createHttpServer(app);
  const io = new Server(http, {
    cors: opts.clientOrigin ? { origin: opts.clientOrigin, credentials: true } : undefined,
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 10_000, pingTimeout: 10_000,
  });
  const manager = new RoomManager({ io, store, fastTimers: opts.fastTimers, now: opts.now, rng: opts.rng });
  const limiter = new RateLimiter();

  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie)[COOKIE];
      const guest = token ? await store.findByToken(token) : null;
      if (!guest) return next(new Error('unauthorized'));
      socket.data.guest = guest;
      next();
    } catch (e) { next(e as Error); }
  });

  io.on('connection', (socket) => bind(socket, store, manager, limiter));

  return {
    app, http, io, manager,
    async close() {
      manager.shutdown();
      await new Promise<void>((r) => io.close(() => r()));
      await store.close();
    },
  };
}

type Handler<T> = (ctx: { guest: GuestRecord; socket: Socket; data: T }) => unknown;

function bind(socket: Socket, store: Store, manager: RoomManager, limiter: RateLimiter) {
  const guestId = (socket.data.guest as GuestRecord).id;
  manager.reattach(guestId, socket.id);

  const on = <T>(event: string, schema: ZodType<T> | null, fn: Handler<T>, rule: [number, number] = [20, 1000]) => {
    socket.on(event, async (payload: unknown, cb?: (a: Ack<Record<string, unknown>>) => void) => {
      const ack = typeof cb === 'function' ? cb : () => {};
      if (!limiter.allow(`${socket.id}:${event}`, rule[0], rule[1])) {
        if (event !== C2S.move) ack({ ok: false, error: 'Too many requests, slow down' });
        return;
      }
      try {
        let data: T = undefined as T;
        if (schema) {
          const parsed = schema.safeParse(payload);
          if (!parsed.success) return void ack({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' });
          data = parsed.data;
        }
        const out = await fn({ guest: socket.data.guest as GuestRecord, socket, data });
        ack({ ok: true, ...((out as object) ?? {}) });
      } catch (e) {
        if (e instanceof RoomError || e instanceof GameError) ack({ ok: false, error: e.message });
        else { console.error(`handler ${event} failed`, e); ack({ ok: false, error: 'Internal error' }); }
      }
    });
  };

  /** Resolve the room + member for this guest; membership is verified every time. */
  const member = (g: GuestRecord) => {
    const room = manager.roomOf(g.id);
    const m = room?.memberByGuest(g.id);
    if (!room || !m) throw new RoomError('You are not in a room');
    return { room, pid: m.pid };
  };

  on(C2S.createRoom, schemas.createRoom, ({ guest, data }) => ({ code: manager.create(guest.id, data.name, data.avatar, data.isPublic, socket.id).code }), [5, 5000]);
  on(C2S.joinRoom, schemas.joinRoom, ({ guest, data }) => { manager.join(guest.id, data.code, data.name, data.avatar, socket.id); }, [8, 5000]);
  on(C2S.matchmake, schemas.matchmake, ({ guest, data }) => { manager.matchmake(guest.id, data.name, data.avatar, socket.id); }, [5, 5000]);
  on(C2S.leave, null, ({ guest }) => { manager.leave(guest.id); });
  on(C2S.settings, schemas.settings, ({ guest, data }) => { const { room, pid } = member(guest); room.updateSettings(pid, data); });
  on(C2S.ready, schemas.ready, ({ guest, data }) => { const { room, pid } = member(guest); room.setReady(pid, data.ready); });
  on(C2S.profile, schemas.profile, ({ guest, data }) => { const { room, pid } = member(guest); room.setProfile(pid, data.name, data.avatar); });
  on(C2S.start, null, ({ guest }) => { const { room, pid } = member(guest); room.start(pid); }, [3, 3000]);
  on(C2S.rematch, null, ({ guest }) => { const { room, pid } = member(guest); room.rematch(pid); }, [3, 3000]);
  on(C2S.chat, schemas.chat, ({ guest, data }) => { const { room, pid } = member(guest); room.chat(pid, data.text); }, [6, 5000]);
  on(C2S.move, schemas.move, ({ guest, data }) => { const { room, pid } = member(guest); room.input(pid, data.x, data.y); }, [40, 1000]);
  on(C2S.missionStart, schemas.missionStart, ({ guest, data }) => { const { room, pid } = member(guest); room.game.startMission(pid, data.missionId); }, [6, 2000]);
  on(C2S.missionSubmit, schemas.missionSubmit, ({ guest, data }) => { const { room, pid } = member(guest); return room.game.submitMission(pid, data.missionId, data.answer); }, [6, 2000]);
  on(C2S.missionCancel, null, ({ guest }) => { const { room, pid } = member(guest); room.game.cancelMission(pid); });
  on(C2S.ability, schemas.ability, ({ guest, data }) => { const { room, pid } = member(guest); return { data: room.game.useAbility(pid, data) }; }, [6, 2000]);
  on(C2S.sabotage, schemas.sabotage, ({ guest, data }) => { const { room, pid } = member(guest); room.game.triggerSabotage(pid, data.sabotageId); }, [4, 2000]);
  on(C2S.repair, schemas.repair, ({ guest, data }) => { const { room, pid } = member(guest); room.game.startRepair(pid, data.stationId); }, [6, 2000]);
  on(C2S.repairCancel, null, ({ guest }) => { const { room, pid } = member(guest); room.game.cancelRepair(pid); });
  on(C2S.report, schemas.report, ({ guest, data }) => { const { room, pid } = member(guest); room.game.reportBody(pid, data.bodyId); }, [4, 2000]);
  on(C2S.emergency, null, ({ guest }) => { const { room, pid } = member(guest); room.game.callEmergency(pid); }, [3, 2000]);
  on(C2S.vote, schemas.vote, ({ guest, data }) => { const { room, pid } = member(guest); room.game.vote(pid, data.target); }, [4, 2000]);

  socket.on('disconnect', () => manager.onDisconnect(guestId, socket.id));
}
