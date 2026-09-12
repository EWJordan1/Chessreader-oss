/*
 * Sync (§9). What these pin is the half of the feature that fails silently: a merge that
 * quietly drops a row, a schedule that gets reset by a device that was behind, a 409 loop
 * that never ends, a blob that cannot be read being overwritten anyway, and anything at
 * all leaving the browser with the switch off.
 *
 * The memory module is mocked (this is a node suite with no IndexedDB); the reference
 * server is not — the round-trip tests drive server/sync.js's real handlers in process.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

vi.mock('../src/memory.js', () => {
  const stores = new Map();
  const st = n => { if (!stores.has(n)) stores.set(n, new Map()); return stores.get(n); };
  const keyOf = r => (r.key ?? r.id ?? r.k ?? r.gameId);
  return {
    memAvailable: () => true,
    dbGet: async (s, k) => st(s).get(k),
    dbPut: async (s, row) => { st(s).set(keyOf(row), row); return true; },
    dbPutAll: async (s, rows) => { for (const r of rows) st(s).set(keyOf(r), r); return true; },
    dbDelete: async (s, k) => { st(s).delete(k); return true; },
    dbAll: async s => [...st(s).values()],
    dbClear: async s => { st(s).clear(); return true; },
    dbCount: async s => st(s).size,
    memRow: g => ({ id: g.id, pgn: g.pgn, headers: g.headers, source: g.source, addedAt: g.addedAt, seq: g.seq, bytes: g.bytes, lastPly: g.lastPly || 0, lastPlayedAt: g.lastPlayedAt || 0 }),
    rememberGames: async () => true,
    __stores: stores,
  };
});

import { S } from '../src/state.js';
import * as mem from '../src/memory.js';
import * as sync from '../src/sync/client.js';
import { mountSync, syncCore, SYNC_STORES as SERVER_STORES } from '../server/sync.js';
import { splitPGN, parseGame } from '../src/pgn.js';

const {
  SYNC_STORES, PUT_ATTEMPTS, mergeStore, packEnvelope, unpackEnvelope,
  syncNow, syncStore, pushAll, pullAll, syncStatus, deleteStore, getStore, boot,
} = sync;

const BASE = 'https://box.local/sync';
const tmps = [];
async function tmp() { const d = await mkdtemp(join(tmpdir(), 'cr-sync-')); tmps.push(d); return d; }
afterAll(async () => { for (const d of tmps) await rm(d, { recursive: true, force: true }); });

function resetS() {
  S.games = []; S.gi = 0; S._seq = 0;
  S.deck = new Map(); S.tactics = new Map(); S.book = new Map(); S.opponents = [];
  S.remember = true; S._restoring = false;
  S.syncOn = true; S.syncUrl = BASE; S.syncToken = 'a-long-random-string';
  mem.__stores.clear();
}
beforeEach(() => { resetS(); });

const card = (key, sched = {}) => ({ key, gameId: key.split(':')[0], ply: Number(key.split(':')[1]), fen: 'x', played: 'e2e4', answer: 'd2d4', box: 0, due: 0, seen: 0, passes: 0, fails: 0, addedAt: 1, ...sched });
const line = (key, sched = {}) => ({ key, color: 'w', moves: ['e4', 'e5'], name: 'Open', box: 0, due: 0, seen: 0, passes: 0, fails: 0, addedAt: 1, ...sched });

/* ===== A fetch over the reference server's real handlers ===== */

const lower = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));

function serverFetch(routes, seen) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    if (seen) seen.push(method + ' ' + u.pathname);
    const handler = routes.get(method + ' ' + u.pathname);
    if (!handler) return new Response(JSON.stringify({ error: 'no such route' }), { status: 404 });
    const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), { method, url: u.pathname, headers: lower(init.headers) });
    let code = 200, body = '';
    const res = { writeHead: c => { code = c; }, end: s => { body = s; } };
    await handler(req, res);
    return new Response(body, { status: code, headers: { 'Content-Type': 'application/json' } });
  };
}

