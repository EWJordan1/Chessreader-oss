import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { S } from '../src/state.js';
import { splitPGN, parseGame } from '../src/pgn.js';
import * as mem from '../src/memory.js';
import { exportEverything, importEverything, furtherAlong, pickEvals } from '../src/sync/export.js';

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const corpus = splitPGN(fixture('chesscom.pgn')).map(parseGame).filter(Boolean);

/* Fresh copies every time: the module mutates games (seq, lastPly) in place. */
function games(n = corpus.length) {
  return corpus.slice(0, n).map((g, i) => ({ ...g, source: 'test', addedAt: 1000 + i, seq: 0, bytes: g.pgn.length }));
}
function resetS() {
  S.games = []; S.gi = 0; S.ply = 0; S._seq = 0;
  S.deck = new Map(); S.tactics = new Map(); S.book = new Map(); S.opponents = [];
  S.remember = true; S._restoring = false; S._memToldOff = false;
}
const evalsRow = (gameId, extra = {}) => ({ gameId, build: 'sf17.1-lite', depth: 18, plies: 10, evals: '10,20,30', lines: '', alts: '', bytes: 40, ...extra });
const card = (gameId, ply, sched = {}) => ({ key: gameId + ':' + ply, gameId, ply, fen: 'x', played: 'e2e4', answer: 'd2d4', box: 0, due: 0, seen: 0, passes: 0, fails: 0, ...sched });

beforeAll(async () => { resetS(); await mem.bootMemory(); });
beforeEach(async () => { await mem.eraseAll(); resetS(); });

