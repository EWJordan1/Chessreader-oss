/*
 * The archive sweep (§7): the pass that fills the deck.
 *
 * It is a press, not an idle-time job — but the consent outlives the tab, which is the
 * one place this app starts work without a click in front of it: a sweep started
 * yesterday picks up this morning and skips everything already cached. Three flags say
 * so, and they have deliberately different lifetimes:
 *
 *   S.sweepOn      the consent            survives a reload
 *   S.sweepPaused  the reader's own pause survives a reload
 *   S._sweepAutoPaused  a hidden tab's pause  dies with the tab, and lifts only its own press
 *
 * Pace is a duty cycle — an idle gap between searches — and never a depth, because the
 * cache stamp is depth-bearing and a game swept at depth 12 would be discarded whole
 * the next time anything read it. A probe never waits on the gap.
 */
import { S, SWEEP_PACES, saveSettings } from '../state.js';
import { $, escHtml, plural } from '../dom.js';
import { dbGet, dbPut, dbDelete } from '../memory.js';
import { analyseGame, hydrate, analysisReady, cancelGame, onSearch, forgetCache } from './analyse.js';

/*
 * The estimate is measured, not guessed: an exponential moving average of what a search
 * actually costs on this machine. Silent until thirty searches have fed it — a figure
 * from three searches is a guess wearing a number's clothes — and hedged with "about"
 * for the life of the feature, because the machine's other work moves it all day.
 */
const EMA_ALPHA = 0.1;
export const EMA_MIN_SEARCHES = 30;

const hasDOM = () => typeof document !== 'undefined';
function dispatch(name, detail) { if (hasDOM()) document.dispatchEvent(new CustomEvent(name, { detail })); }

let _order = [];          // game ids, newest first
let _idx = 0;             // how far along _order the pass has got
let _skipped = new Set(); // ids the reader took out of the queue
let _hydrated = new Set();// ids whose evals row has been read, so their count is exact
let _current = null;      // the game being swept
let _looping = false;
let _tick = 0;            // the 1Hz repaint, so a long game does not look like a stall
let _ema = 0, _searches = 0;
let _seen = 0, _cachedSkips = 0;   // the observed skip ratio

/* ===== The measured estimate ===== */

/** One completed search, in ms. Fed by analyse.js for every search of any kind. */
export function feedSearch(ms) {
  if (!(ms > 0)) return;
  _searches++;
  _ema = _searches === 1 ? ms : _ema + EMA_ALPHA * (ms - _ema);
}
/** The average cost of a search, or null while the average is still a guess. */
export function searchCostMs() { return _searches >= EMA_MIN_SEARCHES ? _ema : null; }
/** How often a game turned out to be cached already. 0 until something has been looked at. */
export function skipRatio() { return _seen ? _cachedSkips / _seen : 0; }

/**
 * What is left, in milliseconds, or null while the average is silent.
 *
 * items: [{plies, done, hydrated}] — one per game still to visit. A hydrated game is
 * counted exactly (its row has been read, so what is missing is known); a game whose
 * row is still on the disk is discounted by the observed skip ratio, because some
 * proportion of them will turn out to need no searches at all. The pace's gap is priced
 * in per search: it is time the reader waits for, whatever it is spent on.
 */
export function estimateMs(items, { ema, searches, paceMs = 0, skip = 0 } = {}) {
  if (!(searches >= EMA_MIN_SEARCHES) || !(ema > 0)) return null;
  const per = ema + Math.max(0, paceMs);
  const s = Math.max(0, Math.min(1, skip));
  let n = 0;
  for (const it of items || []) {
    if (!it) continue;
    if (it.hydrated) n += Math.max(0, (it.plies || 0) - (it.done || 0));
    else n += (it.plies || 0) * (1 - s);
  }
  return Math.round(per * n);
}

/** "about 6 minutes" / "about a minute" / "under a minute". Always hedged. */
export function etaText(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 45000) return 'under a minute left';
  const mins = Math.round(ms / 60000);
  if (mins <= 1) return 'about a minute left';
  if (mins < 90) return 'about ' + mins + ' minutes left';
  const hours = Math.round(ms / 3600000);
  return 'about ' + plural(hours, 'hour') + ' left';
}

/* ===== The order ===== */

