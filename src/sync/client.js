/*
 * Optional self-hosted sync (§9). Off by default; the app is complete without it, and
 * Export / Import (./export.js) is the backup story for everyone who never runs a server.
 *
 * The contract is deliberately dumb — five blobs, one per store:
 *
 *   GET    {base}/{store}   → { version, blob, enc }
 *   PUT    {base}/{store}   ← { version, blob, enc }   409 if version moved
 *   DELETE {base}/{store}                              erase, always ungated
 *
 * The server stores bytes and counts versions. **The merge runs here**, because the
 * browser is the only place holding both halves, and a server that merged would need to
 * understand a Leitner schedule to do it — which is the app's arithmetic, not a file
 * store's. That is also what makes a WebDAV or S3 shim a weekend: see docs/sync.md.
 *
 * Content-addressed keys make this a union rather than a reconciliation. Two devices
 * that author the same line or earn the same card produce the same key, so there is no
 * restore dialog anywhere in this feature and no such thing as a losing side: the worst
 * a merge can do is keep a row somebody already had. Cards merge card by card and take
 * the further-along schedule — `furtherAlong` from ./export.js, the same rule Import
 * uses, because two spellings of "which schedule is ahead" is how the two drift.
 *
 * The prep list deliberately syncs nowhere: five handles you can retype and a record of
 * your weekend nobody else needs to hold. There is no `opponents` store below and the
 * test pins its absence.
 *
 * Nothing here runs on a timer (§2.7). A sync is the button, or the moment the switch
 * goes on — both of them a press.
 */
import { S } from '../state.js';
import { toast } from '../dom.js';
import { exportEverything, importEverything, furtherAlong } from './export.js';

/*
 * The five stores, and the whole list. `evals` is absent because an analysis is a cache
 * with a build stamp on it: it is reconstructible from the game, it is the largest thing
 * on the disk, and a row from another machine's engine build would be discarded on
 * arrival anyway. `opponents` is absent on purpose (§9).
 */
export const SYNC_STORES = ['deck', 'tactics', 'book', 'games', 'learn'];

/* At most this many PUTs for one store in one sync. A 409 means another device wrote
   between our GET and our PUT; re-GET, re-merge and try again — but a server that keeps
   moving is a server we stop arguing with rather than a loop that never ends. */
export const PUT_ATTEMPTS = 4;

/* A blob bigger than this is not a deck, it is an accident. The reference server
   refuses the same figure, so the failure is the same on both sides. */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;

const hasDOM = () => typeof document !== 'undefined';

/* ===== The rows: which local shape each store's blob carries ===== */

/*
 * `learn` is the spec's fifth store. This port keeps lesson and room progress in the
 * `meta` store rather than in one of its own, so meta is what travels — but only the
 * rows that are facts about the *reader*. The rest of that store is about this machine:
 * `cursor` is where this screen was left, `sweepCursor` is how far this CPU has got
 * through its own bookkeeping, and `schema` is this database's version. Shipping any of
 * them would be one device reaching over and moving another's furniture.
 *
 * An allowlist rather than a denylist, deliberately: a meta key added later is
 * device-local until somebody decides otherwise, which is the safe direction to be
 * wrong in. `exportEverything` already drops `schema`; the other two are dropped here,
 * because which of them belong to the reader is a question about sync rather than about
 * the backup file.
 */
export const LEARN_KEYS = ['hero', 'recsHidden'];
const travels = r => r && LEARN_KEYS.includes(r.k);
const KEY_OF = {
  deck: r => r && r.key,
  tactics: r => r && r.key,
  book: r => r && r.key,
  games: r => r && r.id,
  learn: r => r && r.k,
};

export function keyOf(store, row) {
  const f = KEY_OF[store];
  return f ? f(row) : null;
}

