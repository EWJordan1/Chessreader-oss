/*
 * The local engine: Stockfish 17.1 Lite, compiled to WebAssembly and vendored in
 * engine/ (§7). The build *is* a worker and sets its own onmessage, so it is driven
 * from the main thread rather than wrapped in a worker of ours — nested workers are a
 * Safari hazard and the CPU is inside the engine's thread either way.
 *
 * Lazy: nothing here is fetched until the first analyse() call, which only ever follows
 * a press (Analyse, a depth button, Lines, or the sweep's Start). Seven megabytes are
 * never downloaded for a reader who did not ask.
 */
import { newSearch, goCommand } from './uci.js';

/*
 * Relative to the site root, not to this module. Vite would otherwise take a
 * `new URL(…, import.meta.url)` as an asset and hash-rename the loader — and the loader
 * derives the .wasm path from its own filename, so a renamed loader looks for a .wasm
 * that was never copied. engine/ is served as a plain directory under the site root
 * instead (see docs/engine.md, Asks, for the build step that copies it).
 */
export const ENGINE_URL = 'engine/stockfish-17.1-lite-single.js';
/* Hash is the one option worth setting: the default is generous for a desktop engine
   and wasteful for a page analysing one position at a time. */
const HASH_MB = 16;
/* Time for `uci` → `readyok` on first boot, which is the wasm download and its decode. */
const READY_TIMEOUT_MS = 60000;
/* Beyond a search's own movetime before the worker is assumed to have hung. */
const SEARCH_GRACE_MS = 5000;
/*
 * Torn down after this long idle. A decoded engine is a good deal of memory sitting
 * behind a reader who is listening, not analysing; it boots again in well under a
 * second from the HTTP cache when the next question comes.
 */
const IDLE_RELEASE_MS = 90000;

let _worker = null;
let _status = 'idle';          // 'idle' | 'loading' | 'ready' | 'failed'
let _ready = null;             // the boot promise, shared by every waiter
let _multipv = 1;              // the worker's current MultiPV — a mode, not an argument
let _onLine = null;            // the running search's line handler
let _rejectRunning = null;     // how a worker failure reaches the running search
let _chain = Promise.resolve();   // one engine, one search at a time
let _idleTimer = 0;
let _failHooks = [];
let _workerFactory = url => new Worker(url);

export function localStatus() { return _status; }
/** Called once per failure so the shell can say one sentence about it. */
export function onLocalFail(fn) { _failHooks.push(fn); }

function engineURL() {
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  return new URL(ENGINE_URL, base).href;
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function fail(err) {
  const w = _worker;
  _worker = null; _ready = null; _status = 'failed'; _multipv = 1;
  try { if (w) w.terminate(); } catch (e) { /* already gone */ }
  if (_rejectRunning) _rejectRunning(err instanceof Error ? err : new Error('the engine failed'));
  _onLine = null; _rejectRunning = null;
  for (const fn of _failHooks) { try { fn(err); } catch (e) { /* a listener's problem */ } }
}

/** Boot on first use only, and once: every caller waits on the same promise. */
function boot() {
  if (_ready) return _ready;
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    const e = new Error('no Worker or WebAssembly here');
    fail(e);
    return Promise.reject(e);
  }
  _status = 'loading';
  _ready = new Promise((resolve, reject) => {
    let w;
    try { w = _workerFactory(engineURL()); } catch (e) { fail(e); reject(e); return; }
    _worker = w;
    const timer = setTimeout(() => { const e = new Error('the engine did not answer uci'); fail(e); reject(e); }, READY_TIMEOUT_MS);
    // A worker that fails to load (offline, a 404 on the wasm) must not leave the UI
    // saying "analysing" forever. Fail visibly and let the reader try again.
    w.onerror = ev => { clearTimeout(timer); const e = new Error(ev && ev.message ? ev.message : 'the engine could not load'); fail(e); reject(e); };
    w.onmessage = ev => {
      const line = typeof ev.data === 'string' ? ev.data : '';
      if (_status === 'loading') {
        if (line === 'uciok') {
          w.postMessage('setoption name Hash value ' + HASH_MB);
          w.postMessage('setoption name MultiPV value 1');
          w.postMessage('isready');
        } else if (line === 'readyok') {
          clearTimeout(timer);
          _status = 'ready'; _multipv = 1;
          resolve(w);
        }
        return;
      }
      if (_onLine) _onLine(line);
    };
    // The Emscripten build queues commands posted before the wasm is up, so this is safe
    // to send at once.
    w.postMessage('uci');
  });
  return _ready;
}

