/*
 * The reference remote engine (§7). One Node process wrapping a native Stockfish,
 * serving both transports the app knows how to speak:
 *
 *   POST /analyse        {fen, depth, multipv, movetimeMs} → {cp|mate, pv, depth, lines}
 *   POST /analyse/batch  [ …those… ]                       → [ …those answers… ]
 *   GET  /health         {ok, engine, engines, busy}
 *   ws://…               raw UCI, one engine process per connection
 *
 * Nothing in the app assumes this exists. It is here so that "point it at your own
 * machine" is a paragraph of configuration rather than a project, and so that anyone
 * writing their own server has something to diff against.
 *
 * The UCI parsing is the app's own module, imported rather than copied: two spellings
 * of "which info line was the answer" is how a client and a server drift.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { newSearch, goCommand } from '../src/engine/uci.js';
import { mountSync } from './sync.js';

const PORT = Number(process.env.PORT || 8020);
const BIN = process.env.STOCKFISH || 'stockfish';
const TOKEN = process.env.CR_TOKEN || '';            // empty = open, for a machine on your own LAN
const THREADS = Number(process.env.CR_THREADS || 1);
const HASH_MB = Number(process.env.CR_HASH || 128);
const POOL = Math.max(1, Number(process.env.CR_ENGINES || 2));
const ORIGIN = process.env.CR_ORIGIN || '*';

/* Ceilings, because this is a process a browser on someone else's network can reach.
   A request asking for depth 60 is a denial of service, not a question. */
const MAX_DEPTH = 40;
const MAX_MOVETIME = 60000;
const MAX_MULTIPV = 5;
const MAX_BATCH = 64;
const MAX_BODY = 256 * 1024;

/*
 * A FEN goes onto the engine's stdin. Anything outside this alphabet — a newline above
 * all — is a UCI injection, so the guard rejects rather than sanitises.
 */
const FEN_RE = /^[1-8pnbrqkPNBRQK/]{1,90} [wb] (?:-|K?Q?k?q?) (?:-|[a-h][36]) \d{1,3} \d{1,4}$/;
const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def);

/* ===== The engine pool ===== */

function newEngine() {
  const eng = { busy: false, dead: false, onLine: null, buf: '' };
  eng.proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  eng.proc.stdout.setEncoding('utf8');
  eng.proc.stdout.on('data', chunk => {
    eng.buf += chunk;
    let i;
    while ((i = eng.buf.indexOf('\n')) >= 0) {
      const line = eng.buf.slice(0, i).trim();
      eng.buf = eng.buf.slice(i + 1);
      if (line && eng.onLine) eng.onLine(line);
    }
  });
  eng.proc.on('error', () => { eng.dead = true; });
  eng.proc.on('exit', () => { eng.dead = true; });
  eng.send = s => { if (!eng.dead) eng.proc.stdin.write(s + '\n'); };
  eng.send('uci');
  eng.send('setoption name Threads value ' + THREADS);
  eng.send('setoption name Hash value ' + HASH_MB);
  eng.send('isready');
  eng.multipv = 1;
  return eng;
}

const pool = [];
const waiters = [];
function acquire() {
  const free = pool.find(e => !e.busy && !e.dead);
  if (free) { free.busy = true; return Promise.resolve(free); }
  const dead = pool.findIndex(e => e.dead);
  if (dead >= 0) { pool[dead] = newEngine(); pool[dead].busy = true; return Promise.resolve(pool[dead]); }
  if (pool.length < POOL) { const e = newEngine(); e.busy = true; pool.push(e); return Promise.resolve(e); }
  return new Promise(res => waiters.push(res));
}
function release(eng) {
  if (eng.dead) { const i = pool.indexOf(eng); if (i >= 0) pool.splice(i, 1); }
  const next = waiters.shift();
  // Handed straight on rather than released and re-acquired: an engine that goes idle
  // for a tick with somebody waiting is a batch that runs at half the rate it could.
  if (next && !eng.dead) { next(eng); return; }
  eng.busy = false;
  if (next) acquire().then(next);
}

/** One search on one engine, answered in the provider shape. */
function search(eng, { fen, depth, multipv, movetimeMs }) {
  return new Promise((resolve, reject) => {
    const collector = newSearch(multipv);
    const guard = setTimeout(() => { eng.onLine = null; eng.send('stop'); reject(new Error('the engine did not answer')); }, movetimeMs + 30000);
    eng.onLine = line => {
      if (!collector.feed(line)) return;
      clearTimeout(guard);
      eng.onLine = null;
      resolve(collector.result());
    };
    if (multipv !== eng.multipv) { eng.send('setoption name MultiPV value ' + multipv); eng.multipv = multipv; }
    eng.send('position fen ' + fen);
    eng.send(goCommand({ depth, movetimeMs }));
  });
}

