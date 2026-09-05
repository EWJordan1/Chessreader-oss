/*
 * The drill runner (§6 Learn, §6 Listen; docs/openings.md §4). Choosing what to drill
 * is Learn's; *being asked* happens here, in Listen's #drill-body, beside the board —
 * so a reader held on a guess never changes rooms to answer.
 *
 * Four kinds, two judges:
 *
 *   deck · tactics   the reader grades themselves. Nothing here can hear a move said
 *                    out loud, and the engine's one line cannot see the second-best
 *                    move, so Got it / Missed is the deck's own rule (docs/deck.md).
 *                    A typed answer that *matches the engine's move* is the one case
 *                    the app can grade without judging, and it passes the card.
 *   book             the book grades, and the reader does not: the right answer is the
 *                    reader's own earlier decision, written down, so grading against it
 *                    is transcription rather than judgement. Every ply right first time
 *                    passes the line; one miss fails it.
 *   guess            the game is the answer; playback holds before the chosen side's
 *                    moves and the reader says what comes next.
 *
 * One run at a time, in one module-level object. Starting a drill stops the one before
 * it — two questions on one board is two answers with one field.
 */
import { Chess } from 'chess.js';
import { S, currentGame } from '../state.js';
import { $, escHtml, toast, plural } from '../dom.js';
import { setDueCounter, renderNav, navigate, currentRoom } from '../route.js';
import { stageClaim, renderBoard, onRender } from '../render.js';
import { setGuessGuard, play, pause } from '../playback.js';
import { speak } from '../speech/provider.js';
import { moveToSpeech } from '../speech/grammar.js';
import { moveNumberLabel } from '../pgn.js';
import {
  deckDue, tacticsDue, gradeCard, removeCard,
  deckCardHTML, cardClaim, speakCard,
} from '../deck.js';
import { bookDue, gradeLine, bookName, walkLine } from './book.js';

const COLOUR = { w: 'White', b: 'Black' };
const IDLE_HTML = '<p class="hint">Choose a drill in Learn → Drills and it runs here, beside the board.</p>';

/* ----- The judge, and there is only one ----- */

/** A move (SAN or UCI) played on `fen` as a chess.js verbose move, or null. */
export function moveOn(fen, text) {
  const t = String(text || '').trim().replace(/[!?]+$/, '');
  if (!t || !fen) return null;
  try {
    const c = new Chess(fen);
    return /^[a-h][1-8][a-h][1-8][nbrqNBRQ]?$/.test(t)
      ? c.move({ from: t.slice(0, 2), to: t.slice(2, 4), promotion: t[4] ? t[4].toLowerCase() : undefined })
      : c.move(t);
  } catch (e) { return null; }
}

/**
 * Three verdicts, never four. `right` is the move asked for, `legal` is a move that
 * exists here and is not it, `illegal` is not a move at all — and an illegal answer
 * reveals nothing, so the question stays open rather than being spent on a typo.
 * @returns {'right'|'legal'|'illegal'}
 */
export function judgeAnswer(fen, text, expected) {
  const got = moveOn(fen, text);
  if (!got) return 'illegal';
  const want = moveOn(fen, expected);
  if (!want) return 'legal';   // no answer to compare against: never claim it was right
  return got.from === want.from && got.to === want.to && (got.promotion || '') === (want.promotion || '')
    ? 'right' : 'legal';
}

/* ----- The run ----- */

let _run = null;

/** The run in progress, or null. Read by Learn to say a drill is already going. */
export function drillState() {
  if (!_run) return null;
  const r = _run;
  return {
    kind: r.kind, i: r.i, total: r.total, right: r.right, asked: r.asked,
    revealed: !!r.revealed, side: r.side || '', at: r.at || 0, msg: r.msg || '',
    key: r.card ? r.card.key : (r.line ? r.line.key : ''),
  };
}

/**
 * Start a drill. `kind` is 'deck' | 'tactics' | 'book' | 'guess'; opts carries
 * `{side}` for the guess. Returns the state, or null when there is nothing to ask —
 * an empty drill says so in a sentence rather than opening an empty panel.
 */
