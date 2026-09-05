/*
 * The book (§6 Learn; docs/openings.md §3). The repertoire the reader has *decided*
 * to play: lines of SAN from the start position, owned by one colour, on the deck's
 * own Leitner ladder. Nothing enters it except through a press — `addToBook()` is the
 * only writer, and lessons, the library and the import all end in that one call.
 *
 * The store is S.book (memory.js loads it); rows are persisted through dbPut/dbDelete
 * and every change is announced with `cr:book-changed`.
 */
import { Chess } from 'chess.js';
import { S } from '../state.js';
import { pgnId, splitPGN, cleanPGN, parseGame, START_FEN } from '../pgn.js';
// Namespace imports, because a module built in parallel may still be its stub: a named
// import of something the stub does not export would fail to link and take the whole
// Learn room down with it. Reading a missing name off a namespace is just undefined.
import * as mem from '../memory.js';
import * as deck from '../deck.js';

/*
 * The schedule is the deck's, by import. Two spaced-repetition clocks in one app is
 * one too many: a reader who learns "a miss comes back in ten minutes" from the deck
 * must find the book keeping the same promise. The fallbacks equal the contract's
 * values and exist only for the moment deck.js is still a stub.
 */
export const BOXES = Array.isArray(deck.DECK_BOXES) ? deck.DECK_BOXES : [1, 3, 7, 21, 60];
export const RETRY_MS = typeof deck.DECK_RETRY_MS === 'number' ? deck.DECK_RETRY_MS : 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * The key is the colour and a hash of the moves, so a line *is* its own identity: the
 * same line typed in the editor, adopted from a lesson or imported from a study lands
 * on one key, and a second copy is a duplicate rather than a second row. pgnId over
 * the SAN joined by spaces — the same 53-bit hash games use, for the same reason.
 */
export function bookKey(color, sans) {
  return color + ':' + pgnId(sans.join(' '));
}

/**
 * Walk moves (SAN or UCI) from the start with chess.js. Returns the canonical SAN
 * list and the FENs, or null when any move is illegal — a line in the store can never
 * be illegal, which is what lets every reader of the book walk it without a try.
 */
export function walkLine(moves) {
  if (!Array.isArray(moves) || !moves.length) return null;
  const chess = new Chess();
  const sans = [], fens = [START_FEN], verbose = [];
  for (const mv of moves) {
    let m = null;
    try {
      m = /^[a-h][1-8][a-h][1-8][nbrq]?$/.test(mv)
        ? chess.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] })
        : chess.move(mv);
    } catch (e) { m = null; }
    if (!m) return null;
    sans.push(m.san);
    fens.push(m.after);
    verbose.push(m);
  }
  return { sans, fens, verbose };
}

/**
 * A fresh row, or null when the moves are not a legal game. Box 0 and due now: a
 * line just written is due immediately, so "learn it, then answer it" is the default
 * path rather than a feature.
 */
export function bookLine(color, moves, name, now = Date.now()) {
  if (color !== 'w' && color !== 'b') return null;
  const walked = walkLine(moves);
  if (!walked) return null;
  return {
    key: bookKey(color, walked.sans), color, moves: walked.sans, name: String(name || '').trim(),
    box: 0, due: now, seen: 0, passes: 0, fails: 0, lastAt: 0, addedAt: now,
  };
}

