/*
 * The game review (§7 "Judging a move", "The game review"; contract "Review API").
 *
 * Everything in Analysis is about a move; everything in Insights is about the archive.
 * "How did I play *that* game" is the middle, and this file is it. It adds no engine
 * work and no requests: every figure is arithmetic over the evaluations the scan banked
 * in game.analysis and the FENs parseGame() banked at import. The one thing it fetches
 * is the opening table, and only once a reviewed game is on screen.
 *
 * Two boundaries are load-bearing and both are pinned in test/review.test.js:
 *
 * **classifyMove() keeps its three words and its guards.** Callers read a non-null
 * answer as "this move was an error" — the spoken verdict, the tree's marks during a
 * scan, the amber arrow, the deck. A trainer must not call a forced recapture a blunder,
 * so it says nothing for the engine's own move and nothing from a position that was
 * already decided. reviewClass() is a *second* function over the same figures with the
 * wider vocabulary, and wherever classifyMove() says error, reviewClass() says an error
 * word too — never `book`, never `best`.
 *
 * **Accuracy is computed from win probability, not from moveLoss().** Loss is guarded
 * and floored; accuracy wants every move counted, and the probability curve flattens the
 * dead ones on its own. The curve is Lichess's, constant for constant, so the percentage
 * is comparable with the one a reader can get free elsewhere.
 */
import { Chess } from 'chess.js';
import { currentGame } from './state.js';
import { $, escHtml } from './dom.js';
import { moveNumberLabel } from './pgn.js';
import { setTreeMark, onRender, stageOwner, showBoard, renderBoard, TREE_MARKS } from './render.js';
import { goToPly, setVerdictSpeech } from './playback.js';
import { moveToSpeech } from './speech/grammar.js';

/* ===== The figures ===== */

// The thresholds every annotator uses. Worth keeping conventional: a reader who has
// seen Chess.com's numbers should not have to learn ours.
export const SWING = { inaccuracy: 50, mistake: 100, blunder: 300 };

/*
 * Below this win probability the mover was already lost and nothing they do next is
 * worth annotating; above its complement they were already won, and a move that keeps
 * them there gave nothing away whatever the centipawns say. A win-probability bar rather
 * than a centipawn one on purpose: the difference between +2 and +4 is enormous and the
 * difference between +9 and +11 is nothing, and only the curve knows that.
 */
export const DECIDED_WIN_PCT = 5;

/*
 * A mate score has to become a number before it can be compared with a centipawn one.
 * ±10000 is past the curve's clamp (1500), so a mate is 99.8% whatever its distance —
 * the review does not rank a mate in three above a mate in five, and it does not need to.
 */
const MATE_CP = 10000;

/*
 * What a move cost, as a number a mean can survive. Two evaluations either side of a
 * move come from two independent depth-limited searches, so one finding a mate the other
 * did not is ordinary, and a single uncapped difference of ten thousand would be the
 * whole of any average it landed in. Floored too: a negative loss says the player gained
 * material by moving — plausible, precise and impossible.
 */
export const LOSS_CAP = 1000;

/** Under SWING.inaccuracy there is still a difference between a move that gave up
 *  nothing and one that gave up a fifth of a pawn, and the review has room to say so. */
const EXCELLENT_CP = 20;

/*
 * How far the second-best move must trail before the played one was "the only move".
 * The gate on the two words the app cannot afford to hand out wrongly, so it is wide,
 * and it is only ever asked of a position that was still contested: at +7 the "only
 * move that keeps +7" is not a find, it is bookkeeping.
 */
const GREAT_GAP = 100;
const CONTESTED = [10, 90];   // mover's win probability, inclusive

/** Material given up along the engine's own line before a move counts as a sacrifice
 *  rather than an exchange — two pawns, so a pawn-for-tempo gambit is not "Brilliant". */
const SACRIFICE_CP = 200;

/** Won, by the standard `miss` uses: the mover had at least this before the move. */
const MISS_WIN_CP = 300;

/* Opening ends at ply 20 when no table and no header says otherwise. */
const OPENING_FALLBACK_PLY = 20;

/*
 * The endgame, in non-pawn material per side, in the points every club player counts
 * in (Q9 R5 B3 N3). Thirteen is two rooks and a minor, or a queen and a minor: the
 * board where a king walks out. Both sides must be at or under it — a queen against a
 * rook and two minors is still a middlegame for the queen's owner. Checked from the end
 * of the opening on, never before it. A threshold rather than a definition, named so
 * the number a phase accuracy is cut on can be argued with.
 */
