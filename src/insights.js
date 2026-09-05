/*
 * Insights (§6): eight panes of arithmetic over the loaded games. Nothing here is
 * fetched or uploaded, and the one row this module ever writes is which
 * recommendations the reader waved away. Every figure is a read over `games` through
 * gameFacts(), and every pane is a pure function of (games, heroKey) — which is what
 * lets Prep point renderReport() at an opponent's archive and get the same report in
 * the third person.
 *
 * The subject is inferred, never configured: a PGN carries no "you". resolveHero()
 * takes the name that appears in the most games, the remembered handle breaks a tie,
 * and a picker in the room header overrides both. Changing it drops every cache,
 * because everything on the page derives from that one choice.
 *
 * The engine-fed half (the clock's cost, the pattern report, the recommendations,
 * form's accuracy) paints twice: from the headers on arrival, and again when
 * `cr:analysis-done` lands. Each of those paints goes through a per-pane generation
 * counter so a repaint that was queued first cannot land over one queued later.
 */
import { S, saveSettings } from './state.js';
import { $, escHtml, emptyHTML, plural, fmtDate } from './dom.js';
import { registerRoom, navigate, currentRoom } from './route.js';
import { stageClaim, stageRelease, moveRunHTML } from './render.js';
import { setGame } from './playback.js';
import { moveNumberLabel } from './pgn.js';
import { dbGet, dbPut } from './memory.js';
import { speak } from './speech/provider.js';
import * as review from './review.js';

/* ===== Constants: each one is an argument, and the argument sits beside it ===== */

export const EXPLORER_MAX_PLY = 12;   // six moves each: where a repertoire is still a repertoire
/*
 * Time trouble is the last tenth of THAT game's own base clock, never a number of
 * seconds. A minute is the whole game in bullet and nothing in classical, so a fixed
 * threshold would report the time control rather than the habit.
 */
export const TROUBLE_FRACTION = 0.1;
/* The three annotators' thresholds — conventional on purpose, so a reader who has seen
   chess.com's numbers does not have to learn ours. Used only when review.js is absent. */
export const SWING = { inaccuracy: 50, mistake: 100, blunder: 300 };
/*
 * Per-move loss is floored at zero AND capped. A mate escaped is a difference of about
 * 99,000 with a sign on it; one of those in a bucket is the whole of that bucket's mean,
 * and a negative mean says the mover gained material by moving. Ten pawns is where a
 * game stops being a game.
 */
export const LOSS_CAP = 1000;
/* Two floors and a depth, and they are the honesty of the pattern report rather than
   tuning: a node has to be somewhere the reader actually goes (three games), the errors
   under it have to be a habit rather than an afternoon (three), and the root is not an
   opening — two plies is the shallowest thing that names a line at all. */
export const PATTERN_MIN_GAMES = 3;
export const PATTERN_MIN_ERRORS = 3;
export const PATTERN_MIN_PLIES = 2;
/*
 * Every recommendation generator sits behind one of these. Advice is the strongest
 * register the app speaks in, and advice drawn from six games is a horoscope; a
 * generator that cannot clear its floor writes nothing.
 */
export const FLOORS = {
  colour: 20,      // games as EACH colour before a gap is about the colour
  clocked: 15,     // analysed games that carry a clock before time trouble has a cost
  bandMoves: 20,   // moves on each side of a clock comparison
  tilt: 10,        // games on each side of the tilt comparison
  line: 8,         // games through an opening line before its error rate is a finding
  lineRatio: 1.5,  // ...and how far above the baseline it has to sit
  endings: 10,     // losses before how they end is a habit
  collapse: 10,    // analysed games before thrown-away wins are counted
  habit: 5,        // a bucket below this is a coincidence with a percentage on it
  compare: 5,      // games on each side of a comparison
};
const TILT_WINDOW_MS = 20 * 60 * 1000;   // "started within twenty minutes of finishing a loss"
const FORM_LAST = 10;                    // ten results is the run a player reads at a glance
const ROLL_WINDOW = 20;                  // at ten, one bad evening is a cliff in the curve
const OPP_ROWS = 6;
const DAY_PARTS = [
  { key: 'morning', label: 'Morning', spoken: 'in the morning', from: 5, to: 12 },
  { key: 'afternoon', label: 'Afternoon', spoken: 'in the afternoon', from: 12, to: 18 },
  { key: 'evening', label: 'Evening', spoken: 'in the evening', from: 18, to: 23 },
  { key: 'night', label: 'Late night', spoken: 'late at night', from: 23, to: 5 },
];
/* Widening bands, because the difference that matters is between one second and five,
   not between sixty and sixty-five. */
const TIME_BANDS = [
  { label: 'Under 1s', spoken: 'under a second', hi: 1 },
  { label: '1–3s', spoken: 'one to three seconds', hi: 3 },
  { label: '3–10s', spoken: 'three to ten seconds', hi: 10 },
  { label: '10–30s', spoken: 'ten to thirty seconds', hi: 30 },
  { label: 'Over 30s', spoken: 'more than thirty seconds', hi: Infinity },
];
const ENDING_LABEL = {
  checkmate: 'checkmate', resignation: 'resignation', time: 'on time', stalemate: 'stalemate',
  repetition: 'repetition', agreement: 'agreement', insufficient: 'insufficient material',
  'fifty-move': 'the fifty-move rule', abandonment: 'abandonment', draw: 'a draw',
};
const CLASS_LABEL = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', daily: 'Daily' };
const RESULT_WORD = { w: 'win', d: 'draw', l: 'loss' };

/* ===== Small arithmetic ===== */

/** The player key: lowercased, trimmed. '?' is PGN for "nobody", so it is nobody. */
export function playerKey(name) {
  const k = String(name || '').trim().toLowerCase();
  return k === '?' ? '' : k;
}
const newTally = () => ({ n: 0, w: 0, d: 0, l: 0 });
function addTally(t, result) { t.n++; t[result]++; }
/** A draw is half a point, so a record is a score and not a win rate. */
export function scorePct(t) { return t.n ? (t.w + t.d / 2) / t.n * 100 : 0; }
/* An em dash, not 0%, for a tally with nothing in it: "0%" for a colour never played is
   the same confident falsehood the eval bar refuses to tell about an unreached ply. */
const scoreStr = t => (t.n ? Math.round(scorePct(t)) + '%' : '—');
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(list) {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function fmtSecs(s) {
  const n = Math.round(s);
  if (n < 90) return n + 's';
  const m = Math.floor(n / 60), rest = n % 60;
  return m + 'm' + (rest ? ' ' + rest + 's' : '');
}
const pawns = cp => (cp / 100).toFixed(2);
const num = v => '<strong class="num">' + escHtml(String(v)) + '</strong>';

/* ===== Whose games these are ===== */

/** Every name in the headers with how many games it appears in, most frequent first. */
export function heroCandidates(games) {
  const seen = new Map();
  for (const g of games || []) {
    for (const side of ['White', 'Black']) {
      const raw = String((g.headers || {})[side] || '').trim();
      const key = playerKey(raw);
      if (!key) continue;
      const e = seen.get(key) || { name: raw, key, n: 0 };
      e.n++;
      seen.set(key, e);
    }
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/**
 * The subject: the name in the most games. S.heroOverride wins when it names someone
 * present; a tie at the top is broken by the remembered Chess.com / Lichess handle.
 */
export function resolveHero(games) {
  const cands = heroCandidates(games);
  if (!cands.length) return null;
  if (S.heroOverride) {
    const picked = cands.find(c => c.key === S.heroOverride);
    if (picked) return { name: picked.name, key: picked.key };
  }
  const remembered = [S.chesscomUser, S.lichessUser].map(playerKey).filter(Boolean);
  const tied = cands.filter(c => c.n === cands[0].n);
  const pick = tied.find(c => remembered.includes(c.key)) || tied[0];
  return { name: pick.name, key: pick.key };
}

/* ===== One game, reduced to what a record is made of ===== */

/*
 * Both sites derive the class from base plus forty increments, and reading the header
 * rather than the site's own label is what lets a Lichess or hand-pasted PGN land in the
 * right row. Correspondence is written "1/259200" — one move per N seconds.
 */
export function timeClassOf(tc) {
  tc = String(tc || '').trim();
  if (!tc || tc === '-' || tc === '?') return null;
  if (tc.includes('/')) return 'daily';
  const base = parseInt(tc, 10);
  if (!Number.isFinite(base)) return null;
  const inc = parseInt(tc.split('+')[1], 10) || 0;
  const total = base + 40 * inc;
  return total < 180 ? 'bullet' : total < 600 ? 'blitz' : total < 1800 ? 'rapid' : 'classical';
}

/** {base, inc} in seconds, or null. Daily is null outright: time trouble is not a thing
 *  that happens at three days a move, and its readings would swamp every figure here. */
export function timeBudget(game) {
  const tc = String((game.headers || {}).TimeControl || '').trim();
  if (!tc || tc === '-' || tc === '?' || tc.includes('/')) return null;
  const base = parseInt(tc, 10);
  if (!Number.isFinite(base) || base <= 0) return null;
  return { base, inc: parseInt(tc.split('+')[1], 10) || 0 };
}

/** How the game ended, as one word, from Termination and the result; null when unrecorded. */
export function endingOf(game) {
  const h = game.headers || {};
  const t = String(h.Termination || '').toLowerCase();
  const timed = t.includes('on time') || t.includes('time forfeit') || t.includes('timeout');
  if (t.includes('resign')) return 'resignation';
  if (t.includes('insufficient')) return 'insufficient';
  if (timed) return 'time';
  // Stalemate before the bare 'mate' fallback: "Game drawn by stalemate" contains
  // "mate", and filed as a checkmate it is a decisive ending sitting in the draws.
  if (t.includes('stalemate')) return 'stalemate';
  if (t.includes('checkmate') || t.includes('mate')) return 'checkmate';
  if (t.includes('agree')) return 'agreement';
  if (t.includes('repetition')) return 'repetition';
  if (t.includes('50') || t.includes('fifty')) return 'fifty-move';
  if (t.includes('abandon')) return 'abandonment';
  const last = game.moves && game.moves[game.moves.length - 1];
  if (last && String(last.san).includes('#')) return 'checkmate';
  if (h.Result === '1/2-1/2') return 'draw';
  return null;
}
export function endingLabel(key) { return ENDING_LABEL[key] || 'unrecorded'; }

/*
 * A PGN's date and time as an instant. Both sites write UTC in the same two-header
 * shape. The time is matched whole rather than by prefix: a stamp carrying a zone name
 * is not the UTC this would silently read it as, and being an hour out is exactly the
 * error nothing downstream could detect. 0 means "cannot be placed".
 */
function stampMs(dateStr, timeStr) {
  const d = String(dateStr || '').trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  const t = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!d || !t || d[1] === '0000') return 0;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], +t[3]);
}
/* A date with no time is placed at noon UTC so it sorts among its day, and carries no
   hour: the habit panes ask `timed` before they read one. */
