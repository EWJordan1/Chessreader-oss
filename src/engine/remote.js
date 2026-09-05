/*
 * The remote engine (§7): a base URL in Settings, an optional bearer token, and two
 * transports chosen by the URL's scheme.
 *
 *   http(s)://  POST {base}/analyse with {fen, depth, multipv, movetimeMs}, answered in
 *               the provider shape; POST {base}/analyse/batch with an array of those,
 *               answered with an array. GET {base}/health is the test button.
 *   ws(s)://    raw UCI over the socket — what lets someone point at an off-the-shelf
 *               UCI bridge. First message `auth <token>` when a token is set.
 *
 * Every failure is thrown to provider.js, which falls back to the local engine with one
 * toast; nothing here shows the reader an error.
 */
import { S } from '../state.js';
import { newSearch, goCommand, isUciMove } from './uci.js';

const HTTP_TIMEOUT_MS = 30000;
const WS_OPEN_TIMEOUT_MS = 10000;
const HEALTH_TIMEOUT_MS = 8000;

let _status = 'off';   // 'off' | 'ok' | 'down' — what the last exchange said

export function transportOf(url) {
  const u = String(url || '').trim();
  if (/^wss?:\/\//i.test(u)) return 'ws';
  if (/^https?:\/\//i.test(u)) return 'http';
  return null;
}
export function remoteStatus() { return transportOf(S.engineUrl) ? _status : 'off'; }
export function _resetRemote() { _status = 'off'; wsDrop(); }

function base() { return String(S.engineUrl || '').trim().replace(/\/+$/, ''); }
function isAbort(e) { return !!(e && e.name === 'AbortError'); }
function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

/**
 * A server's answer, checked before it is trusted. Returns null for anything that is
 * not the provider shape — a guard that returns null over one that returns a plausible
 * number, because a malformed cp lands in the array classifyMove() compares against.
 */
export function normaliseResult(j) {
  if (!j || typeof j !== 'object') return null;
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const line = l => {
    if (!l || typeof l !== 'object') return null;
    const pv = Array.isArray(l.pv) ? l.pv.filter(isUciMove) : [];
    const out = { pv, depth: num(l.depth) ? l.depth : 0 };
    if (num(l.mate)) out.mate = l.mate;
    else if (num(l.cp)) out.cp = l.cp;
    else return null;
    return out;
  };
  const top = line(j);
  if (!top) return null;
  const lines = Array.isArray(j.lines) ? j.lines.map(line).filter(Boolean) : [top];
  if (!lines.length) lines.push(top);
  return { ...top, lines };
}

/* ----- HTTP ----- */
function headers(json) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (S.engineToken) h.Authorization = 'Bearer ' + S.engineToken;
  return h;
}

async function httpPost(path, body, signal) {
  const t = withTimeout(signal, HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(base() + path, { method: 'POST', headers: headers(true), body: JSON.stringify(body), signal: t.signal });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    return await res.json();
  } finally { t.clear(); }
}

function requestBody(fen, { depth = 18, multipv = 1, movetimeMs = 600 } = {}) {
  return { fen, depth, multipv, movetimeMs };
}

/* ----- WebSocket ----- */
let _ws = null, _wsReady = null, _wsOnLine = null, _wsMultipv = 1, _wsChain = Promise.resolve(), _wsRejectRunning = null;

function wsDrop() {
  const ws = _ws;
  _ws = null; _wsReady = null; _wsMultipv = 1;
  if (_wsRejectRunning) _wsRejectRunning(new Error('the socket closed'));
  _wsOnLine = null; _wsRejectRunning = null;
  try { if (ws) ws.close(); } catch (e) { /* fine */ }
}

function wsOpen() {
  if (_wsReady) return _wsReady;
  _wsReady = new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(base()); } catch (e) { _wsReady = null; reject(e); return; }
    _ws = ws;
    let opened = false;
    const timer = setTimeout(() => { if (!opened) { reject(new Error('the engine did not answer uci')); wsDrop(); } }, WS_OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      if (S.engineToken) ws.send('auth ' + S.engineToken);
      ws.send('uci');
    };
    ws.onmessage = ev => {
      for (const line of String(ev.data).split(/\r?\n/)) {
        if (!line) continue;
        if (!opened) {
          if (line === 'uciok') { opened = true; clearTimeout(timer); _wsMultipv = 1; resolve(ws); }
          continue;
        }
        if (_wsOnLine) _wsOnLine(line);
      }
    };
    ws.onerror = () => { /* onclose follows and carries the code */ };
    ws.onclose = ev => {
      clearTimeout(timer);
      if (!opened) {
        const e = new Error(ev && ev.code === 4001 ? 'auth' : 'closed');
        e.code = ev && ev.code === 4001 ? 'auth' : 'network';
        reject(e);
      }
      if (_ws === ws) wsDrop();
    };
  });
  return _wsReady;
}