export const ENDGAME_POINTS = 13;
const POINTS = { q: 9, r: 5, b: 3, n: 3 };
const PIECE_CP = { q: 900, r: 500, b: 330, n: 320, p: 100 };

/*
 * The review's vocabulary, in the order the card lists it. Ten words: the spec counts
 * eleven, and the eleventh was the original's `forced`, which the contract's list and
 * TREE_MARKS both leave out — a move with no alternative is `best` here.
 */
/*
 * The eleven words. The spec enumerates ten and then calls them eleven; the original
 * app's list is the eleven, and `forced` is the one its enumeration dropped. Restored
 * here because the second pass already collects exactly this fact — alts[n] === null is
 * the engine reporting "asked, and the position was forced" — so the word costs no
 * extra work and saying `Best` of a move that had no alternative overstates it.
 */
export const REVIEW_WORDS = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced', 'inaccuracy', 'mistake', 'miss', 'blunder'];
export const ERROR_WORDS = ['inaccuracy', 'mistake', 'miss', 'blunder'];
const LABEL = { brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent', good: 'Good', book: 'Book', forced: 'Forced', inaccuracy: 'Inaccuracy', mistake: 'Mistake', miss: 'Miss', blunder: 'Blunder' };

/** Lichess's win-probability curve, White-positive, 0..100. */
export function winProb(cp) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** The scan has reached every position, as against having merely started. */
export function analysisReady(game) {
  const a = game && game.analysis;
  return !!(a && Array.isArray(a.evals) && game.fens && a.done >= game.fens.length);
}

/** Move n exists and both evaluations around it are in. "Not a mistake" and "not
 *  looked at" are different answers, and every function below keeps them apart. */
function judged(game, n) {
  const a = game && game.analysis;
  return !!(a && a.evals && game.moves && game.moves[n] && a.evals[n] && a.evals[n + 1]);
}

/** One evaluation as White-positive centipawns. A mate with no distance (the mated
 *  position itself) is read off whose move it is. */
function evalCp(ev, fen) {
  if (!ev) return null;
  if (ev.mate === undefined) return ev.cp;
  if (ev.mate > 0) return MATE_CP;
  if (ev.mate < 0) return -MATE_CP;
  return fen && fen.split(' ')[1] === 'b' ? MATE_CP : -MATE_CP;
}
function cpAt(game, i) { return evalCp(game.analysis.evals[i], game.fens[i]); }
function isMateFor(ev, white) { return !!ev && ev.mate !== undefined && ev.mate !== 0 && (ev.mate > 0) === white; }

/** The mover's own winning chances at fens[i]; evals are White-positive throughout. */
function moverWin(game, i, white) {
  const w = winProb(cpAt(game, i));
  return white ? w : 100 - w;
}

/** UCI of the move played, spelled the way the engine spells its best. */
function playedUci(m) { return m.from + m.to + (m.promotion || ''); }
function isBest(game, n) {
  const best = game.analysis.best && game.analysis.best[n];
  return !!best && best === playedUci(game.moves[n]);
}

/** Centipawns the mover lost on move n, floored at zero and capped; null when unjudged. */
export function moveLoss(game, n) {
  if (!judged(game, n)) return null;
  const before = cpAt(game, n), after = cpAt(game, n + 1);
  const raw = game.moves[n].color === 'w' ? before - after : after - before;
  return Math.max(0, Math.min(LOSS_CAP, raw));
}

/*
 * Why classifyMove() has nothing to say about move n, or null when it does. Kept apart
 * from the verdict so reviewClass() can tell a guarded move from a fine one: a move that
 * lost three pawns from a lost position is not `best`, and it is not a `blunder` either.
 */
function guardOn(game, n) {
  if (isBest(game, n)) return 'best';
  const white = game.moves[n].color === 'w';
  const before = moverWin(game, n, white);
  if (before <= DECIDED_WIN_PCT) return 'lost';
  if (before >= 100 - DECIDED_WIN_PCT && moverWin(game, n + 1, white) >= 100 - DECIDED_WIN_PCT) return 'won';
  return null;
}

/** Three words, guarded. null: fine, unknown, the engine's own move, or already decided. */
export function classifyMove(game, n) {
  if (!judged(game, n) || guardOn(game, n)) return null;
  const loss = moveLoss(game, n);
  if (loss >= SWING.blunder) return 'blunder';
  if (loss >= SWING.mistake) return 'mistake';
  if (loss >= SWING.inaccuracy) return 'inaccuracy';
  return null;
}

/*
 * "You had this." The mover was winning — a mate, or three pawns up by the engine's
 * reckoning — and the move let it go: a mistake or worse that leaves them no longer
 * winning by the same bar. A +15 that becomes +12 is a mistake, not a miss; the win is
 * still there.
 */
function isMiss(game, n, loss) {
  if (loss < SWING.mistake) return false;
  const white = game.moves[n].color === 'w';
  const evs = game.analysis.evals;
  const sign = white ? 1 : -1;
  const had = isMateFor(evs[n], white) || sign * cpAt(game, n) >= MISS_WIN_CP;
  const has = isMateFor(evs[n + 1], white) || sign * cpAt(game, n + 1) >= MISS_WIN_CP;
  return had && !has;
}

/*
 * Whether the move gave material away. Two readings, either suffices: the piece just
 * moved can be taken next ply by something cheaper, or by anything at all with no
 * recapture; or the engine's own line from here (pv[n], which opens with this move) ends
 * with the mover down SACRIFICE_CP. The second is what catches a queen sacrifice that
 * is *not* en prise on its landing square. null when chess.js cannot replay the position.
 */
function isSacrifice(game, n) {
  const mv = game.moves[n];
  const white = mv.color === 'w';
  let chess;
  try { chess = new Chess(game.fens[n + 1]); } catch (e) { return null; }
  const value = PIECE_CP[mv.piece] || 0;
  if (value > PIECE_CP.p) {
    for (const cap of chess.moves({ verbose: true })) {
      if (cap.to !== mv.to) continue;
      if ((PIECE_CP[cap.piece] || 0) < value) return true;
      // Taken by something worth as much or more: a sacrifice only if it stays taken.
      try {
        const c2 = new Chess(game.fens[n + 1]);
        c2.move({ from: cap.from, to: cap.to, promotion: cap.promotion });
        if (!c2.moves({ verbose: true }).some(r => r.to === mv.to)) return true;
      } catch (e) { /* fall through to the line */ }
    }
  }
  const line = game.analysis.pv && game.analysis.pv[n];
  if (!line || !line.length) return false;
  try {
    const c = new Chess(game.fens[n]);
    const bal = fen => materialOf(fen, white) - materialOf(fen, !white);
    const before = bal(game.fens[n]);
    for (const uci of line) c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return before - bal(c.fen()) >= SACRIFICE_CP;
  } catch (e) { return false; }
}

function materialOf(fen, white) {
  let total = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = PIECE_CP[ch.toLowerCase()];
    if (v && (ch === ch.toUpperCase()) === white) total += v;
  }
  return total;
}

