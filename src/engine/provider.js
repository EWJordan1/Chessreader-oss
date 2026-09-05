/*
 * The provider interface (§7): one analyse() call, two implementations behind it.
 *
 *   analyse(fen, {depth, multipv, movetimeMs, signal, kind}) →
 *     Promise<{cp?, mate?, pv: string[], depth, lines?: [{cp?, mate?, pv}]}>
 *
 * cp/mate are from the SIDE TO MOVE's view here, raw UCI; analyse.js converts to
 * White-positive when it commits. Selection is per job kind, not global: a probe is a
 * question just asked and should go wherever answers fastest; a sweep is hours of
 * bookkeeping nobody is watching, which is what a remote engine is for.
 */
import { S } from '../state.js';
import { localAnalyse, localStatus } from './local.js';
import { remoteAnalyse, remoteBatch, remoteStatus, transportOf, testRemote } from './remote.js';

export { testRemote, transportOf };

/**
 * Which engine answers a job. 'split' is remote for the sweep and local for the
 * reader's own scans and probes. Pure, so the table is testable without a browser.
 */
export function providerFor(kind, mode = S.engineMode, url = S.engineUrl) {
  if (!transportOf(url)) return 'local';
  if (mode === 'remote') return 'remote';
  if (mode === 'split') return kind === 'sweep' ? 'remote' : 'local';
  return 'local';
}

/** Whether a kind's jobs may be sent as one HTTP batch (the sweep's, over HTTP). */
export function batchable(kind) {
  return providerFor(kind) === 'remote' && transportOf(S.engineUrl) === 'http';
}

let _toldFallback = false;
let _sayFallback = null;
/** The shell installs the one sentence; provider.js says it once per session. */
export function onFallback(fn) { _sayFallback = fn; }
function fellBack(err) {
  if (_toldFallback) return;
  _toldFallback = true;
  if (_sayFallback) { try { _sayFallback(err); } catch (e) { /* the shell's problem */ } }
}
function isAbort(e) { return !!(e && e.name === 'AbortError'); }

/* Test seam: the two backends, swappable for fakes. */
let _local = localAnalyse;
let _remote = remoteAnalyse;
let _remoteBatch = remoteBatch;
export function _setBackends({ local, remote, batch } = {}) {
  _local = local || localAnalyse;
  _remote = remote || remoteAnalyse;
  _remoteBatch = batch || remoteBatch;
  _toldFallback = false;
}

/**
 * Remote failure falls back to local with one toast, never to an error (§2.3). An abort
 * is not a failure — the caller stopped the search — and is passed straight through.
 */
export async function analyse(fen, opts = {}) {
  if (providerFor(opts.kind) === 'remote') {
    try { return await _remote(fen, opts); }
    catch (e) { if (isAbort(e)) throw e; fellBack(e); }
  }
  return _local(fen, opts);
}

/** items: [{fen, depth, multipv, movetimeMs}] → results in order. Remote HTTP sends one request; everything else runs them one by one. */
export async function analyseBatch(items, opts = {}) {
  if (batchable(opts.kind)) {
    try { return await _remoteBatch(items, opts); }
    catch (e) { if (isAbort(e)) throw e; fellBack(e); }
  }
  const out = [];
  for (const it of items) out.push(await analyse(it.fen, { ...it, ...opts }));
  return out;
}

export function engineStatus() {
  return { local: localStatus(), remote: remoteStatus() };
}