/*
 * Which of two rows for the same key survives.
 *
 * Cards and book lines: the further-along schedule, never a reset (§9). The rule is
 * symmetric in the boxes and the due dates, so it does not matter which side is called
 * "mine" — a card in box 4 wins from either direction. A dead tie keeps the local row,
 * because a row that does not change is a row nobody has to write.
 *
 * Games: the id *is* the PGN hash, so both halves hold the same game and the only
 * fields that can differ are where each device was reading. The later read wins; a game
 * itself is never dropped.
 *
 * Learn/meta: the local value wins, exactly as Import's does. These are this device's
 * own answers (which recommendations were dismissed, who the hero is), and the remote
 * copy fills in only the keys this device has never had one for.
 */
export function pickRow(store, mine, theirs) {
  if (!mine) return theirs;
  if (!theirs) return mine;
  if (store === 'deck' || store === 'tactics' || store === 'book') return furtherAlong(mine, theirs);
  if (store === 'games') return (theirs.lastPlayedAt || 0) > (mine.lastPlayedAt || 0) ? theirs : mine;
  return mine;
}

/**
 * Merge one store's two halves. Pure, and the only merge in the feature.
 * @returns {{rows: object[], incoming: object[], outgoing: object[]}}
 *   `rows` is the union — what the server should hold. `incoming` are the rows this
 *   device does not have or is behind on; `outgoing` are the rows the server does not
 *   have or is behind on. Both empty means the two halves already agree.
 */
function same(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}

export function mergeStore(store, mine = [], theirs = []) {
  const byKey = new Map();
  const order = [];
  for (const row of mine) {
    const k = keyOf(store, row);
    if (k == null || byKey.has(k)) continue;
    byKey.set(k, row); order.push(k);
  }
  const incoming = [];
  const outgoing = [];
  const seenThere = new Set();
  for (const row of theirs) {
    const k = keyOf(store, row);
    if (k == null || seenThere.has(k)) continue;
    seenThere.add(k);
    const have = byKey.get(k);
    const win = pickRow(store, have, row);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, win);
    if (!have) { incoming.push(win); continue; }
    // Two copies of the same row are not a difference. Comparing the *content* rather
    // than the object is what stops a sync between two devices that already agree from
    // writing a new version every time it runs.
    if (same(have, row)) continue;
    if (win === have) outgoing.push(win); else incoming.push(win);
  }
  for (const k of order) if (!seenThere.has(k)) outgoing.push(byKey.get(k));
  return { rows: order.map(k => byKey.get(k)), incoming, outgoing };
}

/* ===== The wire: gzip, base64, the envelope ===== */

const canGzip = () => typeof CompressionStream === 'function';
const canGunzip = () => typeof DecompressionStream === 'function';

