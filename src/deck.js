/*
 * The deck (§5, §14 step 11): every position where one move cost the subject three
 * pawns or more becomes a card, drilled like a flashcard; the band just below is the
 * missed-tactics collection, on the same schedule. Both stores are EARNED, not cached:
 * a row is self-contained — position, the move played, the move before it, the
 * engine's answer, both evaluations, who, against whom, when — so it draws, speaks,
 * reveals and explains itself after the game that produced it has been evicted.
 *
 * This module provides the data, the schedule, the one card renderer, the stage claim
 * and the speech. Dealing cards in Listen is the drill runner's job (src/learn/drills.js).
 */
import { Chess } from 'chess.js';
import { S } from './state.js';
import { dbPutAll, dbPut, dbDelete } from './memory.js';
import { moveToSpeech, positionSpeech } from './speech/grammar.js';
import { speak } from './speech/provider.js';
import { escHtml, toast, plural } from './dom.js';
import { fenPly } from './pgn.js';
import { COLORS } from './board.js';

/*
 * A card is a move that cost the mover three pawns — the annotator's blunder line, and
 * conventional on purpose: a reader who has seen chess.com's numbers should not have to
 * learn ours. The tactic band sits directly below it: two pawns the engine saw and the
 * reader did not, short of a blunder. Half-open so no ply is ever in both stores.
 */
export const DECK_SWING = 300;
export const TACTIC_BAND = [200, 300];
/*
 * Leitner, in days. A card found goes one box further out; five boxes retire a
 * position for two months, which is as long as a blunder from one of your own games
 * is worth leaving alone. `box` counts consecutive passes (0 = the front), so the
 * interval a pass earns is DECK_BOXES[box - 1].
 */
export const DECK_BOXES = [1, 3, 7, 21, 60];
// A card missed returns this sitting, not tomorrow: the point of missing it is that
// you have just been shown the answer and have not yet had to find it yourself.
export const DECK_RETRY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/*
 * A mate has to become a number before it can be compared with a centipawn one, and
 * the number must outrank any material. Ten thousand: past every material loss a
 * position can hold, and small enough that a printed figure is still a figure.
 */
const MATE_SCORE = 10000;

function score(ev) {
  if (!ev) return null;
  if (ev.mate !== undefined) return ev.mate > 0 ? MATE_SCORE : ev.mate < 0 ? -MATE_SCORE : 0;
  return Number.isFinite(ev.cp) ? ev.cp : null;
}

/**
 * Centipawns the mover lost between two White-positive evaluations, floored at zero,
 * or null when either is missing. Exported because a card carries `before`/`after`
 * and not a `loss`: one function reads the figure off every card this app writes.
 */
export function lossBetween(before, after, color) {
  const b = score(before), a = score(after);
  if (b === null || a === null) return null;
  return Math.max(0, color === 'w' ? b - a : a - b);
}
export function cardLoss(card) { return lossBetween(card.before, card.after, card.color); }

/** True when the played move walked into a forced mate — a different sentence from a number. */
export function cardMated(card) {
  const m = card.after && card.after.mate;
  return m !== undefined && m !== null && (card.color === 'w' ? m < 0 : m > 0);
}