export function startDrill(kind, opts = {}) {
  stopDrill({ quiet: true });
  const now = Date.now();
  if (kind === 'deck' || kind === 'tactics') {
    const queue = kind === 'tactics' ? tacticsDue(now) : deckDue(now);
    if (!queue.length) { say('Nothing is due in ' + (kind === 'tactics' ? 'your tactics' : 'the deck') + ' right now.'); return null; }
    _run = { kind, queue, i: 0, total: queue.length, card: queue[0], revealed: false, tries: 0, right: 0, asked: 0, msg: '' };
  } else if (kind === 'book') {
    const lines = bookDue(now);
    if (!lines.length) { say('No lines are due in your book right now.'); return null; }
    _run = { kind, queue: lines, i: 0, total: lines.length, right: 0, asked: 0, msg: '' };
    if (!openLine()) { _run = null; return null; }
  } else if (kind === 'guess') {
    const g = currentGame();
    if (!g || !g.moves.length) { say('Guessing needs a game to read. Import one first.'); return null; }
    const side = ['w', 'b', 'both'].includes(opts.side) ? opts.side : 'w';
    _run = { kind, side, shown: new Set(), total: 0, i: 0, right: 0, asked: 0, msg: '', revealed: false };
    setGuessGuard(guessGuard);
  } else return null;

  if (typeof document !== 'undefined') {
    if (currentRoom() !== 'play') navigate('play');
    if (_run.kind === 'guess') play(); else pause();
    claim();
    paint(true);
    focusField();
    renderNav();
  }
  return drillState();
}

/**
 * End the run and hand the board back. `renderBoard()` is the handover: Listen's claim
 * is what the room shows, and a card left on the stage after its drill is a position
 * nobody is being asked about.
 */
export function stopDrill({ quiet = false } = {}) {
  const was = _run;
  _run = null;
  setGuessGuard(null);
  if (typeof document === 'undefined') return was ? true : false;
  if (was && was.kind === 'guess') { S.awaitingGuess = false; pause(); }
  _sig = '';
  const body = $('drill-body');
  if (body && !quiet) body.innerHTML = IDLE_HTML;
  if (was) renderBoard();
  renderNav();
  return !!was;
}

function say(text) { if (typeof document !== 'undefined') toast(text); }

/* ----- The board and the panel ----- */

function claim() {
  if (typeof document === 'undefined' || !_run) return;
  const r = _run;
  if (r.kind === 'deck' || r.kind === 'tactics') {
    const pos = cardClaim(r.card, { revealed: r.revealed });
    if (pos) stageClaim('play', pos);
    return;
  }
  if (r.kind === 'book') {
    const m = r.at > 0 ? r.walk.verbose[r.at - 1] : null;
    stageClaim('play', {
      fen: r.walk.fens[r.at], from: m ? m.from : null, to: m ? m.to : null,
      flipped: r.line.color === 'b',
      label: 'Drill · ' + bookName(r.line) + ' · as ' + COLOUR[r.line.color],
      arrows: [],
      // Only what has been played: a run showing the whole line is the answer printed
      // above the question.
      line: { moves: r.walk.sans.slice(0, r.at), at: r.at, from: 0 },
    });
  }
  // 'guess' rides Listen's own claim — the board is the game being read.
}

/* A repaint of the panel is cheap, but it also blows away the field the reader is
   typing in. Everything that does not change the question is skipped. */
let _sig = '';
function paint(force) {
  if (typeof document === 'undefined') return;
  const body = $('drill-body');
  if (!body) return;
  if (!_run) { body.innerHTML = IDLE_HTML; _sig = ''; return; }
  const r = _run;
  const sig = [r.kind, r.i, r.at || 0, r.revealed ? 1 : 0, r.msg, S.gi, S.ply, S.awaitingGuess ? 1 : 0].join('|');
  if (!force && sig === _sig) return;
  _sig = sig;
  body.innerHTML = headHTML() +
    (r.kind === 'book' ? bookHTML() : r.kind === 'guess' ? guessHTML() : cardHTML());
}

function headHTML() {
  const r = _run;
  const title = { deck: 'Blunder deck', tactics: 'Missed tactics', book: 'Your book', guess: 'Guess the move' }[r.kind];
  const of = r.total ? ' <span class="num">' + (r.i + 1) + '</span> of <span class="num">' + r.total + '</span>' : '';
  return '<div class="drill-head"><h3 class="drill-title">' + title + (r.kind === 'guess' ? '' : of) + '</h3>' +
    (r.kind === 'guess' ? '<span class="muted">' + plural(r.right, 'right') + ' of ' + r.asked + '</span>' : pipsHTML()) +
    '<button class="btn btn-sm" data-act="drill-stop" type="button">Stop</button></div>';
}

function pipsHTML() {
  const r = _run;
  if (!r.total) return '';
  let out = '<span class="drill-pips" aria-hidden="true">';
  for (let i = 0; i < Math.min(r.total, 24); i++) out += '<i class="pip' + (i < r.i ? ' done' : i === r.i ? ' now' : '') + '"></i>';
  return out + '</span>';
}

