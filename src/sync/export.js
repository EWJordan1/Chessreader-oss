/*
 * Export and Import (§9): one JSON file, merged by the same content-addressed keys the
 * stores use. This is the backup story for everyone who never configures a sync server,
 * and it exists before sync does.
 *
 * Content-addressed keys make an import a union rather than a reconciliation: two
 * devices that author the same line or earn the same card produce the same key, so
 * there is no restore dialog anywhere in here. Cards merge card by card and take the
 * further-along schedule, never resetting one. The prep list deliberately travels
 * nowhere — five handles you can retype and a record of a weekend nobody else needs.
 */
import { S } from '../state.js';
import { parseGame, mergeGames } from '../pgn.js';
import { toast, plural } from '../dom.js';
import { updateAll } from '../render.js';
import { dbAll, dbGet, dbPut, dbPutAll, memRow, rememberGames, memAvailable } from '../memory.js';

export const EXPORT_VERSION = 1;

const hasDOM = () => typeof document !== 'undefined';

/*
 * The games and the cards come from S, which is the source of truth (§2.4) and is also
 * what someone with memory switched off actually has. The evals and meta are the
 * engine's and the rooms' own rows and live only on the disk, so they come from there —
 * an export made with memory off carries no analysis, and says nothing about it because
 * a re-analysis is what that reader already expects on every visit.
 */
export async function exportEverything() {
  return {
    v: EXPORT_VERSION,
    exportedAt: Date.now(),
    games: S.games.filter(g => g && g.id && g.pgn).map(memRow),
    evals: await dbAll('evals'),
    deck: [...S.deck.values()],
    tactics: [...S.tactics.values()],
    book: [...S.book.values()],
    meta: (await dbAll('meta')).filter(r => r && r.k !== 'schema'),
  };
}

/*
 * Which of two schedules for the same card is further along: the higher box, or the
 * later due date when the boxes agree. Never the incoming one by default — a backup
 * from last month must not put a card the reader has since graded twice back a box.
 */
export function furtherAlong(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ab = a.box || 0, bb = b.box || 0;
  if (bb > ab) return b;
  if (bb < ab) return a;
  return (b.due || 0) > (a.due || 0) ? b : a;
}

/* How much of an evals row is filled in: the compact string's non-empty cells. */
const filled = row => (typeof row.evals === 'string' ? row.evals.split(',').filter(Boolean).length : 0);

/*
 * An evals row is a cache stamped with the build and depth that produced it. Two rows
 * from the same engine at the same depth differ only in how far they got, so the fuller
 * one wins; rows from different builds are not comparable, and the one already here
 * stays because it is the one every card and review on this device was read from.
 */
export function pickEvals(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.build !== incoming.build || existing.depth !== incoming.depth) return existing;
  return filled(incoming) > filled(existing) ? incoming : existing;
}

function mergeCards(store, rows) {
  const map = S[store];
  const changed = [];
  let added = 0;
  for (const row of rows || []) {
    if (!row || !row.key) continue;
    const have = map.get(row.key);
    const win = furtherAlong(have, row);
    if (win === have) continue;
    if (!have) added++;
    map.set(row.key, win);
    changed.push(win);
  }
  return { added, changed };
}

/**
 * Merge an exported object into this device. Resolves the count added per store.
 * Games dedupe by id; cards take the further-along schedule; the book unions by key;
 * evals follow pickEvals(); meta fills only keys this device lacks.
 */
export async function importEverything(obj) {
  const out = { games: 0, evals: 0, deck: 0, tactics: 0, book: 0, meta: 0 };
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.games) && !Array.isArray(obj.deck) && !Array.isArray(obj.book)) {
    if (hasDOM()) toast('That file is not a ChessReader export.');
    return out;
  }
  const canWrite = S.remember && memAvailable();

  // Games: parse only what is new. The stored id wins over the recomputed one for the
  // same reason it does on restore — it is what the evals and cards reference.
  const have = new Set(S.games.map(g => g.id));
  const fresh = [];
  const now = Date.now();
  for (const row of obj.games || []) {
    if (!row || !row.id || !row.pgn || have.has(row.id)) continue;
    const g = parseGame(row.pgn);
    if (!g) continue;
    g.id = row.id;
    g.source = row.source || 'import';
    g.addedAt = row.addedAt || now;
    g.seq = ++S._seq;               // it arrived now; the cap is about arrival here, not there
    g.bytes = row.bytes || row.pgn.length;
    g.lastPly = row.lastPly || 0;
    g.lastPlayedAt = row.lastPlayedAt || 0;
    have.add(g.id);
    fresh.push(g);
  }
  out.games = mergeGames(S.games, fresh).added;
  if (canWrite) await rememberGames(fresh);

  // Evals: only for games this device holds after the merge. An eval for a game that
  // is not here is an orphan on arrival.
  if (canWrite) {
    const here = new Set(S.games.map(g => g.id));
    for (const row of obj.evals || []) {
      if (!row || !row.gameId || !here.has(row.gameId)) continue;
      const existing = await dbGet('evals', row.gameId);
      const win = pickEvals(existing, row);
      if (win !== existing) { await dbPut('evals', win); out.evals++; }
    }
  }

  for (const store of ['deck', 'tactics', 'book']) {
    const { added, changed } = mergeCards(store, obj[store]);
    out[store] = added;
    if (canWrite && changed.length) await dbPutAll(store, changed);
  }

  if (canWrite) {
    for (const row of obj.meta || []) {
      if (!row || !row.k || row.k === 'schema' || row.k === 'cursor') continue;
      if (await dbGet('meta', row.k) === undefined) { await dbPut('meta', row); out.meta++; }
    }
  }

  if (hasDOM()) {
    if (out.deck || out.tactics) document.dispatchEvent(new CustomEvent('cr:deck-changed', { detail: { reason: 'import' } }));
    if (out.book) document.dispatchEvent(new CustomEvent('cr:book-changed', { detail: { reason: 'import' } }));
    if (out.games) document.dispatchEvent(new CustomEvent('cr:games-added', { detail: { games: fresh } }));
    updateAll();
    const parts = [];
    if (out.games) parts.push(plural(out.games, 'game'));
    if (out.deck + out.tactics) parts.push(plural(out.deck + out.tactics, 'card'));
    if (out.book) parts.push(plural(out.book, 'book line'));
    if (out.evals) parts.push(plural(out.evals, 'analysis', 'analyses'));
    toast(parts.length ? 'Imported ' + parts.join(', ') + '.' : 'Nothing in that file was new here.');
  }
  return out;
}
