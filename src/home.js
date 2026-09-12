/*
 * Home (§6) — the greeting, the news, and the last seven days.
 *
 * Three things, in that order down the page: who you are and what time it is; what has
 * happened on the sites you play on since the newest game you imported; and the week —
 * drilled, due, how the deck grew, and the single most expensive move in it.
 *
 * Home computes almost nothing. `weekStats()` is the deck's arithmetic, `bookDue()` is
 * the book's, `checkNewGames()` is the tracker's, and `gameFacts()` is Insights'. What
 * this module owns is the wording and the doors: every figure that has evidence behind
 * it is a button that walks to the evidence rather than a number printed at the reader.
 *
 * Two rules here are the whole module, and both break silently if broken:
 *
 * 1. **`S._restoring` holds the page.** From load until the library is off the disk the
 *    week refuses to paint at all. A week counted over half a queue is a *wrong* week,
 *    not a smaller one — and it is wrong in the direction that reads as progress lost.
 *    `cr:restored` is what brings the page back.
 * 2. **Nothing polls (§2.7).** The tracker is asked on arrival at Home — the reader
 *    walking into the room is the press — and never on a timer. sources.js holds the
 *    once-per-thirty-minutes floor; this module only decides when to ask at all, and
 *    never asks a site it has not already asked except on an arrival.
 */
import { S } from './state.js';
import { $, escHtml, emptyHTML, plural, fmtDate, toast } from './dom.js';
import { registerRoom, navigate, currentRoom } from './route.js';
import { setGame } from './playback.js';
import { weekStats, cardLoss, cardMated, cardLabel } from './deck.js';
import { bookDue } from './learn/book.js';
import {
  TRACKER_SITES, TRACKER_GAP_MS, SITE_NAMES,
  checkNewGames, importNewGames, savedUser, lastChecked, newestImported, gameEndMs,
} from './sources.js';
import { resolveHero, gameFacts } from './insights.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
/* How many games the strip shows. Enough to recognise the session you just finished,
   short enough that it never becomes a second queue list — Listen already has one. */
export const RECENT_MAX = 6;
/* Bursts of cr:analysis-done during a sweep would repaint the room per ply. */
const REPAINT_MS = 300;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ===================================================================================
 * The arithmetic and the wording. Nothing below names `document`.
 * =================================================================================== */