/** The field, and the one place the answer is typed. */
function fieldHTML(label) {
  return '<div class="drill-answer"><label class="sr-only" for="drill-input">' + escHtml(label) + '</label>' +
    '<input id="drill-input" class="drill-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
    'placeholder="Your move — Nf3, or g1f3">' +
    '<button class="btn btn-primary" data-act="drill-answer" type="button">Answer</button></div>';
}

function msgHTML() {
  const r = _run;
  return r.msg ? '<p class="drill-msg' + (r.verdict === 'right' ? ' good' : r.verdict === 'legal' ? ' warn' : '') + '">' + escHtml(r.msg) + '</p>' : '';
}

function cardHTML() {
  const r = _run;
  if (!r.card) return '<div class="drill-done"><p class="empty">Nothing left in this stack. ' +
    plural(r.right, 'answered') + ' first time, ' + r.asked + ' asked.</p>' +
    '<button class="btn" data-act="drill-stop" type="button">Done</button></div>';
  return '<div class="drill-card-wrap">' + deckCardHTML(r.card, { revealed: r.revealed }) + '</div>' +
    (r.revealed ? '' : fieldHTML('Your move')) + msgHTML() +
    (r.revealed ? '' : '<p class="hint drill-aside"><button class="btn btn-sm btn-ghost" data-act="drill-skip" type="button">Skip</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="drill-remove" type="button">Remove this card</button></p>');
}

function bookHTML() {
  const r = _run;
  if (!r.line) return '<div class="drill-done"><p class="empty">Your book is answered for now. ' +
    plural(r.right, 'line') + ' of ' + r.asked + ' clean.</p><button class="btn" data-act="drill-stop" type="button">Done</button></div>';
  const done = r.at >= r.walk.sans.length;
  return '<div class="drill-line">' +
    '<p class="card-label">' + escHtml(bookName(r.line)) + ' · as ' + COLOUR[r.line.color] + '</p>' +
    (done
      ? '<p class="card-question">The line is finished.</p>'
      : '<p class="card-question">Your move as ' + COLOUR[r.line.color] + ' — ' + escHtml(moveNumberLabel(r.at)) + '</p>') +
    '<p class="drill-plies" aria-hidden="true">' + linePipsHTML() + '</p></div>' +
    (done ? '' : fieldHTML('Your move as ' + COLOUR[r.line.color])) + msgHTML() +
    (done ? '' : '<p class="hint drill-aside"><button class="btn btn-sm btn-ghost" data-act="drill-reveal" type="button">Show me</button></p>');
}

function linePipsHTML() {
  const r = _run;
  let out = '';
  r.walk.verbose.forEach((m, n) => {
    if (m.color !== r.line.color) return;
    out += '<i class="pip' + (n < r.at ? (r.missedAt.has(n) ? ' bad' : ' done') : n === r.at ? ' now' : '') + '"></i>';
  });
  return out;
}

function guessHTML() {
  const r = _run;
  const g = currentGame();
  if (!g) return '<p class="empty">The game went away. ' +
    '<button class="btn btn-sm" data-act="drill-stop" type="button">Stop the drill</button></p>';
  if (!S.awaitingGuess) {
    return '<p class="hint">Reading ' + escHtml((g.headers.White || '?') + ' vs ' + (g.headers.Black || '?')) +
      '. It stops before ' + (r.side === 'both' ? 'every move' : COLOUR[r.side] + '’s moves') + '.</p>' + msgHTML();
  }
  const mv = g.moves[S.ply];
  return '<p class="card-question">' + escHtml(moveNumberLabel(S.ply)) + ' — what does ' +
    COLOUR[mv ? mv.color : (S.ply % 2 === 0 ? 'w' : 'b')] + ' play?</p>' +
    fieldHTML('The move') + msgHTML() +
    '<p class="hint drill-aside"><button class="btn btn-sm btn-ghost" data-act="drill-reveal" type="button">Show me</button></p>';
}

function focusField() {
  if (typeof document === 'undefined') return;
  const el = $('drill-input');
  if (el) el.focus();
}

/* ----- deck / tactics ----- */

/* `carry` is the verdict on the card just closed: the next question replaces the
   panel, and without it the reader never sees that they got the last one right. */
function dealCard(step = 1, carry = '', verdict = '') {
  const r = _run;
  r.i += step;
  r.card = r.queue[r.i] || null;
  r.revealed = false;
  r.tries = 0;
  r.msg = carry; r.verdict = verdict;
  if (!r.card) { claimNothing(); paint(true); return; }
  claim();
  paint(true);
  focusField();
}

