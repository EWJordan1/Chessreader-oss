/*
 * Memory (§5): IndexedDB, the nine stores, and everything that decides what this device
 * remembers between visits.
 *
 * Nothing in here is authoritative. S is (§2.4); the archive the games came from is one
 * lookup away; the analysis is recomputable. So every failure path — no IndexedDB, a
 * private window, a refused open, a full disk — is "carry on in memory, exactly as
 * before", said once and then never mentioned again. Callers never branch on it: every
 * helper resolves normally when storage is unavailable (get → undefined, all → [],
 * puts → false).
 *
 * Four stores are not caches and must never be blanket-wiped (§5): `deck` and `tactics`
 * are earned, `book` is authored, `opponents` is a record of someone's weekend. The only
 * thing that empties them is the erase the reader presses twice.
 */
import { S, currentGame } from './state.js';
import { parseGame, mergeGames, PARSE_SLICE_MS } from './pgn.js';
import { $, toast, showLoading, hideLoading, plural } from './dom.js';
import { updateAll } from './render.js';
import { route } from './route.js';
import { setGame, onCursor } from './playback.js';
import { onGamesAdded } from './sources.js';
import { exportEverything, importEverything } from './sync/export.js';

export { exportEverything, importEverything };

export const DB_NAME = 'chessreader';
/*
 * The version is the migration contract. onupgradeneeded below creates what is missing
 * and touches nothing that is there, so a bump is always safe for the four stores that
 * cannot be rebuilt. A migration that needs to *change* a store must do so row by row,
 * never by deleting and recreating it — the original's version-1 opener wiped every
 * store on upgrade, and that is the bug this comment exists to keep out.
 */
export const DB_VERSION = 1;
/* A PGN is ~2 KB, so the ceiling is a few megabytes of games — the analysis beside them
   is several times that, which is why the size in Settings counts both. */
export const GAME_CAP = 2000;
/* The cursor: a disk write per ply of playback is the alternative. */
export const CURSOR_DEBOUNCE_MS = 1500;
/* The second press must come soon enough to be the same intention. */
export const ERASE_ARM_MS = 6000;
/* Past this many rows the restore is felt, so it gets the overlay (same bar as an import). */
const LOADING_MIN = 20;
/*
 * indexedDB.open() is not obliged to answer. A locked-down sandbox or a profile
 * mid-repair can leave the request pending forever, and boot awaits it — so a bounded
 * wait, generous enough for a cold profile on a slow disk, puts us on the same path as
 * a refusal rather than wedging the app on a greeting with no way in.
 */
const OPEN_TIMEOUT_MS = 4000;

/*
 * Every store, in one list, because the cost of a second literal is that the erase
 * quietly stops being complete when a store is added.
 */
export const MEM_STORES = ['games', 'evals', 'deck', 'tactics', 'book', 'meta', 'opponents', 'oppgames', 'oppevals'];

let _db = null;          // the resolved handle
let _opening = null;     // the in-flight open, so concurrent callers share one attempt
let _gaveUp = false;     // the wait ran out; latched so boot pays it once, not once per store
let _available = false;  // the module's verdict for callers; see memAvailable()

const hasDOM = () => typeof document !== 'undefined';
function dispatch(name, detail) {
  if (hasDOM()) document.dispatchEvent(new CustomEvent(name, { detail }));
}

/** false = carry on in memory. True only once a database has actually opened. */
export function memAvailable() { return _available && !!_db; }

function createStores(db) {
  // Only what is missing. This is the whole of the "every migration is additive" rule.
  const mk = (name, keyPath) => (db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, { keyPath }));
  mk('games', 'id');          // a hash of the cleaned PGN
  mk('evals', 'gameId');      // one row per analysed game
  mk('deck', 'key');          // gameId:ply — one self-contained card
  mk('tactics', 'key');       // the deck's shape at the 200–300 band
  mk('book', 'key');          // w|b : hash of the SAN moves — the one store the reader authored
  mk('meta', 'k');
  mk('opponents', 'id');      // site:handle
  /*
   * Opponents' games are their own store rather than an `owner` column on `games`:
   * the cap sorts the whole games store by arrival and evicts the oldest, so a
   * stranger's 300-game archive sharing it would evict the reader's own history to make
   * room for somebody they are playing on Saturday. The compound index is what makes
   * Prep cheap — one bounded range is one opponent's games in date order, and drawing
   * the list never reads a PGN.
   */
  const opp = mk('oppgames', 'key');
  if (opp) opp.createIndex('by-opp', ['oppId', 'endTime']);
  mk('oppevals', 'key');      // oppId:pgnId — keyed as their games are, so both go together
}

