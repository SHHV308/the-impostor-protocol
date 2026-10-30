// Production-mode smoke test: embedded PostgreSQL + migrations + `NODE_ENV=production` server + restart.
// Usage: npm run build && node scripts/smoke-prod.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PG_PORT = 54330, APP_PORT = 3300;
const url = `postgresql://postgres:smoke@127.0.0.1:${PG_PORT}/impostor?schema=public`;
const dir = mkdtempSync(path.join(tmpdir(), 'impostor-smoke-'));
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'smoke', port: PG_PORT, persistent: false, onLog: () => {}, onError: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); console.log(`ok - ${msg}`); };

async function startApp() {
  const proc = spawn(process.execPath, ['dist/server/index.mjs'], {
    env: { ...process.env, NODE_ENV: 'production', PORT: String(APP_PORT), DATABASE_URL: url }, stdio: 'pipe',
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)).ok) return proc; } catch { /* not up yet */ }
    await sleep(200);
  }
  proc.kill();
  throw new Error('server did not become healthy');
}

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('impostor');
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url }, shell: true, stdio: 'pipe' });
  console.log('ok - migrations applied');

  let app = await startApp();
  const base = `http://127.0.0.1:${APP_PORT}`;
  const res = await fetch(`${base}/api/session`, { method: 'POST' });
  const setCookie = res.headers.getSetCookie()[0];
  check(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), 'guest cookie is HttpOnly + Secure + SameSite=Lax in production');
  const first = (await res.json()).profile;
  const html = await (await fetch(`${base}/`)).text();
  check(html.includes('The Impostor Protocol'), 'serves the built client');
  check((await fetch(`${base}/assets/missing.js`)).status === 404, 'missing assets 404');
  check(/max-age/.test((await fetch(`${base}/api/health`)).headers.get('strict-transport-security') ?? ''), 'HSTS header present');

  app.kill(); await sleep(500);
  app = await startApp();
  const again = await fetch(`${base}/api/session`, { method: 'POST', headers: { cookie: setCookie.split(';')[0] } });
  check((await again.json()).profile.publicId === first.publicId, 'same guest recognised after a server restart (persisted in PostgreSQL)');
  app.kill();
  console.log('\nproduction smoke test passed');
} finally {
  await pg.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
