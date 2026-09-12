/*
 * The reference sync server (§9). Five blobs a shelf, a version counter, and nothing
 * else — it is deliberately dumb, because **the merge runs in the browser**: that is
 * the only place holding both halves, and a server that merged would have to understand
 * a Leitner schedule to do it.
 *
 *   GET    {base}/{store}   → { version, blob, enc }
 *   PUT    {base}/{store}   ← { version, blob, enc }   409 if version moved
 *   DELETE {base}/{store}                              erase, always ungated
 *
 * Stores: deck, tactics, book, games, learn. There is no `opponents` store and there
 * never will be (§9): the prep list is five handles you can retype.
 *
 * This is a directory of files, one per store per token, and that is the whole of it.
 * Swapping the four functions under "the shelf" for S3 objects or WebDAV files is the
 * entire port — see docs/sync.md, which writes that shim out.
 *
 * Two ways to run it:
 *   - joined to the engine server, which is what `mountSync(routes)` is for: one
 *     process, one port, one token (server/index.js does this when CR_SYNC_DIR is set);
 *   - on its own, `node server/sync.js`, which is what the bottom of this file is for.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/* The one list. A store not here is a 404 — including `opponents`, which is the point. */
export const SYNC_STORES = ['deck', 'tactics', 'book', 'games', 'learn'];

/* The client refuses the same figure, so an oversized blob fails the same way on both
   sides rather than being accepted here and rejected there. */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_BODY = MAX_BLOB_BYTES + 64 * 1024;   // the envelope's own JSON, generously

const STORE_RE = /^[a-z]+$/;

/* ===== The shelf: one directory per token, one file per store ===== */

/*
 * The token names the shelf, hashed — so a token never appears in a path, a log line or
 * a directory listing, and two people sharing a process cannot read each other's decks
 * by guessing a filename. No token at all is one open shelf, which is only sane on a
 * machine nobody else can reach.
 */
export function shelfFor(token) {
  const t = String(token || '');
  return t ? 'u' + createHash('sha256').update(t).digest('hex').slice(0, 24) : 'open';
}

function fileFor(dir, token, store) {
  if (!STORE_RE.test(store) || !SYNC_STORES.includes(store)) return null;
  return join(resolve(dir), shelfFor(token), store + '.json');
}

const EMPTY = { version: 0, blob: null, enc: 'identity' };

async function readShelf(file) {
  try {
    const env = JSON.parse(await readFile(file, 'utf8'));
    return { version: Number(env.version) || 0, blob: typeof env.blob === 'string' ? env.blob : null, enc: env.enc === 'gzip' ? 'gzip' : 'identity' };
  } catch (e) {
    // A shelf that was never written and a shelf whose file is unreadable are the same
    // answer: version 0. The client's next PUT then starts the count again, and because
    // the merge is a union it loses nothing it still holds.
    return { ...EMPTY };
  }
}

async function writeShelf(file, env) {
  await mkdir(join(file, '..'), { recursive: true });
  // Written beside and renamed over: a half-written blob read by another device is a
  // parse error at best, and rename is the one atomic the filesystem gives us.
  const tmp = file + '.' + process.pid + '.tmp';
  await writeFile(tmp, JSON.stringify(env));
  await rename(tmp, file);
}

/* ===== The three verbs, as plain functions, so a test can call them ===== */

export function syncCore(dir) {
  return {
    async get(token, store) {
      const file = fileFor(dir, token, store);
      if (!file) return { code: 404, body: { error: 'no such store' } };
      return { code: 200, body: await readShelf(file) };
    },

    /*
     * The version travelling in a PUT is the version the client *read*, and it must
     * still be the one on the shelf. That is the whole concurrency story: a mismatch is
     * a 409 and the client GETs, merges and PUTs again. The server never merges and
     * never decides a winner, because it cannot see both halves.
     */
    async put(token, store, env) {
      const file = fileFor(dir, token, store);
      if (!file) return { code: 404, body: { error: 'no such store' } };
      if (!env || typeof env.blob !== 'string') return { code: 400, body: { error: 'a blob string is required' } };
      if (env.blob.length > MAX_BLOB_BYTES) return { code: 413, body: { error: 'that blob is too large' } };
      const cur = await readShelf(file);
      const seen = Number(env.version) || 0;
      if (seen !== cur.version) return { code: 409, body: { error: 'the version moved', version: cur.version } };
      const next = { version: cur.version + 1, blob: env.blob, enc: env.enc === 'gzip' ? 'gzip' : 'identity' };
      await writeShelf(file, next);
      return { code: 200, body: { version: next.version } };
    },

    /*
     * Ungated on purpose: no version travels with a DELETE. Erasing is the one thing a
     * reader should never be argued with about, and this erases the *server's* copy
     * only — it is not a delete that propagates. Nothing in this feature removes a card
     * from another device; a device that still holds one will simply put it back.
     */
    async del(token, store) {
      const file = fileFor(dir, token, store);
      if (!file) return { code: 404, body: { error: 'no such store' } };
      await rm(file, { force: true });
      return { code: 200, body: { ok: true, version: 0 } };
    },
  };
}