function open() {
  if (_db) return Promise.resolve(_db);
  if (_opening) return _opening;
  if (_gaveUp) return Promise.resolve(null);
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.resolve(null);
  _opening = new Promise(resolve => {
    let req, settled = false, timer = 0;
    const settle = v => { if (settled) return; settled = true; clearTimeout(timer); _opening = null; resolve(v); };
    try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { settle(null); return; }
    timer = setTimeout(() => { _gaveUp = true; settle(null); }, OPEN_TIMEOUT_MS);
    req.onupgradeneeded = () => { try { createStores(req.result); } catch (e) { /* onerror follows */ } };
    req.onsuccess = () => {
      _db = req.result;
      _available = true;
      // A second tab on a newer build must not sit blocked behind this one. Closing
      // costs this tab its handle and nothing else: the next call reopens.
      _db.onversionchange = () => { try { _db.close(); } catch (e) { /* already closed */ } _db = null; };
      // Adopted even if the wait above already gave up: settle() is a no-op by then,
      // and the next caller finds _db and never opens again.
      settle(_db);
    };
    req.onerror = () => settle(null);
    req.onblocked = () => settle(null);
  });
  return _opening;
}

/*
 * Said once a session, and only to someone who asked for memory and cannot have it. It
 * reports; it does not offer to fix anything, because there is nothing the reader can
 * do about a browser that refuses storage.
 */
function tellOff(err) {
  _available = false;
  if (S._memToldOff || !S.remember) return;
  S._memToldOff = true;
  const full = err && (err.name === 'QuotaExceededError' || err.name === 'NotEnoughSpace');
  const cause = full
    ? 'There is no room left on this device to keep your games.'
    : 'This browser will not let the page store anything.';
  if (!hasDOM()) return;
  toast(cause + ' Your games last only as long as this tab.');
  const el = $('rail-status');
  if (el) el.textContent = 'Nothing is kept on this device.';
}

/** One request, as a promise. */
function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
/*
 * The transaction, not the request. Waiting on the last put says the put was accepted;
 * waiting on the transaction says it was written, which is the only one of the two
 * worth reporting to someone who asked to be remembered.
 */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

/*
 * Every helper is one transaction with one request, and nothing happens inside the
 * transaction after an await: a transaction idle for a microtask is one the browser is
 * entitled to close, and the bug that produces is intermittent by construction. A
 * caller that needs two stores makes two calls.
 */
async function read(store, fallback, fn) {
  const db = await open();
  if (!db) return fallback;
  try {
    const tx = db.transaction(store, 'readonly');
    return await request(fn(tx.objectStore(store)));
  } catch (e) { return fallback; }
}
async function write(store, fn) {
  const db = await open();
  if (!db) return false;
  try {
    const tx = db.transaction(store, 'readwrite');
    fn(tx.objectStore(store));
    return await done(tx);
  } catch (e) { tellOff(e); return false; }
}

export function dbGet(store, key) { return read(store, undefined, s => s.get(key)); }
export function dbAll(store) { return read(store, [], s => s.getAll()); }
export function dbCount(store) { return read(store, 0, s => s.count()); }
/** For oppgames: index 'by-opp' on [oppId, endTime]; bounds are compound keys. */
export function dbIndexRange(store, index, lower, upper) {
  return read(store, [], s => {
    const KR = globalThis.IDBKeyRange;
    const range = lower !== undefined && upper !== undefined && KR ? KR.bound(lower, upper) : undefined;
    return s.index(index).getAll(range);
  });
}
export function dbPut(store, row) { return write(store, s => s.put(row)); }
/** Many puts, one transaction — the same rule, since none of them awaits. */
export function dbPutAll(store, rows) {
  if (!rows || !rows.length) return Promise.resolve(true);
  return write(store, s => { for (const r of rows) s.put(r); });
}
export function dbDelete(store, key) { return write(store, s => s.delete(key)); }
export function dbClear(store) { return write(store, s => s.clear()); }
/** Existence without the row: the check writeCursor() needs before it puts. */
function dbHas(store, key) { return read(store, false, s => s.getKey(key)).then(k => k !== undefined); }

/* ----- the games ----- */

/** The row: only the PGN goes, because a FEN per ply is ~3× the size of the game producing it. */
export function memRow(g) {
  return {
    id: g.id, pgn: g.pgn, headers: g.headers || {}, source: g.source || '',
    addedAt: g.addedAt || Date.now(), seq: g.seq || 0, bytes: g.bytes || (g.pgn ? g.pgn.length : 0),
    lastPly: g.lastPly || 0, lastPlayedAt: g.lastPlayedAt || 0,
  };
}

