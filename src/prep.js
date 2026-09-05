/*
 * Prep (§6) — the people you are about to play.
 *
 * A short list of handles. A handle and a time control brings that person's public games
 * to this browser, filtered to the format you are actually playing, and the row says what
 * it read. Opening a row gives Insights' own eight-pane report pointed at them — this
 * module does not rebuild a single pane of it — and above the report the one finding a
 * report about yourself cannot produce: **your repertoire walked against theirs**.
 *
 * Four decisions run through the whole file, and each breaks silently if undone:
 *
 * 1. **The crossing is the point of the room, so it is written first and read first.**
 *    `crossing()` walks the book's trie and a trie of their games in lockstep. The two
 *    tries are both SAN from the start position, so they align move for move with no
 *    transposition logic and no engine — the whole finding is arithmetic over two trees.
 *    `briefing()` says it before the record for the same reason.
 * 2. **A line the book has no answer to is a row, never a silence.** The interesting half
 *    of a crossing is where it *stops*: they play something often and you have nothing
 *    written down for it. Those rows end in *Add one* and walk to Learn's editor. A walk
 *    that only reported shared nodes would report the repertoire you already know.
 * 3. **`opponents` is a record of someone's weekend (§5), not a cache.** It is never
 *    blanket-wiped, it syncs nowhere (§9), and removing a person is an explicit press
 *    that takes their games and their evaluations with them.
 * 4. **Nothing here runs without a press (§2.7).** Arriving at a row reads what is on
 *    the disk; the fetch, the refresh and the engine pass are three separate buttons. The
 *    refresh asks for what is new — `readAt` on the row is the watermark — rather than
 *    for the archive again.
 */
import { S } from './state.js';
import { $, escHtml, emptyHTML, toast, plural, fmtDate } from './dom.js';
import { registerRoom, navigate, currentRoom, renderNav } from './route.js';
import { stageRelease } from './render.js';
import { cleanPGN, headersOf, pgnId, parseGame, moveNumberLabel } from './pgn.js';
import { dbPut, dbPutAll, dbDelete, dbAll, dbIndexRange } from './memory.js';
import { SITE_NAMES, normaliseChesscom, chesscomArchives, fetchLichess, gameEndMs } from './sources.js';
import {
  renderReport, computeStats, gameFacts, buildExplorer, patternReport,
  timeClassOf, playerKey, scorePct, endingLabel,
} from './insights.js';
import { bookTrie, walkLine } from './learn/book.js';
import { moveToSpeech } from './speech/grammar.js';
import { speak, cancelSpeech } from './speech/provider.js';

/* ===================================================================================
 * Constants — the argument next to the number (§15)
 * =================================================================================== */

export const SITES = ['chesscom', 'lichess'];
/* The formats a row may be filtered to. These are Insights' own time classes, read off
   the PGN's TimeControl by `timeClassOf`, so a Chess.com row, a Lichess row and a
   hand-pasted PGN all land in the same bucket. Two spellings of one rule is how the two
   drift, and the drift here would be a row saying "142 blitz games" about bullet. */
export const FORMATS = ['bullet', 'blitz', 'rapid', 'classical', 'daily'];
export const DEFAULT_FORMAT = 'blitz';

/* A few hundred at most (§5): one person you are playing on Saturday must not be able to
   fill the disk, and their games live in their own store precisely so the cap can be
   theirs rather than shared with the reader's own history. */
export const OPP_GAME_CAP = 300;
/* How many games one press of Refresh may pull. A first read of a busy handle is one
   press; a night-before refresh asks for what is new and gets a handful. */
export const FETCH_MAX = 400;

/* How deep the trie of their games is built. Twelve moves each is past the end of every
   authored line in a normal book, so the walk is bounded by the book rather than by
   this — the cap only bounds the cost of building the tree. */
export const CROSS_MAX_PLY = 24;
/* A "line" is at least one move each. One ply is a move, not a line, and reporting
   "after 1.e4 they score 54%" is reporting their whole archive with a move in front. */
export const CROSS_MIN_PLY = 2;
/* A row needs two games behind it. One game at 100% is not a finding, and the honest
   rendering of a single game is to leave it out rather than to print a confident 100%
   (§15: prefer a guard that returns null over one that returns a plausible number). */
export const CROSS_MIN_GAMES = 2;
/* How many rows of each kind the crossing table draws. The report keeps them all. */
export const CROSS_ROWS = 6;

/* The engine pass (§6): shallower than the reader's own scan, because it is 300 of
   somebody else's games on the reader's own CPU and the finding wanted from it is which
   line the mistakes come out of, not a centipawn. */
export const PASS_DEPTH = 14;
export const PASS_MOVETIME = 300;
/* The stamp on an `oppevals` row. A row with another stamp is discarded whole rather
   than reconciled, exactly as the engine's own rows are. */
export const PASS_BUILD = 'prep-pass-1';

/* ===================================================================================
 * The list — S.opponents is the truth; the store is where it survives a reload
 * =================================================================================== */

export function oppKeyOf(site, handle) {
  return String(site || '').trim().toLowerCase() + ':' + String(handle || '').trim().toLowerCase();
}

/** The Prep API's list. Rows in the order they were added. */
export function opponents() { return S.opponents; }

export function findOpponent(id) {
  return S.opponents.find(o => o && o.id === id) || null;
}

/**
 * Add a person. Returns the row — the existing one when the handle is already listed,
 * because "add" pressed twice is a person meaning one row, not two. Nothing is fetched:
 * the row lands empty and Refresh is the press that fills it (§2.7).
 */
export function addOpponent(site, handle, format, now = Date.now()) {
  site = SITES.includes(site) ? site : SITES[0];
  handle = String(handle || '').trim();
  if (!handle) return null;
  format = FORMATS.includes(format) ? format : DEFAULT_FORMAT;
  const id = oppKeyOf(site, handle);
  const have = findOpponent(id);
  if (have) return have;
  const row = { id, site, handle, format, addedAt: now, readAt: 0, count: 0, since: 0 };
  S.opponents.push(row);
  dbPut('opponents', row);
  return row;
}