/* The stack ran out: the board goes back to Listen but the panel stays, because the
   report of what just happened is the point of finishing. */
function claimNothing() { if (typeof document !== 'undefined') renderBoard(); }

function gradeAndNext(pass, carry = '', verdict = '') {
  const r = _run;
  r.asked++;
  if (pass && !r.tries) r.right++;
  gradeCard(r.card, pass, Date.now(), r.kind === 'tactics' ? 'tactics' : 'deck');
  dealCard(1, carry, verdict);
}

/* ----- book ----- */

function openLine() {
  const r = _run;
  r.line = r.queue[r.i] || null;
  r.msg = ''; r.verdict = '';
  if (!r.line) { claimNothing(); paint(true); return false; }
  const walk = walkLine(r.line.moves);
  // A line in the store can never be illegal (book.js validates on the way in), but a
  // row restored from a hand-edited export can be: drop it rather than deal it.
  if (!walk) { r.i++; return openLine(); }
  r.walk = walk;
  r.at = 0;
  r.missedAt = new Set();
  bookStep();
  return true;
}

/*
 * Walk the line to the reader's next move. The other side plays itself and is spoken,
 * chained on the end of speech rather than on a timer — a second speak() in the same
 * tick cancels the first, and the reader would hear only the last move of a run.
 */
function bookStep() {
  const r = _run;
  const step = () => {
    if (_run !== r || !r.line) return;
    if (r.at >= r.walk.sans.length) { finishLine(); return; }
    const m = r.walk.verbose[r.at];
    if (m.color === r.line.color) { claim(); paint(true); focusField(); return; }
    r.at++;
    claim(); paint(true);
    // Chained on the end of speech, not on a timer: speak() cancels what is in flight,
    // so a run of moves fired in one tick would be heard as only its last move.
    speak(moveToSpeech(m, S.verbosity), step);
  };
  step();
}

function finishLine() {
  const r = _run;
  const clean = r.missedAt.size === 0;
  r.asked++;
  if (clean) r.right++;
  gradeLine(r.line, clean, Date.now());
  const msg = clean ? 'Clean — ' + bookName(r.line) + ' climbs a box.'
    : plural(r.missedAt.size, 'move') + ' missed, so this line is back in ten minutes.';
  r.i++;
  if (!openLine()) return;
  // openLine cleared the message for the new line; the verdict on the line just closed
  // is the one thing worth carrying over it.
  r.msg = msg;
  r.verdict = clean ? 'right' : 'legal';
  paint(true);
}

/* ----- guess ----- */

/**
 * Hold before this ply? Only for the side being drilled, and never for a ply already
 * shown — releasing by *play()* re-enters playStep at the same ply, so a guard that
 * did not remember what it had released would hold on it forever.
 */
export function guessGuard(game, ply) {
  const r = _run;
  if (!r || r.kind !== 'guess' || !game) return false;
  const m = game.moves && game.moves[ply];
  if (!m) return false;
  if (r.side !== 'both' && m.color !== r.side) return false;
  return !r.shown.has(shownKey(game, ply));
}
const shownKey = (game, ply) => (game.id || '') + ':' + ply;

function releaseGuess(game, ply) {
  const r = _run;
  r.shown.add(shownKey(game, ply));
  S.awaitingGuess = false;
  play();
}

/* ----- Answering ----- */

/**
 * The reader's answer, whatever is being asked. One entry, because the field is one
 * field: the runner knows which of the three judges the run is standing in.
 */
export function answerDrill(text) {
  const r = _run;
  if (!r) return;
  if (r.kind === 'guess') return submitGuess(text);
  if (r.kind === 'book') return submitBook(text);
  return submitCard(text);
}

function submitCard(text) {
  const r = _run;
  if (!r.card || r.revealed) return;
  const v = judgeAnswer(r.card.fen, text, r.card.answer);
  r.verdict = v;
  if (v === 'right') {
    // The one case the app can grade without judging: the answer the engine gave is
    // the answer on the card, and matching it is not an opinion.
    gradeAndNext(true, 'Right — that is the engine\u2019s move.', 'right');
    return;
  }
  // A wrong answer does not grade the card. The reveal's Got it / Missed is the deck's
  // own rule, and a mistyped move is not a missed one.
  r.tries++;
  r.msg = v === 'illegal' ? 'That is not a legal move here.' : 'Legal, but not the engine\'s move. Try again, or reveal it.';
  paint(true);
  focusField();
}