function wsAnalyse(fen, opts) {
  const run = () => wsSearch(fen, opts);
  const p = _wsChain.then(run, run);
  _wsChain = p.catch(() => {});
  return p;
}

async function wsSearch(fen, { depth = 18, multipv = 1, movetimeMs = 600, signal } = {}) {
  if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  const ws = await wsOpen();
  return new Promise((resolve, reject) => {
    const search = newSearch(multipv);
    let done = false, aborted = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      _wsOnLine = null; _wsRejectRunning = null;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => { aborted = true; try { ws.send('stop'); } catch (e) { /* gone */ } };
    _wsOnLine = line => {
      if (!search.feed(line)) return;
      if (aborted) { const e = new Error('aborted'); e.name = 'AbortError'; finish(reject, e); }
      else finish(resolve, search.result());
    };
    _wsRejectRunning = err => finish(reject, err);
    const guard = setTimeout(() => { finish(reject, new Error('the remote engine did not answer')); wsDrop(); }, movetimeMs + HTTP_TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (multipv !== _wsMultipv) { ws.send('setoption name MultiPV value ' + multipv); _wsMultipv = multipv; }
    ws.send('position fen ' + fen);
    ws.send(goCommand({ depth, movetimeMs }));
  });
}

/* ----- the provider calls ----- */
export async function remoteAnalyse(fen, opts = {}) {
  const t = transportOf(S.engineUrl);
  if (!t) throw new Error('no remote engine configured');
  try {
    let r;
    if (t === 'ws') r = await wsAnalyse(fen, opts);
    else r = normaliseResult(await httpPost('/analyse', requestBody(fen, opts), opts.signal));
    if (!r) throw new Error('the server answered with something other than an evaluation');
    _status = 'ok';
    return r;
  } catch (e) {
    if (!isAbort(e)) _status = 'down';
    throw e;
  }
}

/** items: [{fen, depth, multipv, movetimeMs}] → results in the same order. */
export async function remoteBatch(items, { signal } = {}) {
  const t = transportOf(S.engineUrl);
  if (!t) throw new Error('no remote engine configured');
  if (t === 'ws') {
    const out = [];
    for (const it of items) out.push(await remoteAnalyse(it.fen, { ...it, signal }));
    return out;
  }
  try {
    const arr = await httpPost('/analyse/batch', items.map(it => requestBody(it.fen, it)), signal);
    if (!Array.isArray(arr) || arr.length !== items.length) throw new Error('the batch answer did not match the request');
    const out = arr.map(normaliseResult);
    if (out.some(r => !r)) throw new Error('a batch answer was not an evaluation');
    _status = 'ok';
    return out;
  } catch (e) {
    if (!isAbort(e)) _status = 'down';
    throw e;
  }
}

/* ----- the test button ----- */
/**
 * Three outcomes a reader can act on, in three different sentences. A browser cannot
 * tell a refused CORS preflight from a machine that is off — both are a TypeError from
 * fetch — so those two share one sentence that names both.
 */
export function describeHealth(kind, extra) {
  switch (kind) {
    case 'ok': return { ok: true, kind, text: 'The engine answers.' + (extra ? ' It reports ' + extra + '.' : '') };
    case 'auth': return { ok: false, kind, text: 'The server is there but refused the token. Check it matches the one the server was started with.' };
    case 'status': return { ok: false, kind, text: 'The server answered ' + extra + ' rather than OK. Is that the engine server’s address?' };
    case 'url': return { ok: false, kind, text: 'Enter an http(s):// or ws(s):// address first.' };
    default: return { ok: false, kind: 'network', text: 'Nothing answered at that address. Either the server is down, the address is wrong, or it does not allow this page to call it (CORS).' };
  }
}

export async function testRemote() {
  const t = transportOf(S.engineUrl);
  if (!t) return describeHealth('url');
  if (t === 'http') {
    const to = withTimeout(null, HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(base() + '/health', { headers: headers(false), signal: to.signal });
      if (res.status === 401 || res.status === 403) { _status = 'down'; return describeHealth('auth'); }
      if (!res.ok) { _status = 'down'; return describeHealth('status', res.status); }
      const j = await res.json().catch(() => ({}));
      _status = 'ok';
      return describeHealth('ok', j && typeof j.engine === 'string' ? j.engine : '');
    } catch (e) {
      _status = 'down';
      return describeHealth('network');
    } finally { to.clear(); }
  }
  try {
    await wsOpen();
    _status = 'ok';
    return describeHealth('ok');
  } catch (e) {
    _status = 'down';
    return describeHealth(e && e.code === 'auth' ? 'auth' : 'network');
  }
}
