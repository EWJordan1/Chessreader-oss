/*
 * The scan and probe layer (§7): the jobs, the queue that orders them, the cache that
 * makes a second visit free, and the panels the reader sees.
 *
 *   Scan   pressing Analyse · every ply · depth 18 capped by 600ms · MultiPV 1
 *   Probe  pressing a depth or Lines · the one position on screen · MultiPV 3 · 6000ms
 *
 * Three rules here are the ones that break silently, and each has its comment below:
 * a row whose stamp disagrees is discarded *whole* rather than reconciled; a probe
 * jumps the queue and the scan it interrupted is re-queued whole rather than allowed to
 * commit a shallow number between two deep ones; and the provider's cp/mate are from
 * the side to move, so they are turned White-positive at the moment they are committed
 * and never afterwards.
 */
import { Chess } from 'chess.js';
import { S, PROBE_DEPTHS, currentGame, viewFEN, inVariation, saveSettings } from '../state.js';
import { $, escHtml, toast } from '../dom.js';
import { setEvalFor, setArrowsFor, moveRunHTML, renderBoard, onRender } from '../render.js';
import { enterVariation, exitVariation, onCursor } from '../playback.js';
import { classifyMove } from '../review.js';
import { dbGet, dbPut, dbDelete } from '../memory.js';
import { PV_PLIES } from './uci.js';
import { analyse, engineStatus, onFallback, testRemote } from './provider.js';
import { _resetRemote } from './remote.js';
import { localStatus, onLocalFail } from './local.js';

/*
 * The cache stamp. Two numbers and a name: a row written by another engine, or at
 * another depth, is not comparable with one written by this one, and a single stale
 * evaluation sitting between two fresh ones is how a forced recapture becomes a
 * blunder. So the stamp is checked before a row is read and never reconciled.
 */
export const ENGINE_BUILD = 'sf17.1-lite';
export const SCAN_DEPTH = 18;
export const SCAN_MOVETIME = 600;
export const PROBE_MOVETIME = 6000;

/* The row is debounced rather than written per ply: 2s of quiet, or every 40 plies so a
   scan the reader closes early has still written most of itself. */
const COMMIT_DEBOUNCE_MS = 2000;
const COMMIT_PLIES = 40;
const PROBE_LINES = 3;
/* The second pass (§7): capped at 24 jobs, and only where a second-best could change
   the word. The bounds are review.js's own CONTESTED window, kept in step by hand
   because the two modules judge the same thing from different sides. */
const ALTS_CAP = 24;
const ALTS_CONTESTED = [10, 90];
const MATE_CP = 10000;

const hasDOM = () => typeof document !== 'undefined';
function dispatch(name, detail) {
  if (hasDOM()) document.dispatchEvent(new CustomEvent(name, { detail }));
}
function isAbort(e) { return !!(e && e.name === 'AbortError'); }
const nowMs = () => (typeof performance === 'object' && performance ? performance.now() : Date.now());

/* ===== The analysis object ===== */

export function blankAnalysis() {
  return { build: ENGINE_BUILD, depth: SCAN_DEPTH, evals: [], best: [], pv: [], alts: [], done: 0, altsDone: false };
}
function ensureAnalysis(game) {
  if (!game.analysis || game.analysis.build !== ENGINE_BUILD || game.analysis.depth !== SCAN_DEPTH) {
    game.analysis = blankAnalysis();
  }
  return game.analysis;
}
function countDone(a, n) {
  let c = 0;
  for (let i = 0; i < n; i++) if (a.evals[i] !== undefined) c++;
  return c;
}

/** The scan has reached every position, as against having merely started. */
export function analysisReady(game) {
  const a = game && game.analysis;
  return !!(a && game.fens && a.done >= game.fens.length);
}

/** Both evaluations around move `ply` are in, so a verdict about it is possible. */
export function classifyable(game, ply) {
  const a = game && game.analysis;
  return !!(a && game.moves && game.moves[ply] && a.evals && a.evals[ply] !== undefined && a.evals[ply + 1] !== undefined);
}

/* ===== The stored row ===== */

/*
 * The codec moved to ./codec.js, a leaf both this module and Prep import — the two were
 * spelling the same format out separately. Re-exported here because the row-building
 * functions below are this module's, and a caller reading a row should not have to know
 * which file the spelling lives in.
 */
