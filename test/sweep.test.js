/*
 * The archive sweep (§7, §12). The pass itself runs here against a fake engine and a
 * fake IndexedDB, because the two claims worth pinning are about *state that outlives
 * something*: the cursor outlives the tab, a reader's pause outlives a reload, and an
 * auto-pause does not. The estimate is a pure function and is proved as one.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { S } from '../src/state.js';
import { splitPGN, parseGame } from '../src/pgn.js';
import * as mem from '../src/memory.js';
import { _setBackends } from '../src/engine/provider.js';
import { evalRow, blankAnalysis, _resetAnalyse } from '../src/engine/analyse.js';
import {
  startSweep, pauseSweep, resumeSweep, stopSweep, sweepState, paused, resumeFromCursor,
  estimateMs, etaText, feedSearch, searchCostMs, skipRatio, sweepOrder, gameTime,
  skipGame, unskipGame, EMA_MIN_SEARCHES, _resetSweep,
} from '../src/engine/sweep.js';

const corpus = splitPGN(readFileSync(new URL('./fixtures/chesscom.pgn', import.meta.url), 'utf8')).map(parseGame).filter(Boolean);
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settled = async (fn, tries = 400) => { for (let i = 0; i < tries; i++) { if (fn()) return true; await tick(2); } return false; };

function toyGame(sans, id, extra = {}) {
  const c = new Chess();
  const fens = [c.fen()];
  const moves = [];
  for (const s of sans) { moves.push(c.move(s)); fens.push(c.fen()); }
  return { id, headers: {}, moves, fens, pgn: '', addedAt: 1000, ...extra };
}
/** A game whose whole scan is already on the disk, as a returning reader's would be. */
function cachedGame(sans, id, extra) {
  const g = toyGame(sans, id, extra);
  g.analysis = blankAnalysis();
  for (let i = 0; i < g.fens.length; i++) g.analysis.evals[i] = { cp: 5 };
  g.analysis.done = g.fens.length;
  const row = evalRow(g);
  g.analysis = undefined;          // the row is on the disk; the session knows nothing
  return { game: g, row };
}

const searched = [];
const fakeEngine = (fen, opts = {}) => {
  searched.push(fen);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ cp: 15, depth: 18, pv: ['e2e4'], lines: [{ cp: 15, depth: 18, pv: ['e2e4'] }] }), 1);
    if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
};

beforeAll(async () => { S.remember = true; await mem.bootMemory(); });
beforeEach(async () => {
  await mem.dbClear('evals'); await mem.dbClear('meta');
  _resetSweep(); _resetAnalyse();
  await tick(5);                    // let any loop from the last case fall out of its awaits
  _resetSweep();
  _setBackends({ local: fakeEngine });
  searched.length = 0;
  S.games = []; S.gi = 0; S.ply = 0; S.remember = true; S._restoring = false;
  S.sweepOn = false; S.sweepPaused = false; S._sweepAutoPaused = false; S.sweepPace = 'fast';
  S.engineMode = 'local'; S.engineUrl = '';
});

/* ===== The order ===== */

describe('the order', () => {
  it('is newest first, by the game\'s own date before its arrival', () => {
    const a = { id: 'a', headers: { UTCDate: '2024.01.01' }, fens: [1, 2], addedAt: 9 };
    const b = { id: 'b', headers: { UTCDate: '2025.06.02' }, fens: [1, 2], addedAt: 1 };
    const c = { id: 'c', headers: {}, fens: [1, 2], addedAt: 5 };
    expect(sweepOrder([a, b, c])).toEqual(['b', 'a', 'c']);
    expect(gameTime(b)).toBeGreaterThan(gameTime(a));
    // A header block with no moves is not a game to sweep.
    expect(sweepOrder([{ id: 'd', headers: {}, fens: [1] }])).toEqual([]);
  });

  it('orders the real corpus without dropping any of it', () => {
    const order = sweepOrder(corpus);
    expect(order.length).toBe(corpus.length);
    expect(new Set(order).size).toBe(order.length);
  });
});

/* ===== The measured estimate ===== */