/** A whole reference server on a scratch directory, reachable at BASE. */
async function reference() {
  const dir = await tmp();
  const routes = new Map();
  mountSync(routes, { dir, prefix: '/sync' });
  const seen = [];
  globalThis.fetch = vi.fn(serverFetch(routes, seen));
  return { dir, routes, seen, core: syncCore(dir) };
}

/** A hand-rolled server, for the answers a real one only gives under a race. */
function stubFetch(reply) {
  const seen = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET');
    const store = new URL(url).pathname.split('/').pop();
    seen.push({ method, store, body: init.body ? JSON.parse(init.body) : null, headers: lower(init.headers) });
    const { status, body } = await reply({ method, store, body: init.body ? JSON.parse(init.body) : null, n: seen.length });
    return new Response(JSON.stringify(body ?? {}), { status });
  });
  return seen;
}

/* ===== The stores ===== */

describe('the five stores', () => {
  it('are exactly the contract\'s, on both sides of the wire', () => {
    expect(SYNC_STORES).toEqual(['deck', 'tactics', 'book', 'games', 'learn']);
    expect([...SERVER_STORES].sort()).toEqual([...SYNC_STORES].sort());
  });

  it('do not include opponents: the prep list syncs nowhere, and a sync never asks for it', async () => {
    expect(SYNC_STORES).not.toContain('opponents');
    const { seen, routes } = await reference();
    expect([...routes.keys()].some(k => k.includes('opponents'))).toBe(false);
    S.opponents = [{ id: 'chesscom:magnus', site: 'chesscom', handle: 'magnus' }];
    await syncNow();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(s => s.includes('opponents'))).toBe(false);
  });

  it('never asks the server to merge: there is no prompt, no dialog, no chooser', () => {
    const names = Object.keys(sync).join(' ');
    expect(names).not.toMatch(/prompt|dialog|conflict|choose|restore/i);
  });
});

/* ===== The merge ===== */

describe('a merge is a union of keys', () => {
  it('keeps every key from both halves and loses neither side', () => {
    const mine = [line('w:a'), line('w:b')];
    const theirs = [line('w:b'), line('w:c')];
    const m = mergeStore('book', mine, theirs);
    expect(m.rows.map(r => r.key).sort()).toEqual(['w:a', 'w:b', 'w:c']);
    expect(m.incoming.map(r => r.key)).toEqual(['w:c']);   // new here
    expect(m.outgoing.map(r => r.key)).toEqual(['w:a']);   // missing there
  });

  it('is a union in the empty cases too', () => {
    expect(mergeStore('deck', [], [card('g:4')]).rows).toHaveLength(1);
    expect(mergeStore('deck', [card('g:4')], []).rows).toHaveLength(1);
    expect(mergeStore('deck', [], []).rows).toHaveLength(0);
  });

  it('ignores a row with no key rather than inventing one', () => {
    expect(mergeStore('deck', [{ box: 9 }], [card('g:4')]).rows.map(r => r.key)).toEqual(['g:4']);
    expect(mergeStore('games', [{ pgn: 'x' }], []).rows).toHaveLength(0);
  });
});