export {
  encodeEval, decodeEval, encodeEvalList, decodeEvalList, encodeLines, decodeLines,
} from './codec.js';
import {
  encodeEval, decodeEval, encodeEvalList, decodeEvalList, encodeLines, decodeLines,
} from './codec.js';

/** The `evals` row for a game, or null when there is nothing to write. */
export function evalRow(game) {
  const a = game && game.analysis;
  if (!a || !game.id || !game.fens) return null;
  const n = game.fens.length;
  const row = {
    gameId: game.id,
    build: ENGINE_BUILD,
    depth: SCAN_DEPTH,
    plies: n,
    evals: encodeEvalList(a.evals, n),
    lines: encodeLines(a.pv, n),
    alts: encodeEvalList(a.alts, n),
  };
  // The row carries its own size so memUsage() never has to re-read and re-measure it.
  row.bytes = JSON.stringify(row).length;
  return row;
}

/**
 * A stored row onto a game. Returns false — and changes nothing — when the row's stamp
 * disagrees with this build: **the row is discarded whole rather than reconciled**,
 * because one stale number between two fresh ones is how a forced recapture becomes a
 * blunder. A partial row is honest and is kept; the scan then queues only what is
 * missing. A merge only ever fills holes, so a fresh evaluation is never overwritten by
 * a stored one.
 */
export function applyEvalRow(game, row) {
  if (!game || !game.fens || !row || typeof row !== 'object') return false;
  if (row.build !== ENGINE_BUILD || row.depth !== SCAN_DEPTH) return false;
  const n = game.fens.length;
  // A ply count that disagrees is a different game under the same key, not a shorter answer.
  if (row.plies !== undefined && row.plies !== n) return false;
  const evals = decodeEvalList(row.evals, n);
  const { pv, best } = decodeLines(row.lines, n);
  const alts = decodeEvalList(row.alts, n);
  const a = ensureAnalysis(game);
  let anyAlt = false;
  for (let i = 0; i < n; i++) {
    if (a.evals[i] === undefined && evals[i] !== undefined) {
      a.evals[i] = evals[i];
      if (pv[i]) { a.pv[i] = pv[i]; a.best[i] = best[i]; }
    }
    if (i in alts) { anyAlt = true; if (!(i in a.alts)) a.alts[i] = alts[i]; }
  }
  a.done = countDone(a, n);
  // The row has no altsDone column, and it does not need one: the second pass writes
  // its whole shortlist at once, so a complete scan carrying any alt has had its pass.
  if (anyAlt && a.done >= n) a.altsDone = true;
  return true;
}

/* ===== The cache read ===== */

const _readRow = new Set();   // game ids already looked for, so a scrub is not a read per ply

/**
 * The cache is why a returning user never sees a scan: a game coming on screen has its
 * row read and applied **silently, with the engine still unloaded**. Nothing here
 * queues a job — that needs a press (§2.7).
 */
export async function hydrate(game) {
  if (!game || !game.id || !game.fens) return false;
  if (_readRow.has(game.id)) return !!(game.analysis && game.analysis.done);
  _readRow.add(game.id);
  const row = await dbGet('evals', game.id);
  // A disagreeing row is ignored rather than deleted: the next scan overwrites it, and
  // silently erasing a reader's cache because a build string moved is the worse failure.
  if (!row || !applyEvalRow(game, row)) return false;
  dispatch('cr:analysis', { game });
  if (analysisReady(game)) dispatch('cr:analysis-done', { game });
  paint();
  return true;
}

/** Whether a game's cache already covers it, without loading the engine. */
export async function isCached(game) {
  await hydrate(game);
  return analysisReady(game);
}

/* ===== The queue ===== */

/*
 * One search at a time and one order for them. A probe jumps: a scan is bookkeeping
 * nobody asked for, a probe is a question just asked. The scan caught mid-search is
 * abandoned — its in-flight numbers are thrown away, never committed — and the *task*
 * goes back in the queue, so it resumes by recomputing what is still missing.
 */
const _queue = [];
let _current = null;
let _ctrl = null;          // the in-flight search's abort handle
let _pumping = false;
let _gapWake = null;       // how a probe cuts the sweep's idle gap short
let _searchHooks = [];

/** The sweep's measured estimate feeds on this: one call per completed search. */
export function onSearch(fn) { _searchHooks.push(fn); }
function searched(ms, kind) { for (const fn of _searchHooks) { try { fn(ms, kind); } catch (e) { /* a listener's problem */ } } }