const B64_CHUNK = 0x8000;   // spreading a megabyte into String.fromCharCode overflows the stack

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function through(bytes, transform) {
  const stream = new Response(bytes).body.pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Rows → the envelope body. `enc` names the encoding rather than the HTTP layer doing
 * it, because a fetch that sets `Content-Encoding: gzip` is decoded again by whatever
 * proxy or runtime is in the way, and because a self-describing envelope is a thing an
 * S3 object or a WebDAV file can hold byte for byte. A browser with no CompressionStream
 * writes `identity` and syncs perfectly well; every client reads both.
 */
export async function packEnvelope(rows, version = 0) {
  const text = JSON.stringify(rows || []);
  if (!canGzip()) return { version, enc: 'identity', blob: text };
  try {
    const bytes = await through(new TextEncoder().encode(text), new CompressionStream('gzip'));
    return { version, enc: 'gzip', blob: bytesToB64(bytes) };
  } catch (e) {
    // A runtime that has the constructor but cannot run it is still a runtime that syncs.
    return { version, enc: 'identity', blob: text };
  }
}

/** The envelope → rows. Throws when the blob cannot be read; the caller skips that store. */
export async function unpackEnvelope(env) {
  if (!env || env.blob == null || env.blob === '') return [];
  if (typeof env.blob !== 'string') throw new Error('the blob is not a string');
  let text = env.blob;
  if (env.enc === 'gzip') {
    if (!canGunzip()) throw new Error('this browser cannot read a gzipped blob');
    text = new TextDecoder().decode(await through(b64ToBytes(env.blob), new DecompressionStream('gzip')));
  }
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('the blob is not a list of rows');
  return rows;
}

/* ===== The transport ===== */

export function syncBase() {
  return String(S.syncUrl || '').trim().replace(/\/+$/, '');
}
export function configured() {
  return !!(S.syncOn && syncBase());
}
function endpoint(store) {
  return syncBase() + '/' + store;
}
function headers(more) {
  const h = { Accept: 'application/json', ...more };
  if (S.syncToken) h.Authorization = 'Bearer ' + S.syncToken;
  return h;
}
async function call(method, store, body) {
  const f = globalThis.fetch;
  if (typeof f !== 'function') throw new Error('this browser has no fetch');
  const init = { method, headers: headers(body ? { 'Content-Type': 'application/json' } : null) };
  if (body) init.body = JSON.stringify(body);
  return f(endpoint(store), init);
}

/** GET one store. A store never written is version 0 and no rows, not an error. */
export async function getStore(store) {
  const res = await call('GET', store);
  if (res.status === 404) return { version: 0, rows: [] };
  if (!res.ok) throw new Error('the server answered ' + res.status);
  const env = await res.json();
  return { version: Number(env && env.version) || 0, rows: await unpackEnvelope(env) };
}

/** DELETE one store on the server. Ungated by design: no version travels with it. */
export async function deleteStore(store) {
  const res = await call('DELETE', store);
  if (!res.ok && res.status !== 404) throw new Error('the server answered ' + res.status);
  return true;
}

/** DELETE every store. The "forget what the server holds" press; never automatic. */
export async function eraseRemote() {
  for (const store of SYNC_STORES) await deleteStore(store);
  return true;
}

/*
 * PUT the union, and answer a 409 the only way this contract allows: GET what is there
 * now, merge again, PUT again. Bounded at PUT_ATTEMPTS — the alternative is a device
 * that argues with a busy server forever, and a sync that never finishes is worse than
 * one that says it did not.
 */
async function putStore(store, version, rows) {
  let at = version, out = rows;
  const late = [];
  for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt++) {
    const env = await packEnvelope(out, at);
    if (env.blob.length > MAX_BLOB_BYTES) throw new Error('that blob is too large to sync');
    const res = await call('PUT', store, env);
    if (res.status !== 409) {
      if (!res.ok) throw new Error('the server answered ' + res.status);
      const body = await res.json().catch(() => ({}));
      return { version: Number(body && body.version) || at + 1, rows: out, incoming: late };
    }
    const cur = await getStore(store);
    const m = mergeStore(store, out, cur.rows);
    at = cur.version; out = m.rows;
    late.push(...m.incoming);
    // Their blob already contains everything of ours: nothing left to say.
    if (!m.outgoing.length) return { version: cur.version, rows: out, incoming: late };
  }
  throw new Error('the server kept moving; gave up after ' + PUT_ATTEMPTS + ' tries');
}

/* ===== Local state ===== */

/** Every store's local rows, through the memory module's own serialisers. */
export async function localAll() {
  const dump = await exportEverything();
  return { deck: dump.deck, tactics: dump.tactics, book: dump.book, games: dump.games, learn: (dump.meta || []).filter(travels) };
}

/*
 * Write what arrived. Import already merges by the same keys with the same rules, writes
 * through the same memory helpers and fires the same events, so sync arriving and a file
 * arriving are one code path — and a bug fixed in one is fixed in the other.
 */
async function applyIncoming(byStore) {
  const any = SYNC_STORES.some(s => (byStore[s] || []).length);
  if (!any) return { games: 0, deck: 0, tactics: 0, book: 0, meta: 0 };
  return importEverything({
    v: 1,
    games: byStore.games || [],
    deck: byStore.deck || [],
    tactics: byStore.tactics || [],
    book: byStore.book || [],
    // Filtered on the way in as well as on the way out: a blob written by an older
    // build, or by a device that did not have this rule, must not land device state here.
    meta: (byStore.learn || []).filter(travels),
    evals: [],
  });
}