/**
 * Remove a person, their games and what the engine found in them. All three go together:
 * `oppevals` is keyed as `oppgames` is precisely so neither can be orphaned by the other.
 */
export async function removeOpponent(id) {
  const i = S.opponents.findIndex(o => o && o.id === id);
  if (i < 0) return false;
  S.opponents.splice(i, 1);
  _games.delete(id);
  await dbDelete('opponents', id);
  const rows = await oppGameRows(id);
  for (const r of rows) { await dbDelete('oppgames', r.key); await dbDelete('oppevals', r.key); }
  return true;
}

/** Persist a row after changing it. The list is small; one row is one transaction. */
function saveOpponent(row) { return dbPut('opponents', row); }

/* ===================================================================================
 * The format filter — one rule, applied at the fetch and again at the read
 * =================================================================================== */

/** The time class a PGN's headers put it in, or null when the header cannot say. */
export function formatOf(headers) {
  return timeClassOf((headers || {}).TimeControl);
}

/**
 * Is this game the format you are playing? A game outside it is **dropped entirely**,
 * not counted at a discount: a bullet game tells you nothing about how somebody handles a
 * rapid opening, and a row reading "142 blitz games" that quietly contains forty bullet
 * games is wrong in the one way nothing downstream could detect.
 */
export function inFormat(headers, format) {
  return !!format && formatOf(headers) === format;
}

/** Keep only the rows in `format`. Rows carry `.headers` or `.pgn`. */
export function filterFormat(rows, format) {
  return (rows || []).filter(r => inFormat(r && (r.headers || headersOf(r.pgn)), format));
}

/* ===================================================================================
 * Fetching — "what is new", never "the archive again"
 * =================================================================================== */

/**
 * The Chess.com month archives worth asking for, given a watermark. The API has no
 * `since` parameter — the archive is a list of month URLs — so the watermark is applied
 * to the *months* and a month that ended before it is never fetched at all. Asking for
 * every month again and filtering afterwards would be the same answer at forty times the
 * bandwidth, every night before a tournament.
 *
 * `urls` arrives newest-first (that is what `chesscomArchives` returns).
 */
export function monthsSince(urls, since) {
  const out = [];
  for (const url of urls || []) {
    const m = /(\d{4})\/(\d{2})\/?$/.exec(String(url));
    if (!m) { out.push(url); continue; }          // an unreadable URL is asked, not guessed at
    // The month's last instant is the first instant of the next month.
    const endsAt = Date.UTC(+m[1], +m[2], 1);
    if (since && endsAt <= since) break;          // newest-first, so everything after is older
    out.push(url);
  }
  return out;
}

/** One Chess.com month → source rows. A month that will not answer is skipped, not fatal. */
async function chesscomMonth(url, handle) {
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.games || []).map(g => normaliseChesscom(g, handle)).filter(Boolean);
  } catch (e) { return []; }
}

/** Their games since `since`, newest first, from either site. */
async function fetchRows(site, handle, since, max) {
  if (site === 'lichess') {
    // Lichess takes the watermark itself, so the network never carries the old archive.
    return await fetchLichess(handle, { max, since: since || 0 });
  }
  const urls = monthsSince(await chesscomArchives(handle), since);
  const rows = [];
  for (const url of urls) {
    rows.push(...await chesscomMonth(url, handle));
    if (rows.length >= max) break;
  }
  rows.sort((a, b) => b.endTime - a.endTime);
  return rows.slice(0, max);
}

/** A source row → the `oppgames` row shape. Null when there is no readable game in it. */
export function oppGameRow(oppId, row) {
  const pgn = String((row && row.pgn) || '').trim();
  if (!pgn) return null;
  const headers = headersOf(pgn);
  const id = pgnId(cleanPGN(pgn));
  if (!id) return null;
  // The finish, from the row when the site gave one and from the headers when it did not.
  const endTime = Number(row.endTime) || gameEndMs({ headers }) || 0;
  return { key: oppId + ':' + id, oppId, pgnId: id, pgn, headers, endTime };
}

/**
 * The cap, oldest first. Returns the rows to keep and the rows to drop, rather than
 * mutating: the caller has to delete the dropped ones from two stores, and a function
 * that had already thrown them away could not say which.
 */
export function evictOldest(rows, cap = OPP_GAME_CAP) {
  const sorted = (rows || []).slice().sort((a, b) => (a.endTime || 0) - (b.endTime || 0));
  if (sorted.length <= cap) return { keep: sorted, drop: [] };
  return { keep: sorted.slice(sorted.length - cap), drop: sorted.slice(0, sorted.length - cap) };
}

/** Every stored game of one opponent, oldest first. One bounded range, no PGN parsing. */
async function oppGameRows(id) {
  const rows = await dbIndexRange('oppgames', 'by-opp', [id, 0], [id, Number.MAX_VALUE]);
  return (rows || []).filter(r => r && r.oppId === id);
}

/**
 * The Prep API's fetch. Resolves the number of *new* games stored, in the chosen format.
 * `since` defaults to the row's `readAt`, which is what makes Refresh the night before an
 * ask for what is new. Passing `since: 0` explicitly asks for the archive.
 */
