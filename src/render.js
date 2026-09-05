/*
 * Rendering. updateAll() fans out to the four repaint functions; everything reads S
 * and nothing holds a copy.
 *
 * The stage: one board in the shell, claimed by whichever room has a position to put
 * on it. Claims are held per room, so a reader walking out of Insights and back finds
 * the node they stood on; only the room on screen is drawn. A room with nothing to show
 * does not claim — a start position on an idle board is a chessboard used as decoration.
 */
import { S, currentGame, inVariation, viewFEN } from './state.js';
import { boardHTML, arrowsSVG } from './board.js';
import { START_FEN, moveNumberLabel } from './pgn.js';
import { $, escHtml, emptyHTML } from './dom.js';
import { renderNav, currentRoom, navigate } from './route.js';
import { moveToSpeech } from './speech/grammar.js';

const _stage = {};          // room → claim
const _hooks = { board: [], notation: [], all: [] };
/** Later modules (analysis, review) add painters without render.js importing them. */
export function onRender(kind, fn) { _hooks[kind].push(fn); }

export const STAGE_ROOM_LABEL = { play: 'Listen', learn: 'Learn', insights: 'Insights', prep: 'Prep', home: 'Home' };
/* The three-word and eleven-word vocabularies both map onto these marks. */
export const TREE_MARKS = { brilliant: '!!', great: '!', best: '', excellent: '', good: '', book: '', forced: '', inaccuracy: '?!', mistake: '?', miss: '?', blunder: '??' };

/**
 * `pos` is {fen, from, to, flipped, veiled, label, line, arrows, evalCp}. `line` is the
 * score beside the board: {moves, at, from, act, mark, nest} — see moveRunHTML(). A
 * claim carrying no line gets no notation panel.
 */
export function stageClaim(room, pos) {
  if (!pos || !pos.fen) { stageRelease(room); return; }
  _stage[room] = pos;
  renderStage();
}
export function stageRelease(room) {
  if (!_stage[room]) return;
  delete _stage[room];
  renderStage();
}
export function stageOwner() { return _stage[currentRoom()] ? currentRoom() : ''; }
export function stagePos() { return _stage[currentRoom()] || null; }
/* The orientation is the claim's and the reader's, in that order. */
export function stageFlipped(pos) { return !!pos.flipped !== !!S.flipped; }

export function renderStage() {
  const pair = $('board-pair');
  const board = $('chess-board');
  if (!pair || !board) return;
  const pos = _stage[currentRoom()] || null;
  pair.classList.toggle('hidden', !pos);
  const overlay = $('board-overlay');
  const cap = $('stage-caption');
  if (!pos) {
    if (overlay) overlay.innerHTML = '';
    if (cap) cap.textContent = '';
    renderNotation();
    return;
  }
  if (cap) cap.textContent = pos.label || STAGE_ROOM_LABEL[currentRoom()] || '';
  const flipped = stageFlipped(pos);
  board.innerHTML = boardHTML(pos.fen, { flipped, from: pos.from || null, to: pos.to || null, coords: !!S.coords });
  board.setAttribute('aria-label', 'Chess position');
  $('board-stack').classList.toggle('board-veiled', !!pos.veiled);
  if (overlay) overlay.innerHTML = arrowsSVG(pos.arrows, flipped);
  // The legend is the claim's: Listen's amber is what the engine wanted instead of the
  // move played; a card's amber is the move that was played. Same colour, two sentences.
  const legend = document.querySelector('.stage-legend');
  if (legend) {
    legend.classList.toggle('on', !!(pos.arrows && pos.arrows.length));
    const l = pos.legend || {};
    legend.querySelector('.stage-legend-best').textContent = l.best || 'green: what the engine plays here';
    legend.querySelector('.stage-legend-missed').textContent = l.missed || 'amber: what it wanted instead';
  }
  renderEvalBar(pos);
  renderNotation();
  for (const fn of _hooks.board) fn(pos);
}

/*
 * The bar shows the evaluation of the position on screen. A ply the engine has not
 * reached has no evaluation, and the honest rendering of that is to leave the bar out.
 */
function renderEvalBar(pos) {
  const bar = $('eval-bar');
  if (!bar) return;
  const ev = pos.eval;
  bar.classList.toggle('hidden', !ev);
  if (!ev) return;
  const cp = ev.mate !== undefined ? (ev.mate > 0 ? 10000 : ev.mate < 0 ? -10000 : 0) : ev.cp;
  const white = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp)))) - 1);
  const pct = Math.max(2, Math.min(98, white));
  $('eval-fill').style.height = (stageFlipped(pos) ? 100 - pct : pct) + '%';
  bar.title = ev.mate !== undefined ? 'Mate in ' + Math.abs(ev.mate) : (cp / 100).toFixed(2);
}

/** The line on the board now, or null. */
export function notationLine() { const pos = _stage[currentRoom()]; return (pos && pos.line) || null; }