/** A game's moment, for the newest-first order: the PGN's date, then when it arrived. */
export function gameTime(g) {
  const h = (g && g.headers) || {};
  const d = h.UTCDate || h.Date || '';
  const t = h.UTCTime || h.Time || '00:00:00';
  const m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/.exec(String(d));
  if (m) {
    const ms = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + t + 'Z');
    if (Number.isFinite(ms)) return ms;
  }
  return g && g.addedAt ? g.addedAt : (g && g.seq ? g.seq : 0);
}

/** Newest first (§7), ties broken by arrival so the order is stable across reloads. */
export function sweepOrder(games) {
  return games.filter(g => g && g.id && g.fens && g.fens.length > 1)
    .map((g, i) => ({ g, i, t: gameTime(g) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map(r => r.g.id);
}

function gameById(id) { return S.games.find(g => g && g.id === id) || null; }

function buildOrder() {
  const before = _order[_idx];
  _order = sweepOrder(S.games);
  // Games imported mid-sweep join the order; the place is kept by id, not by index.
  if (before) { const at = _order.indexOf(before); _idx = at >= 0 ? at : Math.min(_idx, _order.length); }
  if (_idx > _order.length) _idx = _order.length;
}

/* ===== The state ===== */

export function paused() { return !!(S.sweepPaused || S._sweepAutoPaused); }

function remainingItems() {
  const out = [];
  for (let i = _idx; i < _order.length; i++) {
    const id = _order[i];
    if (_skipped.has(id)) continue;
    const g = gameById(id);
    if (!g) continue;
    const a = g.analysis;
    out.push({ plies: g.fens.length, done: a ? a.done : 0, hydrated: _hydrated.has(id) });
  }
  return out;
}

export function sweepState() {
  const total = _order.filter(id => !_skipped.has(id)).length;
  let done = 0;
  for (let i = 0; i < _idx && i < _order.length; i++) if (!_skipped.has(_order[i])) done++;
  return {
    on: !!S.sweepOn,
    paused: paused(),
    auto: !!S._sweepAutoPaused,
    done,
    total,
    etaMs: estimateMs(remainingItems(), { ema: _ema, searches: _searches, paceMs: paceMs(), skip: skipRatio() }),
  };
}

function paceMs() { return SWEEP_PACES[S.sweepPace] !== undefined ? SWEEP_PACES[S.sweepPace] : 0; }

function emit() {
  dispatch('cr:sweep', sweepState());
  paintBar();
  paintSettings();
}

/* ===== The cursor ===== */

async function writeCursor(id) {
  if (!S.remember) return;
  await dbPut('meta', { k: 'sweepCursor', v: { id, at: Date.now() } });
}
async function readCursor() {
  const row = await dbGet('meta', 'sweepCursor');
  return row && row.v && row.v.id ? row.v.id : null;
}
function clearCursor() { dbDelete('meta', 'sweepCursor'); }

/* ===== The pass ===== */

function nextId() {
  while (_idx < _order.length && _skipped.has(_order[_idx])) _idx++;
  return _idx < _order.length ? _order[_idx] : null;
}

/*
 * A generation, because the loop's awaits outlive the thing that started it: stopping
 * and starting again must not leave yesterday's loop walking today's queue. Every stop,
 * and every reset, moves the generation on and the stale loop returns at its next await.
 */
let _gen = 0;

async function loop() {
  if (_looping) return;
  _looping = true;
  const gen = ++_gen;
  startTick();
  try {
    while (S.sweepOn && !paused() && gen === _gen) {
      buildOrder();
      const id = nextId();
      if (!id) { done(); return; }
      const g = gameById(id);
      if (!g) { _idx++; continue; }
      _current = g;
      emit();
      await hydrate(g);
      _hydrated.add(id);
      _seen++;
      if (analysisReady(g)) {
        // Already cached: the whole argument for the cursor outliving the tab.
        _cachedSkips++;
        _idx++;
        continue;
      }
      await writeCursor(id);
      /*
       * The sweep does not run the MultiPV 2 second pass. Its job is the deck, which
       * needs the evaluations and nothing else; twenty-four extra searches a game to
       * settle two words in a review nobody has opened is the wrong trade at archive
       * scale. A reader's own press on Analyse covers the games they actually read.
       */
      const ok = await analyseGame(g, { kind: 'sweep', paceMs: paceMs(), noAlts: true });
      if (!S.sweepOn || paused()) break;      // the cursor stays on this game
      if (!ok) break;                          // the engine failed; it has said so itself
      _idx++;
    }
  } finally {
    if (gen === _gen) {
      _looping = false;
      _current = null;
      stopTick();
      emit();
    }
  }
}

function done() {
  S.sweepOn = false;
  saveSettings();
  clearCursor();
  _current = null;
}

/* ===== The controls ===== */

export function startSweep() {
  S.sweepOn = true;
  S.sweepPaused = false;
  S._sweepAutoPaused = false;
  saveSettings();
  buildOrder();
  emit();
  loop();
  return sweepState();
}

/**
 * Pause keeps the consent and the place. byUser is the whole difference: a reader's
 * pause is written to settings and survives a reload; a hidden tab's is a session flag
 * that dies with the tab, so a reader who closes a backgrounded tab does not come back
 * to a sweep that says it is paused for a reason they never chose.
 */
export function pauseSweep(byUser = true) {
  if (byUser) { S.sweepPaused = true; saveSettings(); }
  else S._sweepAutoPaused = true;
  if (_current) cancelGame(_current);      // the in-flight search is abandoned, not committed short
  if (_current) writeCursor(_current.id);
  emit();
  return sweepState();
}

/** A resume lifts only its own press: an auto-resume never clears a reader's pause. */
export function resumeSweep(byUser = true) {
  if (byUser) { S.sweepPaused = false; saveSettings(); }
  else S._sweepAutoPaused = false;
  emit();
  if (S.sweepOn && !paused()) loop();
  return sweepState();
}

export function stopSweep() {
  _gen++;
  S.sweepOn = false;
  S.sweepPaused = false;
  S._sweepAutoPaused = false;
  saveSettings();
  if (_current) cancelGame(_current);
  _current = null;
  _idx = 0;
  clearCursor();
  emit();
  return sweepState();
}

/* The queue's per-game actions. */
export function skipGame(id) { _skipped.add(id); const g = gameById(id); if (g && _current === g) cancelGame(g); emit(); }
export function unskipGame(id) { _skipped.delete(id); emit(); }
export function reanalyseGame(id) {
  const g = gameById(id);
  if (!g) return;
  forgetCache(g);
  _hydrated.delete(id);
  _skipped.delete(id);
  const at = _order.indexOf(id);
  if (at >= 0 && at < _idx) _idx = at;     // the pass walks back to it
  emit();
  if (S.sweepOn && !paused()) loop();
}

/* ===== What the reader sees ===== */

function startTick() {
  if (_tick || !hasDOM()) return;
  _tick = setInterval(() => { paintBar(); paintSettings(); }, 1000);
}
function stopTick() { if (_tick) { clearInterval(_tick); _tick = 0; } }

function paintBar() {
  if (!hasDOM()) return;
  const bar = $('sweep-bar');
  if (!bar) return;
  const st = sweepState();
  bar.classList.toggle('hidden', !st.on);
  if (!st.on) { bar.innerHTML = ''; return; }
  const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
  const eta = st.paused ? '' : etaText(st.etaMs);
  bar.innerHTML =
    '<span class="sweep-label">' + (st.paused ? (st.auto && !S.sweepPaused ? 'Sweep paused — this tab is in the background' : 'Sweep paused') : 'Analysing your archive') + '</span>' +
    '<span class="progress"><i style="width:' + pct + '%"></i></span>' +
    '<span class="sweep-count num">' + st.done + ' / ' + st.total + (eta ? ' · ' + eta : '') + '</span>' +
    '<button class="btn" type="button" data-sweep="' + (st.paused ? 'resume' : 'pause') + '">' + (st.paused ? 'Resume' : 'Pause') + '</button>' +
    '<button class="btn" type="button" data-sweep="stop">Stop</button>';
}

function rowState(g, id) {
  if (_skipped.has(id)) return { word: 'skipped', act: 'unskip', label: 'Take back' };
  if (_current === g) return { word: 'analysing now', act: 'skip', label: 'Skip' };
  if (analysisReady(g)) return { word: 'analysed', act: 'reanalyse', label: 'Re-analyse' };
  const a = g.analysis;
  if (a && a.done) return { word: a.done + ' of ' + g.fens.length, act: 'skip', label: 'Skip' };
  return { word: 'waiting', act: 'skip', label: 'Skip' };
}

function paintSettings() {
  if (!hasDOM()) return;
  const mount = $('sweep-settings');
  if (!mount) return;
  const st = sweepState();
  const open = mount.querySelector('details') && mount.querySelector('details').open;
  const controls = st.on
    ? '<button class="btn" type="button" data-sweep="' + (st.paused ? 'resume' : 'pause') + '">' + (st.paused ? 'Resume' : 'Pause') + '</button>' +
      '<button class="btn" type="button" data-sweep="stop">Stop</button>'
    : '<button class="btn btn-primary" type="button" data-sweep="start">Start the sweep</button>';
  let html = '<div class="sweep-controls">' + controls + '<span class="hint">' +
    (st.on
      ? escHtml(st.done + ' of ' + st.total + (st.paused ? ' · paused' : (st.etaMs !== null ? ' · ' + etaText(st.etaMs) : ' · timing it')))
      : (st.total ? escHtml(plural(st.total, 'game') + ' in the archive. Newest first, one at a time, skipping anything already analysed.')
                  : 'Nothing to sweep yet — import some games first.')) +
    '</span></div>';
  if (_order.length) {
    html += '<details class="sweep-queue"' + (open ? ' open' : '') + '><summary>Show the games</summary><div class="sweep-list">';
    for (const id of _order) {
      const g = gameById(id);
      if (!g) continue;
      const r = rowState(g, id);
      const h = g.headers || {};
      html += '<div class="sweep-row' + (_current === g ? ' current' : '') + '">' +
        '<span class="sweep-game">' + escHtml((h.White || '?') + ' vs ' + (h.Black || '?')) + '</span>' +
        '<span class="sweep-word num">' + escHtml(r.word) + '</span>' +
        '<button class="btn btn-sm" type="button" data-sweep="' + r.act + '" data-id="' + escHtml(id) + '">' + r.label + '</button>' +
        '</div>';
    }
    html += '</div></details>';
  }
  mount.innerHTML = html;
}

function onControlClick(e) {
  const btn = e.target.closest('[data-sweep]');
  if (!btn) return;
  const id = btn.dataset.id;
  switch (btn.dataset.sweep) {
    case 'start': startSweep(); break;
    case 'pause': pauseSweep(true); break;
    case 'resume': resumeSweep(true); break;
    case 'stop': stopSweep(); break;
    case 'skip': if (id) skipGame(id); break;
    case 'unskip': if (id) unskipGame(id); break;
    case 'reanalyse': if (id) reanalyseGame(id); break;
  }
}

/* ===== boot ===== */

export async function boot() {
  onSearch(ms => feedSearch(ms));
  buildOrder();
  if (hasDOM()) {
    const bar = $('sweep-bar');
    if (bar) bar.addEventListener('click', onControlClick);
    const mount = $('sweep-settings');
    if (mount) mount.addEventListener('click', onControlClick);
    document.addEventListener('cr:settings-painted', paintSettings);
    document.addEventListener('cr:games-added', () => { buildOrder(); emit(); });
    document.addEventListener('cr:games-removed', () => { buildOrder(); emit(); });
    // A hidden tab presses pause, and lifts only its own press on return.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (S.sweepOn && !paused()) pauseSweep(false); }
      else if (S._sweepAutoPaused) resumeSweep(false);
    });
    // The library arrives after boot(), and the cursor names a game by id.
    document.addEventListener('cr:restored', () => { resumeFromCursor(); });
  }
  emit();
  if (!S._restoring) await resumeFromCursor();
}

/*
 * The consent outliving the tab is the one thing here that starts work without a press
 * in front of it, and it is the spec's rule, not a convenience: a sweep started
 * yesterday picks up this morning. A reader's pause still holds.
 */
export async function resumeFromCursor() {
  buildOrder();
  if (!S.sweepOn || paused()) { emit(); return; }
  const id = await readCursor();
  if (id) { const at = _order.indexOf(id); if (at >= 0) _idx = at; }
  emit();
  loop();
}

/* Test seam. */
export function _resetSweep() {
  _gen++;
  _order = []; _idx = 0; _skipped = new Set(); _hydrated = new Set();
  _current = null; _looping = false; stopTick();
  _ema = 0; _searches = 0; _seen = 0; _cachedSkips = 0;
}