describe('cards take the further-along schedule', () => {
  it('in both directions: the rule does not depend on which side is called mine', () => {
    const behind = card('g:10', { box: 1, due: 100 });
    const ahead = card('g:10', { box: 4, due: 900 });
    expect(mergeStore('deck', [behind], [ahead]).rows[0].box).toBe(4);
    expect(mergeStore('deck', [ahead], [behind]).rows[0].box).toBe(4);
    expect(mergeStore('tactics', [behind], [ahead]).rows[0].box).toBe(4);
    expect(mergeStore('tactics', [ahead], [behind]).rows[0].box).toBe(4);
    expect(mergeStore('book', [behind], [ahead]).rows[0].box).toBe(4);
    expect(mergeStore('book', [ahead], [behind]).rows[0].box).toBe(4);
  });

  it('breaks a tie on the later due date, also in both directions', () => {
    const soon = card('g:10', { box: 3, due: 100 });
    const later = card('g:10', { box: 3, due: 900 });
    expect(mergeStore('deck', [soon], [later]).rows[0].due).toBe(900);
    expect(mergeStore('deck', [later], [soon]).rows[0].due).toBe(900);
  });

  it('never resets a card: a fresh copy of an earned card does not undo it', async () => {
    const earned = card('g:10', { box: 5, due: 5e12, passes: 6 });
    const fresh = card('g:10');
    expect(mergeStore('deck', [earned], [fresh]).rows[0]).toEqual(earned);
    expect(mergeStore('deck', [fresh], [earned]).rows[0]).toEqual(earned);

    // …and through a whole sync, not only through the pure function.
    const { core } = await reference();
    await core.put('a-long-random-string', 'deck', await packEnvelope([fresh], 0));
    S.deck.set(earned.key, earned);
    await syncNow();
    expect(S.deck.get('g:10').box).toBe(5);
    const after = await core.get('a-long-random-string', 'deck');
    expect((await unpackEnvelope(after.body))[0].box).toBe(5);
  });

  it('a device that is behind is brought forward, and no card is dropped on the way', async () => {
    const { core } = await reference();
    const theirs = [card('g:1', { box: 4, due: 900 }), card('g:2', { box: 1 })];
    await core.put('a-long-random-string', 'deck', await packEnvelope(theirs, 0));
    S.deck.set('g:1', card('g:1', { box: 1, due: 100 }));
    S.deck.set('g:3', card('g:3', { box: 2 }));
    const out = await syncNow();
    expect(out.ok).toBe(true);
    expect([...S.deck.keys()].sort()).toEqual(['g:1', 'g:2', 'g:3']);
    expect(S.deck.get('g:1').box).toBe(4);
    const rows = await unpackEnvelope((await core.get('a-long-random-string', 'deck')).body);
    expect(rows.map(r => r.key).sort()).toEqual(['g:1', 'g:2', 'g:3']);
  });
});

describe('games and learn merge by their own keys', () => {
  it('a game is never dropped, and the further-along cursor wins', () => {
    const mine = [{ id: 'a', pgn: '1. e4', lastPly: 4, lastPlayedAt: 10 }];
    const theirs = [{ id: 'a', pgn: '1. e4', lastPly: 20, lastPlayedAt: 99 }, { id: 'b', pgn: '1. d4' }];
    const m = mergeStore('games', mine, theirs);
    expect(m.rows.map(r => r.id).sort()).toEqual(['a', 'b']);
    expect(m.rows.find(r => r.id === 'a').lastPly).toBe(20);
    expect(mergeStore('games', theirs, mine).rows.find(r => r.id === 'a').lastPly).toBe(20);
  });

  it('a real game travels and comes back parseable', async () => {
    const pgn = splitPGN(readFileSync(new URL('./fixtures/chesscom.pgn', import.meta.url), 'utf8'))[0];
    const g = parseGame(pgn);
    const { core } = await reference();
    S.games = [{ ...g, source: 'test', addedAt: 1, seq: 1, bytes: pgn.length }];
    await syncNow();
    const rows = await unpackEnvelope((await core.get('a-long-random-string', 'games')).body);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(g.id);
    expect(parseGame(rows[0].pgn).moves.length).toBe(g.moves.length);
    expect(rows[0].fens).toBeUndefined();     // only the PGN travels, as on the disk
  });

  it('learn keeps this device\'s own answer and fills in only what it lacks', () => {
    const m = mergeStore('learn', [{ k: 'hero', v: 'me' }], [{ k: 'hero', v: 'them' }, { k: 'recsHidden', v: ['x'] }]);
    expect(m.rows.find(r => r.k === 'hero').v).toBe('me');
    expect(m.incoming.map(r => r.k)).toEqual(['recsHidden']);
  });
});