function uci(move) { return move ? move.from + move.to + (move.promotion || '') : ''; }
function keep(ev) {
  if (!ev) return null;
  if (ev.mate !== undefined) return { mate: ev.mate };
  if (ev.cp !== undefined) return { cp: ev.cp };
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "4 Mar 2025" off a PGN date, or '' when the header names no day. */
export function dateLabel(headers) {
  const raw = headers.UTCDate && !/\?/.test(headers.UTCDate) ? headers.UTCDate : headers.Date || '';
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(raw);
  if (!m || m[1] === '0000' || !MONTHS[+m[2] - 1]) return '';
  return +m[3] + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
}

function cleanName(s) { s = String(s || '').trim(); return s === '?' ? '' : s; }

/* ----- Harvesting ----- */

/**
 * The cards a finished analysis supports, split by store. Nothing until every ply is
 * evaluated: a half-scanned game would harvest half a deck and the second half would
 * arrive with fresh `addedAt`s, which is the week's figures lying about growth.
 *
 * @param game     a game with `analysis`
 * @param heroKey  lowercased player name; only that player's moves. `undefined` reads
 *                 S.hero; null or '' harvests both colours.
 */
export function harvestDeck(game, heroKey) {
  const out = { deck: [], tactics: [] };
  const a = game && game.analysis;
  if (!a || !game.fens || a.done !== game.fens.length || !game.id) return out;
  if (heroKey === undefined) heroKey = (S.hero && S.hero.key) || null;
  const hero = heroKey ? String(heroKey).toLowerCase() : null;
  const white = cleanName(game.headers.White), black = cleanName(game.headers.Black);
  const now = Date.now();
  for (let n = 0; n < game.moves.length; n++) {
    const move = game.moves[n];
    const player = move.color === 'w' ? white : black;
    if (hero && player.toLowerCase() !== hero) continue;
    const answer = a.best[n];
    const played = uci(move);
    /*
     * The engine's own move is not an error whatever the numbers say: `before` and
     * `after` are two independent depth-limited searches and drift a little between
     * them even when nothing was lost, so a forced recapture would otherwise pick up
     * the drift and be filed as a mistake. A trainer telling someone their only move
     * was a blunder teaches something false. No answer at all means no card: a card
     * that cannot reveal itself is not a card.
     */
    if (!answer || answer === played || answer.slice(0, 4) === played.slice(0, 4)) continue;
    const before = keep(a.evals[n]), after = keep(a.evals[n + 1]);
    const loss = lossBetween(before, after, move.color);
    if (loss === null) continue;
    const store = loss >= DECK_SWING ? 'deck' : loss >= TACTIC_BAND[0] && loss < TACTIC_BAND[1] ? 'tactics' : null;
    if (!store) continue;
    out[store].push({
      key: game.id + ':' + n, gameId: game.id, ply: n,
      fen: game.fens[n],
      played, previous: n > 0 ? uci(game.moves[n - 1]) : '', answer,
      before, after,
      color: move.color,
      player, opponent: move.color === 'w' ? black : white,
      date: dateLabel(game.headers), site: cleanName(game.headers.Site),
      box: 0, due: now, seen: 0, passes: 0, fails: 0, lastAt: 0, addedAt: now,
    });
  }
  return out;
}

/* ----- The stores ----- */

const SCHEDULE = ['box', 'due', 'seen', 'passes', 'fails', 'lastAt', 'addedAt'];
function mapOf(store) { return store === 'tactics' ? S.tactics : S.deck; }
function changed() {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent('cr:deck-changed'));
}

/**
 * Fold harvested cards into a store. An existing card keeps its schedule — re-analysing
 * a game must never send a card the reader has climbed to box four back to the front —
 * and only gains fields it lacked (which is also how an older row grows the shape).
 * Returns how many are new. The write is fire-and-forget: with memory off it resolves
 * false and the deck is a session's worth of cards, the same bargain the games are on.
 */
export function mergeDeck(cards, store = 'deck') {
  const map = mapOf(store);
  const rows = [];
  let added = 0;
  for (const c of cards || []) {
    if (!c || !c.key) continue;
    const old = map.get(c.key);
    if (!old) { map.set(c.key, c); rows.push(c); added++; continue; }
    let filled = false;
    for (const k of Object.keys(c)) {
      if (SCHEDULE.includes(k)) continue;
      if (old[k] === undefined || old[k] === null || old[k] === '') { old[k] = c[k]; filled = true; }
    }
    if (filled) rows.push(old);
  }
  if (rows.length) {
    Promise.resolve(dbPutAll(store, rows)).catch(() => {});
    changed();
  }
  return added;
}

/** Cards due at `now`, the longest-waiting first; among equals, the most-missed. */
function dueFrom(map, now) {
  const out = [];
  for (const c of map.values()) if (c.due <= now) out.push(c);
  return out.sort((a, b) => (a.due - b.due) || ((b.fails || 0) - (a.fails || 0)) || ((a.addedAt || 0) - (b.addedAt || 0)));
}
export function deckDue(now = Date.now()) { return dueFrom(S.deck, now); }
export function tacticsDue(now = Date.now()) { return dueFrom(S.tactics, now); }

/** Which store a card lives in, by key; the deck when it is in neither yet. */
export function storeOf(card) {
  if (S.tactics.has(card.key) && !S.deck.has(card.key)) return 'tactics';
  return 'deck';
}