/** Let the worker go. The next analyse() boots it again from the HTTP cache. */
export function releaseLocal() {
  clearTimeout(_idleTimer);
  if (!_worker) return;
  if (_onLine) return;                  // mid-search: the idle timer will come round again
  const w = _worker;
  _worker = null; _ready = null; _multipv = 1;
  if (_status !== 'failed') _status = 'idle';
  try { w.postMessage('quit'); } catch (e) { /* fine */ }
  try { w.terminate(); } catch (e) { /* fine */ }
}

function armIdle() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(releaseLocal, IDLE_RELEASE_MS);
}

/**
 * The provider call, local flavour. cp/mate are from the side to move, as the engine
 * says them; analyse.js converts. An aborted search sends `stop`, waits for the
 * bestmove that follows, and rejects with an AbortError — its numbers are never handed
 * back, because a search stopped at a depth it never meant to stop at must not be
 * committed beside deep ones.
 */
export function localAnalyse(fen, opts = {}) {
  const run = () => runSearch(fen, opts);
  const p = _chain.then(run, run);
  _chain = p.catch(() => {});
  return p;
}

async function runSearch(fen, { depth = 18, multipv = 1, movetimeMs = 600, signal } = {}) {
  if (signal && signal.aborted) throw abortError();
  clearTimeout(_idleTimer);
  const w = await boot();
  return new Promise((resolve, reject) => {
    const search = newSearch(multipv);
    let done = false, aborted = false, guard = 0, late = 0;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(guard); clearTimeout(late);
      _onLine = null; _rejectRunning = null;
      if (signal) signal.removeEventListener('abort', onAbort);
      armIdle();
      fn(v);
    };
    const onAbort = () => { aborted = true; try { w.postMessage('stop'); } catch (e) { /* gone */ } };
    _onLine = line => {
      if (!search.feed(line)) return;
      if (aborted) finish(reject, abortError());
      else finish(resolve, search.result());
    };
    _rejectRunning = err => finish(reject, err);
    // A search that outlives its movetime by the grace period is asked to stop; one
    // that ignores even that has hung, and is failed rather than waited on forever.
    guard = setTimeout(() => {
      try { w.postMessage('stop'); } catch (e) { /* gone */ }
      late = setTimeout(() => fail(new Error('the engine stopped answering')), SEARCH_GRACE_MS);
    }, movetimeMs + SEARCH_GRACE_MS);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    // MultiPV is a mode, changed only when the job in hand disagrees with the worker.
    if (multipv !== _multipv) { w.postMessage('setoption name MultiPV value ' + multipv); _multipv = multipv; }
    w.postMessage('position fen ' + fen);
    w.postMessage(goCommand({ depth, movetimeMs }));
  });
}

/* ----- test seams: a fake worker, and a clean slate between tests ----- */
export function _setWorkerFactory(fn) { _workerFactory = fn || (url => new Worker(url)); }
export function _resetLocal() {
  clearTimeout(_idleTimer);
  try { if (_worker) _worker.terminate(); } catch (e) { /* fine */ }
  _worker = null; _ready = null; _status = 'idle'; _multipv = 1; _onLine = null; _rejectRunning = null;
  _chain = Promise.resolve(); _failHooks = [];
}
