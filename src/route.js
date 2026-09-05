/*
 * Hash routing (§6). route() is the only thing that decides which room is live: it
 * toggles a `hidden` class and calls renderNav(). hashchange calls route(), so Back
 * and Forward work with no extra code. route() never touches playback.
 */
import { S } from './state.js';
import { $ } from './dom.js';

/* The listed rooms, in rail order. The digit keys and the palette are generated from
   this list rather than from a second literal. Settings is a room with no tab. */
export const ROOMS = ['home', 'learn', 'insights', 'prep', 'play', 'settings'];
export const UNLISTED_ROOMS = ['settings'];
export const NAV_ROOMS = ROOMS.filter(r => !UNLISTED_ROOMS.includes(r));
export const ROOM_NAMES = { home: 'Home', learn: 'Learn', insights: 'Insights', prep: 'Prep', play: 'Listen', settings: 'Settings' };
export const LEARN_SECTIONS = ['openings', 'tactics', 'drills'];
// Where old two-room URLs land, so a bookmark from the original app still opens somewhere.
export const ROOM_ALIASES = { library: 'home', stats: 'insights', train: 'learn' };

let _view = null;      // last rendered room, for change detection
let _arg = '';         // the second segment: a Learn section, or a Prep opponent id
const _enter = {};     // room → fn(arg, {first}) painted on arrival
const _seen = new Set(); // rooms already entered this session, for the `first` flag
const _listeners = [];

/**
 * A room module registers what to paint when the room comes on screen. `enter` is called
 * as enter(arg, {first}) — `first` is true only on the room's first arrival this
 * session, which is where a one-off fetch or a heavy build belongs. Every other arrival
 * must be cheap, because walking between rooms is the commonest thing anyone does.
 */
export function registerRoom(room, enter) { _enter[room] = enter; }
export function hasRoom(room) { return !!_enter[room]; }
/** Anything that wants to know the room changed (the stage, the transport). */
export function onRoute(fn) { _listeners.push(fn); }
export function currentRoom() { return _view; }
export function routeArg() { return _arg; }

export function navigate(room, arg) {
  const want = hashFor(room, arg);
  if (location.hash === want) route();   // hashchange will not fire; route by hand
  else location.hash = want;
}

export function hashFor(room, arg) {
  if (room === 'home') return '#/';
  if (room === 'learn') return '#/learn/' + (arg || S.learnSection);
  return '#/' + room + (arg ? '/' + encodeURIComponent(arg) : '');
}

export function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const cut = hash.indexOf('/');
  const head = cut < 0 ? hash : hash.slice(0, cut);
  let arg = cut < 0 ? '' : decodeURIComponent(hash.slice(cut + 1));
  const asked = ROOM_ALIASES[head] || head;
  const v = ROOMS.includes(asked) ? asked : 'home';

  // Learn's second segment names its section and outlives the visit: bare #/learn lands
  // on whichever section was last stood in, and the address is written back in full.
  if (v === 'learn') {
    const sect = arg.split('/')[0];
    if (LEARN_SECTIONS.includes(sect)) S.learnSection = sect;
    arg = S.learnSection;
  }

  // Keep the URL honest without pushing a history entry the user did not ask for.
  const want = hashFor(v, arg);
  if (location.hash !== want) history.replaceState(null, '', want);

  for (const room of ROOMS) {
    const el = $('view-' + room);
    if (el) el.classList.toggle('hidden', room !== v);
  }
  const changed = v !== _view || arg !== _arg;
  _view = v; _arg = arg;
  renderNav();
  if (changed) { const room = $('room'); if (room) room.scrollTop = 0; }
  if (_enter[v]) { const first = !_seen.has(v); _seen.add(v); _enter[v](arg, { first }); }
  for (const fn of _listeners) fn(v, arg);
}

/*
 * The rail. One due badge on Learn counting deck cards, book lines and tactics once
 * each; Listen wears what is left to hear, not how many games are loaded; Prep wears
 * the list's length. A room with nothing to report shows nothing rather than a zero.
 */
let _dueCounter = () => 0;
export function setDueCounter(fn) { _dueCounter = fn; }

export function renderNav() {
  const nav = $('site-nav');
  if (!nav) return;
  for (const a of nav.querySelectorAll('.nav-link')) {
    const on = a.dataset.room === _view;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text || ''; };
  const left = Math.max(0, S.games.length - S.gi - 1);
  set('badge-play', left ? String(left) : '');
  const due = _dueCounter();
  set('badge-learn', due ? String(due) : '');
  set('badge-prep', S.opponents.length ? String(S.opponents.length) : '');
  const cog = $('btn-settings');
  if (cog) cog.classList.toggle('on', _view === 'settings');
}
