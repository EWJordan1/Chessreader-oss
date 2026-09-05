/*
 * The Learn room (§6 Learn; docs/openings.md). Three sections split by *act*:
 * Openings is deciding — lessons, the library, the book and its editor; Tactics is the
 * collection of missed tactics; Drills is choosing what to be asked. Being asked
 * happens in Listen (drills.js), so a reader held on a guess never changes rooms.
 *
 * Everything here reads S and paints #learn-body; the stage is claimed as 'learn' only
 * while there is a position to show (a lesson step, the editor, an opened tactic).
 */
import { Chess } from 'chess.js';
import { S, currentGame } from '../state.js';
import { $, escHtml, emptyHTML, toast, plural, fmtDate } from '../dom.js';
import { registerRoom, navigate, LEARN_SECTIONS, renderNav } from '../route.js';
import { stageClaim, stageRelease, moveRunHTML } from '../render.js';
import { speak } from '../speech/provider.js';
import { START_FEN, moveNumberLabel } from '../pgn.js';
import * as deck from '../deck.js';
import {
  bookLines, bookKey, bookName, dueLabel, addToBook, removeLine, bookDue, walkLine,
  importBookPGN, studyRef, studyURL,
} from './book.js';
import { startDrill, drillState } from './drills.js';

/* ----- The catalogue, the library and the lessons: fetched when asked, memoised ----- */

const INDEX_URL = './lessons/index.json';
const LIBRARY_URL = './openings/library.json';
const lessonURL = id => './lessons/' + encodeURIComponent(id) + '.json';

let _index = null, _indexP = null;
let _library = null, _libraryP = null;
const _lessons = new Map();   // id → lesson | null

const fetchJSON = url => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);

/** The catalogue. Fetched on arrival in Openings, never at boot. */
export function loadIndex() {
  if (_index) return Promise.resolve(_index);
  if (!_indexP) _indexP = fetchJSON(INDEX_URL).then(t => { _index = t && Array.isArray(t.lessons) ? t : null; _indexP = null; return _index; });
  return _indexP;
}
export function loadLibrary() {
  if (_library) return Promise.resolve(_library);
  if (!_libraryP) _libraryP = fetchJSON(LIBRARY_URL).then(t => { _library = t && Array.isArray(t.families) ? t : null; _libraryP = null; return _library; });
  return _libraryP;
}
/** One lesson, fetched only when opened — a reader who never opens it never pays for it. */
export function loadLesson(id) {
  if (_lessons.has(id)) return Promise.resolve(_lessons.get(id));
  return fetchJSON(lessonURL(id)).then(L => {
    const ok = L && Array.isArray(L.steps) && L.steps.length ? L : null;
    _lessons.set(id, ok);
    return ok;
  });
}
/** Tests hand the JSON in directly rather than through fetch. */
export function primeCatalogue({ index, library, lessons } = {}) {
  if (index) _index = index;
  if (library) _library = library;
  if (lessons) for (const [id, L] of Object.entries(lessons)) _lessons.set(id, L);
}

/* ----- Pure pieces of the walker ----- */

/**
 * The position step k reaches, replayed from the start. A step's moves are SAN from
 * the start position, not from the step before it — which is what lets a lesson
 * double back to move three and take the other branch, and what lets every step be
 * validated on its own. Null when the step does not walk.
 */
export function lessonStep(lesson, k) {
  const s = lesson && lesson.steps && lesson.steps[k];
  if (!s || !Array.isArray(s.moves)) return null;
  const w = walkLine(s.moves);
  if (!w && s.moves.length) return null;
  const last = w ? w.verbose[w.verbose.length - 1] : null;
  return { fen: w ? w.fens[w.fens.length - 1] : START_FEN, from: last ? last.from : null, to: last ? last.to : null, moves: s.moves };
}

/**
 * Which step a press on ply n of the score should land on: the step whose line has
 * exactly n moves and shares the current step's prefix, else the nearest length. The
 * score shows one step's line; a press on move three of a nine-move step means "the
 * step where the lesson stood at move three", not a position the lesson never taught.
 */
