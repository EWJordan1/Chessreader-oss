/*
 * The player (§6 Listen). playStep() is a self-rescheduling state machine, not a
 * fixed-interval tick, so the gap between moves is measured from the *end* of speech.
 * Every navigation action moves the cursor and then either re-enters the loop or
 * repaints. There is no separate seek path.
 */
import { Chess } from 'chess.js';
import { S, currentGame, inVariation, saveSettings } from './state.js';
import { speak, cancelSpeech } from './speech/provider.js';
import { moveToSpeech, announcementSpeech, resultSpeech, openingAnnouncement } from './speech/grammar.js';
import { updateAll, updateNowPlaying, updateTransport, renderBoard, sayNow } from './render.js';

const _cursorListeners = [];
/** memory.js listens here to debounce the cursor to disk. */
export function onCursor(fn) { _cursorListeners.push(fn); }
function noteCursor() { for (const fn of _cursorListeners) fn(); }

export function resetAnnounceFlags() { S.announced = false; S.openingSaid = false; }

function afterPly() {
  noteCursor();
  updateNowPlaying();
  renderBoard();
}

export function play() {
  if (!S.games.length) return;
  exitVariation(true);
  S.playing = true;
  updateTransport();
  playStep();
}

export function pause() {
  S.playing = false;
  S.awaitingGuess = false;
  clearTimeout(S.timer);
  cancelSpeech();
  updateTransport();
}

export function togglePlay() { S.playing ? pause() : play(); }

let _guard = null;   // (game, ply) => true to hold before speaking this ply — drills install it
export function setGuessGuard(fn) { _guard = fn; }
/*
 * The spoken verdict: review.js installs (game, n) => 'Blunder. The engine preferred
 * knight f3.' or '' for a move that was fine. Appended to the move's sentence so an
 * error is heard in the same breath as the move, and only when a verdict exists —
 * classifyMove's guard is what keeps a forced recapture from being called a blunder.
 */
let _verdict = null;
export function setVerdictSpeech(fn) { _verdict = fn; }
/*
 * The loop has stopped and is waiting for an answer. A drill needs to know the moment
 * it happens rather than inferring it from the next board repaint: the hold is a state
 * of the *reading*, and the board has not changed when it begins.
 */
const _holds = [];
export function onGuessHold(fn) { _holds.push(fn); }

/*
 * One step of the reading. Speaks whichever of the four things is due at the cursor —
 * the announcement, the opening name, the result, or the move — then, from the end of
 * speech, waits S.interval and comes back.
 */
export function playStep() {
  if (!S.playing) return;
  const g = currentGame();
  if (!g) { pause(); return; }
  clearTimeout(S.timer);
  const next = (ms = S.interval) => { S.timer = setTimeout(playStep, ms); };

  if (S.ply === 0 && !S.announced) {
    S.announced = true;
    if (S.announce) { speak(announcementSpeech(g.headers), () => next(600), () => sayNow(announcementSpeech(g.headers))); return; }
  }
  if (S.ply >= g.moves.length) {
    const text = S.announce ? resultSpeech(g.headers) : '';
    afterPly();
    speak(text, endOfGame, () => sayNow(text));
    return;
  }
  if (_guard && _guard(g, S.ply)) {
    S.awaitingGuess = true;
    afterPly();
    updateTransport();
    for (const fn of _holds) fn(g, S.ply);
    return;
  }
  const m = g.moves[S.ply];
  let text = moveToSpeech(m, S.verbosity);
  // The opening name lands mid-game, hung off the move where the URL's line ends.
  if (!S.openingSaid && S.announce) {
    const op = openingAnnouncement(g.headers);
    if (op && op.ply === S.ply + 1) { text = text.replace(/\.$/, '') + op.clause.replace(/\.$/, '') + '.'; S.openingSaid = true; }
    else if (op && op.ply === 0 && S.ply === 0) { text = op.clause + ' ' + text; S.openingSaid = true; }
  }
  if (_verdict) { const v = _verdict(g, S.ply); if (v) text += ' ' + v; }
  S.ply++;
  afterPly();
  const gap = S.blackPause && m.color === 'b' ? S.interval * 2 : S.interval;
  speak(text, () => next(gap), () => sayNow(text));
}