export async function fetchOpponent(id, opts = {}) {
  const opp = findOpponent(id);
  if (!opp) return 0;
  const since = opts.since === undefined ? (opp.readAt || 0) : opts.since;
  const max = opts.max || FETCH_MAX;
  const rows = await fetchRows(opp.site, opp.handle, since, max);
  // Filtered here, so the cap is spent on the format the reader is actually playing.
  const mine = filterFormat(rows, opp.format)
    .map(r => oppGameRow(id, r))
    .filter(r => r && (!since || r.endTime > since));

  const had = await oppGameRows(id);
  const have = new Set(had.map(r => r.key));
  const fresh = mine.filter(r => !have.has(r.key));
  if (fresh.length) await dbPutAll('oppgames', fresh);

  const { keep, drop } = evictOldest([...had, ...fresh], OPP_GAME_CAP);
  for (const r of drop) { await dbDelete('oppgames', r.key); await dbDelete('oppevals', r.key); }

  opp.readAt = Date.now();
  opp.count = keep.length;
  opp.since = keep.length ? keep[0].endTime : 0;
  await saveOpponent(opp);
  _games.delete(id);
  return fresh.length;
}

/* ===================================================================================
 * Reading them back
 * =================================================================================== */

/* oppId → parsed games. Cleared whenever the store behind it changes, which is the only
   thing keeping a report off a list of games that no longer exists. */
const _games = new Map();

/** Their stored games, parsed, newest first. The format filter runs again here. */
export async function oppGames(id) {
  if (_games.has(id)) return _games.get(id);
  const opp = findOpponent(id);
  const rows = await oppGameRows(id);
  const games = [];
  let last = Date.now();
  for (const r of rows) {
    if (opp && !inFormat(r.headers, opp.format)) continue;
    const g = parseGame(r.pgn);
    if (!g) continue;
    g.source = opp ? opp.site : '';
    g.oppKey = r.key;
    g.endTime = r.endTime;
    games.push(g);
    // A few hundred games is a second of unbroken parsing; the room is arriving while
    // this runs, so the thread goes back between slices (pgn.js does the same).
    if (Date.now() - last > 40) { await new Promise(res => setTimeout(res, 0)); last = Date.now(); }
  }
  games.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
  await applyStoredEvals(id, games);
  _games.set(id, games);
  return games;
}

/* ===================================================================================
 * The crossing — your repertoire walked against theirs
 * =================================================================================== */

const newNode = san => ({ san, n: 0, w: 0, d: 0, l: 0, gis: [], children: new Map() });

/**
 * A trie over their games as one colour, tallied **from their side**. Same shape as the
 * explorer's node so the arithmetic reads the same, and the same rule: the tally *is* the
 * node — a count in a field of its own is a percentage waiting to drift.
 */
export function oppTrie(games, oppKey, theirColor, maxPly = CROSS_MAX_PLY) {
  const root = newNode('');
  (games || []).forEach((g, gi) => {
    const f = gameFacts(g, oppKey);
    if (!f || f.color !== theirColor) return;
    let node = root;
    node.n++; node[f.result]++; node.gis.push(gi);
    const depth = Math.min(maxPly, g.moves.length);
    for (let p = 0; p < depth; p++) {
      const san = g.moves[p].san;
      let kid = node.children.get(san);
      if (!kid) { kid = newNode(san); node.children.set(san, kid); }
      kid.n++; kid[f.result]++; kid.gis.push(gi);
      node = kid;
    }
  });
  return root;
}

function crossRow(path, node, gap) {
  return {
    path: path.slice(), plies: path.length, san: path[path.length - 1] || '',
    n: node.n, tally: { n: node.n, w: node.w, d: node.d, l: node.l },
    score: scorePct(node), gis: node.gis.slice(), gap: !!gap,
    // A gap is a door: the row ends in *Add one* and the door is Learn's editor.
    walk: gap ? { room: 'learn', arg: 'openings' } : null,
  };
}

/**
 * Walk your book's trie against a trie of their games and report where the two meet.
 *
 * `oppGames` is their archive; `trie` is `bookTrie(color)` for **your** colour, and
 * `opts.color` says which colour that is — so a White book is walked against their games
 * as Black. Both tries are SAN from the start position, which is the whole reason this is
 * a lockstep walk and not a transposition problem.
 *
 * At a ply that is yours, the *book* chooses and only its moves are followed. At a ply
 * that is theirs, *they* choose: a move of theirs your book answers goes deeper, and a
 * move of theirs your book has no answer to becomes a gap row. Both halves are reported,
 * because the second one is the half a report about yourself can never produce.
 *
 * `score` on every row is **their** score at that node, so a high number is a bad line
 * for you. The shared rows are ranked by it rather than by how often it came up: a line
 * they win three of three out of is worse news than one they score even in over twenty.
 */
export function crossing(oppGames, trie, opts = {}) {
  const color = opts.color === 'b' ? 'b' : 'w';
  const theirColor = color === 'w' ? 'b' : 'w';
  const oppKey = opts.oppKey || '';
  const maxPly = opts.maxPly || CROSS_MAX_PLY;
  const minPly = opts.minPly === undefined ? CROSS_MIN_PLY : opts.minPly;
  const minGames = opts.minGames === undefined ? CROSS_MIN_GAMES : opts.minGames;
  const theirs = opts.theirs || oppTrie(oppGames, oppKey, theirColor, maxPly);

  const out = {
    color, theirColor, games: theirs.n, nodes: 0,
    deepest: null, shared: [], gaps: [], rows: [],
  };
  if (!trie || !theirs.n) return out;

  const walk = (mine, them, path) => {
    const ply = path.length;
    out.nodes++;
    if (ply > 0) {
      const here = crossRow(path, them, false);
      if (!out.deepest || here.plies > out.deepest.plies ||
          (here.plies === out.deepest.plies && here.n > out.deepest.n)) out.deepest = here;
    }
    if (ply >= maxPly) return;
    // Ply 0 is White to move. The book's colour decides whose choice this ply is.
    const mineToMove = (ply % 2 === 0) === (color === 'w');
    let descended = false;
    if (mineToMove) {
      for (const [san, kidMine] of mine.children) {
        const kidThem = them.children.get(san);
        if (!kidThem) continue;    // a move of yours they have never faced is not a crossing
        descended = true;
        walk(kidMine, kidThem, [...path, san]);
      }
    } else {
      for (const [san, kidThem] of them.children) {
        const kidMine = mine.children.get(san);
        if (kidMine) { descended = true; walk(kidMine, kidThem, [...path, san]); }
        else if (kidThem.n >= minGames) out.gaps.push(crossRow([...path, san], kidThem, true));
      }
    }
    // The crossing ends here: this is the deepest the two have in common down this branch,
    // and it is the row "where it goes worst for you out of there" is asked about.
    if (!descended && ply >= minPly && them.n >= minGames) out.shared.push(crossRow(path, them, false));
  };
  walk(trie, theirs, []);

  // Worst for you first — by their score, with the sample only breaking a tie.
  out.shared.sort((a, b) => b.score - a.score || b.n - a.n || b.plies - a.plies);
  // A gap is ranked by how often they play it: "no answer to something they play often".
  out.gaps.sort((a, b) => b.n - a.n || b.score - a.score || a.plies - b.plies);
  out.rows = [...out.shared, ...out.gaps];
  return out;
}