/*
 * Called after the games are already on screen and playable. An import that has visibly
 * finished and then blocks on a disk write looks broken, and the write is the one part
 * of it nobody is waiting for. Resolves the ids evicted to make room.
 */
export async function rememberGames(games) {
  if (!S.remember || !memAvailable() || !games || !games.length) return [];
  for (const g of games) if (!g.seq) g.seq = ++S._seq;
  const ok = await dbPutAll('games', games.filter(g => g && g.id && g.pgn).map(memRow));
  if (!ok) return [];
  return evictOverCap();
}

/*
 * Oldest first, by the order they arrived. The cap exists because an "all time" archive
 * on a heavy account is not two megabytes, and a quota error mid-import is a worse way
 * to discover that than a count in Settings that has stopped going up.
 *
 * A game's analysis goes with it: an eval outliving the game it is about is a record of
 * a game we have said we no longer have. A card is earned history and carries its own
 * position, so it deliberately survives. The evicted games leave S too — a library that
 * is on screen but not on disk would be back to "the tab is the unit of memory" for
 * exactly the games the reader has had longest.
 */
export async function evictOverCap(cap = GAME_CAP) {
  const rows = await dbAll('games');
  if (rows.length <= cap) return [];
  rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  // Everything but the game on screen: evicting what someone is in the middle of
  // listening to is the one eviction they would actually notice.
  const here = currentGame();
  const spared = here ? here.id : '';
  const ids = rows.filter(r => r.id !== spared).slice(0, rows.length - cap).map(r => r.id);
  if (!ids.length) return [];
  const gone = new Set(ids);
  let ok = true;
  for (const id of ids) {
    if (!(await dbDelete('games', id))) { ok = false; gone.delete(id); continue; }
    await dbDelete('evals', id);
  }
  if (!ok && !gone.size) return [];
  const before = S.games.length;
  S.games = S.games.filter(g => !gone.has(g.id));
  if (S.games.length !== before) {
    // The spared game keeps the cursor even though its index moved under it.
    S.gi = spared ? Math.max(0, S.games.findIndex(g => g.id === spared)) : Math.min(S.gi, Math.max(0, S.games.length - 1));
  }
  const evicted = [...gone];
  dispatch('cr:games-removed', { ids: evicted });
  if (hasDOM() && S.games.length !== before) updateAll();
  return evicted;
}

/* ----- the cursor ----- */

let _cursorTimer = 0;
export function rememberCursor() {
  // Never while restoring: setGame() fires this on the way back in, and writing the
  // cursor we just read is a no-op at best and a stale ply at worst.
  if (!S.remember || S._restoring) return;
  clearTimeout(_cursorTimer);
  _cursorTimer = setTimeout(writeCursor, CURSOR_DEBOUNCE_MS);
}

/*
 * The game carries its own lastPly as well as meta carrying the pair, so a library
 * restored tomorrow can put every game back where it was left and not only the last one.
 */
export async function writeCursor() {
  const g = currentGame();
  if (!S.remember || S._restoring || !g || !g.id) return false;
  g.lastPly = S.ply;
  g.lastPlayedAt = Date.now();
  /*
   * The existence check is its own read, before the write and not inside it, and it
   * is what stops this being a way back into the store: a game evicted under the cap
   * is not kept, and a blind put would silently undo that — one game over the ceiling,
   * forever, churning in and out on every import.
   */
  if (await dbHas('games', g.id)) await dbPut('games', memRow(g));
  return dbPut('meta', { k: 'cursor', v: { id: g.id, ply: S.ply } });
}

/* ----- restore ----- */