/* ===== HTTP ===== */

function bearer(req) {
  const h = (req.headers && req.headers.authorization) || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function readBody(req) {
  return new Promise((res2, rej) => {
    let n = 0; const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { rej(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => { try { res2(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}

function send(res, origin, { code, body }) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': origin,
  });
  res.end(s);
}

/**
 * Add the sync routes to the engine server's `routes` map (see server/README.md). The
 * map is keyed `"METHOD /path"`, so every store is spelled out — fifteen entries, and a
 * path that is not one of them stays a 404 rather than becoming a filename.
 *
 * @returns {number} how many routes were mounted; 0 when no directory was named, which
 * is how sync stays off unless somebody asks for it.
 */
export function mountSync(routes, opts = {}) {
  const dir = opts.dir || process.env.CR_SYNC_DIR || '';
  if (!routes || !dir) return 0;
  const prefix = (opts.prefix || process.env.CR_SYNC_PREFIX || '/sync').replace(/\/+$/, '');
  const origin = opts.origin || process.env.CR_ORIGIN || '*';
  const core = syncCore(dir);
  let n = 0;
  for (const store of SYNC_STORES) {
    const path = prefix + '/' + store;
    routes.set('GET ' + path, async (req, res) => send(res, origin, await core.get(bearer(req), store)));
    routes.set('PUT ' + path, async (req, res) => send(res, origin, await core.put(bearer(req), store, await readBody(req))));
    routes.set('DELETE ' + path, async (req, res) => send(res, origin, await core.del(bearer(req), store)));
    n += 3;
  }
  return n;
}

/* ===== Standalone ===== */

/*
 * The same routes behind their own listener, for anyone who wants sync without an
 * engine — and because this one answers the OPTIONS preflight with PUT and DELETE in
 * `Access-Control-Allow-Methods`, which the engine server's shared preflight does not
 * yet (see the Asks in docs/sync.md).
 */
export function createSyncServer(opts = {}) {
  const origin = opts.origin || process.env.CR_ORIGIN || '*';
  const tokens = (opts.tokens || String(process.env.CR_SYNC_TOKENS || process.env.CR_TOKEN || '')).split(',').map(s => s.trim()).filter(Boolean);
  const routes = new Map();
  const mounted = mountSync(routes, { ...opts, origin, dir: opts.dir || process.env.CR_SYNC_DIR || './sync-data' });

  const ok = token => {
    if (!tokens.length) return true;              // open: a LAN-only decision, said out loud in the README
    const a = Buffer.from(token);
    return tokens.some(t => { const b = Buffer.from(t); return a.length === b.length && timingSafeEqual(a, b); });
  };

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    const handler = routes.get(req.method + ' ' + path);
    if (!handler) return send(res, origin, { code: 404, body: { error: 'no such route' } });
    if (!ok(bearer(req))) return send(res, origin, { code: 401, body: { error: 'bad token' } });
    try { await handler(req, res); } catch (e) { send(res, origin, { code: 500, body: { error: String(e && e.message || e) } }); }
  });
  return { server, routes, mounted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8021);
  const dir = process.env.CR_SYNC_DIR || './sync-data';
  const { server } = createSyncServer({ dir });
  server.listen(port, () => {
    console.log('chessreader sync on :' + port + ' → ' + resolve(dir) +
      (process.env.CR_SYNC_TOKENS || process.env.CR_TOKEN ? ' (token required)' : ' (open)'));
  });
}

export const __test = { fileFor, readShelf, writeShelf, bearer };