export function greeting(now = Date.now()) {
  const h = new Date(now).getHours();
  return 'Good ' + (h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening');
}

/**
 * A watermark in ms, said the way a person would say it: "today", "yesterday", a day
 * name inside the last week, a date beyond that.
 *
 * The comparison is in whole local days, not in elapsed milliseconds: 23 hours ago can
 * be yesterday and 25 hours ago can still be today, and the reader means the calendar.
 * Seven days back is where the day names stop — the seventh day is the *same* name as
 * today, and "since Tuesday" for a game played last Tuesday is a lie by a week.
 */
export function sinceWording(ms, now = Date.now()) {
  if (!ms) return '';
  const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return DAY_NAMES[new Date(ms).getDay()];
  return fmtDate(ms);
}

/**
 * The news, in parts, so the sentence exists once and the painter can still put the
 * count in the sans. Null when there is nothing to say — and **zero is nothing to
 * say**: "0 new games since Tuesday" is a line that reports the absence of news as
 * news, and a page that says it every visit teaches the reader to stop reading it.
 */
export function newsParts(site, news, now = Date.now()) {
  if (!news || !news.count) return null;
  return {
    count: news.count,
    tail: (news.count === 1 ? 'new game' : 'new games') + ' on ' + (SITE_NAMES[site] || site) +
      ' since ' + sinceWording(news.since, now) + '.',
  };
}

/** The same sentence as one string, for a title, a toast or a test. */
export function newsLine(site, news, now = Date.now()) {
  const p = newsParts(site, news, now);
  return p ? p.count + ' ' + p.tail : null;
}

/** Where a card's game sits in the queue, or -1 when it is not loaded. */
export function gameIndexOf(gameId, games = S.games) {
  return gameId ? games.findIndex(g => g.id === gameId) : -1;
}

/**
 * The last seven days, or **null while the library is still arriving** (§6). Every
 * figure is read from `weekStats()` and `bookDue()`; nothing here recounts a store.
 * `worstAt` is the queue index of the worst card's game, -1 when that game is not
 * loaded — a door with nothing behind it is not drawn.
 */
export function weekReport(now = Date.now()) {
  if (S._restoring) return null;
  const w = weekStats(now);
  const worst = w.worst;
  return {
    drilled: w.drilled,
    due: w.due,
    grew: w.grew,
    lines: bookDue(now).length,
    worst,
    worstLoss: worst ? cardLoss(worst) : null,
    worstMated: worst ? cardMated(worst) : false,
    worstAt: worst ? gameIndexOf(worst.gameId) : -1,
    cards: S.deck.size + S.tactics.size,
  };
}

/**
 * The newest games in the library, newest first.
 *
 * The order is the *game's* own finish (`gameEndMs`, the same reading the tracker's
 * watermark uses), never the subject's facts: `gameFacts` is null for a game the
 * subject did not play, and ordering on its date would float every game by anyone else
 * to the top of the strip on the import stamp alone. Only a game whose headers carry no
 * usable finish falls back to when it was imported — an undated PGN pasted a minute ago
 * belongs at the top of "newest", not at the bottom.
 *
 * The result and the colour are the subject's and stay null when the subject is not in
 * the game: a row that says "won" about two strangers is worse than a row that says
 * nothing (§15 — a guard that returns null over one that returns a plausible answer).
 */
export function recentGames(games = S.games, heroKey = null, max = RECENT_MAX) {
  const rows = [];
  games.forEach((g, gi) => {
    const f = heroKey ? gameFacts(g, heroKey) : null;
    /*
     * With a subject, the strip is *their* last six games. A game they did not play has
     * no result from their side, and a row that cannot say whether it was won or lost is
     * a row with nothing on it — so it is dropped rather than drawn with a blank verdict.
     * With no subject resolved yet there is nobody to have won, and every game belongs:
     * the row says the two players instead, which is the honest reading of the same fact.
     */
    if (heroKey && !f) return;
    const h = g.headers || {};
    const end = gameEndMs(g);
    rows.push({
      gi,
      when: end || g.addedAt || 0,
      date: end || (f && f.date) || null,
      result: f ? f.result : null,
      color: f ? f.color : null,
      opponent: (f && f.opponent) || '',
      players: (h.White || '?') + ' – ' + (h.Black || '?'),
      plies: g.moves ? g.moves.length : 0,
    });
  });
  rows.sort((a, b) => b.when - a.when || b.gi - a.gi);
  return rows.slice(0, max);
}

/* ===================================================================================
 * The room. Everything below is guarded on `document`.
 * =================================================================================== */

/* site → the last answer we have, {count, since} or null. Session state: the answer is
   about this tab's conversation with the site, exactly like sources' own floor. */
const _news = new Map();
const _asking = new Set();

function newsCount() {
  let n = 0;
  for (const site of TRACKER_SITES) { const v = _news.get(site); if (v) n += v.count; }
  return n;
}

/** Ask a site, if there is a saved handle and the floor has passed. */
async function ask(site) {
  if (_asking.has(site) || !savedUser(site)) return;
  _asking.add(site);
  try {
    const res = await checkNewGames(site);
    if (res) _news.set(site, res); else _news.delete(site);
  } catch (e) {
    _news.delete(site);          // a site that would not answer is not news either way
  } finally {
    _asking.delete(site);
    repaint();
  }
}

/**
 * The arrival check. `first` is the reader walking in for the first time this session;
 * later arrivals ask again only once the floor has passed, so walking Home → Learn →
 * Home is free. sources.js enforces the floor itself; this is what keeps a room change
 * from being a request in the first place.
 */
function checkOnArrival(first) {
  const now = Date.now();
  for (const site of TRACKER_SITES) {
    if (first || now - lastChecked(site) >= TRACKER_GAP_MS) ask(site);
  }
}

/** After an import the watermark has moved, so the count is stale. Re-counting inside
 *  the floor costs no request — but a site never asked is not asked here, because that
 *  would be a fetch nobody pressed for. */
function recount() {
  for (const site of TRACKER_SITES) if (lastChecked(site)) ask(site);
}

/* ----- Painting ----- */

function tile(value, label, act, extra = '') {
  const inner = '<span class="stat num">' + escHtml(String(value)) + '</span>' +
    '<span class="label">' + escHtml(label) + '</span>';
  return act
    ? '<button class="stat-tile" type="button" data-act="' + escHtml(act) + '"' + extra + '>' + inner + '</button>'
    : '<div class="stat-tile">' + inner + '</div>';
}

/* The week's most expensive move, as a sentence and (when its game is loaded) a door
   into Listen at the ply before it. Mate is a sentence, not a number: a card that walked
   into mate has no centipawn cost worth printing. */
function worstHTML(rep) {
  if (!rep.worst) {
    return '<p class="hint">No new card was worth more than the rest this week.</p>';
  }
  const c = rep.worst;
  const cost = rep.worstMated ? 'mate' : '−' + ((rep.worstLoss || 0) / 100).toFixed(1);
  const sentence = rep.worstMated
    ? 'The week\'s worst moment walked into mate.'
    : 'The week\'s most expensive move cost';
  let html = '<div class="home-worst">';
  html += rep.worstAt >= 0
    ? '<button class="stat-tile" type="button" data-act="worst" data-gi="' + rep.worstAt + '" data-ply="' + c.ply + '">' +
      '<span class="stat num">' + escHtml(cost) + '</span><span class="label">worst move this week</span></button>'
    : '<div class="stat-tile"><span class="stat num">' + escHtml(cost) + '</span><span class="label">worst move this week</span></div>';
  html += '<div class="home-worst-say"><p class="hint">' + escHtml(sentence) +
    (rep.worstMated ? '' : ' <span class="num">' + escHtml(((rep.worstLoss || 0) / 100).toFixed(1)) + '</span> pawns.') + '</p>' +
    '<p class="meta">' + escHtml(cardLabel(c)) + '</p>' +
    (rep.worstAt >= 0 ? '' : '<p class="meta">That game is not in the queue any more, so there is nowhere to walk to.</p>') +
    '</div></div>';
  return html;
}

function weekHTML(now) {
  const rep = weekReport(now);
  let body;
  if (!rep.cards && !rep.lines) {
    body = emptyHTML('Nothing in the deck yet. Analyse a game and every move that cost you three pawns becomes a card here.',
      'Open Learn', 'go-drills');
  } else {
    body = '<div class="stat-row">' +
      tile(rep.due, plural(rep.due, 'card') + ' due', rep.due ? 'go-drills' : '') +
      tile(rep.drilled, 'drilled this week', '') +
      tile((rep.grew > 0 ? '+' : '') + rep.grew, 'cards earned', '') +
      (rep.lines ? tile(rep.lines, plural(rep.lines, 'line') + ' due', 'go-openings') : '') +
      '</div>' + worstHTML(rep);
  }
  return '<section class="panel span-2 home-week"><header class="panel-head"><h2>The last seven days</h2></header>' +
    '<div class="panel-body">' + body + '</div></section>';
}

function siteNewsHTML(site, now) {
  const name = SITE_NAMES[site];
  const user = savedUser(site);
  if (!user) return '';
  const parts = newsParts(site, _news.get(site), now);
  if (parts) {
    return '<div class="home-news-row"><p class="lede home-news-line"><span class="num">' + parts.count + '</span> ' +
      escHtml(parts.tail) + '</p>' +
      '<button class="btn btn-primary btn-sm" type="button" data-act="import-new" data-site="' + escHtml(site) + '">Import ' +
      (parts.count === 1 ? 'it' : 'them') + '</button></div>';
  }
  if (_asking.has(site)) return '<p class="meta">Asking ' + escHtml(name) + '…</p>';
  if (!newestImported(site)) {
    return '<div class="home-news-row"><p class="hint">Nothing from ' + escHtml(name) + ' has been imported yet, so there is no watermark to count from.</p>' +
      '<button class="btn btn-sm" type="button" data-act="import">Import games</button></div>';
  }
  const since = lastChecked(site);
  const gap = since ? Date.now() - since : 0;
  const stale = !since || gap >= TRACKER_GAP_MS;
  return '<div class="home-news-row"><p class="hint">Nothing new on ' + escHtml(name) + ' since your last import.</p>' +
    (stale
      ? '<button class="btn btn-sm" type="button" data-act="check" data-site="' + escHtml(site) + '">Check ' + escHtml(name) + '</button>'
      : '<span class="meta">Asked ' + Math.max(1, Math.round(gap / 60000)) + ' minutes ago.</span>') +
    '</div>';
}

function newsHTML(now) {
  const rows = TRACKER_SITES.map(s => siteNewsHTML(s, now)).filter(Boolean).join('');
  const body = rows || emptyHTML('Save your Chess.com or Lichess username and Home opens with what has happened since your last import. The browser asks the site itself, at most twice an hour, and only when you are standing here.',
    'Settings', 'go-settings');
  return '<section class="panel home-news"><header class="panel-head"><h2>Since you were last here</h2></header>' +
    '<div class="panel-body">' + body + '</div></section>';
}

const RESULT_WORD = { w: 'won', l: 'lost', d: 'drew' };

function recentHTML(heroKey) {
  const rows = recentGames(S.games, heroKey);
  const body = rows.map(r =>
    '<button class="home-game" type="button" data-act="game" data-gi="' + r.gi + '">' +
    '<span class="home-game-who">' + escHtml(r.opponent ? 'vs ' + r.opponent : r.players) + '</span>' +
    '<span class="meta home-game-facts">' +
    (r.result ? '<span class="home-res home-res-' + r.result + '">' + RESULT_WORD[r.result] + '</span> · ' : '') +
    (r.color ? (r.color === 'w' ? 'white' : 'black') + ' · ' : '') +
    '<span class="num">' + Math.ceil(r.plies / 2) + '</span> moves' +
    (r.date ? ' · ' + escHtml(fmtDate(r.date)) : '') +
    '</span></button>').join('');
  return '<section class="panel home-recent"><header class="panel-head"><h2>Newest in the queue</h2></header>' +
    '<div class="panel-body">' + body + '</div></section>';
}

function homeHTML() {
  const now = Date.now();
  const hero = S.games.length ? resolveHero(S.games) : null;
  let html = '<p class="greeting">' + escHtml(greeting(now) + (hero ? ', ' + hero.name : '')) + '.</p>';

  // The library is still coming off the disk: hold the empty state. Painting a week now
  // would print a smaller, wrong week and then quietly correct itself a second later.
  if (S._restoring) {
    return html + '<p class="empty"><span>Your library is still coming back off the disk. Home fills itself in the moment it lands.</span></p>';
  }
  if (!S.games.length && !S.deck.size && !S.tactics.size) {
    return html + emptyHTML('Nothing here yet. Pull your archive from Chess.com or Lichess and this page opens with your week: what you drilled, what is due, and the move that cost you most.',
      'Import games', 'import');
  }
  html += '<p class="hint">' + escHtml(plural(S.games.length, 'game') + ' loaded. ') +
    'Listen reads them; Insights counts them; what is below is the week.</p>';
  html += '<div class="cards cards-report home-grid">' + weekHTML(now) + newsHTML(now) + recentHTML(hero ? hero.key : null) + '</div>';
  return html;
}

/**
 * The badge is a dot, not a number (§6). route.js's renderNav() sets badge-play,
 * badge-learn and badge-prep and deliberately leaves this one alone, so Home paints it
 * — from here rather than from enter(), because news that arrives while the reader is
 * in another room is exactly what a rail badge is for. The count is in the room; the
 * dot only says *look*.
 */
function paintBadge() {
  const el = $('badge-home');
  if (!el) return;
  const n = newsCount();
  el.classList.toggle('nav-dot', n > 0);
  el.textContent = n ? '•' : '';       // .nav-badge:empty is display:none, so a dot needs a glyph
  if (n) el.setAttribute('aria-label', plural(n, 'new game') + ' waiting'); else el.removeAttribute('aria-label');
}

function paint() {
  const el = $('home-body');
  if (!el) return;
  el.innerHTML = homeHTML();
}

let _timer = 0;
function repaint() {
  if (typeof document === 'undefined') return;
  paintBadge();
  if (currentRoom() !== 'home') return;
  clearTimeout(_timer);
  _timer = setTimeout(paint, REPAINT_MS);
}

function enter(arg, { first } = {}) {
  if (typeof document === 'undefined') return;
  clearTimeout(_timer);
  paint();
  paintBadge();
  checkOnArrival(first);
}

/* ----- Presses ----- */

async function importNews(site) {
  const res = await importNewGames(site).catch(() => null);
  if (!res || !res.added) {
    toast('Nothing new to import from ' + SITE_NAMES[site] + ' just now.');
  } else {
    toast(plural(res.added, 'game') + ' imported from ' + SITE_NAMES[site] + '.');
  }
  _news.delete(site);      // what was news is history; cr:games-added recounts the rest
  repaint();
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !$('home-body').contains(b)) return;
  const act = b.dataset.act;
  if (act === 'go-drills') navigate('learn', 'drills');
  else if (act === 'go-openings') navigate('learn', 'openings');
  else if (act === 'go-settings') navigate('settings');
  else if (act === 'game') { setGame(+b.dataset.gi, 0); navigate('play'); }
  else if (act === 'worst') { setGame(+b.dataset.gi, +b.dataset.ply); navigate('play'); }
  else if (act === 'check') ask(b.dataset.site);
  else if (act === 'import-new') { b.disabled = true; importNews(b.dataset.site); }
  // 'import' is handled by sources.js's own document-level listener.
}

export function boot() {
  registerRoom('home', enter);
  if (typeof document === 'undefined') return;
  const body = $('home-body');
  if (body) body.addEventListener('click', onClick);
  // The library landing, the deck moving, a scan finishing, the book changing: every one
  // of them changes a figure on this page. Delegated so a repaint never re-wires.
  for (const ev of ['cr:restored', 'cr:deck-changed', 'cr:analysis-done', 'cr:book-changed']) {
    document.addEventListener(ev, repaint);
  }
  // An erased library has no watermark, so it has no news either — sources.js forgets
  // its checks on the same event and this forgets the answers.
  document.addEventListener('cr:games-removed', () => { _news.clear(); repaint(); });
  document.addEventListener('cr:games-added', () => { recount(); repaint(); });
  paintBadge();
}
