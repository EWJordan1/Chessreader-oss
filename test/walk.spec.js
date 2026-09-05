/*
 * The headless walk (§12): every room, against a seeded library, one screenshot each,
 * so a layout regression is visible in a diff. Desktop width only.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const corpus = readFileSync(new URL('./fixtures/chesscom.pgn', import.meta.url), 'utf8');
const ROOMS = ['home', 'learn', 'insights', 'prep', 'play', 'settings'];

test.describe('the walk', () => {
  test('every room is reachable, carries its empty state, and the seeded library shows', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('/#/');
    await expect(page.locator('#site-nav .nav-link')).toHaveCount(5);

    // Empty states first: every room reachable with nothing loaded.
    for (const room of ROOMS) {
      await page.goto('/#/' + (room === 'home' ? '' : room));
      await expect(page.locator('#view-' + room)).toBeVisible();
      await page.screenshot({ path: 'test/walk/__screenshots__/empty-' + room + '.png' });
    }

    // Seed by pasting the corpus.
    await page.goto('/#/play');
    await page.click('#btn-import');
    await page.fill('#pgn-text', corpus);
    await page.click('#btn-paste-load');
    await expect(page.locator('#board-pair')).toBeVisible();
    await expect(page.locator('#chess-board .sq')).toHaveCount(64);
    await expect(page.locator('#queue-list .queue-row')).toHaveCount(34);

    // Step through a few plies, and the score follows.
    await page.click('#btn-next-move');
    await page.click('#btn-next-move');
    await expect(page.locator('#move-tree .tree-move.current')).toHaveCount(1);
    await expect(page.locator('#ply-count')).toHaveText(/^2 \//);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#ply-count')).toHaveText(/^3 \//);

    for (const room of ROOMS) {
      await page.goto('/#/' + (room === 'home' ? '' : room));
      await expect(page.locator('#view-' + room)).toBeVisible();
      await page.screenshot({ path: 'test/walk/__screenshots__/' + room + '.png' });
    }
    // The theme is one attribute on <html>.
    await page.goto('/#/settings');
    await page.click('.theme-swatch[data-theme="wood"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'wood');
    await page.goto('/#/play');
    await page.screenshot({ path: 'test/walk/__screenshots__/play-wood.png' });
    expect(errors, 'no page errors during the walk').toEqual([]);
  });
});