function dayMs(dateStr) {
  const d = String(dateStr || '').trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!d || d[1] === '0000') return 0;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], 12);
}
function startOf(h) {
  let ms = stampMs(h.UTCDate || h.Date, h.UTCTime || h.Time || h.StartTime);
  if (ms) return { ms, timed: true };
  ms = stampMs(h.EndDate || h.UTCDate || h.Date, h.EndTime);
  if (ms) return { ms, timed: true };
  ms = dayMs(h.UTCDate || h.Date);
  return ms ? { ms, timed: false } : { ms: 0, timed: false };
}

function heroColor(game, heroKey) {
  const h = game.headers || {};
  if (playerKey(h.White) === heroKey) return 'w';
  if (playerKey(h.Black) === heroKey) return 'b';
  return null;
}

/**
 * Null means the game has no bearing on this record: the subject did not play in it, or
 * it has no result. Dropping those rather than filing them somewhere is why every card
 * says how many of the loaded games it counted. Cached on the game, keyed by hero.
 */
export function gameFacts(game, heroKey) {
  if (!game || !heroKey) return null;
  const c = game._facts;
  if (c && c.key === heroKey) return c.facts;
  const facts = computeFacts(game, heroKey);
  game._facts = { key: heroKey, facts };
  return facts;
}

function computeFacts(game, heroKey) {
  const h = game.headers || {};
  const color = heroColor(game, heroKey);
  if (!color) return null;
  const r = h.Result;
  let result;
  if (r === '1-0') result = color === 'w' ? 'w' : 'l';
  else if (r === '0-1') result = color === 'b' ? 'w' : 'l';
  else if (r === '1/2-1/2') result = 'd';
  else return null;
  const elo = parseInt(h[color === 'w' ? 'WhiteElo' : 'BlackElo'], 10);
  const opp = parseInt(h[color === 'w' ? 'BlackElo' : 'WhiteElo'], 10);
  const start = startOf(h);
  const end = stampMs(h.EndDate || h.UTCDate || h.Date, h.EndTime);
  return {
    color, result,
    ending: endingOf(game),
    timeClass: timeClassOf(h.TimeControl),
    length: (game.moves || []).length,
    rating: Number.isFinite(elo) && elo > 0 ? elo : null,
    oppRating: Number.isFinite(opp) && opp > 0 ? opp : null,
    opponent: playerKey(h[color === 'w' ? 'Black' : 'White']) ? String(h[color === 'w' ? 'Black' : 'White']).trim() : '',
    date: start.ms || null,
    timed: start.timed,
    // A game that appears to end before it began crossed midnight without an EndDate;
    // its end cannot be placed, so it is not.
    endDate: end && end >= start.ms ? end : null,
    hourLocal: start.timed ? new Date(start.ms).getHours() : null,
  };
}

/* ===== The record ===== */

/** The record: every tally the first pane is drawn from. */
export function computeStats(games, heroKey) {
  const st = {
    total: (games || []).length, counted: 0,
    overall: newTally(), white: newTally(), black: newTally(),
    endings: { w: {}, d: {}, l: {} },
    controls: {},
    rating: null, length: null,
  };
  const ratings = [], lengths = [];
  (games || []).forEach((g, gi) => {
    const f = gameFacts(g, heroKey);
    if (!f) return;
    st.counted++;
    addTally(st.overall, f.result);
    addTally(f.color === 'w' ? st.white : st.black, f.result);
    const ek = f.ending || 'unrecorded';
    st.endings[f.result][ek] = (st.endings[f.result][ek] || 0) + 1;
    const ck = f.timeClass || 'unknown';
    if (!st.controls[ck]) st.controls[ck] = newTally();
    addTally(st.controls[ck], f.result);
    if (f.rating) ratings.push({ elo: f.rating, at: f.date || 0 });
    if (f.length) lengths.push({ gi, plies: f.length });
  });
  /*
   * A rating is only a trend if the games can be put in order; undated games count
   * towards the peak, which needs no order at all.
   */
  if (ratings.length) {
    const peak = Math.max(...ratings.map(r => r.elo));
    const dated = ratings.filter(r => r.at).sort((a, b) => a.at - b.at);
    st.rating = dated.length >= 2
      ? { peak, first: dated[0].elo, last: dated[dated.length - 1].elo, delta: dated[dated.length - 1].elo - dated[0].elo, n: ratings.length }
      : { peak, first: null, last: null, delta: 0, n: ratings.length };
  }
  if (lengths.length) {
    let total = 0, longest = lengths[0], shortest = lengths[0];
    for (const e of lengths) { total += e.plies; if (e.plies > longest.plies) longest = e; if (e.plies < shortest.plies) shortest = e; }
    st.length = { avg: total / lengths.length, longest, shortest };
  }
  return st;
}

/** The subject's dated games, oldest first: {gi, f}. Everything about a sequence reads this. */
export function orderedGames(games, heroKey) {
  const out = [];
  (games || []).forEach((g, gi) => {
    const f = gameFacts(g, heroKey);
    if (f && f.date) out.push({ gi, f });
  });
  return out.sort((a, b) => a.f.date - b.f.date);
}

/* ===== Form: results in the order they happened ===== */

export function formReport(games, heroKey) {
  const list = orderedGames(games, heroKey);
  if (!list.length) return null;
  const marks = list.map(e => e.f.result);
  const recent = list.slice(-FORM_LAST);
  const last = newTally();
  for (const e of recent) addTally(last, e.f.result);
  let run = { result: marks[marks.length - 1], n: 0 };
  for (let i = marks.length - 1; i >= 0 && marks[i] === run.result; i--) run.n++;
  const longest = res => { let best = 0, n = 0; for (const m of marks) { n = m === res ? n + 1 : 0; if (n > best) best = n; } return best; };
  let unbeaten = 0, u = 0;
  for (const m of marks) { u = m === 'l' ? 0 : u + 1; if (u > unbeaten) unbeaten = u; }
  /*
   * Score over a trailing window, one point per game once the window is full — and
   * nothing before that: a "rolling average" over the first four games is those four
   * games, and drawn it is noise that settles, which reads as improvement and is not.
   */
  let roll = null;
  if (list.length > ROLL_WINDOW) {
    const pts = marks.map(m => (m === 'w' ? 1 : m === 'd' ? 0.5 : 0));
    roll = [];
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      sum += pts[i];
      if (i >= ROLL_WINDOW) sum -= pts[i - ROLL_WINDOW];
      if (i >= ROLL_WINDOW - 1) roll.push(sum / ROLL_WINDOW * 100);
    }
  }
  const months = new Map();
  for (const e of list) {
    const d = new Date(e.f.date);
    const k = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    let t = months.get(k);
    if (!t) { t = newTally(); t.label = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }); months.set(k, t); }
    addTally(t, e.f.result);
  }
  return {
    n: list.length, marks, last, lastN: recent.length, run, roll,
    bestRun: longest('w'), worstRun: longest('l'), unbeaten,
    months: [...months.values()], from: list[0].f.date, to: list[list.length - 1].f.date,
  };
}

/* ===== The clock ===== */

/**
 * The clock readings off the RAW PGN — cleanPGN() strips `{[%clk …]}` on the way to a
 * move list. One reading per ply or none at all: a file whose count does not match has
 * variations or annotations in it, and a series a move out of step yields figures that
 * are wrong and plausible at once, so the game is dropped whole. Cached on the game.
 */
export function clockSeries(game) {
  if (!game) return null;
  if (game._clk !== undefined) return game._clk;
  const out = [];
  const re = /\[%clk\s+([\d:.]+)\]/g;
  let m;
  while ((m = re.exec(game.pgn || ''))) {
    let secs = 0, ok = true;
    for (const part of m[1].split(':')) {          // h:mm:ss, m:ss and bare seconds alike
      const n = Number(part);
      if (!Number.isFinite(n)) { ok = false; break; }
      secs = secs * 60 + n;
    }
    if (!ok) { out.length = 0; break; }
    out.push(secs);
  }
  game._clk = out.length && out.length === (game.moves || []).length ? out : null;
  return game._clk;
}

/**
 * Was the mover inside the last tenth of their clock at ply n? null — not false — when
 * there is no clock to ask, so an archive without clocks counts towards nothing rather
 * than towards "never in trouble".
 */
export function timeTrouble(game, ply) {
  const clocks = clockSeries(game);
  const tc = timeBudget(game);
  if (!clocks || !tc || !Number.isFinite(clocks[ply])) return null;
  return clocks[ply] <= tc.base * TROUBLE_FRACTION;
}

/* ===== The engine's numbers, read off game.analysis ===== */

export function evalToCp(ev) {
  if (!ev) return null;
  if (ev.mate === undefined) return Number.isFinite(ev.cp) ? ev.cp : null;
  const sign = ev.mate >= 0 ? 1 : -1;
  return sign * (100000 - Math.min(Math.abs(ev.mate), 200) * 100);
}
/** White's winning chances, 0..100 — the Lichess curve. */
export function winProb(cp) {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}
/** Whether the engine has read this whole game. */
export function analysed(game) {
  const a = game && game.analysis;
  if (!a || !Array.isArray(a.evals)) return false;
  const need = (game.fens || []).length;
  return a.done !== undefined ? a.done >= need : a.evals.filter(Boolean).length >= need;
}
function judged(game, n) {
  const a = game && game.analysis;
  return !!(a && a.evals && game.moves[n] && a.evals[n] && a.evals[n + 1]);
}

/*
 * The local fallback for review.js's moveLoss(): the mover's loss in centipawns, floored
 * at zero AND capped at LOSS_CAP, null when the engine would have played the move itself
 * (two depth-limited searches drift a little, and a forced recapture must not pick up
 * 200cp of drift and be called a mistake). review.js's guarded version is preferred
 * whenever it is present — and caps in the same place, so the two agree.
 */
export function moveLossLocal(game, n) {
  if (!judged(game, n)) return null;
  const before = evalToCp(game.analysis.evals[n]), after = evalToCp(game.analysis.evals[n + 1]);
  if (before === null || after === null) return null;
  const played = game.moves[n];
  const best = game.analysis.best && game.analysis.best[n];
  if (best && best.slice(0, 4) === played.from + played.to) return null;
  return Math.max(0, Math.min(LOSS_CAP, played.color === 'w' ? before - after : after - before));
}
function classifyLocal(game, n) {
  const loss = moveLossLocal(game, n);
  if (loss === null) return null;
  return loss >= SWING.blunder ? 'blunder' : loss >= SWING.mistake ? 'mistake' : loss >= SWING.inaccuracy ? 'inaccuracy' : null;
}
const lossFn = () => (typeof review.moveLoss === 'function' ? review.moveLoss : moveLossLocal);
/** 'inaccuracy' | 'mistake' | 'blunder' | null — review's when it exists, else the local read. */
export function classify(game, n) {
  return (typeof review.classifyMove === 'function' ? review.classifyMove : classifyLocal)(game, n);
}
/** What ply n cost the mover, floored at 0 and capped; null when the ply is not judged. */
export function plyLoss(game, n) {
  if (!judged(game, n)) return null;
  const raw = lossFn()(game, n);
  return raw === null ? 0 : Math.max(0, Math.min(LOSS_CAP, raw));
}
/** The accuracy of ply n from the mover's view (Lichess's curve), or null when unjudged. */
export function moveAccuracy(game, n) {
  if (!judged(game, n)) return null;
  const before = evalToCp(game.analysis.evals[n]), after = evalToCp(game.analysis.evals[n + 1]);
  if (before === null || after === null) return null;
  const white = game.moves[n].color === 'w';
  const wb = white ? winProb(before) : 100 - winProb(before);
  const wa = white ? winProb(after) : 100 - winProb(after);
  if (wa >= wb) return 100;
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * (wb - wa)) - 3.1669));
}
/** One game's accuracy for one colour: the mean over its judged plies. Cached on the game. */
export function gameAccuracy(game, color) {
  if (!analysed(game)) return null;
  if (game._acc && game._acc[color] !== undefined) return game._acc[color];
  let sum = 0, n = 0;
  for (let p = color === 'w' ? 0 : 1; p < game.moves.length; p += 2) {
    const a = moveAccuracy(game, p);
    if (a !== null) { sum += a; n++; }
  }
  const out = n ? { accuracy: sum / n, moves: n } : null;
  game._acc = Object.assign(game._acc || {}, { [color]: out });
  return out;
}
/*
 * Accuracy is aggregated per game and then averaged across games, never by pooling the
 * archive's moves into one array: the mean of games is the figure a player recognises
 * (it is what their site reports), and a pooled mean lets one long game outvote ten.
 */
