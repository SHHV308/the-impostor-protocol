import { expect, test } from '@playwright/test';
import { me, snap, startMatch } from './helpers.js';

// Smoke test against a deployed instance: E2E_BASE_URL=https://... npx playwright test public
test.skip(!process.env.E2E_BASE_URL, 'needs E2E_BASE_URL');

test('four players on separate browsers play against the public URL', async ({ browser }) => {
  const { players } = await startMatch(browser, 4);
  const snaps = await Promise.all(players.map((p) => snap(p.page)));
  expect(snaps.filter((s) => s.you.faction === 'impostor')).toHaveLength(1);
  for (const { you, ...pub } of snaps) expect(JSON.stringify(pub)).not.toMatch(/"role"|"faction"/);
  await expect.poll(async () => { const s = await snap(players[1]!.page); return s.now >= s.frozenUntil; }, { timeout: 20_000 }).toBe(true);
  const before = await me(players[1]!.page);
  await players[1]!.page.keyboard.down('KeyD');
  await players[1]!.page.waitForTimeout(800);
  await players[1]!.page.keyboard.up('KeyD');
  await players[1]!.page.waitForTimeout(500);
  const after = await me(players[1]!.page);
  expect(after.x - before.x).toBeGreaterThan(50);
  const seen = (await snap(players[3]!.page)).players.find((x: any) => x.pid === after.pid);
  expect(Math.abs(seen.x - after.x)).toBeLessThan(40);
  for (const p of players) await p.ctx.close();
});