function yieldToPaint() {
  if (typeof scheduler === 'object' && scheduler && scheduler.yield) return scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

/*
 * The Maps first, then the games. The rooms that boot after memory read S.deck, S.book
 * and S.opponents directly; the games are the slow part and the last thing needed.
 * Resolves the cursor {i, ply} to restore, or null. Repaints nothing: bootMemory() does.
 */
export async function restoreLibrary() {
  if (!S.remember) return null;
  const db = await open();
  if (!db) { tellOff(); return null; }
  const toMap = rows => new Map(rows.filter(r => r && r.key).map(r => [r.key, r]));
  S.deck = toMap(await dbAll('deck'));
  S.tactics = toMap(await dbAll('tactics'));
  S.book = toMap(await dbAll('book'));
  S.opponents = (await dbAll('opponents')).filter(r => r && r.id);

  const rows = await dbAll('games');
  rows.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const big = hasDOM() && rows.length >= LOADING_MIN;
  if (big) { showLoading('Getting your games back…', 0); await yieldToPaint(); }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const games = [];
  let mark = now();
  for (let i = 0; i < rows.length; i++) {
    const g = rows[i].pgn ? parseGame(rows[i].pgn) : null;
    if (g) {
      // The stored key wins over the one just recomputed: it is what the evals, the
      // deck and the cursor all reference, and a hash that has drifted between builds
      // must not silently orphan them.
      g.id = rows[i].id;
      g.source = rows[i].source || '';
      g.addedAt = rows[i].addedAt || 0;
      g.seq = rows[i].seq || 0;
      g.bytes = rows[i].bytes || rows[i].pgn.length;
      g.lastPly = rows[i].lastPly || 0;
      g.lastPlayedAt = rows[i].lastPlayedAt || 0;
      games.push(g);
    }
    if (now() - mark >= PARSE_SLICE_MS) {
      if (big) showLoading('Getting your games back… ' + (i + 1) + ' of ' + plural(rows.length, 'game'), (i + 1) / rows.length);
      await yieldToPaint();
      mark = now();
    }
  }
  if (big) hideLoading();
  mergeGames(S.games, games);
  S._seq = S.games.reduce((m, g) => Math.max(m, g.seq || 0), S._seq || 0);
  await dbPut('meta', { k: 'schema', v: DB_VERSION });

  const cur = await dbGet('meta', 'cursor');
  if (cur && cur.v && cur.v.id) {
    const i = S.games.findIndex(g => g.id === cur.v.id);
    if (i >= 0) {
      const ply = Math.max(0, Math.min(S.games[i].moves.length, +cur.v.ply || 0));
      S.gi = i; S.ply = ply;
      return { i, ply };
    }
  }
  return null;
}

/* ----- erase ----- */

/*
 * "Erases immediately" is the whole promise, so this empties every store rather than
 * the one the reader happened to be looking at. It is the disk only: what turning the
 * switch off does. What is on screen stays — this session's work is not what is being
 * withdrawn. Settings live in localStorage and are never touched from here.
 */
export async function eraseAll() {
  clearTimeout(_cursorTimer);
  let ok = true;
  for (const name of MEM_STORES) if (!(await dbClear(name))) ok = false;
  return ok;
}

/*
 * The button: the disk and the screen both. The games, their analysis, the cards, the
 * book, the prep list and where you were. Settings are untouched, and they are the only
 * thing left in this browser afterwards.
 */
export async function forgetEverything() {
  const ids = S.games.map(g => g.id);
  await eraseAll();
  S.games = [];
  S.gi = 0; S.ply = 0; S._seq = 0;
  S.deck = new Map(); S.tactics = new Map(); S.book = new Map(); S.opponents = [];
  S.varFrom = -1; S.varMoves = []; S.varFens = []; S.varAt = 0;
  dispatch('cr:games-removed', { ids });
  dispatch('cr:deck-changed', { reason: 'erase' });
  dispatch('cr:book-changed', { reason: 'erase' });
  if (hasDOM()) { updateAll(); route(); }
  return ids.length;
}

/*
 * The switch going on: whatever this session already holds goes to the disk. The evals
 * are the engine's rows and are not rewritten here — the engine may listen for
 * `cr:setting` {key:'remember'} and put its own; until then a re-analysis is what the
 * switch costs for games analysed while it was off.
 */
export async function persistLibrary() {
  if (!S.remember || !memAvailable()) return false;
  await rememberGames(S.games.filter(g => g && g.id));
  await dbPutAll('deck', [...S.deck.values()]);
  await dbPutAll('tactics', [...S.tactics.values()]);
  await dbPutAll('book', [...S.book.values()]);
  await dbPutAll('opponents', S.opponents.slice());
  await writeCursor();
  return true;
}

/* ----- usage ----- */

const jsonBytes = rows => rows.reduce((n, r) => { try { return n + JSON.stringify(r).length; } catch (e) { return n; } }, 0);

/*
 * The count and the size, because a cap nobody can see is a surprise waiting to happen
 * and "43 games, 1.2 MB" is the only version of this sentence a reader can check
 * against what they think they loaded. The games and evals rows carry their own byte
 * counts; the rest is small and estimated as the JSON it would be.
 */
export async function memUsage() {
  const games = await dbAll('games');
  const evals = await dbAll('evals');
  let bytes = 0;
  for (const r of games) bytes += r.bytes || (r.pgn ? r.pgn.length : 0);
  for (const r of evals) bytes += r.bytes || 0;
  const deck = await dbCount('deck');
  const tactics = await dbCount('tactics');
  const book = await dbCount('book');
  for (const name of ['deck', 'tactics', 'book', 'meta', 'opponents', 'oppgames', 'oppevals']) bytes += jsonBytes(await dbAll(name));
  return { games: games.length, evals: evals.length, deck, tactics, book, bytes };
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** The sentence under the switch. Exported so the test can pin its shape without a DOM. */
export function usageSentence(u) {
  if (!S.remember) return 'Off. Your games last as long as this tab, and this page starts empty every visit.';
  if (!memAvailable()) return 'This browser will not let the page store anything, so your games last as long as this tab.';
  if (!u || (!u.games && !u.deck && !u.tactics && !u.book)) return 'Nothing is kept yet. Games you import stay on this device.';
  const parts = [plural(u.games, 'game')];
  if (u.evals) parts.push(u.evals + ' analysed');
  if (u.deck + u.tactics) parts.push(plural(u.deck + u.tactics, 'card'));
  if (u.book) parts.push(plural(u.book, 'book line'));
  parts.push(fmtBytes(u.bytes) + ' on this device');
  return parts.join(', ') + '.';
}

async function paintUsage() {
  const el = hasDOM() && $('mem-usage');
  if (!el) return;
  el.textContent = usageSentence(await memUsage());
}

/* ----- boot ----- */

/*
 * Two presses rather than a modal. The label already says what it destroys; what it
 * cannot say on its own is that the press was meant, and a second press says that
 * without taking the screen away to ask.
 */
function wireErase() {
  const btn = $('btn-erase');
  if (!btn) return;
  const label = btn.textContent;
  let armed = false, timer = 0;
  btn.addEventListener('click', async () => {
    if (armed) {
      clearTimeout(timer); armed = false; btn.textContent = label;
      const n = await forgetEverything();
      toast(n ? 'Erased. ' + plural(n, 'game') + ' and everything read from them are gone from this device.' : 'Erased. Nothing was kept on this device.');
      paintUsage();
      return;
    }
    armed = true;
    btn.textContent = 'Press again to erase';
    timer = setTimeout(() => { armed = false; btn.textContent = label; }, ERASE_ARM_MS);
  });
}

function wireExport() {
  const exp = $('btn-export');
  if (exp) exp.addEventListener('click', async () => {
    const obj = await exportEverything();
    const d = new Date(obj.exportedAt);
    const name = 'chessreader-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.json';
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported ' + plural(obj.games.length, 'game') + ', ' + plural(obj.deck.length + obj.tactics.length, 'card') + ' and ' + plural(obj.book.length, 'book line') + '.');
  });
  const file = $('file-import');
  if (file) file.addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    let obj = null;
    try { obj = JSON.parse(await f.text()); } catch (err) { obj = null; }
    e.target.value = '';
    if (!obj) { toast('That file is not a ChessReader export.'); return; }
    await importEverything(obj);
    paintUsage();
  });
}

