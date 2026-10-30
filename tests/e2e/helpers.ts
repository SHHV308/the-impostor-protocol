import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export interface Player { name: string; ctx: BrowserContext; page: Page }

declare global { interface Window { __IMPOSTOR__: any } }

export const snap = (p: Page) => p.evaluate(() => window.__IMPOSTOR__?.snapshot ?? null);
export const me = async (p: Page) => {
  return p.evaluate(() => {
    const w = window.__IMPOSTOR__;
    const s = w?.snapshot;
    return s ? { ...s.players.find((x: any) => x.pid === s.you.pid), role: s.you.role, faction: s.you.faction } : null;
  });
};

export async function openPlayer(browser: Browser, name: string, opts: Parameters<Browser['newContext']>[0] = {}): Promise<Player> {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  // GitHub Codespaces shows a one-time interstitial on forwarded ports; click through like a player would
  await page.addLocatorHandler(page.getByRole('button', { name: 'Continue', exact: true }), (b) => b.click());
  return { name, ctx, page };
}

async function fillIdentity(p: Player, avatar: string) {
  await p.page.getByTestId('input-name').fill(p.name);
  await p.page.getByTestId(`avatar-${avatar}`).click();
}

export async function hostCreates(host: Player, env?: string): Promise<string> {
  await host.page.goto('/');
  await host.page.getByTestId('btn-enter').click();
  await fillIdentity(host, 'visor');
  await host.page.getByTestId('btn-create').click();
  await expect(host.page.getByTestId('room-code')).toBeVisible();
  const code = (await host.page.getByTestId('room-code').textContent())!.match(/[A-Z2-9]{6}/)![0];
  if (env) await host.page.getByTestId(`env-${env}`).click();
  return code;
}

export async function guestJoins(g: Player, code: string, avatar = 'helmet') {
  await g.page.goto(`/?room=${code}`);
  await expect(g.page.getByTestId('input-code')).toHaveValue(code);
  await fillIdentity(g, avatar);
  await g.page.getByTestId('btn-join').click();
  await expect(g.page.getByTestId('room-code')).toBeVisible();
}

/** n players in separate browser contexts, lobby -> started match. */
export async function startMatch(browser: Browser, n: number, o: { env?: string; mobile?: number[] } = {}): Promise<{ players: Player[]; code: string }> {
  const players: Player[] = [];
  for (let i = 0; i < n; i++) {
    const mobile = o.mobile?.includes(i);
    players.push(await openPlayer(browser, `Agent${i}`, mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } }));
  }
  const code = await hostCreates(players[0]!, o.env ?? 'space');
  for (const g of players.slice(1)) await guestJoins(g, code);
  for (const g of players.slice(1)) await g.page.getByTestId('btn-ready').click();
  await expect(players[0]!.page.getByTestId('btn-start')).toBeEnabled();
  await players[0]!.page.getByTestId('btn-start').click();
  for (const p of players) await expect.poll(async () => (await snap(p.page))?.phase, { timeout: 15_000 }).toBe('playing');
  return { players, code };
}

/** Closed-loop keyboard walk to a point using the real client controls. */
export async function walkTo(p: Page, x: number, y: number, tol = 12, timeoutMs = 12_000) {
  const keys = { l: 'ArrowLeft', r: 'ArrowRight', u: 'ArrowUp', d: 'ArrowDown' };
  const held = new Set<string>();
  const set = async (want: Set<string>) => {
    for (const k of [...held]) if (!want.has(k)) { await p.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await p.keyboard.down(k); held.add(k); }
  };
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeoutMs) {
      const m = await me(p);
      if (!m) { await p.waitForTimeout(50); continue; }
      const dx = x - m.x, dy = y - m.y;
      if (Math.hypot(dx, dy) <= tol) return;
      const want = new Set<string>();
      if (dx > tol / 2) want.add(keys.r); else if (dx < -tol / 2) want.add(keys.l);
      if (dy > tol / 2) want.add(keys.d); else if (dy < -tol / 2) want.add(keys.u);
      await set(want);
      await p.waitForTimeout(40);
    }
    throw new Error(`walkTo(${x},${y}) timed out`);
  } finally { await set(new Set()); }
}
