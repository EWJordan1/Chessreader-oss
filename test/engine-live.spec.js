/*
 * The one thing no unit test can prove: that the vendored WebAssembly Stockfish really
 * loads in a browser, answers, and that the numbers reach the page.
 *
 * Deliberately NOT part of `npm run walk` — playwright.config.js matches `walk.spec.js`
 * only. It downloads 7MB and runs a real search, which is a minute the layout walk
 * should not pay on every commit. Run it on purpose:
 *
 *   npx playwright test test/engine-live.spec.js --config test/engine-live.config.js
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const corpus = readFileSync(new URL('./fixtures/chesscom.pgn', import.meta.url), 'utf8');

test.describe('the local engine, for real', () => {
  test('loads, analyses a game, and reports the depth it reached', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('/#/play');
    await page.click('#btn-import');
    await page.fill('#pgn-text', corpus);
    await page.click('#btn-paste-load');
    await expect(page.locator('#chess-board .sq')).toHaveCount(64);

    // Nothing analyses without a press (§2.7): the button is there and the engine is not.
    const analyse = page.locator('#btn-analyse');
    await expect(analyse).toBeVisible();
    await expect(page.locator('#analysis-status')).toHaveText('');

    await analyse.click();
    // The whole claim: a real search, at a real depth, said in the status line.
    await expect(page.locator('#analysis-status')).toContainText(/depth \d+/, { timeout: 120_000 });
    await expect(page.locator('#analysis-status')).toContainText(/Analysing… \d+ of \d+/, { timeout: 120_000 });

    // And the evaluations reach the page: the bar beside the board, and the arrow.
    await expect(page.locator('#eval-bar')).toBeVisible({ timeout: 120_000 });
    // #board-overlay is itself the <svg>; the arrow is a line inside it.
    await expect(page.locator('#board-overlay line.arrow-best')).toHaveCount(1, { timeout: 120_000 });

    // A probe jumps the queue and answers with lines of its own.
    await page.click('#analysis-tools .btn-depth[data-depth="18"]');
    await expect(page.locator('#engine-section .eng-line')).not.toHaveCount(0, { timeout: 120_000 });
    const score = await page.locator('#engine-section .eng-line .eng-score').first().textContent();
    expect(score).toMatch(/[+\-−M\d.]/);

    expect(errors, 'no page errors while the engine ran').toEqual([]);
  });
});