function hasProbe() { return _queue.some(t => t.kind === 'probe'); }

function enqueue(task) {
  _queue.push(task);
  if (task.kind === 'probe') interruptForProbe();
  pump();
  return task;
}

function interruptForProbe() {
  if (_current && _current.kind !== 'probe') {
    _current.interrupted = true;
    if (_ctrl) { try { _ctrl.abort(); } catch (e) { /* already gone */ } }
  }
  if (_gapWake) { const w = _gapWake; _gapWake = null; w(); }
}

function takeNext() {
  const i = _queue.findIndex(t => t.kind === 'probe');
  return _queue.splice(i >= 0 ? i : 0, 1)[0];
}

async function pump() {
  if (_pumping) return;
  _pumping = true;
  try {
    while (_queue.length) {
      const task = takeNext();
      _current = task;
      try {
        if (task.kind === 'probe') await runProbe(task);
        else if (task.kind === 'alts') await runAlts(task);
        else await runScan(task);
      } catch (e) { /* every runner settles its own callers */ }
      _current = null;
      _ctrl = null;
    }
  } finally {
    _pumping = false;
    _current = null;
    flushRow();
    paint();
  }
}

/** An interruptible idle gap. Resolves true when a probe cut it short. */
function gap(ms) {
  if (!ms) return Promise.resolve(false);
  return new Promise(resolve => {
    const t = setTimeout(() => { _gapWake = null; resolve(false); }, ms);
    _gapWake = () => { clearTimeout(t); resolve(true); };
  });
}

/* ===== The scan ===== */

function nextMissing(game) {
  const a = game.analysis;
  const skip = game._noScore;
  for (let i = 0; i < game.fens.length; i++) {
    if (a.evals[i] === undefined && !(skip && skip.has(i))) return i;
  }
  return -1;
}

/** cp/mate from the side to move → White-positive, at the one moment they are committed. */
export function whitePositive(score, fen) {
  if (!score) return undefined;
  const black = String(fen).split(' ')[1] === 'b';
  if (score.mate !== undefined) {
    if (!Number.isFinite(score.mate)) return undefined;
    // -0 is not 0 in a stored string, and a mated side to move answers `mate 0`.
    return { mate: black && score.mate !== 0 ? -score.mate : score.mate };
  }
  if (!Number.isFinite(score.cp)) return undefined;
  return { cp: black ? -score.cp : score.cp };
}

function commit(game, i, r) {
  const a = ensureAnalysis(game);
  const ev = whitePositive(r && (r.mate !== undefined ? { mate: r.mate } : { cp: r.cp }), game.fens[i]);
  if (ev === undefined) {
    // A search that answered without a score is not a zero. Skip the ply rather than
    // commit a plausible number, and remember it so the scan does not spin on it.
    (game._noScore || (game._noScore = new Set())).add(i);
    return false;
  }
  a.evals[i] = ev;
  a.pv[i] = (r.pv || []).slice(0, PV_PLIES);
  a.best[i] = a.pv[i][0] || null;
  a.done = countDone(a, game.fens.length);
  _lastDepth = r.depth || _lastDepth;
  markDirty(game);
  dispatch('cr:analysis', { game });
  return true;
}

async function runScan(task) {
  const game = task.game;
  for (;;) {
    if (task.stopped) { finish(task, false); return; }
    if (hasProbe()) { requeue(task); return; }
    const i = nextMissing(game);
    if (i < 0) break;
    _ctrl = new AbortController();
    const t0 = nowMs();
    let r;
    try {
      r = await analyse(game.fens[i], {
        depth: SCAN_DEPTH, movetimeMs: SCAN_MOVETIME, multipv: 1, kind: task.kind, signal: _ctrl.signal,
      });
    } catch (e) {
      _ctrl = null;
      // Abandoned, not failed: the numbers are dropped and the whole task re-queued.
      // Stopped is different from interrupted: nobody is coming back for it.
      if (isAbort(e)) { if (task.stopped) finish(task, false); else requeue(task); return; }
      engineDied(e, task);
      return;
    }
    _ctrl = null;
    searched(nowMs() - t0, task.kind);
    commit(game, i, r);
    paintProgress();
    if (task.paceMs) {
      const cut = await gap(task.paceMs);
      if (cut) { requeue(task); return; }
    }
  }
  flushRow();
  dispatch('cr:analysis-done', { game });
  // The two words that need a second pass, asked for only once the scan has drained.
  if (!game.analysis.altsDone && !task.noAlts) queueAlts(game, task.kind, task.paceMs);
  finish(task, true);
}

