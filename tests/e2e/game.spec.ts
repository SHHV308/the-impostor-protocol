import { expect, test } from '@playwright/test';
import { guestJoins, hostCreates, me, openPlayer, snap, startMatch, walkTo } from './helpers.js';

test.describe('lobby validation in the browser', () => {
  test('invalid codes, duplicate names and the invite link are handled', async ({ browser }) => {
    const host = await openPlayer(browser, 'Hosty');
    const code = await hostCreates(host);
    // invite link copy button exists and the join link prefills the code
    await expect(host.page.getByTestId('btn-copy-link')).toBeVisible();
    await expect(host.page.getByTestId('player-list')).toContainText('Hosty');

    const bad = await openPlayer(browser, 'Newbie');
    await bad.page.goto('/');
    await bad.page.getByTestId('btn-enter').click();
    await bad.page.getByTestId('input-name').fill('Newbie');
    await bad.page.getByTestId('input-code').fill('ZZZZZZ');
    await bad.page.getByTestId('btn-join').click();
    await expect(bad.page.getByTestId('error')).toContainText(/No room/i);
    await bad.page.getByTestId('input-code').fill('ABC');
    await bad.page.getByTestId('btn-join').click();
    await expect(bad.page.getByTestId('error')).toBeVisible();

    const dup = await openPlayer(browser, 'hosty');
    await dup.page.goto(`/?room=${code}`);
    await dup.page.getByTestId('input-name').fill('hosty');
    await dup.page.getByTestId('btn-join').click();
    await expect(dup.page.getByTestId('error')).toContainText(/taken/i);
    for (const p of [host, bad, dup]) await p.ctx.close();
  });

  test('public matchmaking pairs two browsers into one room', async ({ browser }) => {
    const a = await openPlayer(browser, 'PubOne'), b = await openPlayer(browser, 'PubTwo');
    for (const p of [a, b]) {
      await p.page.goto('/');
      await p.page.getByTestId('btn-enter').click();
      await p.page.getByTestId('input-name').fill(p.name);
      await p.page.getByTestId('btn-matchmake').click();
      await expect(p.page.getByTestId('room-code')).toBeVisible();
    }
    await expect(a.page.getByTestId('player-list')).toContainText('PubTwo');
    expect(await a.page.getByTestId('room-code').textContent()).toBe(await b.page.getByTestId('room-code').textContent());
    for (const p of [a, b]) await p.ctx.close();
  });
});