describe('the database', () => {
  it('opens with the nine stores and the by-opp index', async () => {
    expect(mem.memAvailable()).toBe(true);
    const db = await new Promise((res, rej) => { const r = indexedDB.open(mem.DB_NAME, mem.DB_VERSION); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    expect([...db.objectStoreNames].sort()).toEqual([...mem.MEM_STORES].sort());
    expect(db.objectStoreNames.length).toBe(9);
    const tx = db.transaction('oppgames');
    expect([...tx.objectStore('oppgames').indexNames]).toEqual(['by-opp']);
    expect(tx.objectStore('oppgames').index('by-opp').keyPath).toEqual(['oppId', 'endTime']);
    db.close();
  });
  it('a second open at the same version is a no-op: no upgrade, nothing recreated', async () => {
    await mem.dbPut('book', { key: 'w:abc', color: 'w', moves: ['e4'], box: 2 });
    let upgraded = false;
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(mem.DB_NAME, mem.DB_VERSION);
      r.onupgradeneeded = () => { upgraded = true; };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    db.close();
    expect(upgraded).toBe(false);
    expect((await mem.dbGet('book', 'w:abc')).box).toBe(2);   // an authored row survived the reopen
  });
  it('each helper is one transaction with one request', async () => {
    const txSpy = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const reqs = ['get', 'getAll', 'count', 'put', 'delete', 'clear', 'getKey'].map(m => vi.spyOn(IDBObjectStore.prototype, m));
    const calls = () => reqs.reduce((n, s) => n + s.mock.calls.length, 0);
    const one = async (p) => { txSpy.mockClear(); reqs.forEach(s => s.mockClear()); await p(); expect(txSpy).toHaveBeenCalledTimes(1); expect(calls()).toBe(1); };
    await one(() => mem.dbPut('meta', { k: 'x', v: 1 }));
    await one(() => mem.dbGet('meta', 'x'));
    await one(() => mem.dbAll('meta'));
    await one(() => mem.dbCount('meta'));
    await one(() => mem.dbDelete('meta', 'x'));
    await one(() => mem.dbClear('meta'));
    // many puts, still one transaction
    txSpy.mockClear(); reqs.forEach(s => s.mockClear());
    await mem.dbPutAll('meta', [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'c', v: 3 }]);
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(3);
    vi.restoreAllMocks();
  });
  it('dbIndexRange walks one opponent in date order', async () => {
    await mem.dbPutAll('oppgames', [
      { key: 'a:1', oppId: 'a', pgnId: '1', endTime: 30 }, { key: 'a:2', oppId: 'a', pgnId: '2', endTime: 10 },
      { key: 'b:1', oppId: 'b', pgnId: '1', endTime: 20 },
    ]);
    const rows = await mem.dbIndexRange('oppgames', 'by-opp', ['a', 0], ['a', Infinity]);
    expect(rows.map(r => r.key)).toEqual(['a:2', 'a:1']);
  });
});

describe('remembering games', () => {
  it('stores only the PGN and re-parses on restore; the stored id wins', async () => {
    const gs = games(3);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    const row = await mem.dbGet('games', gs[0].id);
    expect(row.fens).toBeUndefined();
    expect(row.moves).toBeUndefined();
    expect(row.pgn).toBe(gs[0].pgn);
    expect(Object.keys(row).sort()).toEqual(['addedAt', 'bytes', 'headers', 'id', 'lastPlayedAt', 'lastPly', 'pgn', 'seq', 'source']);
    // a foreign id must survive the round trip untouched: cards and evals point at it
    await mem.dbPut('games', { ...row, id: 'legacy-id' });
    resetS();
    await mem.restoreLibrary();
    expect(S.games.length).toBe(4);
    const back = S.games.find(g => g.id === 'legacy-id');
    expect(back.fens.length).toBe(back.moves.length + 1);
    expect(S._seq).toBe(3);
  });
  it('restores the Maps and the cursor, and only a cursor whose game is present', async () => {
    const gs = games(2);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    await mem.dbPut('deck', card(gs[0].id, 4));
    await mem.dbPut('tactics', card(gs[1].id, 6));
    await mem.dbPut('book', { key: 'w:h', color: 'w', moves: ['e4'], box: 1 });
    await mem.dbPut('opponents', { id: 'lichess:bob', site: 'lichess', handle: 'bob' });
    await mem.dbPut('meta', { k: 'cursor', v: { id: gs[1].id, ply: 5 } });
    resetS();
    const cur = await mem.restoreLibrary();
    expect(cur).toEqual({ i: 1, ply: 5 });
    expect(S.gi).toBe(1); expect(S.ply).toBe(5);
    expect(S.deck.get(gs[0].id + ':4').ply).toBe(4);
    expect(S.tactics.size).toBe(1);
    expect(S.book.get('w:h').moves).toEqual(['e4']);
    expect(S.opponents.map(o => o.handle)).toEqual(['bob']);
    // a cursor pointing at an evicted game is ignored rather than clamped onto another
    await mem.dbPut('meta', { k: 'cursor', v: { id: 'gone', ply: 3 } });
    resetS();
    expect(await mem.restoreLibrary()).toBeNull();
    expect(S.gi).toBe(0); expect(S.ply).toBe(0);
  });
  it('restores nothing when memory is off', async () => {
    const gs = games(2);
    await mem.rememberGames(gs);
    resetS(); S.remember = false;
    await mem.restoreLibrary();
    expect(S.games).toEqual([]);
  });
});

describe('the cap', () => {
  it('is 2000, evicts oldest seq first, spares the game on screen, takes the evals row and keeps the cards', async () => {
    expect(mem.GAME_CAP).toBe(2000);
    const gs = games(10);
    S.games = gs.slice();
    S.gi = 0;                              // the oldest game is the one on screen
    await mem.rememberGames(gs);
    for (const g of gs) await mem.dbPut('evals', evalsRow(g.id));
    await mem.dbPut('deck', card(gs[1].id, 3));
    const evicted = await mem.evictOverCap(7);
    expect(evicted).toEqual([gs[1].id, gs[2].id, gs[3].id]);   // seq 2,3,4 — seq 1 is spared
    expect(await mem.dbCount('games')).toBe(7);
    expect(await mem.dbGet('games', gs[0].id)).toBeDefined();
    expect(await mem.dbGet('evals', gs[1].id)).toBeUndefined();
    expect(await mem.dbGet('evals', gs[0].id)).toBeDefined();
    expect(await mem.dbCount('deck')).toBe(1);                 // earned history survives
    // and S agrees with the disk, with the cursor still on the spared game
    expect(S.games.map(g => g.id)).not.toContain(gs[1].id);
    expect(S.games.length).toBe(7);
    expect(S.games[S.gi].id).toBe(gs[0].id);
  });
  it('does nothing under the cap', async () => {
    const gs = games(3);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    expect(await mem.evictOverCap(3)).toEqual([]);
    expect(S.games.length).toBe(3);
  });
});

describe('the cursor', () => {
  it('writes meta and the row, but never a blind put for a game that is not stored', async () => {
    const gs = games(2);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    await mem.dbDelete('games', gs[1].id);   // evicted
    S.gi = 1; S.ply = 7;
    await mem.writeCursor();
    expect(await mem.dbGet('games', gs[1].id)).toBeUndefined();   // not resurrected
    expect((await mem.dbGet('meta', 'cursor')).v).toEqual({ id: gs[1].id, ply: 7 });
    S.gi = 0; S.ply = 3;
    await mem.writeCursor();
    const row = await mem.dbGet('games', gs[0].id);
    expect(row.lastPly).toBe(3);
    expect(row.lastPlayedAt).toBeGreaterThan(0);
  });
  it('refuses to write while restoring or with memory off', async () => {
    const gs = games(1);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    S._restoring = true;
    expect(await mem.writeCursor()).toBe(false);
    S._restoring = false; S.remember = false;
    expect(await mem.writeCursor()).toBe(false);
    expect(await mem.dbGet('meta', 'cursor')).toBeUndefined();
  });
});

describe('the switch and the erase', () => {
  it('turning memory off erases the disk and leaves the screen alone', async () => {
    const gs = games(3);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    await mem.dbPut('deck', card(gs[0].id, 2));
    S.deck.set(gs[0].id + ':2', card(gs[0].id, 2));
    S.remember = false;
    await mem.eraseAll();
    for (const name of mem.MEM_STORES) expect(await mem.dbCount(name)).toBe(0);
    expect(S.games.length).toBe(3);
    expect(S.deck.size).toBe(1);
  });
  it('the button erases the disk and the screen, and never the settings', async () => {
    const gs = games(2);
    S.games = gs.slice(); S.gi = 1; S.ply = 4;
    await mem.rememberGames(gs);
    S.book.set('w:x', { key: 'w:x' });
    S.theme = 'wood';
    const n = await mem.forgetEverything();
    expect(n).toBe(2);
    expect(S.games).toEqual([]); expect(S.gi).toBe(0); expect(S.ply).toBe(0); expect(S._seq).toBe(0);
    expect(S.book.size).toBe(0);
    expect(await mem.dbCount('games')).toBe(0);
    expect(S.theme).toBe('wood');
    expect(S.remember).toBe(true);
  });
  it('turning memory on writes what the session holds', async () => {
    const gs = games(2);
    S.games = gs.slice();
    S.deck.set(gs[0].id + ':1', card(gs[0].id, 1));
    S.opponents = [{ id: 'chesscom:ann', site: 'chesscom', handle: 'ann' }];
    await mem.persistLibrary();
    expect(await mem.dbCount('games')).toBe(2);
    expect(await mem.dbCount('deck')).toBe(1);
    expect(await mem.dbCount('opponents')).toBe(1);
    expect((await mem.dbGet('meta', 'cursor')).v.id).toBe(gs[0].id);
  });
  it('memUsage counts every store and prices the rows', async () => {
    const gs = games(3);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    await mem.dbPut('evals', evalsRow(gs[0].id, { bytes: 500 }));
    await mem.dbPut('deck', card(gs[0].id, 1));
    await mem.dbPut('book', { key: 'b:q', color: 'b', moves: ['c5'] });
    const u = await mem.memUsage();
    expect(u.games).toBe(3); expect(u.evals).toBe(1); expect(u.deck).toBe(1); expect(u.tactics).toBe(0); expect(u.book).toBe(1);
    const pgnBytes = gs.reduce((n, g) => n + g.pgn.length, 0);
    expect(u.bytes).toBeGreaterThan(pgnBytes + 500);
    expect(mem.usageSentence(u)).toMatch(/^3 games, 1 analysed, 1 card, 1 book line, \d+ KB on this device\.$/);
    S.remember = false;
    expect(mem.usageSentence(u)).toMatch(/^Off\./);
  });
});

describe('export and import', () => {
  it('round-trips everything but the prep list', async () => {
    const gs = games(4);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    await mem.dbPut('evals', evalsRow(gs[0].id));
    S.deck.set(gs[0].id + ':3', card(gs[0].id, 3, { box: 2, due: 50 }));
    S.tactics.set(gs[1].id + ':5', card(gs[1].id, 5));
    S.book.set('w:k', { key: 'w:k', color: 'w', moves: ['e4', 'e5'], name: 'Open', box: 1 });
    S.opponents = [{ id: 'lichess:zed', site: 'lichess', handle: 'zed' }];
    await mem.persistLibrary();
    await mem.dbPut('meta', { k: 'hero', v: 'me' });
    const obj = await exportEverything();
    expect(obj.v).toBe(1);
    expect(obj.games.length).toBe(4);
    expect(obj.games[0].fens).toBeUndefined();
    expect(obj.evals.length).toBe(1);
    expect(obj.deck.length).toBe(1); expect(obj.tactics.length).toBe(1); expect(obj.book.length).toBe(1);
    expect(obj.meta.map(r => r.k).sort()).toEqual(['cursor', 'hero']);
    expect(obj.opponents).toBeUndefined();
    const json = JSON.parse(JSON.stringify(obj));   // what the file would hold

    await mem.forgetEverything();
    const added = await importEverything(json);
    expect(added).toEqual({ games: 4, evals: 1, deck: 1, tactics: 1, book: 1, meta: 1 });
    expect(S.games.map(g => g.id).sort()).toEqual(gs.map(g => g.id).sort());
    expect(S.games[0].fens.length).toBeGreaterThan(1);
    expect(await mem.dbCount('games')).toBe(4);
    expect((await mem.dbGet('evals', gs[0].id)).evals).toBe('10,20,30');
    expect(S.deck.get(gs[0].id + ':3').box).toBe(2);
    expect(S.book.get('w:k').name).toBe('Open');
    expect((await mem.dbGet('meta', 'hero')).v).toBe('me');
    expect(await mem.dbGet('meta', 'cursor')).toBeUndefined();   // where *they* were is not where you are
    expect(S.opponents).toEqual([]);
  });
  it('dedupes games by id and takes the further-along card schedule', async () => {
    const gs = games(2);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    S.deck.set(gs[0].id + ':1', card(gs[0].id, 1, { box: 3, due: 100 }));   // further along locally
    S.deck.set(gs[0].id + ':2', card(gs[0].id, 2, { box: 1, due: 100 }));   // behind locally
    S.deck.set(gs[0].id + ':3', card(gs[0].id, 3, { box: 1, due: 100 }));   // same box, earlier due
    const obj = {
      v: 1, exportedAt: 1,
      games: gs.map(mem.memRow),
      deck: [card(gs[0].id, 1, { box: 1, due: 999 }), card(gs[0].id, 2, { box: 2, due: 5 }), card(gs[0].id, 3, { box: 1, due: 200 }), card(gs[1].id, 9, { box: 0 })],
      tactics: [], book: [], evals: [], meta: [],
    };
    const added = await importEverything(obj);
    expect(added.games).toBe(0);
    expect(S.games.length).toBe(2);
    expect(added.deck).toBe(1);
    expect(S.deck.get(gs[0].id + ':1').box).toBe(3);      // never reset
    expect(S.deck.get(gs[0].id + ':2').box).toBe(2);      // the higher box wins
    expect(S.deck.get(gs[0].id + ':3').due).toBe(200);    // boxes equal: the later due
    expect((await mem.dbGet('deck', gs[0].id + ':2')).box).toBe(2);
    // only what changed is written: the card that kept its local schedule is not rewritten
    expect(await mem.dbCount('deck')).toBe(3);
    expect(await mem.dbGet('deck', gs[0].id + ':1')).toBeUndefined();
  });
  it('merges evals by fullness within a build and keeps the local row across builds', async () => {
    const gs = games(2);
    S.games = gs.slice();
    await mem.rememberGames(gs);
    await mem.dbPut('evals', evalsRow(gs[0].id, { evals: '10,,' }));
    await mem.dbPut('evals', evalsRow(gs[1].id, { build: 'other' }));
    const obj = { v: 1, exportedAt: 1, games: [], deck: [], tactics: [], book: [], meta: [],
      evals: [evalsRow(gs[0].id, { evals: '10,20,30' }), evalsRow(gs[1].id, { evals: '1,2,3,4,5,6' }), evalsRow('nobody')] };
    const added = await importEverything(obj);
    expect(added.evals).toBe(1);
    expect((await mem.dbGet('evals', gs[0].id)).evals).toBe('10,20,30');
    expect((await mem.dbGet('evals', gs[1].id)).build).toBe('other');
    expect(await mem.dbGet('evals', 'nobody')).toBeUndefined();
    expect(pickEvals(evalsRow('a', { evals: '1,2' }), evalsRow('a', { evals: '1,' })).evals).toBe('1,2');
    expect(furtherAlong(null, { box: 1 })).toEqual({ box: 1 });
  });
  it('rejects a file that is not an export', async () => {
    expect(await importEverything(null)).toEqual({ games: 0, evals: 0, deck: 0, tactics: 0, book: 0, meta: 0 });
    expect(await importEverything({ hello: 'world' })).toEqual({ games: 0, evals: 0, deck: 0, tactics: 0, book: 0, meta: 0 });
  });
});

describe('when there is no storage', () => {
  let m, state, saved;
  beforeAll(async () => {
    saved = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    vi.resetModules();
    state = (await import('../src/state.js')).S;
    m = await import('../src/memory.js');
    state.remember = true; state._memToldOff = false; state._restoring = true;
    await m.bootMemory();
  });
  afterAll(() => { globalThis.indexedDB = saved; vi.resetModules(); });
  it('boots, says so once, and finishes restoring', () => {
    expect(m.memAvailable()).toBe(false);
    expect(state._memToldOff).toBe(true);
    expect(state._restoring).toBe(false);
  });
  it('every helper resolves normally', async () => {
    expect(await m.dbGet('games', 'x')).toBeUndefined();
    expect(await m.dbAll('games')).toEqual([]);
    expect(await m.dbCount('games')).toBe(0);
    expect(await m.dbIndexRange('oppgames', 'by-opp', ['a', 0], ['a', 1])).toEqual([]);
    expect(await m.dbPut('games', { id: 'x' })).toBe(false);
    expect(await m.dbPutAll('games', [{ id: 'x' }])).toBe(false);
    expect(await m.dbDelete('games', 'x')).toBe(false);
    expect(await m.dbClear('games')).toBe(false);
    expect(await m.memUsage()).toEqual({ games: 0, evals: 0, deck: 0, tactics: 0, book: 0, bytes: 0 });
    expect(await m.rememberGames(games(1))).toEqual([]);
    expect(await m.eraseAll()).toBe(false);
    expect(m.usageSentence(await m.memUsage())).toMatch(/will not let the page store/);
  });
});