function requeue(task) { if (!_queue.includes(task)) _queue.unshift(task); task.interrupted = false; }
function finish(task, v) { if (task.done) { task.done(v); task.done = null; } }

function engineDied(e, task) {
  finish(task, false);
  if (hasDOM()) toast('The engine stopped: ' + (e && e.message ? e.message : 'no answer') + '. Press Analyse to try again.');
  paint();
}

/* ===== The probe ===== */

let _probe = null;   // {fen, ply, lines:[{ev, pv, sans}], depth} — the answer on screen

async function runProbe(task) {
  _ctrl = new AbortController();
  const t0 = nowMs();
  try {
    const r = await analyse(task.fen, {
      depth: task.depth, movetimeMs: PROBE_MOVETIME, multipv: PROBE_LINES, kind: 'probe', signal: _ctrl.signal,
    });
    searched(nowMs() - t0, 'probe');
    const lines = (r.lines && r.lines.length ? r.lines : [r]).slice(0, PROBE_LINES).map(l => ({
      ev: whitePositive(l.mate !== undefined ? { mate: l.mate } : { cp: l.cp }, task.fen),
      pv: (l.pv || []).slice(0, PV_PLIES),
    }));
    _probe = { fen: task.fen, ply: task.ply, depth: r.depth || task.depth, lines: lines.filter(l => l.ev !== undefined) };
    paint();
    if (task.resolve) task.resolve(_probe);
  } catch (e) {
    _probe = null;
    if (task.reject) task.reject(e);
    if (!isAbort(e) && hasDOM()) toast('The engine could not answer that position.');
    paint();
  } finally { _ctrl = null; }
}

/* ===== The second pass: MultiPV 2 over a shortlist ===== */

function uciOf(m) { return m.from + m.to + (m.promotion || ''); }
function cpOf(ev, fen) {
  if (!ev) return null;
  if (ev.mate === undefined) return ev.cp;
  if (ev.mate > 0) return MATE_CP;
  if (ev.mate < 0) return -MATE_CP;
  return fen && fen.split(' ')[1] === 'b' ? MATE_CP : -MATE_CP;
}
function winPct(cp) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/**
 * Which plies the second pass asks about. Not the game: only where the played move was
 * already the engine's (the two words are claims about a *best* move), only in a
 * contested position (nobody calls a move in a won game Brilliant), capped at 24, and
 * sharpest first — the swing across the move is the cheapest honest proxy for a
 * position where the second-best line falls away.
 */
export function altsShortlist(game, cap = ALTS_CAP) {
  const a = game && game.analysis;
  if (!a || !game.moves || !game.fens) return [];
  const rows = [];
  for (let n = 0; n < game.moves.length; n++) {
    if (!classifyable(game, n)) continue;
    if (a.alts && n in a.alts) continue;                 // already answered, either way
    if (!a.best || a.best[n] !== uciOf(game.moves[n])) continue;
    const white = game.moves[n].color === 'w';
    const before = cpOf(a.evals[n], game.fens[n]);
    const after = cpOf(a.evals[n + 1], game.fens[n + 1]);
    if (before === null || after === null) continue;
    const mine = white ? winPct(before) : 100 - winPct(before);
    if (mine < ALTS_CONTESTED[0] || mine > ALTS_CONTESTED[1]) continue;
    rows.push({ n, swing: Math.abs(after - before) });
  }
  rows.sort((x, y) => y.swing - x.swing || x.n - y.n);
  return rows.slice(0, cap).map(r => r.n).sort((x, y) => x - y);
}

function queueAlts(game, kind, paceMs) {
  const plies = altsShortlist(game);
  if (!plies.length) {
    game.analysis.altsDone = true;
    markDirty(game);
    dispatch('cr:alts-done', { game });
    return null;
  }
  return enqueue({ kind: 'alts', game, plies, paceMs: paceMs || 0, sourceKind: kind === 'sweep' ? 'sweep' : 'scan' });
}