/*
 * The two words that need the second pass. `alts[n]` is the MultiPV 2 answer the engine
 * module lands after a scan: undefined is "never asked" and null is "asked, and the
 * position was forced". Never asked means the review says `best` and nothing more —
 * inferring "only move" from the evaluation delta is the one guess a reader would
 * believe. Asked-and-forced is the engine's own answer and earns `forced`, which is
 * why standout() reports the two cases apart rather than folding both to null.
 * Compared explicitly rather than for truthiness: a second-best move at dead level is
 * {cp: 0}, and 0 is the most ordinary number here.
 */
function standout(game, n) {
  const alts = game.analysis.alts;
  if (!alts) return null;
  const second = alts[n];
  if (second === undefined) return null;
  if (second === null) return 'forced';
  const white = game.moves[n].color === 'w';
  const before = moverWin(game, n, white);
  if (before < CONTESTED[0] || before > CONTESTED[1]) return null;
  const secondCp = evalCp(second, game.fens[n]);
  if (secondCp === null) return null;
  const gap = white ? cpAt(game, n) - secondCp : secondCp - cpAt(game, n);
  if (gap < GREAT_GAP) return null;
  return isSacrifice(game, n) ? 'brilliant' : 'great';
}

/*
 * The review's verdict on move n: one of REVIEW_WORDS, or null when unjudged. Answers
 * for every judged move rather than only the bad ones, because the counts on the card
 * have to sum to the game.
 *
 * The error words come first, off classifyMove(), so the two functions cannot disagree
 * about whether a move was an error: an inaccuracy played inside a book line is still an
 * inaccuracy — the table names positions, it does not vouch for them. `book` outranks
 * `best` for the rest of the opening because "you were still in the book" is the more
 * useful sentence, and neither Great nor Brilliant is said of a book move.
 */