function job(body) {
  const fen = String(body && body.fen || '');
  if (!FEN_RE.test(fen)) return null;
  return {
    fen,
    depth: clamp(Number(body.depth), 1, MAX_DEPTH, 18),
    multipv: clamp(Number(body.multipv), 1, MAX_MULTIPV, 1),
    movetimeMs: clamp(Number(body.movetimeMs), 1, MAX_MOVETIME, 600),
  };
}

async function runJob(j) {
  const eng = await acquire();
  try { return await search(eng, j); } finally { release(eng); }
}

/* ===== HTTP ===== */

/*
 * The route table is the hook the sync module joins on: it adds its own entries here
 * and the two features share one process, one port and one token.
 */
export const routes = new Map();

/* Optional sync (§9) joins here, so one process can serve both features behind one port
   and one token. It mounts only when a directory is named, which is how a server that
   was asked for an engine never quietly becomes a place to store somebody's deck. */
mountSync(routes);

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Access-Control-Allow-Origin': ORIGIN });
  res.end(s);
};

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  return h === 'Bearer ' + TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; } parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

routes.set('GET /health', (req, res) => json(res, 200, {
  ok: true, engine: 'Stockfish (' + BIN + ')', engines: pool.length, busy: pool.filter(e => e.busy).length,
}));

routes.set('POST /analyse', async (req, res) => {
  const j = job(await readBody(req));
  if (!j) return json(res, 400, { error: 'a fen is required' });
  json(res, 200, await runJob(j));
});

routes.set('POST /analyse/batch', async (req, res) => {
  const body = await readBody(req);
  if (!Array.isArray(body) || !body.length) return json(res, 400, { error: 'an array of jobs is required' });
  if (body.length > MAX_BATCH) return json(res, 413, { error: 'at most ' + MAX_BATCH + ' positions a batch' });
  const jobs = body.map(job);
  if (jobs.some(j => !j)) return json(res, 400, { error: 'every entry needs a fen' });
  // In order, because the client matches answers to requests by index.
  const out = [];
  for (const j of jobs) out.push(await runJob(j));
  json(res, 200, out);
});

const server = createServer(async (req, res) => {
  // A browser page calling this is a cross-origin request with an Authorization header,
  // which is a preflight before it is anything else.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ORIGIN,
      // PUT and DELETE are the sync routes' verbs (server/sync.js). They are advertised
      // here even when sync is not mounted, because this is the one preflight the whole
      // process answers: a browser asks before it knows which route it is calling, and a
      // preflight that omits a verb fails the request with no error the page can read.
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  const handler = routes.get(req.method + ' ' + path);
  if (!handler) return json(res, 404, { error: 'no such route' });
  if (!authed(req)) return json(res, 401, { error: 'bad token' });
  try { await handler(req, res); } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
});

/* ===== WebSocket: the raw UCI bridge ===== */

/*
 * One engine process per connection, and the socket is a pipe: whatever the client
 * sends goes to stdin, whatever the engine says comes back. That is what makes the
 * app's ws transport work against an off-the-shelf bridge as well as against this.
 * `auth <token>` may be the first line; without a token the line is simply ignored.
 */
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let ok = !TOKEN;
  const eng = newEngine();
  eng.onLine = line => { if (ws.readyState === 1) ws.send(line); };
  const timer = setTimeout(() => { if (!ok) ws.close(4001, 'auth'); }, 5000);
  ws.on('message', data => {
    for (const line of String(data).split(/\r?\n/)) {
      const cmd = line.trim();
      if (!cmd) continue;
      if (cmd.startsWith('auth ')) { ok = cmd.slice(5) === TOKEN; if (!ok) ws.close(4001, 'auth'); continue; }
      if (!ok) { ws.close(4001, 'auth'); return; }
      // The same guard as the HTTP side: a position line is the one place a client's
      // text reaches stdin, and only a well-formed FEN is allowed through.
      if (cmd.startsWith('position fen ')) { if (!FEN_RE.test(cmd.slice(13))) continue; }
      else if (!/^(uci|isready|ucinewgame|stop|quit|position startpos|go\b|setoption name (MultiPV|Hash|Threads) value \d+)/.test(cmd)) continue;
      if (cmd === 'quit') { ws.close(); return; }
      eng.send(cmd);
    }
  });
  ws.on('close', () => { clearTimeout(timer); try { eng.proc.kill(); } catch (e) { /* already gone */ } });
});

server.listen(PORT, () => {
  console.log('chessreader engine on :' + PORT + (TOKEN ? ' (token required)' : ' (open)') + ' — ' + BIN);
});

export { server, wss };