/* ===== Status ===== */

const state = {
  busy: false,
  at: 0,              // when the last sync finished
  sent: 0,
  received: 0,
  error: '',
  stores: {},         // name → {version, rows, error}
};

export function syncStatus() {
  return {
    on: !!S.syncOn,
    url: syncBase(),
    configured: configured(),
    busy: state.busy,
    at: state.at,
    sent: state.sent,
    received: state.received,
    error: state.error,
    stores: { ...state.stores },
  };
}

export function statusSentence() {
  if (!S.syncOn) return 'Sync is off. Nothing leaves this browser.';
  if (!syncBase()) return 'Add the address of your server, then press Sync now.';
  if (state.busy) return 'Syncing…';
  if (state.error) return 'The last sync did not finish: ' + state.error;
  if (!state.at) return 'Ready. Nothing has been synced from this browser yet.';
  const parts = [];
  if (state.sent) parts.push('sent ' + state.sent);
  if (state.received) parts.push('received ' + state.received);
  return 'Synced ' + (parts.length ? parts.join(', ') : 'with nothing new either way') + '.';
}

/* One line under the sync fields, for anything that is not the status sentence. */
function say(text) {
  if (!hasDOM()) return;
  const el = document.getElementById('sync-status');
  if (el) el.textContent = text;
}

function paint() {
  if (!hasDOM()) return;
  const el = document.getElementById('sync-status');
  if (el) el.textContent = statusSentence();
  const btn = document.getElementById('btn-sync-now');
  if (btn) btn.disabled = state.busy;
}

/* ===== The presses ===== */

/*
 * One store, one direction pair. `pull` applies what arrived; `push` PUTs the union.
 * Returns the incoming rows rather than writing them, so a whole sync is one write and
 * one repaint instead of five.
 */
async function runStore(store, mine, { pull = true, push = true } = {}) {
  const row = { store, version: 0, rows: [], sent: 0, received: 0, error: '' };
  let theirs = { version: 0, rows: [] };
  try {
    theirs = await getStore(store);
  } catch (e) {
    /*
     * A blob we cannot read is a store we leave alone entirely. PUTting our own half
     * over a version we could not decode is how the other device's cards disappear —
     * the one way this feature could lose anything, so it is the one guard that refuses
     * to carry on.
     */
    row.error = String(e && e.message || e);
    state.stores[store] = { version: 0, rows: 0, error: row.error };
    return row;
  }
  const m = mergeStore(store, mine, theirs.rows);
  row.version = theirs.version;
  row.rows = pull ? m.incoming : [];
  row.received = pull ? m.incoming.length : 0;
  if (push && m.outgoing.length) {
    const done = await putStore(store, theirs.version, m.rows);
    row.version = done.version;
    row.sent = m.outgoing.length;
    if (pull && done.incoming.length) { row.rows = row.rows.concat(done.incoming); row.received += done.incoming.length; }
  }
  state.stores[store] = { version: row.version, rows: m.rows.length, error: '' };
  return row;
}

/*
 * Why this refuses rather than waiting: before the restore finishes, `S` holds fewer
 * games and no cards, so the union we would PUT is *smaller* than what this device
 * actually has. The server would take it, and the next device to sync would read a
 * library with holes in it.
 */
function why() {
  if (!S.syncOn) return 'off';
  if (!syncBase()) return 'unconfigured';
  if (S._restoring) return 'restoring';
  if (state.busy) return 'busy';
  return '';
}