export function meanAccuracy(games, heroKey) {
  const accs = [];
  let moves = 0;
  for (const g of games || []) {
    const f = gameFacts(g, heroKey);
    if (!f) continue;
    const a = gameAccuracy(g, f.color);
    if (a) { accs.push(a.accuracy); moves += a.moves; }
  }
  return accs.length ? { accuracy: mean(accs), games: accs.length, moves } : null;
}

/**
 * The clock pane's numbers. Everything per game then averaged: the same-moves comparison
 * (moves made with under a tenth of the clock, against the rest) is a mean of per-game
 * means, so a bullet marathon cannot outvote the rest of the archive.
 */
export function clockReport(games, heroKey) {
  const side = () => ({ games: 0, moves: 0, accSum: 0, lossSum: 0, errors: 0, acc: null, loss: null });
  const r = {
    counted: 0, tagged: 0, clocked: 0, dropped: 0, moves: 0, low: 0,
    reached: newTally(), calm: newTally(), median: null, flag: {}, onTime: 0, losses: 0,
    analysed: 0, same: { low: side(), rest: side() }, bands: TIME_BANDS.map(b => Object.assign({ label: b.label, spoken: b.spoken }, side())),
  };
  const secs = [];
  for (const g of games || []) {
    const f = gameFacts(g, heroKey);
    if (!f) continue;
    r.counted++;
    if (f.result === 'l') { r.losses++; if (f.ending === 'time') { r.onTime++; const k = f.timeClass || 'unknown'; r.flag[k] = (r.flag[k] || 0) + 1; } }
    const tagged = /%clk/.test(g.pgn || '');
    if (tagged) r.tagged++;
    const clocks = clockSeries(g);
    if (tagged && !clocks) r.dropped++;
    const tc = timeBudget(g);
    if (!clocks || !tc) continue;
    r.clocked++;
    const read = analysed(g);
    if (read) r.analysed++;
    const per = { low: side(), rest: side() };
    const bands = TIME_BANDS.map(side);
    let anyLow = false;
    for (let n = f.color === 'w' ? 0 : 1; n < clocks.length; n += 2) {
      r.moves++;
      const low = clocks[n] <= tc.base * TROUBLE_FRACTION;
      if (low) { r.low++; anyLow = true; }
      // The reading after a move includes the increment just paid, so a move took the
      // difference plus the increment; without it a 3+2 game reads two seconds a move fast.
      const spent = (n >= 2 ? clocks[n - 2] : tc.base) + tc.inc - clocks[n];
      const sane = Number.isFinite(spent) && spent >= 0 && spent <= tc.base + tc.inc;
      if (sane) secs.push(spent);
      if (!read || !judged(g, n)) continue;
      const acc = moveAccuracy(g, n), loss = plyLoss(g, n), tier = classify(g, n);
      const bucket = low ? per.low : per.rest;
      bucket.moves++; bucket.accSum += acc; bucket.lossSum += loss; if (tier) bucket.errors++;
      if (sane) { const b = bands[TIME_BANDS.findIndex(t => spent < t.hi)]; b.moves++; b.accSum += acc; b.lossSum += loss; if (tier) b.errors++; }
    }
    addTally(anyLow ? r.reached : r.calm, f.result);
    const fold = (agg, one) => { if (!one.moves) return; agg.games++; agg.moves += one.moves; agg.errors += one.errors; agg.accSum += one.accSum / one.moves; agg.lossSum += one.lossSum / one.moves; };
    fold(r.same.low, per.low); fold(r.same.rest, per.rest);
    bands.forEach((b, i) => fold(r.bands[i], b));
  }
  const settle = s => { if (s.games) { s.acc = s.accSum / s.games; s.loss = s.lossSum / s.games; } };
  settle(r.same.low); settle(r.same.rest); r.bands.forEach(settle);
  r.median = median(secs);
  return r;
}

/* ===== Habits: tilt, the time of day, who you keep losing to ===== */

export function habitReport(games, heroKey) {
  const st = computeStats(games, heroKey);
  const list = orderedGames(games, heroKey);
  const afterLoss = newTally(), afterWin = newTally();
  let pairs = 0;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].f, cur = list[i].f;
    // Both stamps have to be real times: a date-only archive puts every game at noon and
    // would make every pair "twenty minutes apart".
    if (!cur.timed || !(prev.endDate || prev.timed)) continue;
    const gap = cur.date - (prev.endDate || prev.date);
    if (gap < 0 || gap > TILT_WINDOW_MS) continue;
    pairs++;
    if (prev.result === 'l') addTally(afterLoss, cur.result);
    else if (prev.result === 'w') addTally(afterWin, cur.result);
  }
  const parts = DAY_PARTS.map(p => Object.assign(newTally(), { part: p }));
  const hours = Array.from({ length: 24 }, newTally);
  for (const e of list) {
    const h = e.f.hourLocal;
    if (h === null || h === undefined) continue;
    const part = parts.find(t => (t.part.from < t.part.to ? h >= t.part.from && h < t.part.to : h >= t.part.from || h < t.part.to));
    addTally(part, e.f.result);
    addTally(hours[h], e.f.result);
  }
  const opp = new Map();
  for (const g of games || []) {
    const f = gameFacts(g, heroKey);
    if (!f || !f.opponent) continue;
    const k = playerKey(f.opponent);
    let t = opp.get(k);
    if (!t) { t = Object.assign(newTally(), { name: f.opponent }); opp.set(k, t); }
    addTally(t, f.result);
  }
  return {
    counted: st.counted, dated: list.length,
    tilt: pairs ? { afterLoss, afterWin, pairs } : null,
    day: parts.filter(t => t.n),
    hours: hours.some(t => t.n) ? hours : [],
    // Who you keep losing to, not who you have played most.
    opponents: [...opp.values()].filter(t => t.l).sort((a, b) => b.l - a.l || scorePct(a) - scorePct(b) || b.n - a.n).slice(0, OPP_ROWS),
    losses: st.overall.l, onTime: st.endings.l.time || 0,
  };
}

/* ===== Compare: the same record over two halves of the archive ===== */