/**
 * The Leitner step. A pass moves the card one box out and it is due in that box's
 * days; a miss sends it to the front and it is back in ten minutes. The reader grades
 * themselves — nothing here can hear a move said out loud, and entering it on the
 * board would take the drill off the ear.
 */
export function gradeCard(card, pass, now = Date.now(), store = storeOf(card)) {
  card.seen = (card.seen || 0) + 1;
  card.lastAt = now;
  if (pass) {
    card.box = Math.min((card.box || 0) + 1, DECK_BOXES.length);
    card.due = now + DECK_BOXES[card.box - 1] * DAY_MS;
    card.passes = (card.passes || 0) + 1;
  } else {
    card.box = 0;
    card.due = now + DECK_RETRY_MS;
    card.fails = (card.fails || 0) + 1;
  }
  Promise.resolve(dbPut(store, card)).catch(() => {});
  changed();
  return card;
}

export function removeCard(key, store = 'deck') {
  const map = mapOf(store);
  if (!map.delete(key)) return false;
  Promise.resolve(dbDelete(store, key)).catch(() => {});
  changed();
  return true;
}

/* ----- Reading a card ----- */

/** A UCI move as a chess.js verbose move from the card's position, or null. */
export function cardMove(fen, u) {
  if (!fen || !/^[a-h][1-8][a-h][1-8]/.test(u || '')) return null;
  try {
    return new Chess(fen).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
  } catch (e) { return null; }
}
const sanOf = (fen, u) => { const m = cardMove(fen, u); return m ? m.san : (u || ''); };

/** "+2.6", "−0.4", "+M3" — an evaluation as the card prints it, White-positive. */
export function fmtEval(ev) {
  if (!ev) return '';
  if (ev.mate !== undefined) return (ev.mate > 0 ? '+' : '−') + 'M' + Math.abs(ev.mate);
  const v = ev.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}

function moveNo(card) { return Math.floor(card.ply / 2) + 1; }
/** "Drill card · Black to move, move 23 · vs opponent · 4 Mar 2025" */
export function cardLabel(card) {
  return ['Drill card', COLORS[card.color] + ' to move, move ' + moveNo(card),
    card.opponent ? 'vs ' + card.opponent : '', card.date || ''].filter(Boolean).join(' · ');
}
export function cardQuestion(card) { return 'What should ' + COLORS[card.color] + ' play here?'; }

/**
 * The one card renderer. No board in it: the position is on the stage, through
 * cardClaim(). What the card does NOT say before the reveal is the move that was
 * played — naming it narrows "find a move here" to "find the refutation of Bxf7+",
 * which is a different and much easier exercise. The buttons carry data attributes
 * (data-act="reveal|speak", data-grade="pass|fail") for the runner to delegate on;
 * `.card-why` is the placeholder the ai module fills.
 */
export function deckCardHTML(card, { revealed = false } = {}) {
  if (!card || !card.fen) return '';
  const key = escHtml(card.key);
  let html = '<div class="deck-card" data-key="' + key + '">' +
    '<p class="card-label">' + escHtml(cardLabel(card)) + '</p>' +
    '<p class="card-question">' + escHtml(cardQuestion(card)) + '</p>';
  if (!revealed) {
    html += '<div class="card-actions">' +
      '<button type="button" class="btn btn-ghost" data-act="speak">Speak the position</button>' +
      '<button type="button" class="btn btn-primary" data-act="reveal">Reveal</button></div>';
    return html + '</div>';
  }
  const played = sanOf(card.fen, card.played), answer = sanOf(card.fen, card.answer);
  const loss = cardLoss(card);
  const cost = cardMated(card) ? 'It walked into mate.' : loss !== null ? 'It cost ' + (loss / 100).toFixed(1) + '.' : '';
  html += '<p class="card-answer">You played <span class="san">' + escHtml(played) + '</span>. ' +
    'The engine plays <span class="san">' + escHtml(answer) + '</span>.</p>' +
    '<p class="card-evals"><span class="num">' + escHtml(fmtEval(card.before)) + '</span> before, ' +
    '<span class="num">' + escHtml(fmtEval(card.after)) + '</span> after' + (cost ? '. ' + escHtml(cost) : '.') + '</p>' +
    '<div class="card-why" data-key="' + key + '"></div>' +
    '<div class="card-actions">' +
    '<button type="button" class="btn btn-ghost" data-act="speak">Speak the answer</button>' +
    '<button type="button" class="btn btn-primary" data-grade="pass">Got it</button>' +
    '<button type="button" class="btn" data-grade="fail">Missed</button></div>';
  return html + '</div>';
}