/* ===== The wire ===== */

describe('the blob', () => {
  it('survives a gzip round trip and is smaller than the JSON', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => card('g' + i + ':4', { box: i % 5 }));
    const env = await packEnvelope(rows, 3);
    expect(env.enc).toBe('gzip');
    expect(env.version).toBe(3);
    expect(env.blob.length).toBeLessThan(JSON.stringify(rows).length);
    expect(await unpackEnvelope(env)).toEqual(rows);
  });

  it('an empty or absent blob reads as no rows, not as an error', async () => {
    expect(await unpackEnvelope({ version: 0, blob: null })).toEqual([]);
    expect(await unpackEnvelope(null)).toEqual([]);
    expect(await unpackEnvelope({ version: 1, blob: '[]', enc: 'identity' })).toEqual([]);
  });

  it('a blob that is not a list of rows is refused rather than half-read', async () => {
    await expect(unpackEnvelope({ blob: '{"deck":1}', enc: 'identity' })).rejects.toThrow();
    await expect(unpackEnvelope({ blob: 7 })).rejects.toThrow();
  });

  it('a browser with no CompressionStream still syncs, in plain JSON', async () => {
    const real = globalThis.CompressionStream;
    try {
      delete globalThis.CompressionStream;
      const env = await packEnvelope([card('g:4', { box: 2 })], 0);
      expect(env.enc).toBe('identity');
      expect(JSON.parse(env.blob)[0].box).toBe(2);
      expect(await unpackEnvelope(env)).toHaveLength(1);

      const { core } = await reference();
      S.deck.set('g:4', card('g:4', { box: 2 }));
      const out = await syncNow();
      expect(out.ok).toBe(true);
      const shelf = await core.get('a-long-random-string', 'deck');
      expect(shelf.body.enc).toBe('identity');
      expect(shelf.body.version).toBe(1);
    } finally { globalThis.CompressionStream = real; }
  });

  it('a gzipped shelf a browser cannot read is left alone, never overwritten', async () => {
    const { core } = await reference();
    await core.put('a-long-random-string', 'deck', await packEnvelope([card('g:1', { box: 3 })], 0));
    const real = globalThis.DecompressionStream;
    try {
      delete globalThis.DecompressionStream;
      S.deck.set('g:9', card('g:9', { box: 1 }));
      const out = await syncNow();
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/gzipped/);
      expect(syncStatus().stores.deck.error).toMatch(/gzipped/);
    } finally { globalThis.DecompressionStream = real; }
    // The shelf is untouched: still their card, still version 1.
    const shelf = await core.get('a-long-random-string', 'deck');
    expect(shelf.body.version).toBe(1);
    expect((await unpackEnvelope(shelf.body)).map(r => r.key)).toEqual(['g:1']);
  });

  it('carries the token as a bearer header and nothing else', async () => {
    const seen = stubFetch(() => ({ status: 200, body: { version: 0, blob: null } }));
    await pullAll();
    expect(seen[0].headers.authorization).toBe('Bearer a-long-random-string');
    S.syncToken = '';
    await pullAll();
    expect(seen[seen.length - 1].headers.authorization).toBeUndefined();
  });
});

/* ===== The 409 ===== */