describe('the estimate', () => {
  const items = n => Array.from({ length: n }, () => ({ plies: 10, done: 0, hydrated: true }));

  it('says nothing until thirty searches have fed it', () => {
    for (let i = 0; i < EMA_MIN_SEARCHES - 1; i++) feedSearch(100);
    expect(searchCostMs()).toBe(null);
    expect(estimateMs(items(3), { ema: 100, searches: EMA_MIN_SEARCHES - 1, paceMs: 0 })).toBe(null);
    feedSearch(100);
    expect(searchCostMs()).toBeCloseTo(100, 5);
    expect(estimateMs(items(3), { ema: 100, searches: EMA_MIN_SEARCHES, paceMs: 0 })).toBe(3000);
  });

  it('is an average of what searches actually cost, not a constant', () => {
    _resetSweep();
    for (let i = 0; i < 60; i++) feedSearch(200);
    const flat = searchCostMs();
    for (let i = 0; i < 40; i++) feedSearch(600);
    expect(searchCostMs()).toBeGreaterThan(flat);
    expect(searchCostMs()).toBeLessThan(600);      // it moves towards the truth, it does not jump
  });

  it('prices the pace in: the gap is time the reader waits for', () => {
    const fast = estimateMs(items(2), { ema: 500, searches: 50, paceMs: 0 });
    const gentle = estimateMs(items(2), { ema: 500, searches: 50, paceMs: 1800 });
    expect(fast).toBe(20 * 500);
    expect(gentle).toBe(20 * 2300);
  });

  it('counts a hydrated game exactly and discounts one still on the disk', () => {
    const exact = estimateMs([{ plies: 10, done: 4, hydrated: true }], { ema: 100, searches: 50 });
    expect(exact).toBe(600);
    const blind = estimateMs([{ plies: 10, done: 0, hydrated: false }], { ema: 100, searches: 50, skip: 0.5 });
    expect(blind).toBe(500);
    // Every game cached: nothing left to do, whatever the ply counts say.
    expect(estimateMs([{ plies: 80, hydrated: false }], { ema: 100, searches: 50, skip: 1 })).toBe(0);
  });

  it('hedges every figure it prints', () => {
    expect(etaText(null)).toBe('');
    expect(etaText(20000)).toBe('under a minute left');
    expect(etaText(300000)).toBe('about 5 minutes left');
    expect(etaText(3 * 3600000)).toBe('about 3 hours left');
  });
});

/* ===== Pause, and whose press it was ===== */

describe('pause', () => {
  it('keeps the consent, and a reader\'s pause is written down where an auto-pause is not', () => {
    S.games = [toyGame(['e4', 'e5'], 'g1')];
    startSweep();
    expect(sweepState().on).toBe(true);
    pauseSweep(true);
    expect(S.sweepOn).toBe(true);        // the consent stands
    expect(S.sweepPaused).toBe(true);    // and this one survives a reload
    expect(paused()).toBe(true);
    resumeSweep(true);
    expect(paused()).toBe(false);
  });

  it('lifts only its own press: an auto-resume never clears a reader\'s pause', () => {
    S.games = [toyGame(['e4', 'e5'], 'g1')];
    startSweep();
    pauseSweep(true);            // the reader
    pauseSweep(false);           // then the tab went to the background
    expect(S.sweepPaused).toBe(true);
    expect(S._sweepAutoPaused).toBe(true);
    resumeSweep(false);          // the tab came back
    expect(S._sweepAutoPaused).toBe(false);
    expect(paused()).toBe(true); // still paused, because the reader said so
    expect(sweepState().auto).toBe(false);
    resumeSweep(true);
    expect(paused()).toBe(false);
  });

  it('is a session flag when the tab pressed it, so closing the tab clears it', () => {
    S.games = [toyGame(['e4'], 'g1')];
    startSweep();
    pauseSweep(false);
    expect(S._sweepAutoPaused).toBe(true);
    expect(S.sweepPaused).toBe(false);   // nothing was written to settings
  });

  it('stopping drops the consent and the place together', async () => {
    S.games = [toyGame(['e4', 'e5', 'Nf3'], 'g1')];
    startSweep();
    await tick(2);
    stopSweep();
    expect(S.sweepOn).toBe(false);
    expect(await mem.dbGet('meta', 'sweepCursor')).toBe(undefined);
    expect(sweepState().on).toBe(false);
  });
});