async function runAlts(task) {
  const game = task.game;
  const a = game.analysis;
  while (task.plies.length) {
    if (task.stopped) { finish(task, false); return; }
    if (hasProbe()) { requeue(task); return; }
    const n = task.plies[0];
    _ctrl = new AbortController();
    const t0 = nowMs();
    let r;
    try {
      r = await analyse(game.fens[n], {
        depth: SCAN_DEPTH, movetimeMs: SCAN_MOVETIME, multipv: 2, kind: task.sourceKind, signal: _ctrl.signal,
      });
    } catch (e) {
      _ctrl = null;
      if (isAbort(e)) { if (task.stopped) finish(task, false); else requeue(task); return; }
      // The pass is a nicety: a failure leaves alts as they are and says nothing. The
      // review then says `best`, which is the honest answer to "we do not know".
      finish(task, false);
      return;
    }
    _ctrl = null;
    searched(nowMs() - t0, task.sourceKind);
    task.plies.shift();
    const second = r.lines && r.lines[1];
    // null is not "no answer": it is "asked, and the position was forced" — the engine
    // found no second move. undefined stays undefined for the plies never asked about.
    a.alts[n] = second ? (whitePositive(second.mate !== undefined ? { mate: second.mate } : { cp: second.cp }, game.fens[n]) || null) : null;
    markDirty(game);
    if (task.paceMs) { const cut = await gap(task.paceMs); if (cut) { requeue(task); return; } }
  }
  a.altsDone = true;
  markDirty(game);
  flushRow();
  dispatch('cr:alts-done', { game });
  finish(task, true);
}

/* ===== The debounced write ===== */

let _rowTimer = 0;
let _sinceWrite = 0;
const _dirty = new Set();

function markDirty(game) {
  _dirty.add(game);
  if (++_sinceWrite >= COMMIT_PLIES) { flushRow(); return; }
  if (!_rowTimer) _rowTimer = setTimeout(flushRow, COMMIT_DEBOUNCE_MS);
}

/** Write every dirty game's row now. Gated on S.remember, as memory's own writes are. */
export function flushRow() {
  if (_rowTimer) { clearTimeout(_rowTimer); _rowTimer = 0; }
  _sinceWrite = 0;
  const games = [..._dirty];
  _dirty.clear();
  if (!S.remember) return;
  for (const g of games) { const row = evalRow(g); if (row) dbPut('evals', row); }
}

/**
 * Memory cannot serialise game.analysis itself, so a game analysed while the switch was
 * off would be re-analysed the moment it came back on. This is memory's ask, answered
 * here: when `remember` goes on, every analysed game in the session writes its row.
 */
export function persistAllRows() {
  const rows = [];
  for (const g of S.games) {
    if (g && g.analysis && g.analysis.done > 0) { const r = evalRow(g); if (r) rows.push(r); }
  }
  for (const r of rows) dbPut('evals', r);
  return rows.length;
}

/* ===== The public jobs ===== */

/**
 * The press behind #btn-analyse: cache first, then queue only what is missing. Resolves
 * when the game is evaluated end to end (or false if the scan was stopped or failed).
 */
export async function analyseGame(game, opts = {}) {
  const g = game || currentGame();
  if (!g || !g.fens || !g.fens.length) return false;
  await hydrate(g);
  ensureAnalysis(g);
  const running = _queue.find(t => t.game === g && t.kind !== 'probe') || (_current && _current.game === g ? _current : null);
  if (running) return running.promise || true;
  if (analysisReady(g)) {
    dispatch('cr:analysis-done', { game: g });
    // Cached to the last ply, but the second pass may never have run: the press covers it.
    if (!g.analysis.altsDone && !opts.noAlts) { const t = queueAlts(g, opts.kind || 'scan', opts.paceMs); if (t) { paint(); return t.promise || true; } }
    paint();
    return true;
  }
  const task = { kind: opts.kind === 'sweep' ? 'sweep' : 'scan', game: g, paceMs: opts.paceMs || 0, noAlts: !!opts.noAlts };
  task.promise = new Promise(res => { task.done = res; });
  enqueue(task);
  paint();
  return task.promise;
}

/** MultiPV 3 for the position on screen. Jumps the queue. */
export function probe(fen, depth) {
  const f = fen || viewFEN();
  if (!f) return Promise.resolve(null);
  const d = PROBE_DEPTHS.includes(depth) ? depth : (PROBE_DEPTHS.includes(S.probeDepth) ? S.probeDepth : PROBE_DEPTHS[1]);
  const task = { kind: 'probe', fen: f, depth: d, ply: inVariation() ? -1 : S.ply };
  task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
  enqueue(task);
  paint();
  return task.promise;
}