/** The rows, one colour or both, in the order they were added. */
export function bookLines(color) {
  return [...S.book.values()]
    .filter(r => r && Array.isArray(r.moves) && (!color || r.color === color))
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/*
 * The derived trie, and it carries no tallies at all. A node is {fen, children,
 * line?}: a decision has no denominator, and a node with `n: 0` on it is a percentage
 * waiting to be printed by accident. `line` sits on a leaf (the row that ends there);
 * an interior node reached by a shorter line carries it too, which is how a line that
 * is a prefix of another is still its own scheduled unit.
 */
let _trie = { w: null, b: null };
function invalidate() { _trie = { w: null, b: null }; }

export function bookTrie(color) {
  if (_trie[color]) return _trie[color];
  const root = { fen: START_FEN, children: new Map() };
  for (const row of bookLines(color)) {
    const chess = new Chess();
    let node = root;
    let ok = true;
    for (const san of row.moves) {
      let m = null;
      try { m = chess.move(san); } catch (e) { m = null; }
      if (!m) { ok = false; break; }
      let kid = node.children.get(san);
      if (!kid) { kid = { fen: m.after, children: new Map() }; node.children.set(san, kid); }
      node = kid;
    }
    if (ok) node.line = row;
  }
  _trie[color] = root;
  return root;
}

/** The node a path of SAN reaches, or null. */
export function bookNodeAt(color, path) {
  let node = bookTrie(color);
  for (const san of path || []) {
    node = node && node.children.get(san);
    if (!node) return null;
  }
  return node;
}

function announce() {
  if (typeof document === 'undefined' || typeof CustomEvent === 'undefined') return;
  document.dispatchEvent(new CustomEvent('cr:book-changed'));
}
function persist(row) { if (typeof mem.dbPut === 'function') mem.dbPut('book', row); }

/**
 * The one door into the book. Returns the new row, or null when the line is illegal
 * or already there — a duplicate is not an error, it is the reader agreeing with
 * themselves, and the caller says so in a sentence rather than writing a second row.
 */
export function addToBook(color, sanMoves, name, now = Date.now()) {
  const row = bookLine(color, sanMoves, name, now);
  if (!row || S.book.has(row.key)) return null;
  S.book.set(row.key, row);
  invalidate();
  persist(row);
  announce();
  return row;
}

export function removeLine(key) {
  if (!S.book.has(key)) return false;
  S.book.delete(key);
  invalidate();
  if (typeof mem.dbDelete === 'function') mem.dbDelete('book', key);
  announce();
  return true;
}

/*
 * What is due, in the deck's own order: what you failed first, then what has waited
 * longest. A line missed ten minutes ago and a line never seen are both "due", and
 * only one of them is the reason you are here.
 */
export function bookDue(now = Date.now()) {
  return bookLines()
    .filter(r => (r.due || 0) <= now)
    .sort((a, b) => (b.fails || 0) - (a.fails || 0) || (a.due || 0) - (b.due || 0));
}

/**
 * One Leitner step. Pass climbs a box and comes back in BOXES[box-1] days; a miss
 * drops to box 0 and returns in RETRY_MS — ten minutes, not tomorrow, because a line
 * you just got wrong is the one worth asking again while it is still in your head.
 */
export function gradeLine(row, pass, now = Date.now()) {
  row.seen = (row.seen || 0) + 1;
  row.lastAt = now;
  if (pass) {
    row.passes = (row.passes || 0) + 1;
    row.box = Math.min((row.box || 0) + 1, BOXES.length);
    row.due = now + BOXES[row.box - 1] * DAY_MS;
  } else {
    row.fails = (row.fails || 0) + 1;
    row.box = 0;
    row.due = now + RETRY_MS;
  }
  if (S.book.has(row.key)) { persist(row); announce(); }
  return row;
}

/** What to call a line: the reader's name, else its first moves — never an invention. */
export function bookName(row) {
  if (!row) return '';
  if (row.name) return row.name;
  const head = row.moves.slice(0, 6);
  let s = '';
  for (let i = 0; i < head.length; i++) s += (i % 2 === 0 ? (i / 2 + 1) + '.' : '') + head[i] + ' ';
  return s.trim() + (row.moves.length > 6 ? ' …' : '');
}

/** "due now" · "in 3 days" · "in 10 minutes", for a row's schedule. */
export function dueLabel(row, now = Date.now()) {
  const d = (row.due || 0) - now;
  if (d <= 0) return 'due now';
  if (d < 60 * 60 * 1000) return 'in ' + Math.max(1, Math.round(d / 60000)) + ' min';
  if (d < DAY_MS) return 'in ' + Math.round(d / 3600000) + ' h';
  const days = Math.round(d / DAY_MS);
  return 'in ' + days + (days === 1 ? ' day' : ' days');
}

/* ----- Import: a PGN or a Lichess study, each game's mainline a leaf line ----- */

/** The study id in a lichess.org/study URL, or null. */
export function studyRef(text) {
  const m = /lichess\.org\/study\/([A-Za-z0-9]{8})(?:\/([A-Za-z0-9]{8}))?/.exec(String(text || '').trim());
  return m ? { study: m[1], chapter: m[2] || '' } : null;
}
export function studyURL(ref) {
  return 'https://lichess.org/api/study/' + ref.study + (ref.chapter ? '/' + ref.chapter : '') + '.pgn?clocks=false';
}

/**
 * Every game in the text becomes one leaf line under `color`. Variations are dropped
 * by cleanPGN — the mainline is the decision a study chapter states — and a chapter's
 * name (Lichess writes it into [Event] as "Study: Chapter") names the line.
 * Returns {added, dupes, skipped, total, rows}; nothing is written past `max`.
 */
export const IMPORT_MAX = 200;   // a whole study, not a whole database
export function importBookPGN(text, color, max = IMPORT_MAX) {
  const chunks = splitPGN(text).filter(c => c.trim());
  const out = { added: 0, dupes: 0, skipped: 0, total: chunks.length, over: 0, rows: [] };
  if (chunks.length > max) { out.over = chunks.length; return out; }
  for (const chunk of chunks) {
    const g = parseGame(cleanPGN(chunk));
    if (!g || !g.moves.length) { out.skipped++; continue; }
    const ev = g.headers.Event || '';
    const name = ev.includes(':') ? ev.slice(ev.indexOf(':') + 1).trim() : (g.headers.ChapterName || ev.trim());
    const row = addToBook(color, g.moves.map(m => m.san), name);
    if (row) { out.added++; out.rows.push(row); } else out.dupes++;
  }
  return out;
}

/** Nothing to load: memory fills S.book. The only wiring is the trie cache. */
export function boot() {
  if (typeof document === 'undefined') return;
  // Rows arriving from disk or a sync land in S.book behind our back; the trie must not
  // outlive them.
  document.addEventListener('cr:restored', invalidate);
  document.addEventListener('cr:book-changed', invalidate);
}