/** The sets worth comparing: periods, time classes, colours and two-ply openings. */
export function compareSets(games, heroKey) {
  const rows = [];
  (games || []).forEach((g, gi) => { const f = gameFacts(g, heroKey); if (f) rows.push({ gi, f, g }); });
  const out = [];
  const add = (key, label, gis) => { if (gis.length >= FLOORS.compare) out.push({ key, label, gis }); };
  const dated = rows.filter(r => r.f.date).sort((a, b) => a.f.date - b.f.date);
  if (dated.length >= FLOORS.compare * 2) {
    const cut = dated.length >> 1;
    add('newer', 'Newer half (' + fmtDate(dated[cut].f.date) + ' on)', dated.slice(cut).map(r => r.gi));
    add('older', 'Older half (to ' + fmtDate(dated[cut - 1].f.date) + ')', dated.slice(0, cut).map(r => r.gi));
  }
  const years = new Map();
  for (const r of dated) { const y = new Date(r.f.date).getUTCFullYear(); if (!years.has(y)) years.set(y, []); years.get(y).push(r.gi); }
  for (const [y, gis] of [...years.entries()].sort((a, b) => b[0] - a[0])) add('year:' + y, String(y), gis);
  const classes = new Map();
  for (const r of rows) { const c = r.f.timeClass; if (!c) continue; if (!classes.has(c)) classes.set(c, []); classes.get(c).push(r.gi); }
  for (const [c, gis] of [...classes.entries()].sort((a, b) => b[1].length - a[1].length)) add('class:' + c, CLASS_LABEL[c], gis);
  add('color:w', 'As White', rows.filter(r => r.f.color === 'w').map(r => r.gi));
  add('color:b', 'As Black', rows.filter(r => r.f.color === 'b').map(r => r.gi));
  const lines = new Map();
  for (const r of rows) {
    if (r.g.moves.length < 2) continue;
    const k = r.f.color + ':' + r.g.moves[0].san + ' ' + r.g.moves[1].san;
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push(r.gi);
  }
  for (const [k, gis] of [...lines.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const [c, sans] = k.split(':');
    add('line:' + k, (c === 'w' ? 'As White' : 'As Black') + ': 1.' + sans.replace(' ', ' '), gis);
  }
  return out;
}

/** Two sets side by side, through the same computeStats() the record is drawn from. */
export function compareRows(games, heroKey, a, b) {
  const sa = computeStats(a.gis.map(i => games[i]), heroKey), sb = computeStats(b.gis.map(i => games[i]), heroKey);
  const pct = t => Math.round(scorePct(t));
  const rows = [
    { label: 'Games', a: sa.counted, b: sb.counted },
    { label: 'Score', a: scoreStr(sa.overall), b: scoreStr(sb.overall) },
    { label: 'Won · drawn · lost', a: sa.overall.w + '–' + sa.overall.d + '–' + sa.overall.l, b: sb.overall.w + '–' + sb.overall.d + '–' + sb.overall.l },
    { label: 'As White', a: scoreStr(sa.white), b: scoreStr(sb.white) },
    { label: 'As Black', a: scoreStr(sa.black), b: scoreStr(sb.black) },
    { label: 'Rating', a: sa.rating && sa.rating.last ? sa.rating.last : '—', b: sb.rating && sb.rating.last ? sb.rating.last : '—' },
    { label: 'Game length', a: sa.length ? Math.ceil(sa.length.avg / 2) + ' moves' : '—', b: sb.length ? Math.ceil(sb.length.avg / 2) + ' moves' : '—' },
  ];
  const acca = meanAccuracy(a.gis.map(i => games[i]), heroKey), accb = meanAccuracy(b.gis.map(i => games[i]), heroKey);
  if (acca && accb) rows.push({ label: 'Accuracy', a: Math.round(acca.accuracy) + '%', b: Math.round(accb.accuracy) + '%' });
  return { rows, a: sa, b: sb, swing: pct(sa.overall) - pct(sb.overall) };
}

/* ===== The opening explorer ===== */

/*
 * A node IS a tally with a move and its children hung off it. Not tidiness: a count
 * kept in a field of its own is how every percentage in a tree reads an honest-looking
 * zero when the tally and the counter drift apart.
 */
function newNode(san, move) {
  return Object.assign(newTally(), { san, move, fen: null, games: [], children: new Map() });
}

/**
 * A trie over the first `maxPly` plies of the subject's games as one colour. Each node
 * holds the game indices that reached it and takes its position from fens[depth] of the
 * first game through it — parseGame() banked every FEN, so nothing is replayed.
 */
export function buildExplorer(games, heroKey, color, maxPly = EXPLORER_MAX_PLY) {
  const root = newNode('', null);
  (games || []).forEach((g, gi) => {
    const f = gameFacts(g, heroKey);
    if (!f || f.color !== color) return;
    let node = root;
    addTally(node, f.result); node.games.push(gi); if (!node.fen) node.fen = g.fens[0];
    const depth = Math.min(maxPly, g.moves.length);
    for (let p = 0; p < depth; p++) {
      const san = g.moves[p].san;
      let kid = node.children.get(san);
      if (!kid) { kid = newNode(san, g.moves[p]); node.children.set(san, kid); }
      addTally(kid, f.result); kid.games.push(gi); if (!kid.fen) kid.fen = g.fens[p + 1];
      node = kid;
    }
  });
  return root;
}

/**
 * Walk a path of SAN down from the root. The path is SAN rather than node references so
 * it survives a rebuild: one that no longer exists stops at the last node that does.
 */
export function explorerWalk(root, path) {
  let node = root;
  const kept = [];
  for (const san of path || []) {
    const kid = node.children.get(san);
    if (!kid) break;
    kept.push(san);
    node = kid;
  }
  return { node, path: kept };
}
const sortedKids = node => [...node.children.values()].sort((a, b) => b.n - a.n || a.san.localeCompare(b.san));

/* ===== The pattern report: the same tree, read for errors ===== */

/**
 * The deepest line this game passed through that at least `minGames` of the subject's
 * games also passed through — so the grouping adapts to the repertoire instead of
 * imposing a depth on it. A one-off falls back to the root and is dropped.
 */
export function patternLineFor(root, sans, minGames = PATTERN_MIN_GAMES) {
  let node = root, best = null;
  const path = [];
  for (const san of sans) {
    const kid = node.children.get(san);
    if (!kid || kid.n < minGames) break;
    node = kid;
    path.push(san);
    if (path.length >= PATTERN_MIN_PLIES) best = path.slice();
  }
  return best;
}

/**
 * Rows: one per line, every judged ply of the subject's games under it classified and the
 * tiers kept apart. Sorted by errors per analysed game — repetition, not severity: the
 * single worst move in the archive is already the deck's first card.
 */
export function patternReport(games, heroKey, color, minGames = PATTERN_MIN_GAMES) {
  const root = buildExplorer(games, heroKey, color);
  const map = new Map();
  (games || []).forEach((g, gi) => {
    const f = gameFacts(g, heroKey);
    if (!f || f.color !== color) return;
    const path = patternLineFor(root, g.moves.slice(0, EXPLORER_MAX_PLY).map(m => m.san), minGames);
    if (!path) return;
    const key = color + '/' + path.join(' ');
    let p = map.get(key);
    if (!p) {
      p = { key, color, path, games: 0, analysed: 0, withError: 0, errors: 0, rate: 0,
        tiers: { blunder: 0, mistake: 0, inaccuracy: 0 }, plies: [], score: newTally(), clock: { errors: 0, low: 0 }, sample: null };
      map.set(key, p);
    }
    p.games++;
    addTally(p.score, f.result);
    if (!analysed(g)) return;
    p.analysed++;
    let any = false;
    for (let n = color === 'w' ? 0 : 1; n < g.moves.length; n += 2) {
      const tier = classify(g, n);
      if (!tier) continue;
      any = true;
      p.errors++; p.tiers[tier]++; p.plies.push(n);
      if (!p.sample || tier === 'blunder' && p.sample.tier !== 'blunder') p.sample = { gi, ply: n, tier };
      const low = timeTrouble(g, n);
      if (low !== null) { p.clock.errors++; if (low) p.clock.low++; }
    }
    if (any) p.withError++;
  });
  const rows = [...map.values()].filter(p => p.analysed >= minGames && p.errors >= PATTERN_MIN_ERRORS);
  for (const p of rows) { p.rate = p.errors / p.analysed; p.plies.sort((a, b) => a - b); }
  return rows.sort((a, b) => b.rate - a.rate || b.errors - a.errors || b.games - a.games);
}

/* ===== What to work on ===== */

/**
 * The findings turned round to face forward. Each row: the sentence, the numbers that
 * earned it, and where to walk for the evidence. Weight = a base per generator plus the
 * effect size, so the list leads with whatever this archive says costs the most.
 */
export function recommendations(games, heroKey) {
  const recs = [];
  if (!games || !games.length || !heroKey) return recs;
  const st = computeStats(games, heroKey);
  if (!st.counted) return recs;
  const W = c => (c === 'w' ? 'White' : 'Black');

  // The colour gap
  if (st.white.n >= FLOORS.colour && st.black.n >= FLOORS.colour) {
    const gap = scorePct(st.white) - scorePct(st.black);
    if (Math.abs(gap) >= 10) {
      const worse = gap > 0 ? 'b' : 'w', better = gap > 0 ? 'w' : 'b';
      const wt = worse === 'w' ? st.white : st.black, bt = better === 'w' ? st.white : st.black;
      recs.push({
        id: 'colour:' + worse, weight: 40 + Math.min(15, Math.round(Math.abs(gap) - 10)),
        text: 'Shore up the ' + W(worse) + ' openings: the score is ' + scoreStr(wt) + ' as ' + W(worse) + ' against ' + scoreStr(bt) + ' as ' + W(better) + ', a bigger gap than the move can explain.',
        numbers: scoreStr(wt) + ' over ' + plural(wt.n, 'game') + ' · ' + scoreStr(bt) + ' over ' + plural(bt.n, 'game'),
        walk: { room: 'insights', arg: 'explorer:' + worse },
      });
    }
  }

  // Tilt
  const h = habitReport(games, heroKey);
  if (h.tilt && h.tilt.afterLoss.n >= FLOORS.tilt && h.tilt.afterWin.n >= FLOORS.tilt) {
    const gap = scorePct(h.tilt.afterWin) - scorePct(h.tilt.afterLoss);
    if (gap >= 8) {
      recs.push({
        id: 'tilt', weight: 50 + Math.min(20, Math.round(gap - 8)),
        text: 'Take a breath after a loss: the next game scores ' + scoreStr(h.tilt.afterLoss) + ' when it follows a loss within twenty minutes, against ' + scoreStr(h.tilt.afterWin) + ' after a win.',
        numbers: plural(h.tilt.afterLoss.n, 'game') + ' after a loss · ' + plural(h.tilt.afterWin.n, 'game') + ' after a win',
        walk: { room: 'insights', arg: 'habits' },
      });
    }
  }

  // The endings
  if (st.overall.l >= FLOORS.endings) {
    const onTime = st.endings.l.time || 0, mated = st.endings.l.checkmate || 0;
    if (onTime / st.overall.l >= 0.25) {
      recs.push({
        id: 'flag', weight: 45 + Math.round(onTime / st.overall.l * 30),
        text: 'Stop losing to the flag: ' + onTime + ' of ' + plural(st.overall.l, 'loss', 'losses') + ' ended on time, and some of those positions were still games.',
        numbers: Math.round(onTime / st.overall.l * 100) + '% of losses on time',
        walk: { room: 'insights', arg: 'clock' },
      });
    }
    if (mated / st.overall.l >= 0.3) {
      recs.push({
        id: 'mated', weight: 40 + Math.round(mated / st.overall.l * 20),
        text: 'Watch the king: ' + mated + ' of ' + plural(st.overall.l, 'loss', 'losses') + ' ended in checkmate, which is a tactics habit more than an opening one.',
        numbers: Math.round(mated / st.overall.l * 100) + '% of losses by mate',
        walk: { room: 'learn', arg: 'tactics' },
      });
    }
  }

  // What time trouble costs
  const cr = clockReport(games, heroKey);
  if (cr.analysed >= FLOORS.clocked && cr.same.low.moves >= FLOORS.bandMoves && cr.same.rest.moves >= FLOORS.bandMoves) {
    const lo = cr.same.low.loss, re = cr.same.rest.loss;
    if (re > 0 && lo >= re * 2) {
      recs.push({
        id: 'trouble', weight: 55 + Math.min(15, Math.round(lo / re * 3)),
        text: 'The damage is done in time trouble: a move made with under a tenth of the clock costs ' + pawns(lo) + ' pawns on average, against ' + pawns(re) + ' outside it. The flag is not the loss — the moves just before it are.',
        numbers: plural(cr.same.low.moves, 'move') + ' in trouble · ' + plural(cr.same.rest.moves, 'move') + ' out of it · ' + plural(cr.analysed, 'analysed game') + ' with a clock',
        walk: { room: 'insights', arg: 'clock' },
      });
    }
  }

  // A line that keeps handing over a badly played position
  let totalErr = 0, totalAn = 0, worst = null;
  for (const color of ['w', 'b']) {
    for (const p of patternReport(games, heroKey, color)) {
      totalErr += p.errors; totalAn += p.analysed;
      if (p.games >= FLOORS.line && (!worst || p.rate > worst.rate)) worst = p;
    }
  }
  const baseline = totalAn ? totalErr / totalAn : 0;
  if (worst && baseline > 0 && worst.rate > baseline * FLOORS.lineRatio) {
    recs.push({
      id: 'line:' + worst.key, weight: 60 + Math.min(20, Math.round((worst.rate / baseline - FLOORS.lineRatio) * 10)),
      text: 'Rethink the line ' + sanLine(worst.path) + ' as ' + W(worst.color) + ': it hands over a position played at ' + worst.rate.toFixed(1) + ' errors a game, against ' + baseline.toFixed(1) + ' across the rest.',
      numbers: plural(worst.games, 'game') + ' · ' + plural(worst.analysed, 'analysed') + ' · ' + tiersText(worst.tiers) + ' · scores ' + scoreStr(worst.score),
      walk: { room: 'insights', arg: 'explorer:' + worst.color + ':' + worst.path.join(',') },
    });
  }

  // Thrown-away wins, with the game that shows it
  let analysedN = 0;
  const collapses = [];
  (games || []).forEach((g, gi) => {
    const f = gameFacts(g, heroKey);
    if (!f || !analysed(g)) return;
    analysedN++;
    if (f.result === 'w') return;
    const sign = f.color === 'w' ? 1 : -1;
    let ahead = false, worstPly = -1, worstLoss = 0;
    for (let n = f.color === 'w' ? 0 : 1; n < g.moves.length; n += 2) {
      const cp = evalToCp(g.analysis.evals[n]);
      if (cp !== null && cp * sign >= 200) ahead = true;
      const loss = ahead ? plyLoss(g, n) : null;
      if (loss !== null && loss >= SWING.blunder && loss > worstLoss) { worstLoss = loss; worstPly = n; }
    }
    if (ahead && worstPly >= 0) collapses.push({ gi, ply: worstPly, loss: worstLoss });
  });
  if (analysedN >= FLOORS.collapse && collapses.length >= 3) {
    const c = collapses.sort((a, b) => b.loss - a.loss)[0];
    recs.push({
      id: 'collapse', weight: 55 + Math.min(20, collapses.length * 3),
      text: 'Convert the won games: ' + plural(collapses.length, 'analysed game') + ' reached a clearly better position — two pawns or more — and were not won, each with one move that gave it back.',
      numbers: collapses.length + ' of ' + plural(analysedN, 'analysed game') + ' · the worst gave back ' + pawns(c.loss) + ' pawns',
      walk: { room: 'play', arg: c.gi + ':' + (c.ply + 1) },
    });
  }

  return recs.sort((a, b) => b.weight - a.weight);
}

function sanLine(path) { return path.map((san, i) => (i % 2 === 0 ? (i / 2 + 1) + '.' : '') + san).join(' '); }
function tiersText(t) {
  return ['blunder', 'mistake', 'inaccuracy'].filter(k => t[k]).map(k => plural(t[k], k, k === 'inaccuracy' ? 'inaccuracies' : k + 's')).join(', ') || 'no errors';
}

/* ===== Drawing: the eight panes ===== */

/* Prose switches person with `about`; the panes are otherwise identical for a subject
   and for an opponent. */
const VOICES = {
  you: { subj: 'You', subjL: 'you', poss: 'Your', possL: 'your', obj: 'you', tree: 'Your tree', are: 'are' },
  them: { subj: 'They', subjL: 'they', poss: 'Their', possL: 'their', obj: 'them', tree: 'Their tree', are: 'are' },
};

const PANES = [
  ['record', v => v.poss + ' record'], ['form', () => 'Form'], ['clock', () => 'The clock'], ['habits', () => 'Habits'],
  ['compare', () => 'Compare'], ['explorer', () => 'The opening explorer'], ['patterns', () => 'Where it goes wrong'], ['recs', () => 'What to work on'],
];
const ENGINE_PANES = ['form', 'clock', 'patterns', 'recs'];

const bar = pct => '<span class="ins-bar" aria-hidden="true"><i style="width:' + Math.max(0, Math.min(100, pct)).toFixed(0) + '%"></i></span>';
const wdl = t => '<span class="wdl num"><span class="w">' + t.w + '</span>–' + t.d + '–<span class="l">' + t.l + '</span></span>';
function tile(label, value, sub) {
  return '<div class="stat-tile"><span class="stat">' + value + '</span><span class="label">' + label + '</span>' + (sub ? '<span class="ins-sub">' + sub + '</span>' : '') + '</div>';
}
function tallyTable(caption, rows) {
  if (!rows.length) return '';
  return '<table class="ins-table"><caption>' + escHtml(caption) + '</caption><tbody>' +
    rows.map(([name, t]) => '<tr><td>' + (name && name.html !== undefined ? name.html : escHtml(name)) + '</td><td class="num">' + wdl(t) + '</td><td class="ins-barcell">' + bar(scorePct(t)) + '</td><td class="num">' + scoreStr(t) + '</td></tr>').join('') +
    '</tbody></table>';
}
function figureTable(caption, head, rows) {
  if (!rows.length) return '';
  return '<table class="ins-table"><caption>' + escHtml(caption) + '</caption>' +
    (head ? '<thead><tr>' + head.map((h, i) => '<th' + (i ? ' class="num"' : '') + '>' + escHtml(h) + '</th>').join('') + '</tr></thead>' : '') +
    '<tbody>' + rows.map(r => '<tr>' + r.map((c, i) => '<td' + (i ? ' class="num"' : '') + '>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
const line = text => '<p class="lede ins-line">' + text + '</p>';
const note = text => '<p class="hint ins-note">' + text + '</p>';
const sanRun = path => '<span class="ins-san">' + moveRunHTML(path, { style: 'line', at: path.length }) + '</span>';

/* One construction for every chart: data units across, a hundred down, stretched to the
   panel's width; every fill is a class, and every class is a token. */
function stripSVG(marks, label) {
  if (!marks.length) return '';
  return '<svg class="ins-chart ins-strip" viewBox="0 0 ' + marks.length + ' 100" preserveAspectRatio="none" role="img" aria-label="' + escHtml(label) + '">' +
    marks.map((m, i) => '<rect class="ins-' + m + '" x="' + i + '" y="0" width="1" height="100"/>').join('') + '</svg>';
}
function barsSVG(values, label, hi) {
  const max = Math.max(...values, 0);
  if (!max) return '';
  return '<svg class="ins-chart ins-bars" viewBox="0 0 ' + values.length + ' 100" preserveAspectRatio="none" role="img" aria-label="' + escHtml(label) + '">' +
    values.map((v, i) => { const h = v / max * 100; return h ? '<rect class="ins-bar-fill' + (i === hi ? ' ins-bar-hi' : '') + '" x="' + (i + 0.14).toFixed(2) + '" y="' + (100 - h).toFixed(1) + '" width="0.72" height="' + h.toFixed(1) + '"/>' : ''; }).join('') + '</svg>';
}
function seriesSVG(points, label) {
  if (points.length < 2) return '';
  const w = points.length - 1;
  const d = points.map((v, i) => (i ? 'L' : 'M') + i + ' ' + (100 - v).toFixed(1)).join(' ');
  return '<svg class="ins-chart ins-series" viewBox="0 0 ' + w + ' 100" preserveAspectRatio="none" role="img" aria-label="' + escHtml(label) + '">' +
    '<line class="ins-rule" x1="0" y1="50" x2="' + w + '" y2="50"/><path class="ins-area" d="' + d + ' L' + w + ' 100 L0 100 Z"/><path class="ins-path" d="' + d + '"/></svg>';
}
function chartBox(caption, svg, left, right) {
  if (!svg) return '';
  return '<div class="ins-chartbox"><p class="ins-cap">' + caption + '</p>' + svg + '<div class="ins-foot"><span>' + (left || '') + '</span><span>' + (right || '') + '</span></div></div>';
}

/* ----- The report: one per container, so Insights and Prep can each hold one ----- */

const _reports = new Set();

function reportFor(container) {
  for (const r of _reports) if (r.container === container) return r;
  const rep = { container, games: [], heroKey: '', about: 'you', name: '', room: 'insights', own: false,
    exp: { color: 'w', path: [] }, cmp: { a: '', b: '' }, gen: {}, say: {}, cache: {}, recsShown: [], built: '' };
  _reports.add(rep);
  wireReport(rep);
  return rep;
}
const V = rep => VOICES[rep.about] || VOICES.you;
const body = (rep, pane) => rep.container.querySelector('[data-body="' + pane + '"]');

/* Caches live on the report and die with any change to what they were computed over. */
function cache(rep) {
  const last = rep.games[rep.games.length - 1];
  const sig = rep.games.length + '|' + rep.heroKey + '|' + (last ? last.id : '');
  if (rep.cache.sig !== sig) rep.cache = { sig };
  return rep.cache;
}
const statsOf = rep => (cache(rep).stats ||= computeStats(rep.games, rep.heroKey));
const treeOf = (rep, color) => (cache(rep)['tree' + color] ||= buildExplorer(rep.games, rep.heroKey, color));
function dropEngineCaches(rep) { const c = cache(rep); delete c.clock; delete c.pat; delete c.recs; }

/**
 * The eight panes into `container`, for `games` seen from `heroKey`. Prep reuses this
 * pointed at an opponent, so it never reads S.games and its prose follows `about`.
 */
export function renderReport(container, games, heroKey, opts = {}) {
  if (!container) return;
  const rep = reportFor(container);
  rep.games = games || [];
  rep.heroKey = heroKey || '';
  rep.about = opts.about === 'them' ? 'them' : 'you';
  rep.name = opts.name || heroKey || '';
  rep.room = opts.room || currentRoom() || 'insights';
  rep.own = rep.games === S.games;
  if (rep.built !== rep.about) buildShell(rep);
  for (const [pane] of PANES) paintPane(rep, pane);
}

function buildShell(rep) {
  const v = V(rep);
  rep.container.innerHTML = '<div class="cards ins-cards">' + PANES.map(([pane, title]) =>
    '<section class="panel ins-pane ins-' + pane + '" data-pane="' + pane + '"><header class="panel-head"><h2>' + escHtml(title(v)) + '</h2><div class="tools" data-tools="' + pane + '">' +
    (pane === 'explorer' ? '<div class="seg" role="group" aria-label="Colour"><button class="btn on" type="button" data-side="w">As White</button><button class="btn" type="button" data-side="b">As Black</button></div>' : '') +
    (pane === 'compare' ? '<select data-cmp="a" aria-label="First set"></select><span class="muted">vs</span><select data-cmp="b" aria-label="Second set"></select>' : '') +
    '<button class="btn btn-sm btn-ghost speak-elsewhere" type="button" data-speak="' + pane + '" title="Read this card aloud">Speak</button></div></header>' +
    '<div class="panel-body scroll-x" data-body="' + pane + '"></div></section>').join('') + '</div>';
  rep.built = rep.about;
}

const PAINTERS = { record: paintRecord, form: paintForm, clock: paintClock, habits: paintHabits, compare: paintCompare, explorer: paintExplorer, patterns: paintPatterns, recs: paintRecs };

function paintPane(rep, pane) {
  const el = body(rep, pane);
  if (!el) return;
  rep.say[pane] = '';
  if (!statsOf(rep).counted) {
    el.innerHTML = note('Nothing here counts: ' + escHtml(rep.name || 'the subject') + ' did not play any of these games to a result.');
    if (pane === 'explorer') stageRelease(rep.room);
    return;
  }
  PAINTERS[pane](rep, el);
}

/*
 * The second paint. A repaint is queued rather than run, and only the newest queued
 * generation for a pane is allowed to land — so a burst of `cr:analysis-done` events
 * during a sweep paints once, and an older paint cannot land over a newer one.
 */
function repaintEngine(rep) {
  dropEngineCaches(rep);
  for (const pane of ENGINE_PANES) {
    const gen = rep.gen[pane] = (rep.gen[pane] || 0) + 1;
    setTimeout(() => { if (gen === rep.gen[pane] && rep.container.isConnected) paintPane(rep, pane); }, 0);
  }
}

/* ----- 1 The record ----- */
function paintRecord(rep, el) {
  const st = statsOf(rep), v = V(rep);
  const o = st.overall;
  const sentence = v.subj + ' ' + v.are.replace('are', 'have') + ' played ' + plural(st.counted, 'game') + ' to a result: ' + plural(o.w, 'win') + ', ' + plural(o.d, 'draw') + ', ' + plural(o.l, 'loss', 'losses') + ' — a score of ' + scoreStr(o) + '. As White ' + scoreStr(st.white) + ' over ' + st.white.n + ', as Black ' + scoreStr(st.black) + ' over ' + st.black.n + '.';
  rep.say.record = sentence + (st.rating && st.rating.last ? ' Rating ' + st.rating.last + ', peak ' + st.rating.peak + '.' : '');
  let html = line(v.subj + ' score ' + num(scoreStr(o)) + ' over ' + num(st.counted) + ' games: ' + wdl(o) + '.');
  html += '<div class="stat-row">' +
    tile('As White', scoreStr(st.white), wdl(st.white)) + tile('As Black', scoreStr(st.black), wdl(st.black)) +
    (st.rating ? tile('Rating', st.rating.last || st.rating.peak, st.rating.last ? 'peak ' + st.rating.peak + (st.rating.delta ? ' · ' + (st.rating.delta > 0 ? '+' : '') + st.rating.delta + ' across these games' : '') : 'peak, undated') : '') +
    (st.length ? tile('Game length', Math.ceil(st.length.avg / 2) + ' moves', 'on average · longest ' + Math.ceil(st.length.longest.plies / 2)) : '') + '</div>';
  const endRows = res => Object.entries(st.endings[res]).sort((a, b) => b[1] - a[1]).map(([k, n]) => [escHtml(k === 'unrecorded' ? 'unrecorded' : endingLabel(k)), n, bar(n / (o[res] || 1) * 100), Math.round(n / (o[res] || 1) * 100) + '%']);
  html += '<div class="ins-cols">' +
    figureTable('How the wins come', ['Ending', 'Games', '', 'Share'], endRows('w')) +
    figureTable('How the losses come', ['Ending', 'Games', '', 'Share'], endRows('l')) + '</div>';
  html += tallyTable('By time control', Object.entries(st.controls).sort((a, b) => b[1].n - a[1].n).map(([k, t]) => [CLASS_LABEL[k] || 'Unknown', t]));
  html += note('Counted ' + st.counted + ' of the ' + plural(st.total, 'loaded game') + ': the ones ' + escHtml(rep.name) + ' played to a result.');
  el.innerHTML = html;
}

/* ----- 2 Form ----- */
function paintForm(rep, el) {
  const v = V(rep), f = formReport(rep.games, rep.heroKey);
  if (!f) {
    el.innerHTML = note('Form is results in the order they happened, and these games carry no dates to put them in. An archive fetched from Chess.com or Lichess carries one on every game.');
    return;
  }
  const runWord = { w: 'won', d: 'drawn', l: 'lost' }[f.run.result];
  let text = v.poss + ' last ' + f.lastN + ': ' + plural(f.last.w, 'win') + ', ' + plural(f.last.d, 'draw') + ', ' + plural(f.last.l, 'loss', 'losses') + '.';
  if (f.run.n >= 2) text += ' ' + v.subj + ' have ' + runWord + ' the last ' + f.run.n + '.';
  let html = line(v.poss + ' last ' + num(f.lastN) + ': ' + wdl(f.last) + ' · ' + num(scoreStr(f.last)) + '.' + (f.run.n >= 2 ? ' ' + v.subj + ' have ' + runWord + ' the last ' + num(f.run.n) + '.' : ''));
  html += chartBox('Every dated game, oldest first', stripSVG(f.marks, plural(f.n, 'game') + ' in order: green a win, red a loss.'), fmtDate(f.from), fmtDate(f.to));
  if (f.roll) {
    html += chartBox('Score over each run of ' + ROLL_WINDOW + ' games', seriesSVG(f.roll, 'Rolling score against the fifty percent line.'), 'earliest', 'now · ' + Math.round(f.roll[f.roll.length - 1]) + '%');
    text += ' Over the last ' + ROLL_WINDOW + ' games ' + v.subjL + ' score ' + Math.round(f.roll[f.roll.length - 1]) + ' percent, against ' + Math.round(f.roll[0]) + ' at the start.';
  }
  const acc = meanAccuracy(rep.games, rep.heroKey);
  if (acc && acc.games >= FLOORS.habit) {
    html += '<div class="stat-row">' + tile('Accuracy', Math.round(acc.accuracy) + '%', 'per game, averaged over ' + plural(acc.games, 'analysed game')) + tile('Longest unbeaten run', f.unbeaten, 'best run ' + plural(f.bestRun, 'win') + ' · worst ' + plural(f.worstRun, 'loss', 'losses')) + '</div>';
    text += ' Accuracy averages ' + Math.round(acc.accuracy) + ' percent over the ' + plural(acc.games, 'game') + ' the engine has read.';
  }
  if (f.months.length > 1) html += tallyTable('By month', f.months.slice(-12).map(t => [t.label, t]));
  html += note(plural(f.n, 'dated game') + ' of ' + statsOf(rep).counted + ' counted.' + (acc ? '' : ' Accuracy arrives when the engine has read some of them.'));
  rep.say.form = text;
  el.innerHTML = html;
}

/* ----- 3 The clock ----- */
function paintClock(rep, el) {
  const v = V(rep), c = cache(rep).clock ||= clockReport(rep.games, rep.heroKey);
  if (!c.clocked) {
    el.innerHTML = note((c.dropped ? plural(c.dropped, 'game') + ' carried a clock whose readings did not match the moves and ' + (c.dropped === 1 ? 'was' : 'were') + ' dropped whole. ' : '') +
      'This card needs the clock times in the file. Both sites write them into the games they export; a PGN pasted from somewhere else usually has none.' +
      (c.onTime ? ' ' + c.onTime + ' of ' + v.possL + ' ' + plural(c.losses, 'loss', 'losses') + ' ended on the flag.' : ''));
    rep.say.clock = c.onTime ? c.onTime + ' of ' + v.possL + ' ' + plural(c.losses, 'loss', 'losses') + ' ended on time.' : '';
    return;
  }
  const parts = [];
  let html = '';
  /*
   * Lead with the comparison that holds difficulty still. A long think is usually a hard
   * position, so any curve over thinking time is partly reporting which moves were hard;
   * the same moves made with a tenth of the clock left change the circumstance and not
   * the position.
   */
  const lo = c.same.low, re = c.same.rest;
  const compared = lo.moves >= FLOORS.bandMoves && re.moves >= FLOORS.bandMoves;
  if (compared) {
    html += line('With under a tenth of the clock left ' + v.subjL + ' play at ' + num(Math.round(lo.acc) + '%') + ' accuracy and give away ' + num(pawns(lo.loss)) + ' pawns a move, against ' + num(Math.round(re.acc) + '%') + ' and ' + num(pawns(re.loss)) + ' the rest of the time.');
    parts.push('With under a tenth of the clock left ' + v.subjL + ' play at ' + Math.round(lo.acc) + ' percent accuracy and give away ' + pawns(lo.loss) + ' pawns a move, against ' + Math.round(re.acc) + ' percent and ' + pawns(re.loss) + ' the rest of the time.');
    html += figureTable('The same moves, in time trouble and out of it', ['', 'Moves', 'Accuracy', 'Pawns a move', 'Error rate'], [
      ['Under a tenth of the clock', lo.moves, Math.round(lo.acc) + '%', pawns(lo.loss), Math.round(lo.errors / lo.moves * 100) + '%'],
      ['The rest of the game', re.moves, Math.round(re.acc) + '%', pawns(re.loss), Math.round(re.errors / re.moves * 100) + '%'],
    ]);
  } else {
    html += line(num(Math.round(c.low / c.moves * 100) + '%') + ' of ' + v.possL + ' moves come in the last tenth of the clock, over ' + num(c.clocked) + ' games that carry one.');
    parts.push(Math.round(c.low / c.moves * 100) + ' percent of ' + v.possL + ' moves come in the last tenth of the clock.');
  }
  html += '<div class="stat-row">' +
    (c.median !== null ? tile('A move takes', fmtSecs(c.median), 'at the median') : '') +
    tile('Moves in time trouble', Math.round(c.low / c.moves * 100) + '%', 'under a tenth of the clock left') +
    (c.losses && c.onTime ? tile('Lost on time', c.onTime + ' of ' + c.losses, Math.round(c.onTime / c.losses * 100) + '% of ' + v.possL + ' losses') : '') + '</div>';
  if (c.reached.n >= FLOORS.habit && c.calm.n >= FLOORS.habit) {
    html += tallyTable('Games that reached time trouble', [['Reached it', c.reached], ['Did not', c.calm]]);
    parts.push('In the ' + plural(c.reached.n, 'game') + ' that reached time trouble ' + v.subjL + ' score ' + scoreStr(c.reached) + ', against ' + scoreStr(c.calm) + ' in the ones that did not.');
  }
  const bands = c.bands.filter(b => b.moves >= FLOORS.bandMoves);
  if (bands.length >= 2) {
    const worst = bands.slice().sort((a, b) => b.loss - a.loss)[0];
    html += chartBox('What a move cost, against how long it took', barsSVG(bands.map(b => b.loss), 'Pawns given away per move by thinking time.', bands.indexOf(worst)), bands[0].label, bands[bands.length - 1].label);
    html += figureTable('By how long the move took', ['', 'Moves', 'Accuracy', 'Pawns a move'], bands.map(b => [b.label, b.moves, Math.round(b.acc) + '%', pawns(b.loss)]));
    // The confound, said out loud rather than left in the table.
    html += note('A long think is usually a hard position, so this curve is partly about which moves were difficult rather than where the time was wasted. The comparison above changes the circumstance and not the position.');
    parts.push('By thinking time ' + v.subjL + ' lose most on the moves ' + v.subjL + ' spend ' + worst.spoken + ' on — though a long think is usually a hard position, so that is partly about which moves are difficult.');
  }
  const flags = Object.entries(c.flag);
  if (flags.length > 1) html += figureTable('Lost on time, by time control', ['', 'Losses'], flags.sort((a, b) => b[1] - a[1]).map(([k, n]) => [CLASS_LABEL[k] || 'Unknown', n]));
  html += note(plural(c.clocked, 'game') + ' of ' + c.counted + ' carry a usable clock' + (c.dropped ? '; ' + plural(c.dropped, 'game') + ' carried readings that did not match the moves and ' + (c.dropped === 1 ? 'was' : 'were') + ' dropped whole' : '') +
    '. ' + (c.analysed ? 'The engine has read ' + c.analysed + ' of them; accuracy and cost are per game, then averaged.' : 'What a move costs arrives once the engine has read some of them.'));
  rep.say.clock = parts.join(' ');
  el.innerHTML = html;
}

/* ----- 4 Habits ----- */
function paintHabits(rep, el) {
  const v = V(rep), h = habitReport(rep.games, rep.heroKey);
  const parts = [];
  let html = '';
  if (h.tilt && h.tilt.afterLoss.n >= FLOORS.habit && h.tilt.afterWin.n >= FLOORS.habit) {
    html += line('Straight after a loss ' + v.subjL + ' score ' + num(scoreStr(h.tilt.afterLoss)) + ' over ' + num(h.tilt.afterLoss.n) + ' games, against ' + num(scoreStr(h.tilt.afterWin)) + ' after a win.');
    html += tallyTable('The next game, begun within twenty minutes', [['After a loss', h.tilt.afterLoss], ['After a win', h.tilt.afterWin]]);
    parts.push('Straight after a loss ' + v.subjL + ' score ' + scoreStr(h.tilt.afterLoss) + ' over ' + plural(h.tilt.afterLoss.n, 'game') + ', against ' + scoreStr(h.tilt.afterWin) + ' after a win.');
  } else if (h.tilt) {
    html += note('Only ' + plural(h.tilt.afterLoss.n, 'game') + ' here began within twenty minutes of a loss, which is too few to call it anything.');
  }
  const ranked = h.day.filter(t => t.n >= FLOORS.habit).sort((a, b) => scorePct(b) - scorePct(a));
  if (ranked.length > 1) {
    const best = ranked[0], worst = ranked[ranked.length - 1];
    html += tallyTable('By time of day, on this device’s clock', h.day.map(t => [t.part.label, t]));
    parts.push(v.subj + ' score ' + scoreStr(best) + ' ' + best.part.spoken + ' and ' + scoreStr(worst) + ' ' + worst.part.spoken + '.');
    if (rep.about === 'them') html += note('Read on this device’s clock rather than theirs — the right clock for a round both players sit down to at once, and not a claim about their evenings.');
  }
  if (h.hours.length) {
    const counts = h.hours.map(t => t.n), busiest = counts.indexOf(Math.max(...counts));
    html += chartBox('When ' + v.subjL + ' play, hour by hour', barsSVG(counts, 'Games by the hour they started; the busiest is ' + busiest + ':00.', busiest), 'midnight', '11pm');
  }
  if (h.opponents.length) {
    html += tallyTable('Who ' + v.subjL + ' keep losing to', h.opponents.map(t => [t.name, t]));
    const n = h.opponents[0];
    parts.push(v.subj + ' have lost most often to ' + n.name + ': ' + plural(n.l, 'loss', 'losses') + ' in ' + plural(n.n, 'game') + '.');
  }
  if (!html) html = note('These come off the date, the time and the opponent tags, and this archive carries too few of them. Games fetched from Chess.com or Lichess carry all three.');
  else html += note(plural(h.dated, 'dated game') + ' of ' + h.counted + ' counted' + (h.tilt ? '; ' + plural(h.tilt.pairs, 'pair') + ' of games began within twenty minutes of the one before' : '') + '.');
  rep.say.habits = parts.join(' ');
  el.innerHTML = html;
}

/* ----- 5 Compare ----- */
function paintCompare(rep, el) {
  const v = V(rep), sets = compareSets(rep.games, rep.heroKey);
  const tools = rep.container.querySelector('[data-tools="compare"]');
  const selA = tools && tools.querySelector('[data-cmp="a"]'), selB = tools && tools.querySelector('[data-cmp="b"]');
  if (sets.length < 2) {
    if (selA) { selA.hidden = true; selB.hidden = true; tools.querySelector('.muted').hidden = true; }
    el.innerHTML = note('Nothing here splits in two yet. A comparison needs ' + FLOORS.compare + ' games on each side of it — two periods, two time controls, two colours or two openings.');
    return;
  }
  if (!sets.find(s => s.key === rep.cmp.a)) rep.cmp.a = sets[0].key;
  if (!sets.find(s => s.key === rep.cmp.b) || rep.cmp.b === rep.cmp.a) rep.cmp.b = (sets.find(s => s.key !== rep.cmp.a) || sets[0]).key;
  const opts = sets.map(s => '<option value="' + escHtml(s.key) + '">' + escHtml(s.label) + ' (' + s.gis.length + ')</option>').join('');
  if (selA) {
    const sig = sets.map(s => s.key).join('|');
    if (selA.dataset.sig !== sig) { selA.innerHTML = opts; selB.innerHTML = opts; selA.dataset.sig = sig; }
    selA.value = rep.cmp.a; selB.value = rep.cmp.b; selA.hidden = false; selB.hidden = false; tools.querySelector('.muted').hidden = false;
  }
  const a = sets.find(s => s.key === rep.cmp.a), b = sets.find(s => s.key === rep.cmp.b);
  const cmp = compareRows(rep.games, rep.heroKey, a, b);
  // Six points is the smallest gap worth a sentence at these sizes; below it, "much the same".
  const verdict = Math.abs(cmp.swing) < 6 ? 'Much the same either side: ' + cmp.rows[1].a + ' against ' + cmp.rows[1].b + '.'
    : a.label + ' is ' + Math.abs(cmp.swing) + ' points ' + (cmp.swing > 0 ? 'better' : 'worse') + ' than ' + b.label + '.';
  rep.say.compare = a.label + ' against ' + b.label + '. ' + v.subj + ' score ' + cmp.rows[1].a + ' over ' + plural(cmp.a.counted, 'game') + ', against ' + cmp.rows[1].b + ' over ' + cmp.b.counted + '. ' + verdict;
  el.innerHTML = line(escHtml(verdict)) +
    '<table class="ins-table ins-compare"><thead><tr><th></th><th class="num">' + escHtml(a.label) + '</th><th class="num">' + escHtml(b.label) + '</th></tr></thead><tbody>' +
    cmp.rows.map(r => '<tr><td>' + escHtml(r.label) + '</td><td class="num">' + escHtml(String(r.a)) + '</td><td class="num">' + escHtml(String(r.b)) + '</td></tr>').join('') + '</tbody></table>' +
    note('The same record run twice: overlapping sets share their games.');
}

/* ----- 6 The opening explorer ----- */
function paintExplorer(rep, el) {
  const v = V(rep);
  const tools = rep.container.querySelector('[data-tools="explorer"]');
  if (tools) for (const b of tools.querySelectorAll('[data-side]')) b.classList.toggle('on', b.dataset.side === rep.exp.color);
  const root = treeOf(rep, rep.exp.color);
  const { node, path } = explorerWalk(root, rep.exp.path);
  rep.exp.path = path;
  const colour = rep.exp.color === 'w' ? 'White' : 'Black';
  if (!node.n) {
    stageRelease(rep.room);
    el.innerHTML = note('Nothing here yet: ' + v.subjL + ' have not played a game as ' + colour + ' to a result.');
    rep.say.explorer = '';
    return;
  }
  /*
   * The node goes on the stage — flipped for Black, because a repertoire is remembered
   * from the side that plays it. Not at the root: the start position on an idle board is
   * a chessboard used as decoration, and the sentence there is about a side, not a square.
   */
  if (path.length) {
    const last = node.move;
    stageClaim(rep.room, {
      fen: node.fen, from: last ? last.from : null, to: last ? last.to : null, flipped: rep.exp.color === 'b',
      label: v.tree + ' · after ' + moveNumberLabel(path.length - 1) + ' ' + path[path.length - 1],
      line: { moves: path, at: path.length, from: 0, act: n => { rep.exp.path = path.slice(0, Math.max(0, Math.min(path.length, n))); paintExplorer(rep, el); } },
    });
  } else stageRelease(rep.room);

  const here = path.length ? v.subj + ' have been here ' + num(plural(node.n, 'time')) : num(plural(node.n, 'game')) + ' as ' + colour;
  let html = '<p class="ins-path-row"><span class="crumb crumb-root' + (path.length ? '' : ' current') + '" data-crumb="0" role="button" tabindex="0">Start</span> ' +
    moveRunHTML(path, { style: 'line', at: path.length, attr: 'data-crumb' }) + '</p>';
  html += line(here + ' · ' + wdl(node) + ' · ' + num(scoreStr(node)) + '.');
  html += '<div class="tools">' + (path.length ? '<button class="btn btn-sm" type="button" data-back>Back a move</button>' : '') + '</div>';
  const kids = sortedKids(node);
  if (kids.length) {
    html += '<div class="ins-moves">' + kids.map(k =>
      '<button class="ins-move" type="button" data-san="' + escHtml(k.san) + '" title="Walk into this move"><span class="san">' + escHtml(k.san) + '</span><span class="num muted">' + plural(k.n, 'game') + '</span>' + bar(scorePct(k)) + '<span class="num">' + scoreStr(k) + '</span></button>').join('') + '</div>';
  } else {
    html += note(path.length >= EXPLORER_MAX_PLY ? 'The tree stops here, ' + EXPLORER_MAX_PLY / 2 + ' moves in.' : 'The game ended here.');
  }
  const shown = node.games.slice(0, 8);
  html += '<div class="ins-games"><p class="hint">Games here' + (rep.own ? ' — press one to listen from this position' : '') + '</p>' + shown.map(gi => {
    const g = rep.games[gi], f = gameFacts(g, rep.heroKey);
    const mark = f.result === 'w' ? '+' : f.result === 'l' ? '−' : '=';
    const inner = '<span class="ins-res ins-res-' + f.result + '">' + mark + '</span><span class="ins-opp">' + escHtml(f.opponent || '?') + '</span><span class="muted num">' + (f.date ? escHtml(fmtDate(f.date)) : '') + '</span>';
    return rep.own ? '<button class="ins-game" type="button" data-gi="' + gi + '" data-depth="' + path.length + '">' + inner + '</button>' : '<div class="ins-game ins-game-flat">' + inner + '</div>';
  }).join('') + (node.games.length > shown.length ? note('and ' + (node.games.length - shown.length) + ' more.') : '') + '</div>';
  el.innerHTML = html;
  const top = kids[0];
  rep.say.explorer = (path.length ? v.subj + ' have been here ' + plural(node.n, 'time') : plural(node.n, 'game') + ' as ' + colour) + ': ' + plural(node.w, 'win') + ', ' + plural(node.d, 'draw') + ', ' + plural(node.l, 'loss', 'losses') + '. ' + v.subj + ' score ' + scoreStr(node) + '.' +
    (top ? ' Most often ' + top.san + ', ' + plural(top.n, 'game') + ', ' + scoreStr(top) + '.' : '');
}

/* ----- 7 The pattern report ----- */
function paintPatterns(rep, el) {
  const v = V(rep), c = cache(rep);
  const rows = c.pat ||= [...patternReport(rep.games, rep.heroKey, 'w'), ...patternReport(rep.games, rep.heroKey, 'b')].sort((a, b) => b.rate - a.rate || b.errors - a.errors);
  let analysedN = 0;
  for (const g of rep.games) if (gameFacts(g, rep.heroKey) && analysed(g)) analysedN++;
  if (!analysedN) {
    el.innerHTML = note('The engine is what finds these. None of ' + v.possL + ' games have been analysed yet — press Analyse on one in Listen, or start the archive sweep in Settings, and this fills itself in.');
    rep.say.patterns = '';
    return;
  }
  if (!rows.length) {
    el.innerHTML = note('No pattern yet. A pattern is the same kind of error, ' + PATTERN_MIN_ERRORS + ' times or more, out of a line ' + v.subjL + ' have played at least ' + PATTERN_MIN_GAMES + ' times — so it takes an archive before it takes shape. ' + analysedN + ' of ' + statsOf(rep).counted + ' games are analysed.');
    rep.say.patterns = '';
    return;
  }
  let html = line((rows.length === 1 ? 'One line' : num(rows.length) + ' lines') + ' where the same thing keeps happening, across ' + num(analysedN) + ' analysed games.');
  html += rows.slice(0, 8).map(p => {
    const lo = p.plies.length ? Math.floor(p.plies[0] / 2) + 1 : 0, hi = p.plies.length ? Math.floor(p.plies[p.plies.length - 1] / 2) + 1 : 0;
    return '<div class="ins-pat"><div class="ins-pat-line">' + sanRun(p.path) + ' <span class="muted">as ' + (p.color === 'w' ? 'White' : 'Black') + '</span></div>' +
      '<div class="ins-tiers">' + ['blunder', 'mistake', 'inaccuracy'].filter(t => p.tiers[t]).map(t => '<span class="chip ins-tier-' + t + '">' + plural(p.tiers[t], t, t === 'inaccuracy' ? 'inaccuracies' : t + 's') + '</span>').join('') + '</div>' +
      '<p class="hint">' + num(p.rate.toFixed(1)) + ' errors a game, in ' + num(p.withError + ' of ' + p.analysed) + ' analysed games from this line' + (lo ? ', around ' + (lo === hi ? 'move ' + lo : 'moves ' + lo + '–' + hi) : '') + '. ' + v.subj + ' score ' + num(scoreStr(p.score)) + ' from here over ' + plural(p.games, 'game') + '.' +
      (p.clock.errors >= PATTERN_MIN_ERRORS && p.clock.low ? ' ' + p.clock.low + ' of the ' + p.clock.errors + ' came in the last tenth of the clock.' : '') + '</p>' +
      '<div class="tools"><button class="btn btn-sm" type="button" data-pat="' + escHtml(p.color + ':' + p.path.join(',')) + '">Open in the tree</button>' +
      (rep.own && p.sample ? '<button class="btn btn-sm btn-ghost" type="button" data-gi="' + p.sample.gi + '" data-depth="' + (p.sample.ply + 1) + '">Listen to a ' + p.sample.tier + '</button>' : '') + '</div></div>';
  }).join('');
  if (analysedN < statsOf(rep).counted) html += note((statsOf(rep).counted - analysedN) + ' of ' + v.possL + ' ' + statsOf(rep).counted + ' games have not been analysed and count towards none of this.');
  el.innerHTML = html;
  const p = rows[0];
  rep.say.patterns = 'Across ' + plural(analysedN, 'analysed game') + ', ' + (rows.length === 1 ? 'one line stands out' : rows.length + ' lines stand out') + '. After ' + sanLine(p.path) + ' as ' + (p.color === 'w' ? 'White' : 'Black') + ': ' + tiersText(p.tiers) + ' in ' + p.withError + ' of ' + plural(p.analysed, 'game') + '.';
}

/* ----- 8 What to work on ----- */
let _hidden = new Set();     // dismissed row ids — the one thing this room remembers

function paintRecs(rep, el) {
  const c = cache(rep);
  const all = c.recs ||= recommendations(rep.games, rep.heroKey);
  const shown = all.filter(r => !_hidden.has(r.id));
  rep.recsShown = shown;
  const hid = all.length - shown.length;
  let html = shown.map((r, i) =>
    '<div class="ins-rec"><p class="lede ins-line">' + escHtml(r.text) + '</p><p class="hint num ins-rec-nums">' + escHtml(r.numbers) + '</p>' +
    '<div class="tools"><button class="btn btn-sm" type="button" data-rec-walk="' + i + '">' + escHtml(walkLabel(r.walk)) + '</button><button class="btn btn-sm btn-ghost" type="button" data-rec-hide="' + i + '" title="Take this row off the list">Dismiss</button></div></div>').join('');
  if (!shown.length) html += note(hid ? 'Everything here has been dismissed.' : 'Nothing to recommend yet. A recommendation needs a habit big enough to bet on, and these games have not shown one — more games, and more analysed games, is what finds one.');
  if (hid) html += '<p class="hint ins-note"><button class="btn btn-sm btn-ghost" type="button" data-rec-restore>Bring back ' + plural(hid, 'dismissed row') + '</button></p>';
  el.innerHTML = html;
  rep.say.recs = shown.map(r => r.text).join(' ');
}

function walkLabel(w) {
  if (!w) return 'See the evidence';
  if (w.room === 'play') return 'Listen to the game';
  if (w.room === 'learn') return 'Open Tactics';
  if (String(w.arg).startsWith('explorer')) return 'Open in the tree';
  if (w.arg === 'clock') return 'See the clock';
  if (w.arg === 'habits') return 'See the habit';
  return 'See the evidence';
}

/* Where a row's control walks. A Listen game is set here rather than through the hash,
   because Listen takes no argument; everything else is a room and an argument. */
function walkTo(walk) {
  if (!walk) return;
  if (walk.room === 'play') {
    const [gi, ply] = String(walk.arg).split(':').map(Number);
    if (S.games[gi]) setGame(gi, ply || 0);
    navigate('play');
    return;
  }
  navigate(walk.room, walk.arg);
}

async function setHidden(next) {
  _hidden = next;
  await dbPut('meta', { k: 'recsHidden', v: [...next] });   // resolves false when storage is off; the set stands for the session
}

/* ----- Wiring: one delegate per report ----- */
function wireReport(rep) {
  rep.container.addEventListener('click', e => {
    const t = e.target.closest('[data-side],[data-san],[data-crumb],[data-back],[data-gi],[data-pat],[data-rec-walk],[data-rec-hide],[data-rec-restore],[data-speak]');
    if (!t || !rep.container.contains(t)) return;
    const d = t.dataset;
    if (d.side) { rep.exp.color = d.side; rep.exp.path = []; paintExplorer(rep, body(rep, 'explorer')); }
    else if (d.san !== undefined) { rep.exp.path = rep.exp.path.concat(d.san); paintExplorer(rep, body(rep, 'explorer')); }
    else if (d.crumb !== undefined) { rep.exp.path = rep.exp.path.slice(0, +d.crumb); paintExplorer(rep, body(rep, 'explorer')); }
    else if (d.back !== undefined) { rep.exp.path = rep.exp.path.slice(0, -1); paintExplorer(rep, body(rep, 'explorer')); }
    else if (d.gi !== undefined) { if (rep.own && S.games[+d.gi]) { setGame(+d.gi, +d.depth || 0); navigate('play'); } }
    else if (d.pat !== undefined) { openInTree(rep, d.pat); }
    else if (d.recWalk !== undefined) { walkTo((rep.recsShown[+d.recWalk] || {}).walk); }
    else if (d.recHide !== undefined) { const r = rep.recsShown[+d.recHide]; if (r) { setHidden(new Set([..._hidden, r.id])); paintRecs(rep, body(rep, 'recs')); } }
    else if (d.recRestore !== undefined) { setHidden(new Set()); paintRecs(rep, body(rep, 'recs')); }
    else if (d.speak) { const text = rep.say[d.speak]; if (text) speak(text); }
  });
  rep.container.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const c = e.target.closest('[data-crumb]');
    if (c) { rep.exp.path = rep.exp.path.slice(0, +c.dataset.crumb); paintExplorer(rep, body(rep, 'explorer')); }
  });
  rep.container.addEventListener('change', e => {
    const s = e.target.closest('[data-cmp]');
    if (!s) return;
    rep.cmp[s.dataset.cmp] = s.value;
    paintCompare(rep, body(rep, 'compare'));
  });
}

/* "Open in the tree" is a walk, not a link: colour and path, then the same paint. */
function openInTree(rep, spec) {
  const [color, path] = String(spec).split(':');
  if (color !== 'w' && color !== 'b') return;
  rep.exp.color = color;
  rep.exp.path = path ? path.split(',') : [];
  paintExplorer(rep, body(rep, 'explorer'));
  const pane = rep.container.querySelector('[data-pane="explorer"]');
  if (pane && pane.scrollIntoView) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ===== The room ===== */

/** Drop every cache: the per-game facts, clocks and accuracies, and each report's. */
export function dropCaches() {
  for (const g of S.games) { delete g._facts; delete g._clk; delete g._acc; }
  for (const rep of _reports) rep.cache = {};
}

function enter(arg) {
  const el = $('insights-body');
  if (!el) return;
  if (!S.games.length) {
    stageRelease('insights');
    S.hero = null;
    el.innerHTML = emptyHTML('Insights is counted from your games, and there are none loaded yet. Pull your archive from Chess.com or Lichess and every card here fills itself in.', 'Import games', 'import');
    return;
  }
  const hero = resolveHero(S.games);
  S.hero = hero;
  if (!hero) {
    stageRelease('insights');
    el.innerHTML = emptyHTML('None of these games name their players, so there is nobody to count.', 'Import games', 'import');
    return;
  }
  let head = el.querySelector('.ins-head'), mount = el.querySelector('.ins-report');
  if (!head || !mount) {
    el.innerHTML = '<div class="ins-head"></div><div class="ins-report"></div>';
    head = el.querySelector('.ins-head'); mount = el.querySelector('.ins-report');
    head.addEventListener('change', e => {
      const s = e.target.closest('[data-hero]');
      if (!s) return;
      S.heroOverride = s.value;
      saveSettings();
      dropCaches();
      enter();
    });
  }
  const cands = heroCandidates(S.games).slice(0, 8);
  const st = computeStats(S.games, hero.key);
  head.innerHTML = '<h2 class="ins-subject">' + escHtml(hero.name) + '</h2>' +
    '<label class="ins-picker">Seen from <select data-hero aria-label="Whose record to show">' +
    cands.map(c => '<option value="' + escHtml(c.key) + '"' + (c.key === hero.key ? ' selected' : '') + '>' + escHtml(c.name) + ' (' + c.n + ')</option>').join('') + '</select></label>' +
    '<p class="hint">Counted <span class="num">' + st.counted + '</span> of <span class="num">' + S.games.length + '</span> games — the ones ' + escHtml(hero.name) + ' played to a result. Nothing here is fetched or stored; it is arithmetic over what is loaded.</p>';
  renderReport(mount, S.games, hero.key, { about: 'you', name: hero.name, room: 'insights' });
  if (arg) handleArg(mount, arg);
}

/* The second hash segment: a pane to scroll to, or `explorer:colour:san,san` to stand in. */
function handleArg(mount, arg) {
  const rep = reportFor(mount);
  let pane = arg;
  if (arg.startsWith('explorer')) {
    const [, color, path] = arg.split(':');
    if (color === 'w' || color === 'b') { rep.exp.color = color; rep.exp.path = path ? path.split(',') : []; paintExplorer(rep, body(rep, 'explorer')); }
    pane = 'explorer';
  }
  const el = mount.querySelector('[data-pane="' + pane + '"]');
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let _repaintTimer = 0;
function scheduleEngineRepaint(game) {
  if (game) delete game._acc;
  clearTimeout(_repaintTimer);
  _repaintTimer = setTimeout(() => { for (const rep of _reports) if (rep.container.isConnected) repaintEngine(rep); }, 300);
}

export function boot() {
  registerRoom('insights', enter);
  if (typeof document === 'undefined') return;
  document.addEventListener('cr:analysis-done', e => scheduleEngineRepaint(e.detail && e.detail.game));
  for (const ev of ['cr:games-added', 'cr:games-removed', 'cr:restored']) {
    document.addEventListener(ev, () => { dropCaches(); if (currentRoom() === 'insights') enter(); });
  }
  document.addEventListener('cr:setting', e => {
    const k = e.detail && e.detail.key;
    if ((k === 'chesscomUser' || k === 'lichessUser') && currentRoom() === 'insights') { dropCaches(); enter(); }
  });
  dbGet('meta', 'recsHidden').then(row => {
    if (row && Array.isArray(row.v)) { _hidden = new Set(row.v); for (const rep of _reports) if (rep.container.isConnected) paintRecs(rep, body(rep, 'recs')); }
  }).catch(() => { /* storage off: the session's own set stands */ });
}