export function reviewClass(game, n) {
  if (!judged(game, n)) return null;
  const err = classifyMove(game, n);
  if (err) return isMiss(game, n, moveLoss(game, n)) ? 'miss' : err;
  if (inBook(game, n)) return 'book';
  if (isBest(game, n)) return standout(game, n) || 'best';
  // A forced move that was not the engine's first choice is still forced — but the
  // engine only ever reports forced for a position it was asked about, and it is asked
  // only where the played move was already best, so there is no branch to write here.
  return moveLoss(game, n) < EXCELLENT_CP ? 'excellent' : 'good';
}

/* ===== The opening table ===== */

/*
 * Position-keyed ECO names, 3,800 of them, keyed by EPD (the first four FEN fields —
 * the move counters are what make one position two strings). Fetched by the review and
 * by nothing else, and only once a game with analysis is on screen: a reader who never
 * asks for a review never pays for it, and playback never waits on it because
 * gameOpening() falls through to the PGN headers while it is out.
 */
const ECO_URL = './openings/eco.json';
/* ECO lines run to about fifteen moves; past this a hit is a transposition into
   somebody's twentieth-move novelty rather than an opening the reader was in. */
const ECO_MAX_PLY = 30;

let _eco = null;        // {epd: "C50 Italian Game"} once loaded
let _ecoNoEp = null;    // the same table keyed without the en-passant field — see ecoLookup
let _ecoPending = null; // the in-flight promise, so forty games ask once
let _ecoFailed = false;
/* Bumped whenever the table changes, so everything cached off it falls at once — the
   per-game opening below and the review's own signature both read it. */
let _ecoEpoch = 0;

/** Tests hand the table in; the app fetches it. Passing null unloads it. */
export function setEcoTable(table) {
  _eco = table && typeof table === 'object' ? table : null;
  _ecoNoEp = null;
  _ecoEpoch++;
  if (_eco) {
    _ecoNoEp = {};
    for (const k of Object.keys(_eco)) _ecoNoEp[k.split(' ').slice(0, 3).join(' ')] = _eco[k];
  }
  _ecoPending = null; _ecoFailed = false;
}
export function ecoLoaded() { return !!_eco; }

export function loadEcoTable() {
  if (_eco) return Promise.resolve(_eco);
  if (_ecoPending) return _ecoPending;
  if (_ecoFailed || typeof fetch !== 'function') return Promise.resolve(null);
  _ecoPending = fetch(ECO_URL)
    .then(r => (r.ok ? r.json() : null))
    .then(t => { setEcoTable(t); if (!_eco) _ecoFailed = true; return _eco; })
    // A missing table is a game with no opening name, which is where the app was before.
    .catch(() => { _ecoFailed = true; return null; });
  return _ecoPending;
}

function epdOf(fen) { return String(fen || '').split(' ').slice(0, 4).join(' '); }

/*
 * {eco, name} for one position, or null — null too while the table is not loaded.
 *
 * The table writes the en-passant square after every double pawn step ("e3" after 1.e4);
 * chess.js writes "-" unless a capture is actually possible. Same position, two strings,
 * and 1.e4 e5 would never be book. So the exact EPD is tried first and the field is
 * dropped second — the fields that make the position (placement, side, castling) are kept.
 */
export function ecoLookup(fen) {
  if (!_eco || !fen) return null;
  const epd = epdOf(fen);
  const hit = _eco[epd] || _ecoNoEp[epd.split(' ').slice(0, 3).join(' ')];
  return hit ? { eco: hit.slice(0, 3), name: hit.slice(4) } : null;
}

/*
 * Move n was played inside the book: it comes before the ply the game left it on.
 *
 * Cut on the exit ply rather than asked of each position, because the table is a list of
 * named *lines* and so has holes — 5…d6 in the Giuoco Pianissimo reaches a position no
 * line happens to name, sitting between two positions that are named. A single move
 * demoted out of the book between two that stayed in is an artefact of the table, not
 * something that happened at the board, and it would make the card's `book` count
 * disagree with the opening phase the same exit ply cuts.
 */
function inBook(game, n) {
  const op = openingOf(game);
  return !!(op && op.exitPly && n < op.exitPly);
}

/*
 * The opening from the PGN's own headers — Chess.com's ECOUrl slug carries the line and
 * so the exit ply; Lichess's plain Opening header lands at zero and says nothing about
 * where book ended. Fallback only: the table wins wherever it has an answer.
 */