/** Drop a game's queued and running scan. The row keeps whatever was committed. */
export function cancelGame(game) {
  for (let i = _queue.length - 1; i >= 0; i--) {
    if (_queue[i].game === game) { _queue[i].stopped = true; finish(_queue[i], false); _queue.splice(i, 1); }
  }
  if (_current && _current.game === game) {
    _current.stopped = true;
    if (_ctrl) { try { _ctrl.abort(); } catch (e) { /* gone */ } }
    if (_gapWake) { const w = _gapWake; _gapWake = null; w(); }
  }
  flushRow();
}

/** Everything but a probe: what stopping the sweep does. */
export function cancelScans() {
  for (const t of [..._queue]) if (t.kind !== 'probe') cancelGame(t.game);
  if (_current && _current.kind !== 'probe' && _current.game) cancelGame(_current.game);
}

/** For the sweep's bar and the status line: what the engine is doing now. */
export function jobState() {
  return {
    kind: _current ? _current.kind : null,
    game: _current ? _current.game || null : null,
    queued: _queue.length,
    depth: _lastDepth,
    local: localStatus(),
  };
}

/* ===== What the reader sees ===== */

let _lastDepth = 0;

function evalFor(game, ply) {
  const a = game && game.analysis;
  if (!a || !a.evals) return null;
  const ev = a.evals[ply];
  return ev === undefined ? null : ev;
}

/*
 * Two arrows and two sentences: green is the move the engine plays in the position on
 * screen, amber is what it wanted instead of the move just played. The amber is drawn
 * only where classifyMove() calls the move an error — the guarded vocabulary, not a
 * threshold of our own, so the arrow, the tree mark and the spoken verdict cannot
 * disagree about whether a move was a mistake.
 */
function arrowsFor(game) {
  const a = game && game.analysis;
  if (!a || !a.best) return [];
  const out = [];
  const best = a.best[S.ply];
  if (best) out.push({ from: best.slice(0, 2), to: best.slice(2, 4), kind: 'best' });
  const n = S.ply - 1;
  if (n >= 0 && classifyable(game, n) && classifyMove(game, n)) {
    const wanted = a.best[n];
    if (wanted) out.push({ from: wanted.slice(0, 2), to: wanted.slice(2, 4), kind: 'missed' });
  }
  return out;
}

function fmtEval(ev) {
  if (!ev) return '';
  if (ev.mate !== undefined) return ev.mate === 0 ? 'mate' : (ev.mate > 0 ? 'M' : '-M') + Math.abs(ev.mate);
  const v = ev.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
}

function pvSans(fen, uci) {
  const out = [];
  try {
    const c = new Chess(fen);
    for (const u of uci) {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!m) break;
      out.push(m.san);
    }
  } catch (e) { /* a line the position does not admit stops where it stops */ }
  return out;
}

function depthSaid() { return _lastDepth ? ' · depth ' + _lastDepth + ' reached' : ''; }

function statusText() {
  const g = currentGame();
  if (!g) return '';
  const a = g.analysis;
  const job = _current;
  const n = g.fens.length;
  if (localStatus() === 'loading') return 'Loading the engine…';
  if (job && job.kind === 'probe') return 'Asking the engine about this position at depth ' + job.depth + '…';
  if (job && job.game === g && job.kind === 'alts') return 'Checking the standout moves…' + depthSaid();
  // The depth is only claimed once a search has actually reached one: "depth 18" said
  // before the first search lands is the engine's setting, not its answer.
  if (job && job.game === g) return 'Analysing… ' + a.done + ' of ' + n + depthSaid() + '.';
  if (!a || !a.done) return '';
  if (a.done >= n) return 'Analysed at depth ' + SCAN_DEPTH + (a.altsDone ? '.' : ' · the standout moves are still to check.');
  return a.done + ' of ' + n + ' positions evaluated at depth ' + SCAN_DEPTH + '. Press Analyse to finish.';
}

function paintProgress() {
  if (!hasDOM()) return;
  const el = $('analysis-status');
  if (el) el.textContent = statusText();
}

/* The scrubber's marks: one per move the guarded vocabulary calls an error, at its
   place along the slider, so "where did it go wrong" is answerable without reading. */