/*
 * One run of numbered SAN, and the only one. A line that starts on Black's move opens
 * "12…dxe4" and not "12.dxe4", and this is the one place that has to know it.
 *
 * @param moves  SAN strings or verbose moves — .san is read off either
 * @param o {style, from, at, attr, tail, mark, nest}
 *   from  the zero-based ply the first move stands at
 *   at    how many have been played; the move at at-1 is current. -1 for none.
 *   attr  the data attribute a move carries ('data-ply'); nothing for an inert run
 *   mark  (ply) => 'blunder' | null — appended to the SAN and added to the classes
 *   nest  (ply) => html, asked after every ply and before the first
 */
const RUN_STYLES = {
  tree: { num: 'tree-num', move: 'tree-move', cur: 'current', col: true, numGap: true },
  var: { num: 'tree-num', move: 'tree-move', cur: 'current', col: false, numGap: true },
  line: { num: 'crumb-num', move: 'san', cur: '', col: false, numGap: false },
  plain: { num: '', move: '', cur: '', col: false, numGap: true },
};
export function moveRunHTML(moves, o) {
  const st = RUN_STYLES[o.style || 'line'];
  const from = o.from || 0;
  const at = o.at === undefined ? moves.length : o.at;
  let html = o.nest ? o.nest(from) : '';
  for (let i = 0; i < moves.length; i++) {
    const ply = from + i;
    const san = typeof moves[i] === 'string' ? moves[i] : moves[i].san;
    let num = '';
    if (ply % 2 === 0 || i === 0) {
      const label = moveNumberLabel(ply);
      num = st.num ? '<span class="' + st.num + '">' + label + '</span>' : escHtml(label);
      if (st.numGap) num += ' ';
    }
    const verdict = o.mark ? o.mark(ply) : null;
    const text = escHtml(san + (verdict && TREE_MARKS[verdict] ? TREE_MARKS[verdict] : ''));
    if (st.move) {
      let cls = st.move;
      if (st.col) cls += ply % 2 === 0 ? ' tree-w' : ' tree-b';
      if (st.cur && at === i + 1) cls += ' ' + st.cur;
      if (verdict) cls += ' tree-' + verdict;
      html += num + '<span class="' + cls + '"' + (o.attr ? ' ' + o.attr + '="' + (i + 1) + '"' : '') + '>' + text + '</span> ';
    } else {
      const item = num + text + ' ';
      html += o.tail && i >= at ? '<span class="' + o.tail + '">' + item + '</span>' : item;
    }
    if (o.nest) html += o.nest(ply + 1);
  }
  return html;
}

/** The score, for whichever room is holding the board. */
export function renderNotation() {
  const el = $('move-tree');
  const sec = $('notation-section');
  if (!el || !sec) return;
  const line = notationLine();
  syncTransport();
  if (!line) { el.innerHTML = ''; return; }
  el.classList.toggle('tree-flat', !line.act);
  if (!line.moves.length) { el.innerHTML = '<p class="hint">No moves yet.</p>'; return; }
  el.innerHTML = moveRunHTML(line.moves, {
    style: 'tree', from: line.from || 0, at: line.at, attr: line.act ? 'data-ply' : '',
    mark: line.mark, nest: line.nest,
  });
  // Follow the game without yanking the page: scroll only the panel body.
  const cur = el.querySelector('.tree-move.current');
  const box = el.parentElement;
  if (cur && box && box.clientHeight) {
    box.scrollTop += cur.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2 + cur.offsetHeight / 2;
  }
  for (const fn of _hooks.notation) fn(line);
}

/* The variation in brackets, numbered from where it branches. */
export function variationHTML() {
  return '<span class="tree-var">(' + moveRunHTML(S.varMoves, { style: 'var', from: S.varFrom, at: S.varAt, attr: 'data-var' }).trim() + ')</span> ';
}

/* ----- Listen's claim ----- */
let _treeMark = null;   // (game, ply) => tier | null, installed by review.js
export function setTreeMark(fn) { _treeMark = fn; }
let _arrowsFor = null;  // (game) => arrows, installed by analyse.js
export function setArrowsFor(fn) { _arrowsFor = fn; }
let _evalFor = null;    // (game, ply) => {cp|mate} | null
export function setEvalFor(fn) { _evalFor = fn; }

export function renderBoard() {
  const g = currentGame();
  if (!g) { stageRelease('play'); return; }
  const fen = viewFEN() || START_FEN;
  const last = inVariation() ? S.varMoves[S.varAt - 1] : (S.ply > 0 ? g.moves[S.ply - 1] : null);
  const label = 'Listen · ' + (g.headers.White || '?') + ' vs ' + (g.headers.Black || '?') +
    (inVariation() ? ' · a line of your own' : S.ply > 0 ? ' · after ' + moveNumberLabel(S.ply - 1) + ' ' + g.moves[S.ply - 1].san : ' · the start');
  stageClaim('play', {
    fen, from: last ? last.from : null, to: last ? last.to : null, flipped: false, label,
    arrows: _arrowsFor && !inVariation() ? _arrowsFor(g) : [],
    eval: _evalFor && !inVariation() ? _evalFor(g, S.ply) : null,
    line: {
      moves: g.moves, at: inVariation() ? -1 : S.ply, from: 0, act: 'play',
      mark: _treeMark ? n => _treeMark(g, n) : null,
      nest: ply => inVariation() && S.varFrom === ply ? variationHTML() : '',
    },
  });
}