export function headerOpening(headers) {
  const h = headers || {};
  const eco = h.ECO && h.ECO !== '?' ? h.ECO : null;
  const url = h.ECOUrl || '';
  if (url) {
    const slug = url.split('/').filter(Boolean).pop() || '';
    // The line begins at a numbered move starting its own token ("-4.Bc4") or at the
    // "..." welding it to the name, whichever comes first. A bare number inside the name
    // ("with-1-e4") is not a boundary.
    const numMatch = slug.match(/(?:^|-)\d+\./);
    const dots = slug.indexOf('...');
    let cut = numMatch ? numMatch.index + (numMatch[0][0] === '-' ? 1 : 0) : -1;
    if (dots !== -1 && (cut === -1 || dots < cut)) cut = dots;
    const words = (cut === -1 ? slug : slug.slice(0, cut)).split('-').filter(Boolean);
    let name = '';
    words.forEach((w, i) => {
      const isNum = /^\d+$/.test(w) && i < words.length - 1;
      name += (name && !name.endsWith('.') ? ' ' : '') + w + (isNum ? '.' : '');
    });
    name = name.trim();
    if (name) {
      let ply = 0;
      if (cut !== -1) {
        for (const t of slug.slice(cut).replace(/^\.+/, '').split('-')) {
          const m = t.match(/^(\d+)(\.{1,3})/);
          if (m) ply = m[2] === '...' ? +m[1] * 2 : +m[1] * 2 - 1;
          else if (!/^[O0]$/.test(t)) ply++;   // the trailing halves of O-O are not moves
        }
      }
      return { eco, name, exitPly: ply || null };
    }
  }
  if (h.Opening && h.Opening !== '?') return { eco, name: h.Opening, exitPly: null };
  return eco ? { eco, name: null, exitPly: null } : null;
}

/*
 * {eco, name, exitPly} — the deepest position the table names, because every game passes
 * through 1.e4 and naming it "King's Pawn Opening" is true and useless. exitPly is the
 * index of the last named position: moves 0..exitPly-1 were book, moves[exitPly] left it.
 * Null exitPly means nobody knows where book ended.
 */
export function gameOpening(game) {
  if (!game || !game.fens) return null;
  const header = headerOpening(game.headers);
  if (_eco) {
    const top = Math.min(ECO_MAX_PLY, game.fens.length - 1);
    for (let ply = top; ply >= 1; ply--) {
      const hit = ecoLookup(game.fens[ply]);
      if (hit) return { eco: hit.eco, name: hit.name, exitPly: ply };
    }
  }
  return header;
}

/*
 * gameOpening() cached on the game. reviewClass() asks per ply and the answer is thirty
 * table lookups, so a review of a hundred-ply game would otherwise scan the table three
 * thousand times. Keyed on the table's epoch, so a review taken before the table landed
 * is not the one the card settles on.
 */
function openingOf(game) {
  if (game._openingSig === _ecoEpoch) return game._opening;
  const op = gameOpening(game);
  game._openingSig = _ecoEpoch;
  game._opening = op;
  return op;
}

/* ===== Accuracy ===== */

/*
 * One move's accuracy on Lichess's published curve. Only losses count: a move that
 * improves the evaluation is not more than perfect, and a curve that rewarded it would
 * pay for the opponent's mistakes.
 */
export function moveAccuracy(winBefore, winAfter) {
  const drop = Math.max(0, winBefore - winAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length);
}

/*
 * A game's accuracy from its moves' — Lichess's aggregate, for the reason the curve is.
 *
 * A plain mean is wrong in a way that matters: most games are decided in a handful of
 * sharp positions surrounded by fifty moves nobody could get wrong, and averaging those
 * flat hands a 95% to somebody who threw the game away once. So each move is weighted
 * by how volatile the win probability was around it — the moves that mattered count for
 * more — and that weighted mean is averaged with the harmonic mean, which punishes one
 * catastrophe rather than diluting it. Because it is non-linear, an archive's accuracy
 * is the mean of its games' figures, never this over the concatenated moves; the test
 * shows the two differ.
 *
 * @param accs  per-move accuracies for one player
 * @param wins  that player's win probability *before* each of those moves
 */