function paintMarks() {
  const el = $('scrub-marks');
  if (!el) return;
  const g = currentGame();
  if (!g || !g.analysis || !g.moves.length) { el.innerHTML = ''; return; }
  const len = g.moves.length;
  let html = '';
  for (let n = 0; n < len; n++) {
    if (!classifyable(g, n)) continue;
    const tier = classifyMove(g, n);
    if (!tier) continue;
    html += '<i class="scrub-mark ' + tier + '" style="left:' + ((n + 1) / len * 100).toFixed(2) + '%" title="' +
      escHtml('Move ' + (Math.floor(n / 2) + 1) + ': ' + tier) + '"></i>';
  }
  el.innerHTML = html;
}

function paintTools() {
  const btn = $('btn-analyse');
  const g = currentGame();
  if (btn) {
    btn.classList.toggle('hidden', !g);
    const busy = !!(_current && _current.game === g);
    btn.disabled = busy;
    btn.textContent = busy ? 'Analysing…' : (g && analysisReady(g) ? 'Analysed' : 'Analyse');
  }
  const tools = $('analysis-tools');
  if (!tools) return;
  if (!g) { tools.innerHTML = ''; return; }
  const want = PROBE_DEPTHS.map(d => '<button class="btn btn-depth" type="button" data-depth="' + d + '"' +
    (S.probeDepth === d ? ' aria-pressed="true"' : '') + '>d' + d + '</button>').join('') +
    '<button class="btn" type="button" id="btn-lines">Lines</button>';
  if (tools.dataset.sig !== String(S.probeDepth)) { tools.innerHTML = want; tools.dataset.sig = String(S.probeDepth); }
}

function engineSection() {
  const mount = $('analysis-mount');
  if (!mount) return null;
  let sec = $('engine-section');
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'panel';
    sec.id = 'engine-section';
    sec.innerHTML = '<header class="panel-head"><h2>Engine</h2><span class="muted" id="engine-note"></span></header>' +
      '<div class="panel-body" id="engine-body"></div>';
    mount.appendChild(sec);
    sec.addEventListener('click', onPanelClick);
  }
  return sec;
}

function paintPanel() {
  const sec = engineSection();
  if (!sec) return;
  const body = $('engine-body');
  const note = $('engine-note');
  const g = currentGame();
  const fen = viewFEN();
  if (!g) {
    sec.classList.add('hidden');
    return;
  }
  sec.classList.remove('hidden');
  const status = engineStatus();
  if (note) note.textContent = status.remote === 'ok' ? 'remote' : (status.local === 'ready' ? 'local' : '');
  if (!_probe || _probe.fen !== fen) {
    body.innerHTML = '<p class="hint">The engine has not been asked about this position. ' +
      '<button class="btn" type="button" id="btn-lines-empty">Lines</button> — or press <kbd>L</kbd>.</p>';
    return;
  }
  const from = inVariation() ? 0 : S.ply;
  let html = '<div class="eng-lines">';
  _probe.lines.forEach((l, k) => {
    const sans = pvSans(_probe.fen, l.pv);
    html += '<div class="eng-line" data-line="' + k + '">' +
      '<span class="eng-score num">' + escHtml(fmtEval(l.ev)) + '</span>' +
      '<span class="eng-moves">' + (sans.length ? moveRunHTML(sans, { style: 'line', from, at: -1, attr: 'data-pv' }) : '<span class="hint">no line</span>') + '</span>' +
      '</div>';
  });
  html += '</div><p class="hint eng-foot">Depth ' + _probe.depth + '. A press on a move plays the line on the board.</p>';
  body.innerHTML = html;
}

function onPanelClick(e) {
  const depthBtn = e.target.closest('[data-depth]');
  if (depthBtn) { pressDepth(+depthBtn.dataset.depth); return; }
  if (e.target.id === 'btn-lines-empty') { probe(viewFEN(), S.probeDepth); return; }
  const mv = e.target.closest('[data-pv]');
  if (!mv || !_probe) return;
  const lineEl = mv.closest('[data-line]');
  if (!lineEl) return;
  const line = _probe.lines[+lineEl.dataset.line];
  if (!line) return;
  const from = inVariation() ? 0 : S.ply;
  const upto = Math.max(0, (+mv.dataset.pv) - from);
  // A press walks the line as a variation of the reader's own — the same one they get
  // from the board, so nothing downstream needs a second kind of "position on screen".
  if (inVariation()) exitVariation(true);
  for (let i = 0; i <= upto && i < line.pv.length; i++) enterVariation(line.pv[i]);
}

