import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { PrismaStore } from './store/prisma.js';
import type { Store } from './store/types.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);

let store: Store;
if (process.env.DATABASE_URL) {
  store = new PrismaStore();
} else {
  if (production) throw new Error('DATABASE_URL is required in production');
  console.warn('[server] DATABASE_URL not set: using the in-memory store. Progression is lost on restart.');
  store = new MemoryStore();
}

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server/index.mjs -> dist/client ; src/index.ts -> ../../dist/client
const clientDir = process.env.CLIENT_DIR ?? path.resolve(here, production ? '../client' : '../../dist/client');

const { http, close } = createApp({
  store, clientDir, production,
  clientOrigin: process.env.CLIENT_ORIGIN || undefined,
  fastTimers: process.env.FAST_TIMERS === '1',
});

http.listen(port, () => console.log(`[server] listening on :${port} (${production ? 'production' : 'development'})`));

const stop = () => { void close().finally(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