describe('a 409 is the whole concurrency story', () => {
  it('re-GETs, re-merges and re-PUTs, and the second PUT carries both halves', async () => {
    let version = 1;
    let shelf = [card('g:1', { box: 1 })];
    let puts = 0;
    const seen = stubFetch(async ({ method, body }) => {
      if (method === 'GET') return { status: 200, body: await packEnvelope(shelf, version) };
      // The first PUT loses the race: another device wrote while it was in flight.
      if (++puts === 1) { shelf = shelf.concat(card('g:2', { box: 2 })); version = 2; return { status: 409, body: { error: 'the version moved', version } }; }
      if (body.version !== version) return { status: 409, body: { error: 'the version moved', version } };
      shelf = await unpackEnvelope(body);
      version += 1;
      return { status: 200, body: { version } };
    });
    S.deck.set('g:3', card('g:3', { box: 1 }));
    const out = await syncStore('deck');
    expect(out.ok).toBe(true);
    expect(seen.filter(s => s.method === 'PUT' && s.store === 'deck').length).toBe(2);
    expect(seen.filter(s => s.method === 'GET' && s.store === 'deck').length).toBe(2);
    // The re-PUT carried the union of both halves…
    expect(shelf.map(r => r.key).sort()).toEqual(['g:1', 'g:2', 'g:3']);
    // …and the row that appeared during the race was applied here too.
    expect(S.deck.has('g:1')).toBe(true);
    expect(S.deck.has('g:2')).toBe(true);
  });

  it('a PUT that keeps losing is re-merged and retried, then bounded', async () => {
    let version = 1;
    const seen = stubFetch(async ({ method }) => {
      if (method === 'GET') return { status: 200, body: await packEnvelope([card('g:' + version, { box: 1 })], version) };
      version += 1;                                  // the shelf moves again every time
      return { status: 409, body: { error: 'the version moved', version } };
    });
    S.deck.set('g:mine', card('g:mine', { box: 2 }));
    const out = await syncStore('deck');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/kept moving/);
    const puts = seen.filter(s => s.method === 'PUT');
    expect(puts.length).toBe(PUT_ATTEMPTS);
    expect(puts.length).toBeLessThan(10);
    // Each retry carried the re-merged union, not the same blob again.
    const last = await unpackEnvelope(puts[puts.length - 1].body);
    expect(last.map(r => r.key)).toContain('g:mine');
    expect(last.length).toBeGreaterThan(1);
  });

  it('gives up quietly when their blob already contains ours', async () => {
    const mine = card('g:1', { box: 2 });
    let calls = 0;
    const seen = stubFetch(async ({ method }) => {
      if (method === 'GET') return { status: 200, body: await packEnvelope([mine], ++calls) };
      return { status: 409, body: { error: 'the version moved' } };
    });
    S.deck.set('g:1', mine);
    S.tactics = new Map(); S.book = new Map();
    const out = await syncStore('deck');
    expect(out.ok).toBe(true);
    expect(seen.filter(s => s.method === 'PUT').length).toBe(0);   // nothing to say
  });
});

/* ===== DELETE ===== */

describe('a delete is ungated', () => {
  it('carries no version and no body', async () => {
    const seen = stubFetch(() => ({ status: 200, body: { ok: true, version: 0 } }));
    await deleteStore('deck');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('DELETE');
    expect(seen[0].body).toBe(null);
  });

  it('erases whatever version the shelf was on, and the counter starts again', async () => {
    const { core } = await reference();
    const token = 'a-long-random-string';
    await core.put(token, 'deck', await packEnvelope([card('g:1')], 0));
    await core.put(token, 'deck', await packEnvelope([card('g:1'), card('g:2')], 1));
    expect((await core.get(token, 'deck')).body.version).toBe(2);
    await deleteStore('deck');                      // no version, no argument
    const after = await core.get(token, 'deck');
    expect(after.body.version).toBe(0);
    expect(after.body.blob).toBe(null);
    // And the device that still holds the cards simply puts them back.
    S.deck.set('g:1', card('g:1'));
    await syncNow();
    expect((await core.get(token, 'deck')).body.version).toBe(1);
  });
});

/* ===== Off by default ===== */