function wireSwitch() {
  document.addEventListener('cr:setting', async e => {
    if (!e.detail || e.detail.key !== 'remember') return;
    // Off erases immediately; it does not merely stop writing. On writes what the
    // session already holds, so the switch costs nothing either way.
    if (S.remember) await persistLibrary(); else await eraseAll();
    paintUsage();
  });
  document.addEventListener('cr:settings-painted', paintUsage);
  document.addEventListener('cr:games-added', paintUsage);
  document.addEventListener('cr:deck-changed', paintUsage);
  document.addEventListener('cr:book-changed', paintUsage);
  document.addEventListener('cr:analysis-done', paintUsage);
}

/**
 * Open, migrate, load the Maps, restore the games, fire cr:restored. Every other module
 * boots after this resolves, so S.deck, S.book and S.opponents are already there for
 * them. Tolerates a missing document: the DOM wiring is skipped, the rest is not.
 */
export async function bootMemory() {
  S._restoring = true;
  let cur = null;
  try { cur = await restoreLibrary(); } catch (e) { /* the app works from memory */ }
  // The hooks, after the restore, so the restore's own cursor changes never write.
  onGamesAdded(games => { rememberGames(games); });
  onCursor(rememberCursor);
  if (hasDOM()) {
    if (cur) setGame(cur.i, cur.ply);   // repaints; rememberCursor() is still gated by _restoring
    wireSwitch(); wireErase(); wireExport();
  }
  S._restoring = false;
  if (hasDOM()) { updateAll(); paintUsage(); }
  dispatch('cr:restored', { games: S.games.length });
}