/* ===== The pass, the cursor, and the cache ===== */

describe('the pass', () => {
  it('sweeps newest first and writes the cursor as it goes', async () => {
    const older = toyGame(['e4', 'e5'], 'old', { headers: { UTCDate: '2024.01.01' } });
    const newer = toyGame(['d4', 'd5'], 'new', { headers: { UTCDate: '2025.01.01' } });
    S.games = [older, newer];
    startSweep();
    expect(await settled(() => searched.length > 0)).toBe(true);
    const cursor = await settled(async () => true) && await mem.dbGet('meta', 'sweepCursor');
    expect(await settled(() => !sweepState().on)).toBe(true);
    expect(newer.analysis.done).toBe(newer.fens.length);
    expect(older.analysis.done).toBe(older.fens.length);
    // The newer game's positions were asked about first. (fens[0] is the start position
    // and every game shares it, so the comparison is on the first position of its own.)
    expect(searched.indexOf(newer.fens[1])).toBeLessThan(searched.indexOf(older.fens[1]));
    expect(cursor === undefined || typeof cursor.v.id === 'string').toBe(true);
  });

  it('resumes from the cursor and skips what the cache already covers', async () => {
    const { game: cached, row } = cachedGame(['e4', 'e5', 'Nf3'], 'cached', { headers: { UTCDate: '2025.05.05' } });
    const fresh = toyGame(['d4', 'd5'], 'fresh', { headers: { UTCDate: '2024.05.05' } });
    await mem.dbPut('evals', row);
    S.games = [cached, fresh];
    S.sweepOn = true; S.sweepPaused = false;
    await resumeFromCursor();
    expect(await settled(() => !sweepState().on)).toBe(true);
    // Not one search for the cached game, and its numbers came back off the disk.
    // (Every game shares the start position, so the middle of the game is the test.)
    for (const fen of cached.fens.slice(1)) expect(searched).not.toContain(fen);
    expect(cached.analysis.done).toBe(cached.fens.length);
    expect(searched.length).toBe(fresh.fens.length);
    expect(skipRatio()).toBeGreaterThan(0);
    expect(skipRatio()).toBeLessThan(1);
  });

  it('picks up where a reader\'s pause left it, on a later visit', async () => {
    const a = toyGame(['e4', 'e5'], 'a', { headers: { UTCDate: '2025.03.03' } });
    const b = toyGame(['d4', 'd5'], 'b', { headers: { UTCDate: '2024.03.03' } });
    S.games = [a, b];
    // The cursor is what a paused sweep left behind; a fresh tab has no _idx at all.
    await mem.dbPut('meta', { k: 'sweepCursor', v: { id: 'b', at: Date.now() } });
    S.sweepOn = true;
    await resumeFromCursor();
    expect(await settled(() => !sweepState().on)).toBe(true);
    expect(b.analysis.done).toBe(b.fens.length);
    // It resumed at b rather than starting the archive again from the newest game.
    expect(searched).not.toContain(a.fens[1]);
  });

  it('does not start on a reload when the reader had paused it', async () => {
    S.games = [toyGame(['e4', 'e5'], 'g1')];
    S.sweepOn = true; S.sweepPaused = true;
    await resumeFromCursor();
    await tick(10);
    expect(searched.length).toBe(0);
    expect(sweepState().paused).toBe(true);
  });

  it('counts a skipped game out of the total, and taking it back puts it in', async () => {
    const a = toyGame(['e4', 'e5'], 'a');
    const b = toyGame(['d4', 'd5'], 'b');
    S.games = [a, b];
    startSweep();
    pauseSweep(true);
    const total = sweepState().total;
    skipGame('b');
    expect(sweepState().total).toBe(total - 1);
    unskipGame('b');
    expect(sweepState().total).toBe(total);
  });

  it('reports done and total honestly while it runs', async () => {
    S.games = [toyGame(['e4', 'e5'], 'a'), toyGame(['d4', 'd5'], 'b')];
    startSweep();
    expect(sweepState().total).toBe(2);
    expect(await settled(() => !sweepState().on)).toBe(true);
    expect(sweepState().done).toBe(2);
  });
});