function submitBook(text) {
  const r = _run;
  if (!r.line || r.at >= r.walk.sans.length) return;
  const want = r.walk.sans[r.at];
  const v = judgeAnswer(r.walk.fens[r.at], text, want);
  r.verdict = v;
  if (v === 'right') {
    r.msg = '';
    r.at++;
    bookStep();
    return;
  }
  // One miss fails the line, and it is recorded against the ply rather than as a flag:
  // a multi-question line must know *which* ply went wrong, not merely that one did.
  r.missedAt.add(r.at);
  r.msg = v === 'illegal' ? 'Not a legal move here. Your book plays ' + want + '.'
    : moveOn(r.walk.fens[r.at], text).san + ' is legal. Your book plays ' + want + ' here.';
  r.at++;
  bookStep();
}

function submitGuess(text) {
  const r = _run;
  const g = currentGame();
  if (!g || !S.awaitingGuess) return;
  const ply = S.ply;
  const m = g.moves[ply];
  if (!m) return;
  const v = judgeAnswer(g.fens[ply], text, m.san);
  r.asked++;
  if (v === 'right') {
    r.right++;
    r.msg = 'Right — ' + m.san + '.';
    r.verdict = 'right';
    releaseGuess(g, ply);
    return;
  }
  r.asked--;   // an illegal answer spends nothing: the question is still open
  r.verdict = v;
  r.msg = v === 'illegal' ? 'That is not a legal move here.' : 'Legal, but not what was played.';
  paint(true);
  focusField();
}

/** "Show me" — the other press, and the only other thing the field's row can do. */
export function revealDrill() {
  const r = _run;
  if (!r) return;
  if (r.kind === 'guess') {
    const g = currentGame();
    if (!g || !S.awaitingGuess) return;
    const m = g.moves[S.ply];
    r.asked++;
    r.msg = 'It was ' + m.san + '.';
    r.verdict = 'legal';
    releaseGuess(g, S.ply);
    return;
  }
  if (r.kind === 'book') {
    if (!r.line || r.at >= r.walk.sans.length) return;
    r.missedAt.add(r.at);
    r.msg = 'Your book plays ' + r.walk.sans[r.at] + ' here.';
    r.verdict = 'legal';
    r.at++;
    bookStep();
    return;
  }
  r.revealed = true;
  r.msg = '';
  claim();
  paint(true);
}

/* ----- Wiring ----- */

function onClick(e) {
  const el = e.target.closest('button');
  if (!el || !_run) return;
  const act = el.dataset.act;
  const grade = el.dataset.grade;
  const r = _run;
  if (grade === 'pass' || grade === 'fail') { gradeAndNext(grade === 'pass'); return; }
  if (act === 'reveal') { revealDrill(); return; }
  if (act === 'speak') {
    if (r.kind === 'book' && r.line) speak(bookName(r.line) + '. Your move as ' + COLOUR[r.line.color] + '.');
    else if (r.card) speakCard(r.card, { revealed: r.revealed });
    return;
  }
  switch (act) {
    case 'drill-stop': stopDrill(); break;
    case 'drill-answer': { const f = $('drill-input'); answerDrill(f ? f.value : ''); break; }
    case 'drill-reveal': revealDrill(); break;
    case 'drill-skip': if (r.card) dealCard(1); break;
    case 'drill-remove': {
      if (!r.card) break;
      const card = r.card;
      removeCard(card.key, r.kind === 'tactics' ? 'tactics' : 'deck');
      toast('That card left your deck.');
      r.queue.splice(r.i, 1);
      r.total = r.queue.length;
      dealCard(0);
      break;
    }
    default: break;
  }
}

export function boot() {
  if (typeof document === 'undefined') return;
  // The Learn badge: deck cards, book lines and tactics, counted once each.
  setDueCounter(() => deckDue().length + bookDue().length + tacticsDue().length);
  const repaint = () => renderNav();
  document.addEventListener('cr:deck-changed', repaint);
  document.addEventListener('cr:book-changed', repaint);
  document.addEventListener('cr:restored', repaint);
  // A guess drill is about one library; if the game under it is evicted, stop rather
  // than hold on a ply of something that is gone.
  document.addEventListener('cr:games-removed', () => { if (_run && _run.kind === 'guess' && !currentGame()) stopDrill(); });

  const body = $('drill-body');
  if (!body) return;
  body.innerHTML = IDLE_HTML;
  body.addEventListener('click', onClick);
  body.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'drill-input') { e.preventDefault(); answerDrill(e.target.value); }
  });
  // Playback repaints the board on every ply, and the guess prompt lives on that beat:
  // the loop has no callback for "held", so the board's repaint is the signal.
  onRender('board', () => { if (_run) paint(false); });
}