/** The queue for the engine pass: the games from the crossing first, then the rest. */
export function passOrder(games, cross) {
  const seen = new Set();
  const order = [];
  for (const key of ['w', 'b']) {
    const c = cross && cross[key];
    if (!c) continue;
    for (const row of c.rows) for (const gi of row.gis) if (!seen.has(gi)) { seen.add(gi); order.push(gi); }
  }
  for (let i = 0; i < (games || []).length; i++) if (!seen.has(i)) order.push(i);
  return order;
}

/* ===================================================================================
 * The report and the briefing
 * =================================================================================== */

/**
 * Everything the room and the briefing read, as one plain object. Pure: it takes the
 * games and the tries and returns arithmetic, so the ninety seconds of speech can be
 * tested without a document and without a network.
 */
export function buildReport(opp, games, opts = {}) {
  games = games || [];
  const oppKey = playerKey(opp.handle);
  const book = opts.book || { w: bookTrie('w'), b: bookTrie('b') };
  const co = { oppKey, minGames: opts.minGames, minPly: opts.minPly, maxPly: opts.maxPly };
  return {
    id: opp.id, site: opp.site, handle: opp.handle, format: opp.format,
    name: displayName(games, oppKey) || opp.handle,
    oppKey, games,
    stats: computeStats(games, oppKey),
    cross: {
      w: crossing(games, book.w, { ...co, color: 'w' }),
      b: crossing(games, book.b, { ...co, color: 'b' }),
    },
    since: opp.since || oldestEnd(games),
    readAt: opp.readAt || 0,
    pass: passSummary(games, oppKey),
  };
}

/** Their name as their own PGNs spell it, so the report is headed the way they write it. */
function displayName(games, oppKey) {
  for (const g of games) {
    const h = g.headers || {};
    if (playerKey(h.White) === oppKey) return String(h.White).trim();
    if (playerKey(h.Black) === oppKey) return String(h.Black).trim();
  }
  return '';
}

function oldestEnd(games) {
  let out = 0;
  for (const g of games) { const t = g.endTime || gameEndMs(g) || 0; if (t && (!out || t < out)) out = t; }
  return out;
}

/** What the engine pass has found so far: the lines their mistakes keep coming out of. */
function passSummary(games, oppKey) {
  const done = games.filter(g => g.analysis && g.analysis.done > 0);
  if (!done.length) return { games: 0, lines: [] };
  const lines = [...patternReport(games, oppKey, 'w'), ...patternReport(games, oppKey, 'b')]
    .sort((a, b) => b.rate - a.rate || b.errors - a.errors);
  return { games: done.length, lines };
}

const pct = v => Math.round(v) + '%';

/** A line of SAN as a person reads it: "1.e4 c5 2.Nf3". */
export function lineText(path) {
  let out = '';
  (path || []).forEach((san, i) => {
    if (i % 2 === 0) out += (out ? ' ' : '') + moveNumberLabel(i) + ' ';
    else out += ' ';
    out += san;
  });
  return out.trim();
}

/**
 * The same line as speech. SAN read literally is not speech ("N f 3"), so the moves are
 * walked back into verbose moves and handed to the one grammar that knows how to say
 * them. An illegal path — which the book cannot contain, but a trie of somebody's games
 * could in principle — falls back to the SAN rather than throwing.
 */
export function lineSpeech(path) {
  const w = walkLine(path || []);
  if (!w) return (path || []).join(' ');
  return w.verbose.map(m => moveToSpeech(m, 'short').replace(/\.$/, '')).join(', ');
}

/**
 * The briefing, in parts. The order is fixed and the **crossing comes before the
 * record**: the record is what a report about them already says, and the crossing is the
 * one thing it cannot. A person with no games in the chosen format gets one sentence
 * saying exactly that, rather than a briefing read over an empty report.
 */
export function briefingParts(rep) {
  const out = [];
  const site = SITE_NAMES[rep.site] || rep.site;
  if (!rep.games.length) {
    out.push({ key: 'none', text: rep.name + ' has no ' + rep.format + ' games on ' + site +
      ' to read. Change the format on the row, or check the handle.' });
    return out;
  }
  out.push({ key: 'read', text: rep.name + ': ' + plural(rep.games.length, rep.format + ' game') +
    ' from ' + site + (rep.since ? ', the oldest from ' + fmtDate(rep.since) : '') + '.' });

  for (const part of crossingParts(rep)) out.push(part);

  const st = rep.stats;
  const o = st.overall;
  out.push({ key: 'record', text: rep.name + ' played ' + plural(st.counted, 'game') + ' to a result: ' +
    plural(o.w, 'win') + ', ' + plural(o.d, 'draw') + ', ' + plural(o.l, 'loss', 'losses') +
    ' — a score of ' + pct(scorePct(o)) + '. As White ' + pct(scorePct(st.white)) + ' over ' + st.white.n +
    ', as Black ' + pct(scorePct(st.black)) + ' over ' + st.black.n + '.' });

  const ends = endingParts(rep);
  if (ends) out.push(ends);
  for (const part of openingParts(rep)) out.push(part);

  if (rep.pass.games) {
    const worst = rep.pass.lines[0];
    out.push({ key: 'pass', text: 'The engine went through ' + plural(rep.pass.games, 'of their games') +
      (worst ? '. Their mistakes come most often out of ' + lineSpeech(worst.path) + ' — ' +
        plural(worst.errors, 'error') + ' over ' + plural(worst.analysed, 'game') + '.' : '.') });
  }
  return out;
}