test.describe('four independent players', () => {
  test('roles stay private, state is shared, movement syncs, emergency meeting votes resolve together, reload reconnects', async ({ browser }) => {
    const { players } = await startMatch(browser, 4, { env: 'space' });
    const [host, p1, p2, p3] = players;

    // --- role reveal + secrecy
    for (const p of players) await expect(p.page.getByTestId('role-badge')).toBeVisible({ timeout: 15_000 });
    const snaps = await Promise.all(players.map((p) => snap(p.page)));
    const imps = snaps.filter((s) => s.you.faction === 'impostor');
    expect(imps).toHaveLength(1);
    for (const s of snaps) {
      const { you, ...pub } = s;
      expect(JSON.stringify(pub)).not.toMatch(/"role"|"faction"|detective|shapeshifter/);
      expect(s.env).toBe('space');
    }
    const pubSets = new Set(snaps.map((s) => JSON.stringify(s.players.map((x: any) => x.name).sort())));
    expect(pubSets.size).toBe(1);
    // nobody received a role_reveal for someone else
    for (const p of players) {
      const reveals = await p.page.evaluate(() => window.__IMPOSTOR__.events.filter((e: any) => e.type === 'role_reveal'));
      expect(reveals).toHaveLength(1);
    }
    await host.page.screenshot({ path: 'test-results/game-host.png' });

    // --- movement syncs across independent browsers
    await expect.poll(async () => (await snap(host.page)).now >= (await snap(host.page)).frozenUntil, { timeout: 15_000 }).toBe(true);
    const before = await me(p1.page);
    await p1.page.keyboard.down('KeyD');
    await p1.page.waitForTimeout(700);
    await p1.page.keyboard.up('KeyD');
    await p1.page.waitForTimeout(300);
    const after = await me(p1.page);
    expect(after.x - before.x).toBeGreaterThan(50);
    const seenByOther = (await snap(p3.page)).players.find((x: any) => x.pid === after.pid);
    expect(Math.abs(seenByOther.x - after.x)).toBeLessThan(25);

    // --- emergency meeting (the button unlocks 15 s into the match)
    await expect.poll(async () => { const s = await snap(p2.page); return s.now - s.frozenUntil; }, { timeout: 30_000, intervals: [500] }).toBeGreaterThan(15_500);
    // Command Deck centre is (800, 230); the button sits at (800, 126). Approach from the left to avoid the table prop.
    await walkTo(p2.page, 705, 300);
    await walkTo(p2.page, 705, 150);
    await walkTo(p2.page, 800, 150); // the client offers the nearest console, so stand at the button
    await expect(p2.page.getByTestId('btn-use')).toContainText(/emergency/i);
    await p2.page.getByTestId('btn-use').click();
    for (const p of players) await expect(p.page.getByTestId('meeting-panel')).toBeVisible();
    for (const p of players) await expect(p.page.getByTestId(`vote-${(await snap(p.page)).you.pid}`)).toHaveCount(0); // cannot vote for yourself

    // voting opens after the (shortened) discussion; votes stay hidden until everyone has voted
    await expect(p1.page.getByTestId('vote-skip')).toBeEnabled({ timeout: 15_000 });
    await p1.page.getByTestId('vote-skip').click();
    await p2.page.getByTestId('vote-skip').click();
    await expect.poll(async () => (await snap(host.page)).meeting?.voted.length).toBe(2);
    const mid = await snap(host.page);
    expect(mid.meeting.results).toBeUndefined();
    expect(JSON.stringify(mid.meeting)).not.toContain('"target"');
    await host.page.getByTestId('vote-skip').click();
    await p3.page.getByTestId('vote-skip').click();
    for (const p of players) await expect(p.page.getByTestId('meeting-results')).toBeVisible();
    // a skip-majority ejects nobody and play resumes for everyone
    for (const p of players) await expect.poll(async () => (await snap(p.page))?.phase, { timeout: 15_000 }).toBe('playing');
    for (const p of players) expect((await snap(p.page)).players.every((x: any) => x.alive)).toBe(true);

    // --- reload = reconnect as the same player with the same secret role
    const pid = (await snap(p3.page)).you.pid, role = (await snap(p3.page)).you.role;
    await p3.page.reload();
    await expect.poll(async () => (await snap(p3.page))?.you?.pid, { timeout: 15_000 }).toBe(pid);
    expect((await snap(p3.page)).you.role).toBe(role);
    await expect(p3.page.getByTestId('role-badge')).toBeVisible();

    for (const p of players) await p.ctx.close();
  });
});

test.describe('mobile', () => {
  test('touch joystick moves a phone player and the layout does not overflow', async ({ browser }) => {
    const { players } = await startMatch(browser, 4, { env: 'cyber', mobile: [1] });
    const phone = players[1]!;
    await expect.poll(async () => { const s = await snap(phone.page); return s.now >= s.frozenUntil; }, { timeout: 15_000 }).toBe(true);
    const joy = phone.page.getByTestId('touch-joystick');
    await expect(joy).toBeVisible();
    const box = (await joy.boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await phone.ctx.newCDPSession(phone.page);
    const before = await me(phone.page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + i * 8, y: cy }] });
    await phone.page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await phone.page.waitForTimeout(300);
    const after = await me(phone.page);
    expect(after.x - before.x).toBeGreaterThan(40);
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await phone.page.screenshot({ path: 'test-results/mobile-game.png' });
    for (const p of players) await p.ctx.close();
  });
});