export function aggregateAccuracy(accs, wins) {
  const n = accs.length;
  if (!n) return null;
  const span = Math.max(2, Math.min(8, Math.ceil(n / 10)));
  let wSum = 0, wAcc = 0, hSum = 0;
  for (let i = 0; i < n; i++) {
    const slice = wins.slice(Math.max(0, i - span + 1), i + 2);
    // Floored: a weight of zero would delete a quiet move rather than count it for little.
    const w = Math.max(0.5, stdev(slice));
    wSum += w; wAcc += w * accs[i];
    hSum += 1 / Math.max(accs[i], 1);
  }
  return (wAcc / wSum + n / hSum) / 2;
}

/* ===== Phases ===== */

function nonPawnPoints(fen, white) {
  let total = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = POINTS[ch.toLowerCase()];
    if (v && (ch === ch.toUpperCase()) === white) total += v;
  }
  return total;
}
export function isEndgame(fen) { return nonPawnPoints(fen, true) <= ENDGAME_POINTS && nonPawnPoints(fen, false) <= ENDGAME_POINTS; }

/**
 * Where the phases cut, as {opening, endgame}: move n is in the opening while
 * n < opening, in the endgame from n >= endgame. The opening ends where the book did —
 * the table's exit ply, else the header's, else ply 20.
 */
export function gamePhases(game) {
  const op = openingOf(game);
  const plies = game.moves.length;
  const opening = Math.min(plies, (op && op.exitPly) || OPENING_FALLBACK_PLY);
  let endgame = plies;
  for (let ply = opening; ply < plies; ply++) {
    if (isEndgame(game.fens[ply])) { endgame = ply; break; }
  }
  return { opening, endgame: Math.max(opening, endgame) };
}
function phaseAt(n, b) { return n < b.opening ? 'opening' : n < b.endgame ? 'middlegame' : 'endgame'; }

/* ===== The review ===== */

function reviewSig(game) {
  const a = game.analysis;
  return [a.done | 0, a.altsDone ? 1 : 0, _ecoEpoch].join(':');
}

/**
 * One game reduced to the numbers a review is made of, both players at once. Cached on
 * the game and keyed on how much analysis existed when it was built — the scan's done
 * count, whether the second pass has landed, whether the opening table has — so a review
 * taken halfway through a scan is replaced rather than believed. null when the game has
 * no analysis at all; partial while a scan runs, and says so in `complete`.
 */
export function gameReview(game) {
  const a = game && game.analysis;
  if (!a || !Array.isArray(a.evals) || !game.moves || !game.moves.length) return null;
  const sig = reviewSig(game);
  if (game._review && game._review.sig === sig) return game._review;

  const bounds = gamePhases(game);
  const side = () => ({ accs: [], wins: [], phases: { opening: { accs: [], wins: [] }, middlegame: { accs: [], wins: [] }, endgame: { accs: [], wins: [] } } });
  const sides = { w: side(), b: side() };
  const counts = { w: {}, b: {} };
  for (const c of ['w', 'b']) for (const t of REVIEW_WORDS) counts[c][t] = 0;
  const plies = [];
  const swings = [];

  for (let n = 0; n < game.moves.length; n++) {
    if (!judged(game, n)) continue;
    const mv = game.moves[n];
    const white = mv.color === 'w';
    const before = moverWin(game, n, white), after = moverWin(game, n + 1, white);
    const acc = moveAccuracy(before, after);
    const tier = reviewClass(game, n);
    const s = sides[mv.color];
    const ph = s.phases[phaseAt(n, bounds)];
    s.accs.push(acc); s.wins.push(before);
    ph.accs.push(acc); ph.wins.push(before);
    if (tier) { counts[mv.color][tier]++; plies[n] = tier; }
    // A moment is an error with a swing behind it: how much of the game the move gave
    // away, in win probability, from the mover's side. Errors only — a swing on a fine
    // move is two searches disagreeing, not the game turning.
    if (tier && ERROR_WORDS.includes(tier)) swings.push({ ply: n, tier, color: mv.color, swing: Math.max(0, before - after), loss: moveLoss(game, n) });
  }
  swings.sort((x, y) => y.swing - x.swing || x.ply - y.ply);

  const agg = s => aggregateAccuracy(s.accs, s.wins);
  const phases = {};
  for (const ph of ['opening', 'middlegame', 'endgame']) {
    phases[ph] = { w: agg(sides.w.phases[ph]), b: agg(sides.b.phases[ph]), moves: sides.w.phases[ph].accs.length + sides.b.phases[ph].accs.length };
  }
  const out = {
    sig, complete: analysisReady(game), judged: sides.w.accs.length + sides.b.accs.length,
    accuracy: { w: agg(sides.w), b: agg(sides.b) },
    plies, phases, bounds,
    moments: swings.slice(0, 3),
    opening: openingOf(game),
    counts,
  };
  game._review = out;
  return out;
}