/** The Prep API's briefing: the sentences, in order, for the button to speak in sequence. */
export function briefing(rep) { return briefingParts(rep).map(p => p.text); }

function crossingParts(rep) {
  const out = [];
  for (const color of ['w', 'b']) {
    const c = rep.cross[color];
    if (!c || !c.games) continue;
    const mine = color === 'w' ? 'White' : 'Black';
    const theirs = color === 'w' ? 'Black' : 'White';
    if (!c.deepest) {
      out.push({ key: 'cross-' + color, text: 'Your ' + mine + ' book and their ' + theirs +
        ' games never meet: nothing you have written down has come up in ' + plural(c.games, 'game') + '.' });
      continue;
    }
    const d = c.deepest;
    out.push({ key: 'cross-' + color, text: 'Your ' + mine + ' book and their games go as deep as ' +
      lineSpeech(d.path) + ' — ' + plural(d.n, 'of their games') + ', and they score ' + pct(d.score) + ' there.' });
    const worst = c.shared[0];
    if (worst && worst.path.join(' ') !== d.path.join(' ')) {
      out.push({ key: 'cross-worst-' + color, text: 'It goes worst for you after ' + lineSpeech(worst.path) +
        ': they score ' + pct(worst.score) + ' over ' + plural(worst.n, 'game') + '.' });
    }
    const gap = c.gaps[0];
    if (gap) {
      out.push({ key: 'cross-gap-' + color, text: 'Your book has no answer to ' + lineSpeech(gap.path) +
        ', which they play in ' + plural(gap.n, 'game') + '. Add one in Learn.' });
    }
  }
  if (!out.length) out.push({ key: 'cross-none', text: 'Your book has nothing to walk against them yet — write a line in Learn and this is where it is tested.' });
  return out;
}

function endingParts(rep) {
  const top = obj => {
    const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    return rows.length ? rows[0] : null;
  };
  const w = top(rep.stats.endings.w), l = top(rep.stats.endings.l);
  if (!w && !l) return null;
  const bits = [];
  if (w) bits.push('they win most often by ' + endingLabel(w[0]) + ' (' + plural(w[1], 'game') + ')');
  if (l) bits.push('they lose most often by ' + endingLabel(l[0]) + ' (' + plural(l[1], 'game') + ')');
  return { key: 'endings', text: bits.join(', and ') + '.' };
}

function openingParts(rep) {
  const out = [];
  for (const color of ['w', 'b']) {
    const root = buildExplorer(rep.games, rep.oppKey, color, 2);
    if (!root.n) continue;
    const kids = [...root.children.values()].sort((a, b) => b.n - a.n);
    if (!kids.length) continue;
    const top = kids[0];
    out.push({
      key: 'opening-' + color,
      text: 'As ' + (color === 'w' ? 'White they open ' : 'Black they answer with ') +
        lineSpeech([top.san]) + ' in ' + top.n + ' of ' + root.n + ' games, scoring ' + pct(scorePct(top)) + '.',
    });
  }
  return out;
}

/* ===================================================================================
 * The engine pass — a press, never an idle job (§2.7)
 * =================================================================================== */

/* The compact spellings of an `oppevals` row. They are the engine's spellings (see the
   contract), written out again here rather than imported: `oppevals` is Prep's store and
   this module must not reach into the scan queue to write it. See the Asks in
   docs/prep.md — this codec wants to live in a leaf both modules can read. */
function encodeEval(ev) {
  if (ev === null) return 'n';
  if (ev === undefined) return '';
  if (ev.mate !== undefined) return 'm' + ev.mate;
  return String(ev.cp);
}
function decodeEval(s) {
  if (s === '') return undefined;
  if (s === 'n') return null;
  if (s[0] === 'm') { const v = Number(s.slice(1)); return Number.isFinite(v) ? { mate: v } : undefined; }
  const v = Number(s);
  return Number.isFinite(v) ? { cp: v } : undefined;
}
function encodeList(list, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(encodeEval(list ? list[i] : undefined));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join(',');
}
function decodeList(str, n) {
  const out = [];
  out.length = n;
  if (!str) return out;
  const parts = String(str).split(',');
  for (let i = 0; i < parts.length && i < n; i++) { const v = decodeEval(parts[i]); if (v !== undefined) out[i] = v; }
  return out;
}
function encodeLines(pv, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pv && pv[i] && pv[i].length ? pv[i].join(' ') : '');
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('|');
}
function decodeLines(str, n) {
  const pv = []; pv.length = n;
  const best = []; best.length = n;
  if (!str) return { pv, best };
  String(str).split('|').forEach((s, i) => {
    if (i >= n || !s) return;
    const moves = s.split(' ').filter(Boolean);
    if (moves.length) { pv[i] = moves; best[i] = moves[0]; }
  });
  return { pv, best };
}

function ensureAnalysis(game) {
  if (!game.analysis || game.analysis.build !== PASS_BUILD || game.analysis.depth !== PASS_DEPTH) {
    game.analysis = { build: PASS_BUILD, depth: PASS_DEPTH, evals: [], best: [], pv: [], alts: [], done: 0, altsDone: false };
  }
  return game.analysis;
}