export function nearestStep(lesson, n, cur = 0) {
  const steps = lesson.steps;
  const here = steps[cur] ? steps[cur].moves : [];
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const m = steps[i].moves;
    const shares = m.slice(0, Math.min(n, m.length, here.length)).every((san, j) => san === here[j]);
    const score = Math.abs(m.length - n) * 4 + (shares ? 0 : 2) + Math.abs(i - cur) / steps.length;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** "1. e4 c5 2. Nf3" → ['e4','c5','Nf3']: the library's lines are movetext strings. */
export function movetextSANs(text) {
  return String(text || '').replace(/\{[^}]*\}/g, '').split(/\s+/)
    .map(t => t.replace(/^\d+\.+/, '')).filter(t => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The library family a game's headers name, or null. Lichess writes "Family: Variation"
 * into [Opening]; Chess.com writes a slug into [ECOUrl]. The longest family name the
 * slug opens with wins, so "Queen's Gambit Declined" beats "Queen's Gambit". No
 * guess from the ECO code alone: a wrong shelf is worse than no shelf.
 */
export function familyOfGame(headers, names) {
  if (!headers) return null;
  const op = headers.Opening;
  if (op) { const fam = op.split(':')[0].trim(); if (names.has(fam)) return fam; }
  const url = headers.ECOUrl;
  if (url) {
    const slug = norm(url.slice(url.lastIndexOf('/') + 1));
    let best = null;
    for (const name of names) {
      const n = norm(name);
      if (n && slug.startsWith(n) && (!best || n.length > norm(best).length)) best = name;
    }
    return best;
  }
  return null;
}

/** Games per family name, for the "Openings you play" shelf. */
export function familyPlayCounts(games, families) {
  const names = new Set(families.map(f => f.name));
  const m = new Map();
  for (const g of games || []) {
    const fam = familyOfGame(g.headers, names);
    if (fam) m.set(fam, (m.get(fam) || 0) + 1);
  }
  return m;
}

/* ----- The room's own state: session-only, underscore-prefixed ----- */

function L() {
  if (!S._learn) {
    S._learn = {
      mode: 'shelf',            // shelf | lesson | editor | import
      lessonId: '', step: 0,
      family: '', q: '', libColor: 'w',
      editor: { color: 'w', sans: [], at: 0, name: '', msg: '' },
      imp: { text: '', color: 'w', busy: false, msg: '', err: false },
      tactic: null,             // {key, revealed} while a card is open on the stage
    };
  }
  return S._learn;
}

const speakBtn = (act, label = 'Speak') =>
  '<button class="btn btn-sm speak-elsewhere" data-act="' + act + '" type="button">' + label + '</button>';

/* ----- Painting ----- */

export function renderLearn() {
  const body = $('learn-body');
  if (!body) return;
  const tabs = $('learn-tabs');
  if (tabs) for (const b of tabs.querySelectorAll('[data-sect]')) {
    const on = b.dataset.sect === S.learnSection;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (S.learnSection === 'tactics') { renderTactics(body); return; }
  if (S.learnSection === 'drills') { renderDrills(body); return; }
  renderOpenings(body);
}

/* ===== Openings ===== */

function renderOpenings(body) {
  const st = L();
  st.tactic = null;
  if (st.mode === 'lesson') { renderLesson(body); return; }
  if (st.mode === 'editor') { renderEditor(body); return; }
  if (st.mode === 'import') { renderImport(body); return; }
  stageRelease('learn');
  body.innerHTML = bookPanelHTML() + lessonsPanelHTML() + libraryPanelHTML();
  if (!_index) loadIndex().then(() => onScreen('openings') && renderLearn());
  if (!_library) loadLibrary().then(() => onScreen('openings') && renderLearn());
}

function onScreen(section) {
  const view = $('view-learn');
  return !!view && !view.classList.contains('hidden') && S.learnSection === section;
}

function runHTML(sans, style = 'line') { return '<span class="book-run">' + moveRunHTML(sans, { style }) + '</span>'; }

/* The book: what you decided, grouped by the colour you decided it for. */
function bookPanelHTML() {
  const rows = bookLines();
  let inner;
  if (!rows.length) {
    inner = emptyHTML('Your book is empty. Play a line into it, or take one from a lesson below.', 'Start a line', 'editor');
  } else {
    inner = '';
    for (const color of ['w', 'b']) {
      const lines = rows.filter(r => r.color === color);
      if (!lines.length) continue;
      inner += '<h3 class="book-color">' + (color === 'w' ? 'As White' : 'As Black') + ' <span class="count">' + lines.length + '</span></h3>';
      inner += '<table class="book-table"><tbody>';
      for (const r of lines) {
        const due = (r.due || 0) <= Date.now();
        inner += '<tr><td class="book-name">' + escHtml(bookName(r)) + '</td>' +
          '<td class="book-line">' + runHTML(r.moves) + '</td>' +
          '<td class="book-due' + (due ? ' due' : '') + '">' + escHtml(dueLabel(r)) + (r.box ? ' · box ' + r.box : '') + '</td>' +
          '<td class="book-tools"><button class="btn btn-sm" data-act="open-line" data-key="' + escHtml(r.key) + '" type="button">Open</button> ' +
          '<button class="btn btn-sm btn-ghost" data-act="remove-line" data-key="' + escHtml(r.key) + '" type="button">Remove</button></td></tr>';
      }
      inner += '</tbody></table>';
    }
  }
  const due = bookDue().length;
  return '<section class="panel" id="learn-book"><header class="panel-head"><h2>Your book</h2><div class="tools">' +
    (due ? '<button class="btn btn-sm btn-primary" data-act="drill-book" type="button">Drill ' + plural(due, 'due line') + '</button>' : '') +
    '<button class="btn btn-sm" data-act="editor" type="button">Start a line</button>' +
    '<button class="btn btn-sm" data-act="import" type="button">Bring lines in</button></div></header>' +
    '<div class="panel-body">' + inner + '</div></section>';
}

function lessonRowHTML(l) {
  return '<button class="shelf-row" data-act="lesson" data-id="' + escHtml(l.id) + '" type="button">' +
    '<span class="shelf-name">' + escHtml(l.name) + '</span>' +
    '<span class="shelf-blurb">' + escHtml(l.blurb || '') + '</span>' +
    '<span class="shelf-meta"><span class="eco">' + escHtml(l.eco || '') + '</span> · as ' + (l.color === 'b' ? 'Black' : 'White') + '</span></button>';
}

/* The shelf of lessons, in the catalogue's groups and order. */
function lessonsPanelHTML() {
  let inner;
  if (!_index) inner = '<p class="hint">Fetching the lessons…</p>';
  else {
    inner = '';
    for (const g of _index.groups || []) {
      const rows = _index.lessons.filter(l => l.group === g.id);
      if (!rows.length) continue;
      inner += '<div class="shelf-group"><h3>' + escHtml(g.name) + '</h3><p class="hint">' + escHtml(g.blurb || '') + '</p><div class="shelf-rows">' +
        rows.map(lessonRowHTML).join('') + '</div></div>';
    }
  }
  return '<section class="panel" id="learn-lessons"><header class="panel-head"><h2>Lessons</h2><span class="muted">' +
    (_index ? plural(_index.lessons.length, 'lesson') : '') + '</span></header><div class="panel-body">' + inner + '</div></section>';
}

/* The library: every family, the ones you play first. */
let _counts = { n: -1, map: new Map() };
function playCounts() {
  if (!_library) return new Map();
  if (_counts.n !== S.games.length) _counts = { n: S.games.length, map: familyPlayCounts(S.games, _library.families) };
  return _counts.map;
}

function addButtonHTML(color, sans, name) {
  const have = S.book.has(bookKey(color, sans));
  return have
    ? '<span class="in-book">In your book</span>'
    : '<button class="btn btn-sm" data-act="add" data-color="' + color + '" data-moves="' + escHtml(sans.join(' ')) + '" data-name="' + escHtml(name) + '" type="button">Add to my book</button>';
}

function lineRowHTML(color, name, sans, eco) {
  return '<div class="lib-line"><span class="lib-line-name">' + escHtml(name) + (eco ? ' <span class="eco">' + escHtml(eco) + '</span>' : '') + '</span>' +
    runHTML(sans) + '<span class="lib-line-tools">' + addButtonHTML(color, sans, name) + '</span></div>';
}

function familyLinesHTML(fam, color) {
  const lessons = _index ? _index.lessons.filter(l => l.family === fam.name) : [];
  let html = '';
  for (const l of lessons) html += '<button class="shelf-row guided" data-act="lesson" data-id="' + escHtml(l.id) + '" type="button"><span class="shelf-name">' + escHtml(l.name) + ' <span class="pill">Guided lesson</span></span><span class="shelf-blurb">' + escHtml(l.blurb || '') + '</span></button>';
  for (const [eco, variation, movetext] of fam.lines) {
    const sans = movetextSANs(movetext);
    // A library line that does not walk is a data bug, and it must not become a button.
    if (!walkLine(sans)) continue;
    html += lineRowHTML(color, fam.name + (variation && variation !== 'Main line' ? ', ' + variation : ''), sans, eco);
  }
  return html;
}

function libraryPanelHTML() {
  const st = L();
  let inner;
  if (!_library) inner = '<p class="hint">Fetching the library…</p>';
  else {
    const q = st.q.trim().toLowerCase();
    const played = playCounts();
    const fams = _library.families.slice().sort((a, b) => (played.get(b.name) || 0) - (played.get(a.name) || 0));
    inner = '';
    let shelf = '';
    for (const fam of fams) {
      const n = played.get(fam.name) || 0;
      let only = null;
      if (q) {
        const hit = fam.name.toLowerCase().includes(q) || String(fam.eco).toLowerCase().includes(q);
        if (!hit) {
          only = fam.lines.filter(l => l[1].toLowerCase().includes(q));
          if (!only.length) continue;
        }
      } else {
        const want = n ? 'yours' : played.size ? 'rest' : '';
        if (want !== shelf) {
          shelf = want;
          if (want === 'yours') inner += '<h3 class="shelf-label">Openings you play</h3>';
          else if (want === 'rest') inner += '<h3 class="shelf-label">The rest of the library</h3>';
        }
      }
      const open = st.family === fam.name || !!only;
      inner += '<button class="fam-row' + (open ? ' open' : '') + '" data-act="family" data-name="' + escHtml(fam.name) + '" type="button" aria-expanded="' + open + '">' +
        '<span class="fam-name">' + escHtml(fam.name) + '</span>' +
        (n ? '<span class="fam-count">' + escHtml(plural(n, 'game')) + '</span>' : '') +
        '<span class="fam-eco eco">' + escHtml(fam.eco) + ' · ' + plural(fam.lines.length, 'line') + '</span></button>';
      if (open) inner += '<div class="fam-lines">' + familyLinesHTML(only ? { ...fam, lines: only } : fam, st.libColor) + '</div>';
    }
    if (!inner) inner = '<p class="empty"><span>Nothing on the shelf answers to that.</span></p>';
  }
  return '<section class="panel" id="learn-library"><header class="panel-head"><h2>The library</h2><div class="tools">' +
    '<input type="text" id="lib-q" placeholder="Search names, ECO, variations" value="' + escHtml(st.q) + '" aria-label="Search the library">' +
    '<span class="muted">Add as</span><span class="seg" role="group" aria-label="Add lines as">' +
    '<button class="btn' + (st.libColor === 'w' ? ' on' : '') + '" data-act="lib-color" data-color="w" type="button">White</button>' +
    '<button class="btn' + (st.libColor === 'b' ? ' on' : '') + '" data-act="lib-color" data-color="b" type="button">Black</button></span>' +
    '</div></header><div class="panel-body">' + inner + '</div></section>';
}

/* ----- A lesson: the step walker ----- */

function lessonRowFor(id) { return _index ? _index.lessons.find(l => l.id === id) || null : null; }

function renderLesson(body) {
  const st = L();
  const lesson = _lessons.get(st.lessonId);
  const row = lessonRowFor(st.lessonId);
  if (lesson === undefined) {
    body.innerHTML = '<section class="panel"><div class="panel-body"><p class="hint">Opening the lesson…</p></div></section>';
    loadLesson(st.lessonId).then(() => onScreen('openings') && renderLearn());
    return;
  }
  if (!lesson) {
    stageRelease('learn');
    body.innerHTML = '<section class="panel"><div class="panel-body">' +
      emptyHTML('That lesson could not be fetched.', 'Back to the shelf', 'shelf') + '</div></section>';
    return;
  }
  st.step = Math.max(0, Math.min(lesson.steps.length - 1, st.step));
  const k = st.step, n = lesson.steps.length;
  const step = lesson.steps[k];
  const pos = lessonStep(lesson, k);
  if (pos) {
    stageClaim('learn', {
      fen: pos.fen, from: pos.from, to: pos.to,
      // Seen from the side the lesson is written for — the side the reader is deciding
      // to play. A Caro-Kann looked at from White's seat is the wrong way up.
      flipped: lesson.color === 'b',
      label: 'Lesson · ' + lesson.name + ' · step ' + (k + 1) + ' of ' + n,
      line: { moves: step.moves, at: step.moves.length, from: 0, act: ply => { st.step = nearestStep(lesson, ply, st.step); renderLearn(); } },
    });
  } else stageRelease('learn');

  const last = k === n - 1;
  let offers = '';
  if (last) {
    const color = lesson.color === 'b' ? 'b' : 'w';
    offers += '<h3>Lines this lesson offers</h3><p class="hint">Nothing here is in your book until you put it there.</p>';
    for (const ln of lesson.lines || []) if (walkLine(ln.moves)) offers += lineRowHTML(color, ln.name, ln.moves, '');
    const fam = _library && row ? _library.families.find(f => f.name === row.family) : null;
    if (fam) {
      offers += '<h3>More lines in the ' + escHtml(fam.name) + '</h3><div class="fam-lines">' +
        fam.lines.map(([eco, variation, movetext]) => {
          const sans = movetextSANs(movetext);
          return walkLine(sans) ? lineRowHTML(color, fam.name + (variation !== 'Main line' ? ', ' + variation : ''), sans, eco) : '';
        }).join('') + '</div>';
    } else if (!_library) loadLibrary().then(() => onScreen('openings') && renderLearn());
  }

  body.innerHTML = '<section class="panel lesson" id="learn-lesson"><header class="panel-head">' +
    '<div><h2>' + escHtml(lesson.name) + '</h2><span class="muted"><span class="eco">' + escHtml(lesson.eco || '') + '</span> · as ' + (lesson.color === 'b' ? 'Black' : 'White') + '</span></div>' +
    '<div class="tools">' + speakBtn('speak-note') + '<button class="btn btn-sm" data-act="shelf" type="button">Back to the shelf</button></div></header>' +
    '<div class="panel-body">' +
    '<p class="lesson-note prose">' + escHtml(step.note || '') + '</p>' +
    '<div class="lesson-nav"><button class="btn" data-act="step" data-d="-1" type="button"' + (k === 0 ? ' disabled' : '') + '>Previous</button>' +
    '<span class="count">Step ' + (k + 1) + ' of ' + n + '</span>' +
    '<button class="btn btn-primary" data-act="step" data-d="1" type="button"' + (last ? ' disabled' : '') + '>Next</button></div>' +
    (offers ? '<div class="lesson-offers">' + offers + '</div>' : '') +
    '</div></section>';
}

/* ----- The editor: your move is the line ----- */

function editorPosition(ed) {
  const w = ed.sans.length ? walkLine(ed.sans) : { sans: [], fens: [START_FEN], verbose: [] };
  const at = Math.max(0, Math.min(ed.sans.length, ed.at));
  const last = at ? w.verbose[at - 1] : null;
  return { fen: w.fens[at], from: last ? last.from : null, to: last ? last.to : null, at };
}

function renderEditor(body) {
  const st = L(), ed = st.editor;
  const pos = editorPosition(ed);
  ed.at = pos.at;
  stageClaim('learn', {
    fen: pos.fen, from: pos.from, to: pos.to, flipped: ed.color === 'b',
    label: 'Your book · writing a line as ' + (ed.color === 'b' ? 'Black' : 'White'),
    line: { moves: ed.sans, at: ed.at, from: 0, act: ply => { ed.at = Math.max(0, Math.min(ed.sans.length, ply)); renderLearn(); } },
  });
  const chess = new Chess(pos.fen);
  const legal = chess.moves();
  const branching = ed.at < ed.sans.length;
  const exists = ed.sans.length && S.book.has(bookKey(ed.color, ed.sans));
  body.innerHTML = '<section class="panel" id="learn-editor"><header class="panel-head"><h2>Write a line</h2>' +
    '<div class="tools"><span class="seg" role="group" aria-label="Whose line">' +
    '<button class="btn' + (ed.color === 'w' ? ' on' : '') + '" data-act="ed-color" data-color="w" type="button">As White</button>' +
    '<button class="btn' + (ed.color === 'b' ? ' on' : '') + '" data-act="ed-color" data-color="b" type="button">As Black</button></span>' +
    '<button class="btn btn-sm" data-act="shelf" type="button">Back to the shelf</button></div></header>' +
    '<div class="panel-body">' +
    '<p class="hint">Type a move or press one below. A move typed before the end replaces what follows — that is how a variation is born. <em>End the line here</em> is the only thing that writes to your book.</p>' +
    '<p class="ed-run">' + (ed.sans.length ? moveRunHTML(ed.sans, { style: 'plain', at: ed.at, tail: 'ed-tail' }) : '<span class="muted">The start position.</span>') + '</p>' +
    (branching ? '<p class="hint">Standing at move ' + moveNumberLabel(ed.at - 1) + ' — the next move branches here.</p>' : '') +
    '<div class="field-row"><label>Move <input type="text" id="ed-san" placeholder="Nf3 or g1f3" autocomplete="off" spellcheck="false"></label>' +
    '<button class="btn" data-act="ed-add" type="button">Add</button>' +
    '<button class="btn" data-act="ed-undo" type="button"' + (ed.sans.length ? '' : ' disabled') + '>Undo</button>' +
    '<button class="btn btn-ghost" data-act="ed-clear" type="button"' + (ed.sans.length ? '' : ' disabled') + '>Clear</button></div>' +
    (ed.msg ? '<p class="hint ed-msg">' + escHtml(ed.msg) + '</p>' : '') +
    '<div class="legal"><span class="muted">Legal here:</span> ' + legal.map(s => '<button class="btn btn-sm san" data-act="ed-move" data-san="' + escHtml(s) + '" type="button">' + escHtml(s) + '</button>').join(' ') + '</div>' +
    '<div class="field-row"><label>Name (optional) <input type="text" id="ed-name" value="' + escHtml(ed.name) + '" placeholder="Caro-Kann, Advance" autocomplete="off"></label>' +
    '<button class="btn btn-primary" data-act="ed-end" type="button"' + (ed.sans.length && !exists ? '' : ' disabled') + '>End the line here</button>' +
    (exists ? '<span class="in-book">This line is in your book.</span>' : '') + '</div>' +
    '</div></section>';
  const f = $('ed-san'); if (f) f.focus();
}

function editorAdd(text) {
  const st = L(), ed = st.editor;
  const mv = String(text || '').trim();
  if (!mv) return;
  const pos = editorPosition(ed);
  const chess = new Chess(pos.fen);
  let m = null;
  try {
    m = /^[a-h][1-8][a-h][1-8][nbrq]?$/i.test(mv)
      ? chess.move({ from: mv.slice(0, 2).toLowerCase(), to: mv.slice(2, 4).toLowerCase(), promotion: mv[4] && mv[4].toLowerCase() })
      : chess.move(mv);
  } catch (e) { m = null; }
  if (!m) { ed.msg = 'There is no legal move called ' + mv + ' here.'; renderLearn(); return; }
  ed.msg = '';
  ed.sans = ed.sans.slice(0, ed.at).concat([m.san]);   // the tail is replaced: a branch, not an error
  ed.at = ed.sans.length;
  renderLearn();
}

function editorEnd() {
  const st = L(), ed = st.editor;
  const name = $('ed-name') ? $('ed-name').value : ed.name;
  ed.name = name;
  const row = addToBook(ed.color, ed.sans, name);
  if (!row) { ed.msg = S.book.has(bookKey(ed.color, ed.sans)) ? 'That line is already in your book.' : 'That line does not walk.'; renderLearn(); return; }
  toast('“' + bookName(row) + '” is in your book, due now.', { action: 'Drill it', onAction: () => startDrill('book') });
  ed.sans = []; ed.at = 0; ed.name = ''; ed.msg = '';
  st.mode = 'shelf';
  renderLearn();
}

function openInEditor(row) {
  const st = L();
  st.editor = { color: row.color, sans: row.moves.slice(), at: row.moves.length, name: row.name || '', msg: '' };
  st.mode = 'editor';
  renderLearn();
}

/* ----- Import: a PGN or a study, each mainline a leaf ----- */

function renderImport(body) {
  const st = L(), im = st.imp;
  stageRelease('learn');
  body.innerHTML = '<section class="panel" id="learn-import"><header class="panel-head"><h2>Bring lines in</h2>' +
    '<div class="tools"><button class="btn btn-sm" data-act="shelf" type="button">Back to the shelf</button></div></header>' +
    '<div class="panel-body">' +
    '<p class="hint">Paste a PGN — one game or many — or a lichess.org/study link. Each game’s main line becomes one line in your book; variations are not followed.</p>' +
    '<textarea id="imp-text" rows="8" placeholder="1. e4 c6 2. d4 d5 3. e5 Bf5 …  or  https://lichess.org/study/abcdefgh" aria-label="PGN or study link">' + escHtml(im.text) + '</textarea>' +
    '<div class="field-row"><span class="muted">Into my book</span><span class="seg" role="group" aria-label="As which colour">' +
    '<button class="btn' + (im.color === 'w' ? ' on' : '') + '" data-act="imp-color" data-color="w" type="button">as White</button>' +
    '<button class="btn' + (im.color === 'b' ? ' on' : '') + '" data-act="imp-color" data-color="b" type="button">as Black</button></span>' +
    '<button class="btn btn-primary" data-act="imp-go" type="button"' + (im.busy ? ' disabled' : '') + '>' + (im.busy ? 'Importing…' : 'Import') + '</button></div>' +
    (im.msg ? '<p class="hint' + (im.err ? ' err' : '') + '">' + escHtml(im.msg) + '</p>' : '') +
    '</div></section>';
}

async function importGo() {
  const st = L(), im = st.imp;
  const field = $('imp-text');
  im.text = field ? field.value : im.text;
  let text = im.text.trim();
  if (!text) { im.msg = 'Paste a PGN or a study link first.'; im.err = true; renderLearn(); return; }
  const ref = studyRef(text);
  if (ref) {
    im.busy = true; im.msg = ''; renderLearn();
    try {
      const r = await fetch(studyURL(ref));
      if (!r.ok) throw new Error('the study is private or gone');
      text = await r.text();
    } catch (e) {
      im.busy = false; im.msg = 'That study could not be fetched — ' + (e.message || 'network error') + '.'; im.err = true;
      renderLearn(); return;
    }
    im.busy = false;
  }
  const r = importBookPGN(text, im.color);
  if (r.over) { im.msg = 'That is ' + plural(r.over, 'game') + ' — more than an import writes at once. Import a chapter at a time.'; im.err = true; }
  else if (!r.total) { im.msg = 'No games found in that. Is it a PGN?'; im.err = true; }
  else {
    im.msg = plural(r.added, 'line') + ' into your book' +
      (r.dupes ? ' — ' + (r.dupes === 1 ? 'one was' : r.dupes + ' were') + ' already there' : '') +
      (r.skipped ? '; ' + plural(r.skipped, 'game') + ' would not parse and ' + (r.skipped === 1 ? 'was' : 'were') + ' skipped' : '') + '.';
    im.err = !r.added;
    if (r.added) im.text = '';
  }
  renderLearn();
}

/* ===== Tactics: the collection ===== */

function tacticsDueList() { return typeof deck.tacticsDue === 'function' ? deck.tacticsDue(Date.now()) : []; }

function renderTactics(body) {
  const st = L();
  const cards = [...S.tactics.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  if (!cards.length) {
    stageRelease('learn');
    body.innerHTML = '<section class="panel"><header class="panel-head"><h2>Missed tactics</h2></header><div class="panel-body">' +
      emptyHTML('Missed tactics appear here once games are analysed — the 200 to 300 centipawn misses, on the deck’s own schedule.', 'Analyse a game in Listen', 'go-play') +
      emptyHTML('Or let the archive sweep read every game while you are away.', 'Open Settings', 'go-settings') +
      '</div></section>';
    return;
  }
  const due = tacticsDueList();
  const open = st.tactic ? S.tactics.get(st.tactic.key) : null;
  if (open && typeof deck.cardClaim === 'function') {
    const pos = deck.cardClaim(open, { revealed: st.tactic.revealed });
    if (pos) { pos.label = pos.label || 'A missed tactic'; stageClaim('learn', pos); } else stageRelease('learn');
  } else stageRelease('learn');

  let cardPanel = '';
  if (open) {
    cardPanel = '<section class="panel" id="learn-tactic"><header class="panel-head"><h2>' + escHtml((open.player || '?') + ' vs ' + (open.opponent || '?')) + '</h2>' +
      '<div class="tools">' + speakBtn('speak-card') +
      '<button class="btn btn-sm" data-act="tactic-reveal" type="button">' + (st.tactic.revealed ? 'Hide' : 'Reveal') + '</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="tactic-close" type="button">Close</button></div></header>' +
      '<div class="panel-body">' + (typeof deck.deckCardHTML === 'function' ? deck.deckCardHTML(open, { revealed: st.tactic.revealed }) :
        '<p class="hint">' + (st.tactic.revealed ? 'The move was ' + escHtml(open.answer || '?') + '.' : 'Find the move for ' + (open.color === 'w' ? 'White' : 'Black') + '.') + '</p>') +
      '</div></section>';
  }
  let table = '<table class="tactics-table"><thead><tr><th>Player</th><th>Opponent</th><th>Date</th><th class="num">Move</th><th>Due</th></tr></thead><tbody>';
  for (const c of cards) {
    table += '<tr class="clickable' + (st.tactic && st.tactic.key === c.key ? ' current' : '') + '" data-act="tactic" data-key="' + escHtml(c.key) + '" tabindex="0">' +
      '<td>' + escHtml(c.player || '?') + '</td><td>' + escHtml(c.opponent || '?') + '</td><td>' + escHtml(c.date || '') + '</td>' +
      '<td class="num">' + escHtml(moveNumberLabel(c.ply || 0)) + '</td><td>' + escHtml(dueLabel(c)) + '</td></tr>';
  }
  table += '</tbody></table>';
  body.innerHTML = cardPanel +
    '<section class="panel" id="learn-tactics"><header class="panel-head"><h2>Missed tactics</h2><div class="tools">' +
    '<span class="muted">' + plural(due.length, 'due') + ' of ' + cards.length + '</span>' +
    '<button class="btn btn-sm btn-primary" data-act="drill-tactics" type="button"' + (due.length ? '' : ' disabled') + '>Drill these</button></div></header>' +
    '<div class="panel-body">' + table + '</div></section>';
}

/* ===== Drills: choosing what to be asked ===== */

function renderDrills(body) {
  stageRelease('learn');
  const deckN = typeof deck.deckDue === 'function' ? deck.deckDue(Date.now()).length : 0;
  const bookN = bookDue().length;
  const tacN = tacticsDueList().length;
  const running = drillState();
  const card = (kind, title, count, unit, sentence, door) =>
    '<div class="card drill-card"><h3>' + title + '</h3><p class="stat">' + count + '</p><p class="hint">' + (count ? plural(count, unit) + ' due. ' : '') + sentence + '</p>' +
    (count ? '<button class="btn btn-primary" data-act="drill" data-kind="' + kind + '" type="button">Start</button>'
      : '<button class="btn btn-sm" data-act="' + door.act + '" type="button">' + door.label + '</button>') + '</div>';
  const g = currentGame();
  const side = (L().guessSide || 'w');
  body.innerHTML = (running ? '<section class="panel"><div class="panel-body">' + emptyHTML('A drill is running in Listen.', 'Go to it', 'go-play') + '</div></section>' : '') +
    '<div class="cards">' +
    card('deck', 'Blunder deck', deckN, 'card', 'Your own mistakes, asked back on the Leitner ladder.', { act: 'go-play', label: 'Analyse a game' }) +
    card('book', 'Your book', bookN, 'line', 'The lines you decided, one move at a time — you play your side, the other side plays itself.', { act: 'go-openings', label: 'Write a line' }) +
    card('tactics', 'Missed tactics', tacN, 'tactic', 'The 200–300 centipawn misses from your analysed games.', { act: 'go-tactics', label: 'See the collection' }) +
    '</div>' +
    '<section class="panel" id="learn-guess"><header class="panel-head"><h2>Guess the move</h2></header><div class="panel-body">' +
    '<p class="hint">Listen reads the current game and stops before each move of the side you choose. Type it, or ask for it.</p>' +
    (g ? '<div class="field-row"><span class="seg" role="group" aria-label="Guess for">' +
      ['w', 'b', 'both'].map(s => '<button class="btn' + (side === s ? ' on' : '') + '" data-act="guess-side" data-side="' + s + '" type="button">' + (s === 'w' ? 'White' : s === 'b' ? 'Black' : 'Both') + '</button>').join('') +
      '</span><button class="btn btn-primary" data-act="drill" data-kind="guess" type="button">Start on ' + escHtml((g.headers.White || '?') + ' vs ' + (g.headers.Black || '?')) + '</button></div>'
      : emptyHTML('Guessing needs a game to read. Import one first.', 'Import games', 'import')) +
    '</div></section>';
}

/* ----- Wiring ----- */

function onAct(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const st = L();
  const act = el.dataset.act;
  switch (act) {
    case 'lesson': st.mode = 'lesson'; st.lessonId = el.dataset.id; st.step = 0; renderLearn(); break;
    case 'step': st.step += +el.dataset.d; renderLearn(); break;
    case 'shelf': st.mode = 'shelf'; renderLearn(); break;
    case 'speak-note': {
      const lesson = _lessons.get(st.lessonId);
      const step = lesson && lesson.steps[st.step];
      if (step) speak(step.note);
      break;
    }
    case 'family': st.family = st.family === el.dataset.name ? '' : el.dataset.name; renderLearn(); break;
    case 'lib-color': st.libColor = el.dataset.color; renderLearn(); break;
    case 'add': {
      const row = addToBook(el.dataset.color, el.dataset.moves.split(' '), el.dataset.name);
      if (row) toast('“' + bookName(row) + '” is in your book, due now.', { action: 'Drill it', onAction: () => startDrill('book') });
      else toast('That line is already in your book.');
      renderLearn();
      break;
    }
    case 'editor': st.mode = 'editor'; renderLearn(); break;
    case 'ed-color': st.editor.color = el.dataset.color; renderLearn(); break;
    case 'ed-add': editorAdd($('ed-san') && $('ed-san').value); break;
    case 'ed-move': editorAdd(el.dataset.san); break;
    case 'ed-undo': st.editor.sans = st.editor.sans.slice(0, Math.max(0, st.editor.at - 1)); st.editor.at = st.editor.sans.length; st.editor.msg = ''; renderLearn(); break;
    case 'ed-clear': st.editor.sans = []; st.editor.at = 0; st.editor.msg = ''; renderLearn(); break;
    case 'ed-end': editorEnd(); break;
    case 'open-line': { const row = S.book.get(el.dataset.key); if (row) openInEditor(row); break; }
    case 'remove-line': {
      const row = S.book.get(el.dataset.key);
      if (row && removeLine(row.key)) toast('“' + bookName(row) + '” left your book.', { action: 'Undo', onAction: () => { addToBook(row.color, row.moves, row.name); renderLearn(); } });
      renderLearn();
      break;
    }
    case 'import': st.mode = 'import'; renderLearn(); break;
    case 'imp-color': st.imp.color = el.dataset.color; renderLearn(); break;
    case 'imp-go': importGo(); break;
    case 'drill-book': startDrill('book'); break;
    case 'drill-tactics': startDrill('tactics'); break;
    case 'drill': startDrill(el.dataset.kind, { side: st.guessSide || 'w' }); break;
    case 'guess-side': st.guessSide = el.dataset.side; renderLearn(); break;
    case 'tactic': st.tactic = st.tactic && st.tactic.key === el.dataset.key ? null : { key: el.dataset.key, revealed: false }; renderLearn(); break;
    case 'tactic-reveal': if (st.tactic) { st.tactic.revealed = !st.tactic.revealed; renderLearn(); } break;
    case 'tactic-close': st.tactic = null; renderLearn(); break;
    case 'speak-card': {
      const card = st.tactic && S.tactics.get(st.tactic.key);
      if (card && typeof deck.speakCard === 'function') deck.speakCard(card);
      break;
    }
    case 'go-play': navigate('play'); break;
    case 'go-settings': navigate('settings'); break;
    case 'go-openings': st.mode = 'editor'; navigate('learn', 'openings'); break;
    case 'go-tactics': navigate('learn', 'tactics'); break;
    default: break;   // 'import' on the door is sources.js's, handled at the document
  }
}

export function boot() {
  if (typeof document === 'undefined') return;
  registerRoom('learn', () => renderLearn());
  const tabs = $('learn-tabs');
  if (tabs) tabs.addEventListener('click', e => {
    const b = e.target.closest('[data-sect]');
    if (b && LEARN_SECTIONS.includes(b.dataset.sect)) navigate('learn', b.dataset.sect);
  });
  const body = $('learn-body');
  if (!body) return;
  body.addEventListener('click', e => {
    // The book panel's own "Bring lines in" is ours; the import *door* in empty states
    // belongs to sources.js, which listens at the document for data-act="import".
    const el = e.target.closest('[data-act]');
    if (el && el.dataset.act === 'import' && !el.closest('#learn-book')) return;
    onAct(e);
  });
  body.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'ed-san') { e.preventDefault(); editorAdd(e.target.value); }
    else if (e.target.id === 'lib-q') { e.preventDefault(); L().q = e.target.value; renderLearn(); }
    else if (e.target.matches('tr[data-act="tactic"]')) { e.preventDefault(); onAct(e); }
  });
  body.addEventListener('input', e => {
    const st = L();
    if (e.target.id === 'lib-q') { st.q = e.target.value; renderLearn(); const q = $('lib-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
    else if (e.target.id === 'ed-name') st.editor.name = e.target.value;
    else if (e.target.id === 'imp-text') st.imp.text = e.target.value;
  });
  // The book and the deck change under the room; repaint only while it is on screen.
  const repaint = () => { renderNav(); if ($('view-learn') && !$('view-learn').classList.contains('hidden')) renderLearn(); };
  document.addEventListener('cr:book-changed', repaint);
  document.addEventListener('cr:deck-changed', repaint);
  document.addEventListener('cr:restored', repaint);
  document.addEventListener('cr:games-added', () => { _counts.n = -1; if (onScreen('openings')) renderLearn(); });
}