describe('nothing leaves the browser without a press', () => {
  it('sends nothing at all when the switch is off', async () => {
    const seen = stubFetch(() => ({ status: 200, body: { version: 0, blob: null } }));
    S.syncOn = false;
    S.deck.set('g:1', card('g:1', { box: 3 }));
    expect((await syncNow()).skipped).toBe('off');
    expect((await pushAll()).skipped).toBe('off');
    expect((await pullAll()).skipped).toBe('off');
    expect((await syncStore('deck')).skipped).toBe('off');
    expect(seen).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('sends nothing with no server address', async () => {
    const seen = stubFetch(() => ({ status: 200, body: {} }));
    S.syncUrl = '   ';
    expect((await syncNow()).skipped).toBe('unconfigured');
    expect(seen).toHaveLength(0);
  });

  it('refuses while the library is still coming back off the disk', async () => {
    const seen = stubFetch(() => ({ status: 200, body: {} }));
    S._restoring = true;
    expect((await syncNow()).skipped).toBe('restoring');
    expect(seen).toHaveLength(0);
  });

  it('installs no timer and asks for nothing on boot', async () => {
    const seen = stubFetch(() => ({ status: 200, body: {} }));
    const spy = vi.spyOn(globalThis, 'setInterval');
    boot();                       // no document in node: it must return, not throw
    expect(spy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    spy.mockRestore();
  });

  it('pushAll writes nothing here; pullAll sends nothing there', async () => {
    const { core } = await reference();
    const token = 'a-long-random-string';
    await core.put(token, 'deck', await packEnvelope([card('g:theirs', { box: 2 })], 0));
    S.deck.set('g:mine', card('g:mine'));
    await pushAll();
    expect(S.deck.has('g:theirs')).toBe(false);                       // nothing applied here
    expect((await unpackEnvelope((await core.get(token, 'deck')).body)).length).toBe(2);

    const before = (await core.get(token, 'book')).body.version;
    await pullAll();
    expect(S.deck.has('g:theirs')).toBe(true);                        // now it is applied
    expect((await core.get(token, 'book')).body.version).toBe(before); // and nothing was written
  });
});

/* ===== The reference server, in process ===== */

describe('the reference server', () => {
  it('round-trips two devices through one directory', async () => {
    const { core } = await reference();
    const token = 'a-long-random-string';

    // Device A: two cards and a book line.
    S.deck.set('a:1', card('a:1', { box: 3, due: 500 }));
    S.book.set('w:x', line('w:x', { box: 2 }));
    const first = await syncNow();
    expect(first.ok).toBe(true);
    expect(first.sent).toBe(2);

    // Device B: a different card, and the same card one box further on.
    resetS();
    S.deck.set('a:1', card('a:1', { box: 4, due: 900 }));
    S.deck.set('b:2', card('b:2', { box: 1 }));
    const second = await syncNow();
    expect(second.ok).toBe(true);
    expect(second.received).toBeGreaterThan(0);
    expect([...S.deck.keys()].sort()).toEqual(['a:1', 'b:2']);
    expect(S.book.has('w:x')).toBe(true);
    expect(S.deck.get('a:1').box).toBe(4);

    // Device A again: it ends up with everything, and its own card intact.
    resetS();
    S.deck.set('a:1', card('a:1', { box: 3, due: 500 }));
    S.book.set('w:x', line('w:x', { box: 2 }));
    await syncNow();
    expect([...S.deck.keys()].sort()).toEqual(['a:1', 'b:2']);
    expect(S.deck.get('a:1').box).toBe(4);

    const shelf = await core.get(token, 'deck');
    expect(shelf.body.version).toBeGreaterThanOrEqual(2);
    expect(shelf.body.enc).toBe('gzip');
  });

  it('counts versions and answers a stale PUT with 409', async () => {
    const dir = await tmp();
    const core = syncCore(dir);
    expect((await core.get('t', 'deck')).body).toEqual({ version: 0, blob: null, enc: 'identity' });
    expect((await core.put('t', 'deck', { version: 0, blob: '[]', enc: 'identity' })).body.version).toBe(1);
    const stale = await core.put('t', 'deck', { version: 0, blob: '[]', enc: 'identity' });
    expect(stale.code).toBe(409);
    expect(stale.body.version).toBe(1);
    expect((await core.put('t', 'deck', { version: 1, blob: '[]', enc: 'identity' })).body.version).toBe(2);
  });

  it('keeps one shelf per token and never names a token in a path', async () => {
    const dir = await tmp();
    const core = syncCore(dir);
    await core.put('alice', 'deck', { version: 0, blob: '["a"]', enc: 'identity' });
    await core.put('bob', 'deck', { version: 0, blob: '["b"]', enc: 'identity' });
    expect((await core.get('alice', 'deck')).body.blob).toBe('["a"]');
    expect((await core.get('bob', 'deck')).body.blob).toBe('["b"]');
    const dump = JSON.stringify(await import('node:fs').then(fs => fs.readdirSync(dir)));
    expect(dump).not.toContain('alice');
    expect(dump).not.toContain('bob');
  });

  it('refuses a store it has never heard of, opponents included', async () => {
    const dir = await tmp();
    const core = syncCore(dir);
    for (const bad of ['opponents', 'evals', '../../etc/passwd', 'meta']) {
      expect((await core.get('t', bad)).code).toBe(404);
      expect((await core.put('t', bad, { version: 0, blob: '[]' })).code).toBe(404);
      expect((await core.del('t', bad)).code).toBe(404);
    }
  });

  it('refuses a body that is not a blob', async () => {
    const dir = await tmp();
    const core = syncCore(dir);
    expect((await core.put('t', 'deck', { version: 0 })).code).toBe(400);
    expect((await core.put('t', 'deck', null)).code).toBe(400);
  });

  it('mounts only when a directory is named', () => {
    const off = new Map();
    expect(mountSync(off, { dir: '' })).toBe(0);
    expect(off.size).toBe(0);
    const on = new Map();
    expect(mountSync(on, { dir: '/tmp/x' })).toBe(15);
    expect([...on.keys()]).toContain('PUT /sync/deck');
    expect([...on.keys()]).toContain('DELETE /sync/learn');
  });

  it('writes a file per store the shim in the docs could serve', async () => {
    const { dir, core } = await reference();
    S.deck.set('g:1', card('g:1'));
    await syncNow();
    const file = join(dir, (await import('../server/sync.js')).shelfFor('a-long-random-string'), 'deck.json');
    const env = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(env).sort()).toEqual(['blob', 'enc', 'version']);
    expect(env.version).toBe(1);
    expect(await unpackEnvelope(env)).toHaveLength(1);
    expect((await core.get('a-long-random-string', 'deck')).body.version).toBe(1);
  });
});

/* ===== Status ===== */

describe('the status', () => {
  it('says what it did without naming the token', async () => {
    await reference();
    S.deck.set('g:1', card('g:1'));
    await syncNow();
    const st = syncStatus();
    expect(st.on).toBe(true);
    expect(st.busy).toBe(false);
    expect(st.error).toBe('');
    expect(st.sent).toBe(1);
    expect(st.at).toBeGreaterThan(0);
    expect(st.stores.deck.version).toBe(1);
    expect(JSON.stringify(st)).not.toContain('a-long-random-string');
    expect(sync.statusSentence()).toMatch(/sent 1/);
    S.syncOn = false;
    expect(sync.statusSentence()).toMatch(/off/i);
  });

  it('reports a server that is simply not there, and applies nothing', async () => {
    stubFetch(() => ({ status: 503, body: { error: 'down' } }));
    S.deck.set('g:1', card('g:1', { box: 1 }));
    const out = await syncNow();
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/503/);
    expect(S.deck.get('g:1').box).toBe(1);
    expect(syncStatus().busy).toBe(false);
  });

  it('treats a store that was never written as empty, not as a failure', async () => {
    stubFetch(({ method }) => ({ status: method === 'GET' ? 404 : 200, body: { version: 1 } }));
    S.deck.set('g:1', card('g:1'));
    const out = await syncNow();
    expect(out.ok).toBe(true);
    expect(out.sent).toBe(1);
  });
});