/** The `oppevals` row for one of their games, or null when nothing has been found in it. */
export function passRow(oppId, game) {
  const a = game && game.analysis;
  if (!a || !a.done || !game.oppKey) return null;
  const n = game.fens.length;
  const row = {
    key: game.oppKey, oppId, pgnId: game.id,
    build: PASS_BUILD, depth: PASS_DEPTH, plies: n,
    evals: encodeList(a.evals, n), lines: encodeLines(a.pv, n), alts: '',
  };
  row.bytes = JSON.stringify(row).length;
  return row;
}

/** Put a stored row back onto a game. A row of another build is discarded whole. */
export function applyPassRow(game, row) {
  if (!game || !game.fens || !row || row.build !== PASS_BUILD || row.depth !== PASS_DEPTH) return false;
  const n = game.fens.length;
  if (row.plies !== undefined && row.plies !== n) return false;   // a different game under the same key
  const evals = decodeList(row.evals, n);
  const { pv, best } = decodeLines(row.lines, n);
  const a = ensureAnalysis(game);
  let done = 0;
  for (let i = 0; i < n; i++) {
    if (a.evals[i] === undefined && evals[i] !== undefined) {
      a.evals[i] = evals[i];
      if (pv[i]) { a.pv[i] = pv[i]; a.best[i] = best[i]; }
    }
    if (a.evals[i] !== undefined) done++;
  }
  a.done = done;
  return true;
}

async function applyStoredEvals(id, games) {
  const rows = await dbAll('oppevals');
  if (!rows || !rows.length) return;
  const by = new Map();
  for (const r of rows) if (r && r.oppId === id) by.set(r.key, r);
  if (!by.size) return;
  for (const g of games) { const r = by.get(g.oppKey); if (r) applyPassRow(g, r); }
}

/* The pass is one at a time and it belongs to the room, not to a queue: it is the
   reader's own CPU, started by a press and stopped by one. */
const _pass = { on: false, id: '', done: 0, total: 0, game: 0, games: 0, ctrl: null };
export function passState() { return { on: _pass.on, id: _pass.id, done: _pass.done, total: _pass.total, game: _pass.game, games: _pass.games }; }

export function stopPass() {
  _pass.on = false;
  if (_pass.ctrl) { try { _pass.ctrl.abort(); } catch (e) { /* already gone */ } }
  _pass.ctrl = null;
  onPassChange();
}

/**
 * Go through their games with the engine. The games from the crossing come first — those
 * are the positions the reader is actually going to be in on Saturday — and the walk is
 * stoppable at any ply. What has been committed is written per game, so stopping and
 * pressing again resumes where it stopped rather than starting the archive over.
 */
export async function startPass(id, games, cross) {
  if (_pass.on) return 0;
  const { analyse } = await import('./engine/provider.js');
  const order = passOrder(games, cross);
  _pass.on = true; _pass.id = id; _pass.done = 0; _pass.game = 0; _pass.games = order.length;
  _pass.total = order.reduce((n, gi) => n + (games[gi] ? games[gi].fens.length : 0), 0);
  _pass.ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  onPassChange();
  let found = 0;
  try {
    for (const gi of order) {
      if (!_pass.on) break;
      const g = games[gi];
      if (!g) continue;
      _pass.game++;
      const a = ensureAnalysis(g);
      let wrote = false;
      for (let i = 0; i < g.fens.length; i++) {
        if (!_pass.on) break;
        if (a.evals[i] !== undefined) { _pass.done++; continue; }
        let r = null;
        try {
          r = await analyse(g.fens[i], {
            depth: PASS_DEPTH, movetimeMs: PASS_MOVETIME, kind: 'scan',
            signal: _pass.ctrl ? _pass.ctrl.signal : undefined,
          });
        } catch (e) { break; }   // an abort or a dead engine ends this game, not the row
        if (!r) break;
        // The provider answers from the side to move; the store is White-positive.
        const black = String(g.fens[i]).split(' ')[1] === 'b';
        if (r.mate !== undefined) a.evals[i] = { mate: black ? -r.mate : r.mate };
        else if (r.cp !== undefined) a.evals[i] = { cp: black ? -r.cp : r.cp };
        else continue;
        if (r.pv && r.pv.length) { a.pv[i] = r.pv; a.best[i] = r.pv[0]; }
        a.done++; _pass.done++; found++; wrote = true;
        if (_pass.done % 20 === 0) onPassChange();
      }
      if (wrote) { const row = passRow(id, g); if (row) await dbPut('oppevals', row); }
    }
  } finally {
    _pass.on = false; _pass.ctrl = null;
    onPassChange();
  }
  return found;
}

/* ===================================================================================
 * The room. Everything below is guarded on `document`.
 * =================================================================================== */

const hasDOM = () => typeof document !== 'undefined';
let _painting = null;      // the opponent id whose report is on screen, '' for the list
let _report = null;        // the built report on screen

function onPassChange() {
  if (!hasDOM() || currentRoom() !== 'prep' || !_painting) return;
  const el = document.querySelector('.prep-pass-status');
  if (el) el.textContent = passText();
  const btn = document.querySelector('[data-act="pass"]');
  if (btn) btn.textContent = _pass.on ? 'Stop' : 'Go through their games';
}

function passText() {
  const st = passState();
  if (st.on) return 'Game ' + st.game + ' of ' + st.games + ' · ' + st.done + ' of ' + st.total + ' positions';
  if (_report && _report.pass.games) return plural(_report.pass.games, 'game') + ' evaluated so far.';
  return 'Your own CPU, on a press. Stoppable, and it resumes where it stopped.';
}

/** "142 blitz games since 3 Mar 2024" — or that there are none in that format at all. */
export function rowSentence(opp) {
  if (!opp.readAt) return 'Not read yet. Refresh brings their public ' + opp.format + ' games here.';
  if (!opp.count) return 'No ' + opp.format + ' games on ' + (SITE_NAMES[opp.site] || opp.site) + ' at all — try another format.';
  return plural(opp.count, opp.format + ' game') + (opp.since ? ' since ' + fmtDate(opp.since) : '') + '.';
}