/* ===== Speech ===== */

/**
 * "Mistake. The engine preferred knight f3." — the three-word verdict, then the move the
 * engine wanted, said the way a commentator says it. Empty when the move was fine or
 * unjudged, so a caller can speak it unconditionally.
 */
export function verdictSpeech(game, n) {
  const tier = classifyMove(game, n);
  if (!tier) return '';
  const word = tier[0].toUpperCase() + tier.slice(1) + '.';
  const best = game.analysis.best && game.analysis.best[n];
  if (!best) return word;
  let bm = null;
  try { bm = new Chess(game.fens[n]).move({ from: best.slice(0, 2), to: best.slice(2, 4), promotion: best[4] }); } catch (e) { bm = null; }
  if (!bm) return word;
  const said = moveToSpeech(bm, 'natural').replace(/\.$/, '');
  return word + ' The engine preferred ' + said[0].toLowerCase() + said.slice(1) + '.';
}

/* ===== The card and the chips ===== */

/*
 * The tree wears the review's words once the scan is complete; while it is running the
 * three-word vocabulary stands in, because a partial review would say `book` and `best`
 * of the analysed half and nothing of the rest, and a tree that changes its vocabulary
 * at ply 40 mid-scan is a tree the reader cannot read.
 */
function treeMark(game, n) {
  if (!game || !game.analysis) return null;
  if (analysisReady(game)) { const r = gameReview(game); return (r && r.plies[n]) || null; }
  return classifyMove(game, n);
}

const pct = v => (v === null || v === undefined ? '—' : v.toFixed(1) + '%');
const momentTitle = (game, m) => LABEL[m.tier] + ' · ' + (m.tier === 'miss' ? 'gave up a win' : '−' + (m.swing).toFixed(0) + '% for ' + (m.color === 'w' ? 'White' : 'Black'));
const momentText = (game, m) => moveNumberLabel(m.ply) + ' ' + game.moves[m.ply].san;
const chipClass = m => 'chip rev-chip rev-' + m.tier + (m.tier === 'blunder' || m.tier === 'miss' ? ' chip-danger' : '');
function momentChip(game, m) {
  return '<button type="button" class="' + chipClass(m) + '" data-ply="' + (m.ply + 1) + '" title="' + escHtml(momentTitle(game, m)) + '">' +
    '<span class="san">' + escHtml(momentText(game, m)) + '</span><span class="rev-mark">' + (TREE_MARKS[m.tier] || '') + '</span></button>';
}

function ensureCard() {
  const mount = $('review-mount');
  if (!mount) return null;
  let sec = $('review-section');
  if (!sec) {
    sec = document.createElement('section');
    sec.className = 'panel hidden';
    sec.id = 'review-section';
    sec.innerHTML = '<header class="panel-head"><h2>Review</h2><span class="muted" id="review-note"></span></header><div class="panel-body" id="review-body"></div>';
    mount.appendChild(sec);
    sec.addEventListener('click', onChip);
  }
  return sec;
}

/* A chip is a door to a position: the move's own ply, then the board back on screen. */
function onChip(e) {
  const b = e.target.closest('[data-ply]');
  if (!b) return;
  goToPly(+b.dataset.ply);
  showBoard();
}

let _cardSig = '', _stripSig = '';

/*
 * Guarded on a signature rather than redrawn on every call: cr:analysis fires once per
 * committed ply and this is a table, so a scan of a long game would otherwise rebuild
 * the card two hundred times while the reader watched. The signature is everything the
 * card is made of.
 */