/* ----- The bar beside the board ----- */
export function updateNowPlaying() {
  const g = currentGame();
  const gl = $('game-label'), pl = $('players-label'), ml = $('move-label');
  if (!gl) return;
  if (!g) {
    gl.textContent = 'Nothing loaded yet';
    pl.textContent = '';
    ml.textContent = '';
    sayNow('');
    updateProgress();
    return;
  }
  const h = g.headers;
  const total = S.games.length;
  gl.textContent = (total > 1 ? 'Game ' + (S.gi + 1) + ' of ' + total : 'Game 1') + (h.Event && h.Event !== '?' ? ' — ' + h.Event : '');
  pl.textContent = (h.White && h.White !== '?' ? h.White : 'White') + ' vs ' + (h.Black && h.Black !== '?' ? h.Black : 'Black');
  if (S.ply === 0) { ml.textContent = 'Starting position'; if (!S.playing) sayNow(''); }
  else {
    const m = g.moves[S.ply - 1];
    ml.innerHTML = 'Move ' + Math.ceil(S.ply / 2) + ' · ' + (S.ply % 2 ? 'White' : 'Black') + (m ? ' · <span class="san">' + escHtml(m.san) + '</span>' : '');
    if (!S.playing && m) sayNow(moveToSpeech(m, S.verbosity));
  }
  updateProgress();
}

export function sayNow(text) { const el = $('spoken-text'); if (el) el.textContent = text || ''; }

export function updateProgress() {
  const g = currentGame();
  const slider = $('ply-slider'), count = $('ply-count');
  if (!slider) return;
  const len = g ? g.moves.length : 0;
  slider.max = String(len);
  slider.value = String(g ? S.ply : 0);
  slider.disabled = !g;
  count.textContent = g ? S.ply + ' / ' + len : '';
}

export function updateTransport() {
  const b = $('btn-play');
  if (b) { b.textContent = S.playing ? '⏸︎' : '▶︎'; b.setAttribute('aria-label', S.playing ? 'Pause' : 'Play'); }
  syncTransport();
}

/* The step buttons and the scrubber are the claim's; play and the game skips are the
   reading's, and appear only while the board holds what is being read. */
export function syncTransport() {
  const bar = $('board-bar');
  if (!bar) return;
  const line = notationLine();
  const reading = stageOwner() === 'play';
  bar.classList.toggle('bar-reading', reading);
  const walkable = !!(line && line.act);
  const at = line ? line.at : 0, len = line ? line.moves.length : 0;
  const dis = (id, v) => { const el = $(id); if (el) el.disabled = v; };
  dis('btn-prev-move', !(walkable && at > 0));
  dis('btn-next-move', !(walkable && at < len));
  dis('btn-restart', !(walkable && at > 0));
  for (const id of ['btn-play', 'btn-prev-game', 'btn-next-game', 'btn-analyse']) {
    const el = $(id); if (el) el.classList.toggle('hidden', !reading);
  }
  const scrub = $('scrub'); if (scrub) scrub.classList.toggle('hidden', !reading);
}

/* ----- The queue ----- */
export function updateQueue() {
  const el = $('queue-list');
  if (!el) return;
  if (!S.games.length) {
    el.innerHTML = emptyHTML('Nothing lined up yet. Paste a PGN or pull an archive and the games appear here.', 'Import games', 'import');
    return;
  }
  let html = '';
  S.games.forEach((g, i) => {
    const h = g.headers;
    html += '<div class="queue-row' + (i === S.gi ? ' current' : '') + '" data-gi="' + i + '" role="button" tabindex="0">' +
      '<span>' + escHtml((h.White || '?') + ' – ' + (h.Black || '?')) + '</span>' +
      '<span class="meta">' + escHtml([h.Result, h.Date && h.Date !== '????.??.??' ? h.Date : '', h.ECO].filter(Boolean).join(' · ')) + '</span></div>';
  });
  el.innerHTML = html;
}

export function updateAll() {
  updateQueue();
  updateNowPlaying();
  updateTransport();
  renderBoard();
  renderNav();
  for (const fn of _hooks.all) fn();
}

/** Winding the room back to the board, from a press below the pair. Not from goToPly. */
export function showBoard() {
  const room = $('room'), pair = $('board-pair');
  if (!room || !pair || pair.classList.contains('hidden')) return;
  const top = pair.getBoundingClientRect().top - room.getBoundingClientRect().top;
  if (top >= 0 && pair.getBoundingClientRect().bottom <= room.getBoundingClientRect().bottom) return;
  room.scrollTo({ top: Math.max(0, room.scrollTop + top), behavior: 'smooth' });
}

export { navigate };