function listHTML() {
  const add = '<section class="panel prep-add"><header class="panel-head"><h2>The people you are about to play</h2></header>' +
    '<div class="panel-body"><p class="hint">A handle and a time control brings their public games to this browser, filtered to the format you are actually playing. The list is five handles you can retype: it is stored here and synced nowhere.</p>' +
    '<div class="field-row prep-form">' +
    '<label>Site<select data-f="site">' + SITES.map(s => '<option value="' + s + '">' + escHtml(SITE_NAMES[s]) + '</option>').join('') + '</select></label>' +
    '<label>Handle<input data-f="handle" type="text" placeholder="their username" autocomplete="off"></label>' +
    '<label>Format<select data-f="format">' + FORMATS.map(f => '<option value="' + f + '"' + (f === DEFAULT_FORMAT ? ' selected' : '') + '>' + escHtml(f[0].toUpperCase() + f.slice(1)) + '</option>').join('') + '</select></label>' +
    '<button class="btn btn-primary" type="button" data-act="add">Add</button></div></div></section>';

  const rows = S.opponents.map(o =>
    '<div class="prep-row" data-id="' + escHtml(o.id) + '">' +
      '<div class="prep-who"><span class="prep-name">' + escHtml(o.handle) + '</span>' +
        '<span class="meta">' + escHtml(SITE_NAMES[o.site] || o.site) + ' · ' + escHtml(o.format) + '</span></div>' +
      '<p class="hint prep-said">' + escHtml(rowSentence(o)) + '</p>' +
      '<div class="prep-row-tools">' +
        '<button class="btn btn-sm" type="button" data-act="open">Open</button>' +
        '<button class="btn btn-sm" type="button" data-act="refresh">' + (o.readAt ? 'What is new' : 'Read their games') + '</button>' +
        '<button class="btn btn-sm btn-ghost speak-elsewhere" type="button" data-act="say" title="Read this row aloud">Speak</button>' +
        '<button class="btn btn-sm btn-ghost btn-danger" type="button" data-act="remove">Remove</button>' +
      '</div></div>').join('');

  const list = '<section class="panel prep-list"><header class="panel-head"><h2>Your list</h2>' +
    '<div class="tools"><span class="meta">' + plural(S.opponents.length, 'person', 'people') + '</span></div></header>' +
    '<div class="panel-body">' + (rows ||
      emptyHTML('Nobody on the list yet. Add the person you are about to play and their public games are read here.', 'Write a line in your book', 'book')) +
    '</div></section>';
  return add + list;
}

function crossPanelHTML(rep) {
  let body = '';
  for (const color of ['w', 'b']) {
    const c = rep.cross[color];
    const mine = color === 'w' ? 'your White book against their games as Black' : 'your Black book against their games as White';
    if (!c.games) { body += '<p class="hint">They have no games as ' + (color === 'w' ? 'Black' : 'White') + ' here.</p>'; continue; }
    body += '<h3 class="prep-cross-head">As ' + (color === 'w' ? 'White' : 'Black') + ' <span class="meta">' + escHtml(mine) + '</span></h3>';
    if (!c.deepest) {
      body += '<p class="hint">Nothing you have written down has come up in their ' + plural(c.games, 'game') + '. ' +
        '<button class="btn btn-sm" type="button" data-act="learn">Write a line</button></p>';
      continue;
    }
    body += '<p class="lede">You go as deep as <span class="cross-san">' + escHtml(lineText(rep.cross[color].deepest.path)) +
      '</span> — ' + plural(c.deepest.n, 'of their games') + ', and they score <span class="num">' + pct(c.deepest.score) + '</span> there.</p>';
    const rows = [...c.shared.slice(0, CROSS_ROWS), ...c.gaps.slice(0, CROSS_ROWS)];
    body += '<table class="prep-cross-table"><thead><tr><th>Line</th><th class="num">Games</th><th class="num">Their score</th><th></th></tr></thead><tbody>' +
      rows.map(r => '<tr class="' + (r.gap ? 'prep-gap' : '') + '">' +
        '<td><span class="cross-san">' + escHtml(lineText(r.path)) + '</span></td>' +
        '<td class="num">' + r.n + '</td>' +
        '<td class="num">' + pct(r.score) + '</td>' +
        '<td>' + (r.gap ? '<button class="btn btn-sm" type="button" data-act="learn">Add one</button>' : '') + '</td></tr>').join('') +
      '</tbody></table>';
  }
  return '<section class="panel span-2 prep-cross"><header class="panel-head"><h2>Your repertoire against theirs</h2>' +
    '<div class="tools"><button class="btn btn-sm btn-ghost speak-elsewhere" type="button" data-act="say-cross" title="Read this card aloud">Speak</button></div></header>' +
    '<div class="panel-body scroll-x">' + body + '</div></section>';
}

function reportHeadHTML(rep) {
  const site = SITE_NAMES[rep.site] || rep.site;
  const read = rep.games.length
    ? plural(rep.games.length, rep.format + ' game') + ' from ' + escHtml(site) +
      (rep.since ? ', the oldest from ' + escHtml(fmtDate(rep.since)) : '') +
      (rep.readAt ? ' · read ' + escHtml(fmtDate(rep.readAt)) : '')
    : 'No ' + escHtml(rep.format) + ' games from ' + escHtml(site) + ' yet.';
  return '<div class="prep-head">' +
    '<button class="btn btn-sm" type="button" data-act="back">← The list</button>' +
    '<h2 class="prep-subject">' + escHtml(rep.name) + '</h2>' +
    '<p class="hint">' + read + '</p>' +
    '<div class="prep-head-tools">' +
      '<button class="btn btn-primary" type="button" data-act="brief">Ninety-second briefing</button>' +
      '<button class="btn" type="button" data-act="stop-brief" hidden>Stop reading</button>' +
      '<button class="btn" type="button" data-act="refresh">What is new</button>' +
      '<button class="btn" type="button" data-act="pass">Go through their games</button>' +
      '<span class="prep-pass-status meta">' + escHtml(passText()) + '</span>' +
    '</div></div>';
}