function paint() {
  const sec = ensureCard();
  const strip = $('turn-strip');
  const game = currentGame();
  const review = game ? gameReview(game) : null;

  // The chips: only while Listen holds the board. Another room's score has its own header.
  if (strip) {
    const stripSig = review && stageOwner() === 'play' ? game.id + ':' + review.sig + ':' + review.moments.map(m => m.ply).join(',') : '';
    if (stripSig !== _stripSig) {
      _stripSig = stripSig;
      strip.innerHTML = stripSig ? review.moments.map(m => momentChip(game, m)).join('') : '';
    }
  }

  if (!sec) return;
  if (!review) { sec.classList.add('hidden'); _cardSig = ''; return; }
  sec.classList.remove('hidden');

  // The table is what the review asks for, so the review is what fetches it — and once,
  // the moment a reviewed game is on screen, never at boot.
  if (!_eco && !_ecoPending && !_ecoFailed) {
    loadEcoTable().then(t => { if (t) { renderBoard(); paint(); } });
  }

  const sig = game.id + ':' + review.sig;
  if (sig === _cardSig) return;
  _cardSig = sig;

  const h = game.headers || {};
  const names = { w: (h.White && h.White !== '?' ? h.White : 'White').trim(), b: (h.Black && h.Black !== '?' ? h.Black : 'Black').trim() };
  let html = '<div class="stat-row rev-sides">';
  for (const c of ['w', 'b']) {
    html += '<div class="stat-tile"><span class="stat">' + pct(review.accuracy[c]) + '</span><span class="label">' + escHtml(names[c]) + '</span></div>';
  }
  html += '</div>';

  html += '<table class="rev-counts"><thead><tr><th>Move</th><th>' + escHtml(names.w) + '</th><th>' + escHtml(names.b) + '</th></tr></thead><tbody>';
  for (const t of REVIEW_WORDS) {
    const wn = review.counts.w[t], bn = review.counts.b[t];
    html += '<tr><th class="rev-' + t + '">' + LABEL[t] + (TREE_MARKS[t] ? ' <span class="rev-mark">' + TREE_MARKS[t] + '</span>' : '') + '</th>' +
      '<td class="num' + (wn ? '' : ' rev-zero') + '">' + wn + '</td><td class="num' + (bn ? '' : ' rev-zero') + '">' + bn + '</td></tr>';
  }
  html += '</tbody></table>';

  // Only the phases the game reached: a twenty-move miniature has no endgame, and a row
  // of dashes for it is furniture.
  const reached = ['opening', 'middlegame', 'endgame'].filter(ph => review.phases[ph].moves);
  if (reached.length > 1) {
    html += '<div class="rev-block"><h3>By phase</h3><table class="rev-counts"><tbody>';
    for (const ph of reached) {
      html += '<tr><th>' + ph[0].toUpperCase() + ph.slice(1) + '</th><td class="num">' + pct(review.phases[ph].w) + '</td><td class="num">' + pct(review.phases[ph].b) + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }

  html += '<div class="rev-block"><h3>Where it turned</h3>';
  html += review.moments.length
    ? '<div class="rev-moments">' + review.moments.map(m => momentChip(game, m)).join('') + '</div>'
    : '<p class="rev-sentence">Nobody gave anything away — there is no moment to point at.</p>';
  html += '</div>';

  const op = review.opening;
  if (op && op.name) {
    // exitPly is the last named position, so moves before it were book and the first new
    // move is the one at that index; its move number is floor(exitPly / 2) + 1.
    html += '<p class="rev-sentence rev-opening">' + escHtml(op.name) + (op.eco ? ' <span class="rev-eco">' + escHtml(op.eco) + '</span>' : '') +
      (op.exitPly ? ', left at move ' + (Math.floor(op.exitPly / 2) + 1) : '') + (_eco ? '' : ' — named from the PGN; the opening table is on its way') + '.</p>';
  } else if (!_eco) {
    html += '<p class="rev-sentence">The opening will be named when the table lands.</p>';
  }
  $('review-body').innerHTML = html;
  // Said where the numbers are: an accuracy over a scan that has not finished is a
  // different figure from the one the card will settle on, and the difference is invisible.
  const note = $('review-note');
  if (note) note.textContent = review.complete ? '' : 'Analysing… figures will move.';
}

function repaint(e) {
  const g = e && e.detail && e.detail.game;
  if (g && g !== currentGame()) return;
  renderBoard();   // the tree's marks read the same review
  paint();
}

export function boot() {
  setTreeMark(treeMark);
  /*
   * The spoken half of the same judgement. verdictSpeech() answers '' for anything
   * classifyMove() will not name, so the reading says nothing about a fine move and
   * nothing about a forced recapture — the guard is the whole point of installing this
   * function rather than the review's wider vocabulary, which would have the reading
   * announce "Book" and "Excellent" after every move in the game.
   */
  setVerdictSpeech(verdictSpeech);
  if (typeof document === 'undefined') return;
  const strip = $('turn-strip');
  if (strip) strip.addEventListener('click', onChip);
  for (const ev of ['cr:analysis', 'cr:analysis-done', 'cr:alts-done']) document.addEventListener(ev, repaint);
  onRender('all', paint);
  onRender('board', paint);   // the stage changes owner without an 'all' repaint
  paint();
}
