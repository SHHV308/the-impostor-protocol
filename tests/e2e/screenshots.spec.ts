import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { io } from 'socket.io-client';
import { C2S } from '../../shared/src/index.js';
import { hostCreates, openPlayer, snap, walkTo } from './helpers.js';

// Generates the README screenshots: `SCREENSHOTS=1 npx playwright test screenshots`
test.skip(!process.env.SCREENSHOTS, 'screenshot generation only');
const OUT = 'docs/screenshots';
const base = 'http://127.0.0.1:3200';

async function bot(name: string, code: string) {
  const res = await fetch(`${base}/api/session`, { method: 'POST' });
  const cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0]!;
  const s = io(base, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false });
  await new Promise<void>((r) => s.once('connect', () => r()));
  const ack = (ev: string, p?: unknown) => new Promise<any>((r) => s.emit(ev, p, r));
  await ack(C2S.joinRoom, { code, name, avatar: 'goggles' });
  await ack(C2S.ready, { ready: true });
  return s;
}

test('capture screens', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const host = await openPlayer(browser, 'SHHV', { viewport: { width: 1280, height: 800 } });
  await host.page.goto('/');
  await host.page.waitForTimeout(1500);
  await host.page.screenshot({ path: `${OUT}/01-title.png` });
  await host.page.getByTestId('btn-enter').click();
  await host.page.getByTestId('input-name').fill('SHHV');
  await host.page.waitForTimeout(500);
  await host.page.screenshot({ path: `${OUT}/02-landing.png` });
  await host.ctx.close();

  const bots: ReturnType<typeof io>[] = [];
  for (const env of ['space', 'lab', 'cyber', 'bunker']) {
    const h = await openPlayer(browser, 'SHHV', { viewport: { width: 1280, height: 800 } });
    const code = await hostCreates(h, env);
    for (const n of ['Nova', 'Echo', 'Kite']) bots.push(await bot(n, code));
    await expect(h.page.getByTestId('player-list')).toContainText('Kite');
    if (env === 'space') await h.page.screenshot({ path: `${OUT}/03-lobby.png` });
    await h.page.getByTestId('btn-start').click();
    await expect(h.page.getByTestId('role-reveal')).toBeVisible({ timeout: 15_000 });
    await h.page.waitForTimeout(600);
    if (env === 'space') await h.page.screenshot({ path: `${OUT}/04-role-reveal.png` });
    await expect(h.page.getByTestId('role-badge')).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => { const s = await snap(h.page); return s.now >= s.frozenUntil; }, { timeout: 15_000 }).toBe(true);
    await h.page.waitForTimeout(1200);
    await h.page.screenshot({ path: `${OUT}/05-game-${env}.png` });
    if (env === 'space') {
      await expect.poll(async () => { const s = await snap(h.page); return s.now - s.frozenUntil; }, { timeout: 30_000, intervals: [500] }).toBeGreaterThan(15_500);
      await walkTo(h.page, 705, 300); await walkTo(h.page, 705, 150); await walkTo(h.page, 800, 150);
      await h.page.getByTestId('btn-use').click();
      await expect(h.page.getByTestId('meeting-panel')).toBeVisible();
      await h.page.waitForTimeout(5000);
      await h.page.screenshot({ path: `${OUT}/06-meeting.png` });
    }
    await h.ctx.close();
    bots.splice(0).forEach((b) => b.close());
  }

  // phone
  const phone = await openPlayer(browser, 'SHHV', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const code = await hostCreates(phone, 'cyber');
  for (const n of ['Nova', 'Echo', 'Kite']) bots.push(await bot(n, code));
  await phone.page.getByTestId('btn-start').click();
  await expect(phone.page.getByTestId('role-badge')).toBeVisible({ timeout: 15_000 });
  await phone.page.waitForTimeout(2500);
  await phone.page.screenshot({ path: `${OUT}/07-mobile.png` });
  bots.forEach((b) => b.close());
  await phone.ctx.close();
});