async function run(opts, label) {
  const skipped = why();
  if (skipped) return { ok: false, skipped, sent: 0, received: 0 };
  state.busy = true; state.error = ''; paint();
  const got = {};
  let sent = 0, received = 0, failed = '';
  try {
    for (const store of SYNC_STORES) {
      const row = await runStore(store, (await mineFor(store)), opts);
      if (row.error) { failed = failed || row.error; continue; }
      got[store] = row.rows;
      sent += row.sent; received += row.received;
    }
    if (opts.pull !== false) await applyIncoming(got);
    state.at = Date.now(); state.sent = sent; state.received = received; state.error = failed;
  } catch (e) {
    state.error = String(e && e.message || e);
    failed = state.error;
  } finally {
    state.busy = false;
    _mine = null;
    paint();
  }
  if (hasDOM()) {
    if (failed) toast(label + ' did not finish: ' + failed);
    else if (sent || received) toast(label + ': sent ' + sent + ', received ' + received + '.');
    else toast(label + ': everything already agreed.');
  }
  return { ok: !failed, sent, received, error: failed };
}

/* One dump of the local rows per press, not one per store: exportEverything walks the
   database, and walking it five times to answer the same question is four too many. */
let _mine = null;
async function mineFor(store) {
  if (!_mine) _mine = await localAll();
  return _mine[store] || [];
}

/** The button. Both directions, every store, one write, one sentence. */
export function syncNow() { return run({ pull: true, push: true }, 'Sync'); }

/** Send this device's half of every store; apply nothing. */
export function pushAll() { return run({ pull: false, push: true }, 'Upload'); }

/** Take the server's half of every store; send nothing. */
export function pullAll() { return run({ pull: true, push: false }, 'Download'); }

/** One store, both directions — the same press at a smaller scale. */
export async function syncStore(store, opts = {}) {
  if (!SYNC_STORES.includes(store)) return { ok: false, skipped: 'no such store', sent: 0, received: 0 };
  const skipped = why();
  if (skipped) return { ok: false, skipped, sent: 0, received: 0 };
  state.busy = true; paint();
  try {
    const row = await runStore(store, (await localAll())[store] || [], opts);
    if (row.error) { state.error = row.error; return { ok: false, error: row.error, sent: 0, received: 0 }; }
    if (opts.pull !== false) await applyIncoming({ [store]: row.rows });
    state.at = Date.now(); state.sent = row.sent; state.received = row.received; state.error = '';
    return { ok: true, sent: row.sent, received: row.received };
  } catch (e) {
    state.error = String(e && e.message || e);
    return { ok: false, error: state.error, sent: 0, received: 0 };
  } finally {
    state.busy = false; paint();
  }
}

/*
 * No timer, no interval, no sync on boot (§2.7). The button is a press; the switch going
 * on is the other press, and it is the only reason this listens to anything.
 */
export function boot() {
  if (!hasDOM()) return;
  const btn = document.getElementById('btn-sync-now');
  if (btn) btn.addEventListener('click', () => syncNow());
  /*
   * The way out. Asked twice, because it destroys the copy the reader's other devices
   * are syncing against — and once, not twice, because it takes nothing off *this*
   * device: the next sync simply pushes this machine's rows back up. The second press
   * lapses after a few seconds so a stray click cannot sit armed.
   */
  const erase = document.getElementById('btn-sync-erase');
  if (erase) {
    let armed = 0;
    erase.addEventListener('click', async () => {
      if (!syncBase()) { say('Name a server first.'); return; }
      if (Date.now() - armed > 5000) {
        armed = Date.now();
        erase.textContent = 'Erase it — press again';
        setTimeout(() => { erase.textContent = 'Erase the server copy'; armed = 0; }, 5000);
        return;
      }
      armed = 0;
      erase.textContent = 'Erase the server copy';
      try {
        await eraseRemote();
        say('The server copy is gone. Nothing on this device was touched.');
      } catch (e) {
        say('Could not erase it: ' + e.message);
      }
    });
  }
  document.addEventListener('cr:settings-painted', paint);
  document.addEventListener('cr:setting', e => {
    const key = e && e.detail && e.detail.key;
    if (key !== 'syncOn' && key !== 'syncUrl' && key !== 'syncToken') return;
    paint();
    if (key === 'syncOn' && S.syncOn && syncBase()) syncNow();
  });
  paint();
}