function endOfGame() {
  if (S.repeat === 'game') { S.ply = 0; resetAnnounceFlags(); afterPly(); S.timer = setTimeout(playStep, S.interval); return; }
  if (S.gi < S.games.length - 1) { S.gi++; S.ply = 0; resetAnnounceFlags(); updateAll(); S.timer = setTimeout(playStep, S.interval); return; }
  if (S.repeat === 'queue' && S.games.length) { S.gi = 0; S.ply = 0; resetAnnounceFlags(); updateAll(); S.timer = setTimeout(playStep, S.interval); return; }
  pause();
}

function reenter() {
  if (S.playing) { clearTimeout(S.timer); cancelSpeech(); playStep(); }
  else afterPly();
}

export function nextMove() {
  if (inVariation()) { varStep(1); return; }
  const g = currentGame(); if (!g) return;
  if (S.ply < g.moves.length) { S.ply++; reenter(); }
}
export function prevMove() {
  if (inVariation()) { varStep(-1); return; }
  if (!currentGame()) return;
  if (S.ply > 0) { S.ply--; reenter(); }
}
export function goToPly(n) {
  const g = currentGame(); if (!g) return;
  exitVariation(true);
  const ply = Math.max(0, Math.min(g.moves.length, n));
  if (ply === S.ply) { afterPly(); return; }
  S.ply = ply;
  if (ply === 0) resetAnnounceFlags();
  reenter();
}
export function setGame(i, ply = 0) {
  if (!S.games[i]) return;
  exitVariation(true);
  S.gi = i; S.ply = Math.max(0, Math.min(S.games[i].moves.length, ply)); resetAnnounceFlags();
  if (S.playing) { clearTimeout(S.timer); cancelSpeech(); updateAll(); playStep(); } else updateAll();
  noteCursor();
}
export function nextGame() { if (S.gi < S.games.length - 1) setGame(S.gi + 1); }
export function prevGame() { if (S.gi > 0) setGame(S.gi - 1); }
export function restartGame() { if (currentGame()) goToPly(0); }

export function flipBoard() { S.flipped = !S.flipped; renderBoard(); }

/* ----- Variations: a position the game never reached, so not a ply (§7) ----- */
export function exitVariation(silent) {
  if (!inVariation()) return;
  S.varFrom = -1; S.varMoves = []; S.varFens = []; S.varAt = 0;
  if (!silent) afterPly();
}

/**
 * Walk a move (UCI or SAN) from the position on screen. From the game it starts a
 * variation at S.ply; from inside one it *extends* it rather than starting another.
 */
export function enterVariation(move) {
  const g = currentGame(); if (!g) return false;
  const baseFen = inVariation() ? S.varFens[S.varAt] : g.fens[S.ply];
  const chess = new Chess(baseFen);
  let m = null;
  try {
    m = /^[a-h][1-8][a-h][1-8][nbrq]?$/.test(move)
      ? chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
      : chess.move(move);
  } catch (e) { m = null; }
  if (!m) return false;
  if (S.playing) pause();
  if (!inVariation()) { S.varFrom = S.ply; S.varMoves = []; S.varFens = [baseFen]; S.varAt = 0; }
  // Branching from the middle of a line replaces its tail — one continuous thought.
  S.varMoves = S.varMoves.slice(0, S.varAt).concat([m]);
  S.varFens = S.varFens.slice(0, S.varAt + 1).concat([m.after]);
  S.varAt = S.varMoves.length;
  afterPly();
  sayNow(moveToSpeech(m, S.verbosity));
  return true;
}
export function varStep(d) {
  if (!inVariation()) return;
  S.varAt = Math.max(0, Math.min(S.varMoves.length, S.varAt + d));
  afterPly();
  const m = S.varMoves[S.varAt - 1];
  sayNow(m ? moveToSpeech(m, S.verbosity) : '');
}
export function varGoTo(n) { if (inVariation()) { S.varAt = Math.max(0, Math.min(S.varMoves.length, n)); afterPly(); } }
export function varUndo() { if (!inVariation()) return; if (S.varMoves.length <= 1) { exitVariation(); return; } S.varMoves.pop(); S.varFens.pop(); S.varAt = S.varMoves.length; afterPly(); }

/* Settings that live on the Listen panel. */
export function setInterval_(ms) { S.interval = ms; saveSettings(); }
