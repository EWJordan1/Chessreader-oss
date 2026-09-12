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
    await page.goto('/app.html#/');
    await expect(page.locator('#site-nav .nav-link')).toHaveCount(5);

    // Empty states first: every room reachable with nothing loaded.
    for (const room of ROOMS) {
      await page.goto('/app.html#/' + (room === 'home' ? '' : room));
      await expect(page.locator('#view-' + room)).toBeVisible();
      await page.screenshot({ path: 'test/walk/__screenshots__/empty-' + room + '.png' });
    }

    // Seed by pasting the corpus.
    await page.goto('/app.html#/play');
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
      await page.goto('/app.html#/' + (room === 'home' ? '' : room));
      await expect(page.locator('#view-' + room)).toBeVisible();
      await page.screenshot({ path: 'test/walk/__screenshots__/' + room + '.png' });
    }
    // The theme is one attribute on <html>.
    await page.goto('/app.html#/settings');
    await page.click('.theme-swatch[data-theme="wood"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'wood');
    await page.goto('/app.html#/play');
    await page.screenshot({ path: 'test/walk/__screenshots__/play-wood.png' });
    expect(errors, 'no page errors during the walk').toEqual([]);
  });

  /*
   * The memory layer end to end, which no unit test can reach: a real IndexedDB, a real
   * reload, and the library coming back off the disk. This is also the one place
   * `S._restoring` is genuinely exercised — in a unit test it is a flag somebody sets.
   */
  test('the library survives a reload, and the cursor comes back with it', async ({ page }) => {
    await page.goto('/app.html#/play');
    await page.click('#btn-import');
    await page.fill('#pgn-text', corpus);
    await page.click('#btn-paste-load');
    await expect(page.locator('#queue-list .queue-row')).toHaveCount(34);

    // Stand somewhere specific: the third game, four plies in.
    await page.click('#queue-list .queue-row:nth-child(3)');
    for (let i = 0; i < 4; i++) await page.click('#btn-next-move');
    await expect(page.locator('#ply-count')).toHaveText(/^4 \//);
    const label = await page.locator('#players-label').textContent();

    // The cursor is debounced before it is written, so give it its window.
    await page.waitForTimeout(2000);
    await page.reload();

    await expect(page.locator('#queue-list .queue-row')).toHaveCount(34, { timeout: 15000 });
    await expect(page.locator('#players-label')).toHaveText(label);
    await expect(page.locator('#ply-count')).toHaveText(/^4 \//);
  });

  /* §2.1: below the minimum width the app says so in one sentence rather than reflowing. */
  test('a narrow window is told, not reflowed', async ({ page }) => {
    await page.goto('/app.html#/');
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator('#too-narrow')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#too-narrow')).toBeHidden();
  });

  test('Learn carries its three sections in the URL, and the keyboard map opens', async ({ page }) => {
    await page.goto('/app.html#/learn');
    // A bare #/learn rewrites to the section it landed on, so the address says where you are.
    await expect(page).toHaveURL(/#\/learn\/(openings|tactics|drills)$/);
    await expect(page.locator('#learn-body')).toBeVisible();

    await page.goto('/app.html#/learn/openings');
    // The whole shipped catalogue, drawn from the one index rather than 23 fetches.
    await expect(page.locator('#learn-lessons .shelf-row[data-act="lesson"]')).toHaveCount(23);

    for (const sect of ['tactics', 'drills']) {
      await page.goto('/app.html#/learn/' + sect);
      await expect(page).toHaveURL(new RegExp('#/learn/' + sect + '$'));
      await expect(page.locator('#learn-body')).toBeVisible();
    }

    await page.goto('/app.html#/');
    await page.keyboard.press('?');
    await expect(page.locator('#dlg-keys')).toBeVisible();
    // The map is generated from the binding table, so it cannot lie about a key.
    await expect(page.locator('#dlg-keys .keymap kbd')).not.toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#dlg-keys')).toBeHidden();
  });
});