/* The Test button's one sentence. Three outcomes, three sentences — see describeHealth. */
function sayHealth(text, ok) {
  const el = $('engine-test-result');
  if (!el) return;
  el.textContent = text;
  el.style.color = text && ok !== undefined ? (ok ? 'var(--good)' : 'var(--danger)') : '';
}

function pressDepth(d) {
  if (!PROBE_DEPTHS.includes(d)) return;
  S.probeDepth = d;
  saveSettings();
  paintTools();
  probe(viewFEN(), d);
}

/** One repaint for everything this module draws. */
export function paint() {
  if (!hasDOM()) return;
  paintTools();
  paintProgress();
  paintMarks();
  paintPanel();
}

/* ===== boot ===== */

export function boot() {
  // The two hooks the stage reads. Installed before any DOM check, so a headless
  // caller still gets the eval bar and the arrows wired.
  setEvalFor(evalFor);
  setArrowsFor(arrowsFor);
  if (!hasDOM()) return;

  const btn = $('btn-analyse');
  if (btn) btn.addEventListener('click', () => analyseGame(currentGame()));
  const tools = $('analysis-tools');
  if (tools) tools.addEventListener('click', e => {
    const d = e.target.closest('[data-depth]');
    if (d) { pressDepth(+d.dataset.depth); return; }
    if (e.target.id === 'btn-lines') probe(viewFEN(), S.probeDepth);
  });

  document.addEventListener('cr:analyse', () => analyseGame(currentGame()));
  document.addEventListener('cr:lines', () => probe(viewFEN(), S.probeDepth));

  // The cache read: a game arriving on screen, or a library coming back off the disk.
  // Silent, and the engine stays unloaded.
  onCursor(() => {
    const g = currentGame();
    if (_probe && _probe.fen !== viewFEN()) { _probe = null; }
    if (g) hydrate(g);
    paint();
  });
  document.addEventListener('cr:restored', () => { const g = currentGame(); if (g) hydrate(g); paint(); });
  document.addEventListener('cr:games-added', () => { const g = currentGame(); if (g) hydrate(g); paint(); });
  document.addEventListener('cr:games-removed', e => {
    const ids = (e.detail && e.detail.ids) || [];
    for (const id of ids) _readRow.delete(id);
  });

  // Memory's ask: the switch coming on has to catch up the games analysed while it was off.
  document.addEventListener('cr:setting', e => {
    if (!e.detail) return;
    if (e.detail.key === 'remember' && S.remember) persistAllRows();
    // A new address is a new server: the cached socket and the last verdict both go.
    if (e.detail.key === 'engineUrl' || e.detail.key === 'engineToken') { _resetRemote(); sayHealth(''); }
  });

  const test = $('btn-engine-test');
  if (test) test.addEventListener('click', async () => {
    sayHealth('Asking…');
    const r = await testRemote();
    sayHealth(r.text, r.ok);
  });

  // The engine's own bad news, said once and in a sentence.
  onLocalFail(err => toast('The engine could not start: ' + (err && err.message ? err.message : 'unknown') + '. Everything else still works.'));
  onFallback(() => toast('The remote engine did not answer, so this is running locally.'));

  onRender('board', paint);
  onRender('all', paint);
  paint();
}

/* Test seam: a clean queue between cases. */
export function _resetAnalyse() {
  _queue.length = 0;
  _current = null; _ctrl = null; _pumping = false; _gapWake = null;
  _probe = null; _lastDepth = 0;
  _readRow.clear(); _dirty.clear();
  if (_rowTimer) { clearTimeout(_rowTimer); _rowTimer = 0; }
  _sinceWrite = 0; _searchHooks = [];
}

/**
 * Forget what is known about a game so the next press analyses it from nothing: the
 * sweep's "re-analyse". The stored row goes with it, or the next hydrate would put the
 * old numbers straight back.
 */
export function forgetCache(game) {
  if (!game || !game.id) return;
  cancelGame(game);
  _readRow.delete(game.id);
  game.analysis = blankAnalysis();
  game._noScore = null;
  dbDelete('evals', game.id);
  paint();
}