/**
 * A card's claim on the stage: the position from the side that had to find the move,
 * with the move that reached it lit — context, not a hint. After the reveal the
 * answer and the played move are arrows, green and amber, the legend the stage already
 * wears. The score panel is empty: a card carries no game, and numbering it from its
 * own ply is what `from` is for.
 */
export function cardClaim(card, { revealed = false } = {}) {
  if (!card || !card.fen) return null;
  const prev = /^[a-h][1-8][a-h][1-8]/.test(card.previous || '') ? card.previous : '';
  const arrows = [];
  if (revealed) {
    if (card.answer) arrows.push({ from: card.answer.slice(0, 2), to: card.answer.slice(2, 4), kind: 'best' });
    if (card.played) arrows.push({ from: card.played.slice(0, 2), to: card.played.slice(2, 4), kind: 'missed' });
  }
  return {
    fen: card.fen,
    from: prev ? prev.slice(0, 2) : null, to: prev ? prev.slice(2, 4) : null,
    flipped: card.color === 'b',
    label: cardLabel(card),
    arrows,
    line: { moves: [], at: 0, from: fenPly(card.fen) },
  };
}

/* ----- Speaking a card ----- */

/** "Knight takes e5." → "knight takes e5", for the middle of a sentence. */
function clause(move) {
  const s = moveToSpeech(move, 'natural').replace(/\.$/, '');
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "You played knight takes e5. The engine plays bishop f7, check." */
export function cardAnswerSpeech(card) {
  const played = cardMove(card.fen, card.played), answer = cardMove(card.fen, card.answer);
  const parts = [];
  if (played) parts.push('You played ' + clause(played) + '.');
  if (answer) parts.push('The engine plays ' + clause(answer) + '.');
  return parts.join(' ');
}

/**
 * Say the card: the position the way a player dictates one, then the question; after
 * the reveal, the answer. Two utterances chained on completion rather than two calls —
 * speak() cancels what is in flight, so a second call in the same tick would eat the first.
 */
export function speakCard(card, { revealed = false } = {}) {
  if (!card || !card.fen) return;
  if (revealed) { speak(cardAnswerSpeech(card)); return; }
  speak(positionSpeech(card.fen), () => speak(cardQuestion(card)));
}

/* ----- The week, for Home ----- */

/**
 * What changed this week across both stores: cards drilled, cards due now, cards
 * earned, and the single most expensive move among the new ones (null when nothing
 * was earned — a "worst" read off an empty week is a card from some other week).
 */
export function weekStats(now = Date.now()) {
  const since = now - WEEK_MS;
  const out = { drilled: 0, due: 0, grew: 0, worst: null };
  let worstLoss = -1;
  for (const map of [S.deck, S.tactics]) {
    for (const c of map.values()) {
      if (c.lastAt && c.lastAt > since) out.drilled++;
      if (c.due <= now) out.due++;
      if (c.addedAt > since) {
        out.grew++;
        const loss = cardLoss(c);
        if (loss !== null && loss > worstLoss) { worstLoss = loss; out.worst = c; }
      }
    }
  }
  return out;
}

/* ----- Boot ----- */

const _toasted = new Set();   // games already announced this session

/**
 * A finished scan harvests itself: cards are arithmetic over evaluations already paid
 * for, so this is not a job in the §2.7 sense. The subject is whoever Insights resolved;
 * without one, both players' mistakes are harvested.
 */
export function onAnalysisDone(game) {
  if (!game) return 0;
  const { deck, tactics } = harvestDeck(game);
  const added = mergeDeck(deck, 'deck') + mergeDeck(tactics, 'tactics');
  if (added && !_toasted.has(game.id)) {
    _toasted.add(game.id);
    if (typeof document !== 'undefined') toast(plural(added, 'card') + ' earned from this game.');
  }
  return added;
}

export function boot() {
  if (typeof document === 'undefined') return;
  document.addEventListener('cr:analysis-done', e => onAnalysisDone(e.detail && e.detail.game));
}