async function paintReport(el, id) {
  const opp = findOpponent(id);
  if (!opp) {
    el.innerHTML = emptyHTML('Nobody on the list answers to that address.', 'Back to the list', 'back');
    return;
  }
  el.innerHTML = '<p class="hint">Reading ' + escHtml(opp.handle) + '’s games…</p>';
  const games = await oppGames(id);
  if (_painting !== id) return;            // the reader walked on while this was loading
  const rep = buildReport(opp, games);
  _report = rep;
  el.innerHTML = reportHeadHTML(rep) +
    (games.length
      ? '<div class="cards cards-report prep-cross-wrap">' + crossPanelHTML(rep) + '</div><div class="prep-report"></div>'
      : emptyHTML(briefingParts(rep)[0].text, 'Read their games', 'refresh'));
  if (!games.length) { stageRelease('prep'); return; }
  renderReport(el.querySelector('.prep-report'), games, rep.oppKey, { about: 'them', name: rep.name, room: 'prep' });
}

/* The briefing button: one array of sentences, each starting when the last has finished.
   A queue rather than one long string, so a press on Stop lands between sentences and the
   reader hears where they stopped. */
let _brief = null;
function readBriefing(sentences) {
  stopBriefing();
  _brief = { list: sentences.slice(), i: 0 };
  const next = () => {
    if (!_brief || _brief.i >= _brief.list.length) { stopBriefing(); return; }
    const text = _brief.list[_brief.i++];
    speak(text, next);
  };
  briefingButtons(true);
  next();
}
function stopBriefing() {
  if (_brief) { _brief = null; cancelSpeech(); }
  briefingButtons(false);
}
function briefingButtons(on) {
  if (!hasDOM()) return;
  const go = document.querySelector('[data-act="brief"]');
  const stop = document.querySelector('[data-act="stop-brief"]');
  if (go) go.hidden = !!on;
  if (stop) stop.hidden = !on;
}

async function refresh(id) {
  const opp = findOpponent(id);
  if (!opp) return;
  toast('Asking ' + (SITE_NAMES[opp.site] || opp.site) + ' for ' + opp.handle + '’s games…');
  try {
    const n = await fetchOpponent(id);
    toast(n ? plural(n, 'new ' + opp.format + ' game') + ' read.' : 'Nothing new in ' + opp.format + ' since last time.');
  } catch (e) {
    // Every failure path is a sentence, never an error (§2.3).
    toast((e && e.message) || 'That site would not answer just now.');
  }
  renderNav();
  enter(currentRoomArg());
}

function currentRoomArg() { return _painting || ''; }

function wire(el) {
  if (el._prepWired) return;
  el._prepWired = true;
  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const rowEl = btn.closest('[data-id]');
    const id = rowEl ? rowEl.dataset.id : _painting;
    if (act === 'add') {
      const f = k => el.querySelector('[data-f="' + k + '"]');
      const handle = f('handle').value.trim();
      if (!handle) { toast('Type the handle of the person you are about to play.'); return; }
      const row = addOpponent(f('site').value, handle, f('format').value);
      f('handle').value = '';
      renderNav();
      enter('');
      if (row) refresh(row.id);
      return;
    }
    if (act === 'open') { navigate('prep', id); return; }
    if (act === 'back') { navigate('prep'); return; }
    if (act === 'refresh') { refresh(id); return; }
    if (act === 'remove') {
      const opp = findOpponent(id);
      await removeOpponent(id);
      renderNav();
      enter('');
      if (opp) toast(opp.handle + ' is off the list, with their games and their evaluations.');
      return;
    }
    if (act === 'say') { const opp = findOpponent(id); if (opp) speak(opp.handle + '. ' + rowSentence(opp)); return; }
    if (act === 'say-cross') { if (_report) speak(crossingParts(_report).map(p => p.text).join(' ')); return; }
    if (act === 'brief') { if (_report) readBriefing(briefing(_report)); return; }
    if (act === 'stop-brief') { stopBriefing(); return; }
    if (act === 'learn' || act === 'book') { navigate('learn', 'openings'); return; }
    if (act === 'import') { navigate('learn', 'openings'); return; }
    if (act === 'pass') {
      if (_pass.on) { stopPass(); return; }
      if (!_report || !_report.games.length) return;
      const found = await startPass(id, _report.games, _report.cross);
      if (currentRoom() === 'prep' && _painting === id) {
        toast(found ? plural(found, 'position') + ' evaluated. The report has what it found.' : 'Nothing more to evaluate.');
        enter(id);
      }
      return;
    }
  });
}

/**
 * Prep is a room with two addresses: `#/prep` is the list and `#/prep/<site>:<handle>` is
 * that person's report. The report is therefore a *place* — reachable by URL, surviving a
 * reload, and closed by the Back button, which is the only reason it is a route segment
 * rather than an expanded row.
 */
function enter(arg) {
  const el = $('prep-body');
  if (!el) return;
  wire(el);
  stopBriefing();
  const id = String(arg || '').trim();
  _painting = id;
  if (!id) {
    _report = null;
    stageRelease('prep');
    el.innerHTML = listHTML();
    return;
  }
  paintReport(el, id);
}

export function boot() {
  registerRoom('prep', enter);
  if (!hasDOM()) return;
  // Rows arrive from the disk behind the room's back, and erasing empties the list.
  for (const ev of ['cr:restored', 'cr:book-changed']) {
    document.addEventListener(ev, () => { _games.clear(); if (currentRoom() === 'prep') enter(_painting); });
  }
}
