/*
 * Sources (§3, §4 pipeline; build order step 4). Paste, URL, Chess.com and Lichess all
 * resolve to PGN text and converge on loadPGNText(), the single entry into parsing. An
 * import merges by id rather than replacing: the ones already present are dropped,
 * counted and said.
 *
 * The file is in two halves on purpose. The top half is arithmetic and fetching — the
 * normalisers, the archive walkers, the tracker — and never names `document`, so the
 * tests can import it in node with only `fetch` stubbed. The bottom half, from
 * wireSources() down, is the dialog. Nothing in the top half reaches into the bottom.
 */
import { S, saveSettings } from './state.js';
import { loadGames, mergeGames } from './pgn.js';
import { $, escHtml, toast, showLoading, hideLoading, plural, emptyHTML, fmtDate } from './dom.js';
import { updateAll } from './render.js';
import { setGame } from './playback.js';

const _added = [];
/** memory.js and the sweep listen here for games that arrived. */
export function onGamesAdded(fn) { _added.push(fn); }

/**
 * Parse text, merge into S.games, repaint. Resolves {added, dupes, skipped}.
 * `source` is a short tag stored on each game ('paste' | 'url' | 'chesscom' | 'lichess').
 */
export async function loadPGNText(text, source = 'paste') {
  const t0 = Date.now();
  let shown = false;
  const { games, skipped } = await loadGames(text, (done, total) => {
    if (total > 20) { shown = true; showLoading('Reading ' + done + ' of ' + plural(total, 'game') + '…', done / total); }
  });
  if (shown) hideLoading();
  const now = Date.now();
  for (const g of games) { g.source = source; g.addedAt = now; g.seq = ++S._seq; g.bytes = g.pgn.length; }
  const before = S.games.length;
  const { added, dupes } = mergeGames(S.games, games);
  const fresh = S.games.slice(before);
  if (added && !S.playing) setGame(before, 0); else updateAll();
  const parts = [];
  if (added) parts.push(plural(added, 'game') + ' added');
  if (dupes) parts.push(plural(dupes, 'game') + ' already here');
  if (skipped) parts.push(plural(skipped, 'game') + ' would not parse');
  if (!parts.length) parts.push('Nothing in that text looked like a game');
  toast(parts.join(', ') + '.');
  for (const fn of _added) fn(fresh);
  document.dispatchEvent(new CustomEvent('cr:games-added', { detail: { games: fresh } }));
  return { added, dupes, skipped, games: fresh, ms: Date.now() - t0 };
}

/* ===================================================================================
 * The two sites, and the one row shape they both reduce to
 * =================================================================================== */

export const TRACKER_SITES = ['chesscom', 'lichess'];
export const SITE_NAMES = { chesscom: 'Chess.com', lichess: 'Lichess' };
/* A lookup stops here. Enough for every report in Insights to have a sample; small
 * enough that Chess.com's month-by-month archive is a handful of requests. */
export const LOOKUP_MAX = 300;
/* Coming back to the tab is not a reason to ask a site anything. The floor between two
 * checks of one site — deliberately far longer than a chess game. */
export const TRACKER_GAP_MS = 30 * 60 * 1000;
/* Past this the honest answer is an import, not a count. */
export const TRACKER_MAX = 100;

const CHESSCOM_API = 'https://api.chess.com/pub/player/';
const LICHESS_API = 'https://lichess.org/api/games/user/';
/* chess.js parses orthodox chess. Filtering at the API keeps variant games out of a
 * browser where selecting them would only produce a parse failure later. */
const LICHESS_PERFS = 'ultraBullet,bullet,blitz,rapid,classical,correspondence';

/**
 * @typedef {object} SourceRow  One game as the browser and the tracker both want it.
 * @property {'chesscom'|'lichess'} site
 * @property {string} pgn
 * @property {string} white
 * @property {string} black
 * @property {number} whiteRating   0 when unknown
 * @property {number} blackRating
 * @property {string} timeClass     bullet | blitz | rapid | classical | daily
 * @property {'w'|'l'|'d'} result   from the looked-up user's view
 * @property {string} reason        checkmate, resignation, time, …; '' when unknown
 * @property {number} endTime       ms since the epoch, 0 when unknown — ms, not seconds,
 *                                  so Date.now(), fmtDate() and Lichess agree without a *1000
 * @property {string} opponent
 * @property {string} url
 */

const lower = s => String(s || '').trim().toLowerCase();

/* Chess.com puts the reason on the loser's side ('resigned', 'timeout', …) and on both
 * sides of a draw; the winner just says 'win'. */
const CC_LOSSES = ['checkmated', 'timeout', 'resigned', 'lose', 'abandoned', 'bughousepartnerlose', 'threecheck', 'kingofthehill'];
const CC_REASONS = {
  checkmated: 'checkmate', timeout: 'time', resigned: 'resignation', abandoned: 'abandoned',
  stalemate: 'stalemate', agreed: 'agreement', repetition: 'repetition', insufficient: 'insufficient material',
  '50move': '50-move rule', timevsinsufficient: 'time vs insufficient material',
};

/**
 * One game of a Chess.com month archive → a SourceRow, or null for anything the app
 * cannot read: no PGN, or a variant. `rules` is checked rather than `time_class`
 * because Chess960 and bughouse are served in the same months as chess.
 */
export function normaliseChesscom(g, user) {
  if (!g || typeof g.pgn !== 'string' || !g.pgn.trim()) return null;
  if (g.rules && g.rules !== 'chess') return null;
  const white = (g.white && g.white.username) || '?';
  const black = (g.black && g.black.username) || '?';
  const wr = (g.white && g.white.result) || '', br = (g.black && g.black.result) || '';
  const u = lower(user);
  // A user who is neither player (a stale field, a renamed account) is read as White:
  // the row still needs a side to be from, and White is the PGN's own default.
  const isWhite = u ? lower(white) === u || lower(black) !== u : true;
  const mine = isWhite ? wr : br;
  const result = mine === 'win' ? 'w' : CC_LOSSES.includes(mine) ? 'l' : 'd';
  const loserCode = wr === 'win' ? br : wr;
  return {
    site: 'chesscom', pgn: g.pgn, white, black,
    whiteRating: Number((g.white && g.white.rating) || 0), blackRating: Number((g.black && g.black.rating) || 0),
    timeClass: g.time_class || 'unknown', result, reason: CC_REASONS[loserCode] || '',
    endTime: (Number(g.end_time) || 0) * 1000, opponent: isWhite ? black : white, url: g.url || '',
  };
}

const LICHESS_REASONS = {
  mate: 'checkmate', resign: 'resignation', timeout: 'time', outoftime: 'time', stalemate: 'stalemate',
  draw: 'agreement', repetition: 'repetition', insufficientMaterialClaim: 'insufficient material',
  cheat: 'fair-play closure', unknownFinish: 'finished',
};
const LICHESS_SPEEDS = { ultraBullet: 'bullet', bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'classical', correspondence: 'daily' };

function lichessPlayer(side) {
  if (!side) return 'Anonymous';
  if (side.user && (side.user.name || side.user.id)) return side.user.name || side.user.id;
  if (side.aiLevel) return 'Stockfish level ' + side.aiLevel;
  return side.name || 'Anonymous';
}

const pad2 = n => String(n).padStart(2, '0');

/**
 * Lichess's PGN carries the start (UTCDate/UTCTime) and its JSON envelope carries
 * lastMoveAt; Chess.com writes the finish into EndDate/EndTime. Insights reads the finish
 * off those two headers for the time-of-day and tilt findings, so a Lichess game without
 * them is not "a game with no clock" — it is silently dropped from those reports. The
 * opening name rides along for the same reason: it is in the envelope, not the PGN.
 * Headers already present are left alone.
 */
export function withLichessHeaders(pgn, lastMoveAt, openingName) {
  pgn = String(pgn || '');
  const extra = [];
  const d = new Date(Number(lastMoveAt));
  if (Number.isFinite(lastMoveAt) && Number.isFinite(d.getTime())) {
    if (!/^\[EndDate\s+"/m.test(pgn)) extra.push('[EndDate "' + d.getUTCFullYear() + '.' + pad2(d.getUTCMonth() + 1) + '.' + pad2(d.getUTCDate()) + '"]');
    if (!/^\[EndTime\s+"/m.test(pgn)) extra.push('[EndTime "' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + '"]');
  }
  if (openingName && !/^\[Opening\s+"/m.test(pgn)) extra.push('[Opening "' + String(openingName).replace(/"/g, '\\"') + '"]');
  if (!extra.length) return pgn;
  const split = pgn.search(/\r?\n\r?\n/);
  // A PGN with no blank line has no header block to extend; prepend one rather than guess.
  if (split < 0) return extra.join('\n') + '\n' + pgn;
  return pgn.slice(0, split) + '\n' + extra.join('\n') + pgn.slice(split);
}

/**
 * One line of the Lichess NDJSON export (already parsed) → a SourceRow, or null. Games
 * aborted before a first move have no chess to read and would only fail at parse.
 */
export function normaliseLichessLine(g, user) {
  if (!g || typeof g !== 'object' || typeof g.pgn !== 'string') return null;
  if (g.status === 'aborted' || g.status === 'noStart') return null;
  if (g.variant && g.variant !== 'standard') return null;
  const white = lichessPlayer(g.players && g.players.white);
  const black = lichessPlayer(g.players && g.players.black);
  const u = lower(user);
  const isWhite = u ? lower(white) === u || lower(black) !== u : true;
  const winner = g.winner === 'white' || g.winner === 'black' ? g.winner : '';
  const result = !winner ? 'd' : (winner === 'white') === isWhite ? 'w' : 'l';
  return {
    site: 'lichess', pgn: withLichessHeaders(g.pgn, g.lastMoveAt, g.opening && g.opening.name), white, black,
    whiteRating: Number((g.players && g.players.white && g.players.white.rating) || 0),
    blackRating: Number((g.players && g.players.black && g.players.black.rating) || 0),
    timeClass: LICHESS_SPEEDS[g.speed] || (g.speed || 'unknown'), result, reason: LICHESS_REASONS[g.status] || '',
    endTime: Number(g.lastMoveAt) || 0, opponent: isWhite ? black : white,
    url: g.id ? 'https://lichess.org/' + g.id : '',
  };
}

/* ----- Fetching ----- */

/**
 * The URL tab's fetch. Resolves {ok, text} or {ok:false, error}. The failure sentence
 * names CORS because that, not the URL, is what decides: a browser may only read a
 * cross-origin response the host has said it may, and the same URL that opens in a tab
 * can refuse here. The door is the Paste tab's file picker.
 */
export async function fetchPGNFromURL(url) {
  url = String(url || '').trim();
  if (!url) return { ok: false, error: 'Type or paste a URL first.' };
  let host = url;
  try { host = new URL(url, 'https://x.invalid').hostname || url; } catch (e) { /* named as typed */ }
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return { ok: true, text: await resp.text() };
  } catch (e) {
    return {
      ok: false,
      error: 'Could not fetch from ' + host + ' (' + (e && e.message || 'no response') + '). ' +
        "The host's CORS headers decide whether a browser may fetch it, so a page that opens in a tab can still refuse here. " +
        'Save the file and open it from the Paste tab instead.',
    };
  }
}

/** Fetch JSON, with 404 and 429 as sentences of their own. Throws. */
async function getJSON(url, site, user) {
  const resp = await fetch(url);
  if (resp.status === 404) throw new Error('No ' + SITE_NAMES[site] + ' player called ' + user + '.');
  if (resp.status === 429) throw new Error(SITE_NAMES[site] + ' is rate-limiting requests. Wait a minute and try again.');
  if (!resp.ok) throw new Error(SITE_NAMES[site] + ' answered HTTP ' + resp.status + '.');
  return resp.json();
}

/**
 * Chess.com: the archive index, newest month first. A player with no games has an
 * archive list with nothing in it, which is a different sentence from no player.
 */
export async function chesscomArchives(user) {
  const d = await getJSON(CHESSCOM_API + encodeURIComponent(lower(user)) + '/games/archives', 'chesscom', user);
  return (d.archives || []).slice().reverse();
}

/**
 * Walk months newest-first until `max` games or the archive runs out. Resolves rows
 * newest first. A month that will not answer is skipped, not fatal: a 2019 archive
 * that 500s should not take this month's games with it.
 */
export async function lookupChesscom(user, { max = LOOKUP_MAX, onProgress } = {}) {
  user = String(user || '').trim();
  const urls = await chesscomArchives(user);
  const rows = [];
  for (let i = 0; i < urls.length && rows.length < max; i++) {
    if (onProgress) onProgress(rows.length, i + 1, urls.length);
    try {
      const r = await fetch(urls[i]);
      if (!r.ok) continue;
      const d = await r.json();
      const month = (d.games || []).map(g => normaliseChesscom(g, user)).filter(Boolean);
      month.sort((a, b) => b.endTime - a.endTime);
      rows.push(...month);
    } catch (e) { /* one bad month does not end the walk */ }
  }
  rows.sort((a, b) => b.endTime - a.endTime);
  return rows.slice(0, max);
}

/**
 * Lichess: the NDJSON export, streamed. `since` is ms and exclusive. Resolves rows
 * newest first. Streamed rather than text()'d because a public Lichess archive can run
 * to hundreds of thousands of games, and a second archive-sized string is the wrong
 * way to find out. A malformed line is skipped without poisoning the rest.
 */
export async function fetchLichess(user, { max = LOOKUP_MAX, since = 0, onProgress } = {}) {
  user = String(user || '').trim();
  const url = new URL(LICHESS_API + encodeURIComponent(user));
  url.searchParams.set('max', String(max));
  url.searchParams.set('clocks', 'true');
  url.searchParams.set('opening', 'true');
  url.searchParams.set('pgnInJson', 'true');
  url.searchParams.set('perfType', LICHESS_PERFS);
  if (since > 0) url.searchParams.set('since', String(Math.floor(since)));
  const resp = await fetch(url.toString(), { headers: { Accept: 'application/x-ndjson' } });
  if (resp.status === 404) throw new Error('No Lichess player called ' + user + '.');
  if (resp.status === 429) throw new Error('Lichess is rate-limiting requests. Wait a minute and try again.');
  if (!resp.ok) throw new Error('Lichess answered HTTP ' + resp.status + '.');
  const rows = [];
  const accept = line => {
    if (!line.trim()) return;
    try { const row = normaliseLichessLine(JSON.parse(line), user); if (row) { rows.push(row); if (onProgress) onProgress(rows.length); } }
    catch (e) { /* one malformed row */ }
  };
  if (resp.body && resp.body.getReader) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach(accept);
      if (done) { accept(pending); break; }
    }
  } else {
    String(await resp.text()).split(/\r?\n/).forEach(accept);
  }
  rows.sort((a, b) => b.endTime - a.endTime);
  return rows;
}

/* ===================================================================================
 * The tracker — "7 new games since Tuesday" (§6 Home)
 *
 * The watermark is not stored anywhere: it is derived from the library each time, as
 * the newest finish among the games imported from that site. A stored number would
 * need moving on import, resetting on erase, and reconciling on sync; a derived one is
 * right by construction — a reader who took four of forty games has seen four.
 *
 * It never runs on its own (§2.7). Home calls checkNewGames() on a press or an arrival
 * and decides what to do with the answer; this module only enforces the floor.
 * =================================================================================== */

/** The saved handle for a site, '' when none. */
export function savedUser(site) { return lower(site === 'lichess' ? S.lichessUser : S.chesscomUser); }

/**
 * When a game finished, in ms, from its headers: EndDate+EndTime (Chess.com writes them,
 * Lichess rows gain them above), else UTCDate+UTCTime (the start — close enough for a
 * watermark), else null. Null rather than the Date header alone: a day with no time is
 * midnight, and a midnight watermark would report the whole day's games as new forever.
 */
export function gameEndMs(game) {
  const h = (game && game.headers) || {};
  const pick = (dk, tk) => {
    const dm = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(h[dk] || '');
    const tm = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(h[tk] || '');
    if (!dm || !tm) return null;
    const ms = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +tm[3]);
    return Number.isFinite(ms) ? ms : null;
  };
  return pick('EndDate', 'EndTime') ?? pick('UTCDate', 'UTCTime');
}

/** The newest finish among the games imported from `site`, in ms; 0 when none. */
export function newestImported(site, games = S.games) {
  let best = 0;
  for (const g of games) {
    if (g.source !== site) continue;
    const t = gameEndMs(g);
    if (t && t > best) best = t;
  }
  return best;
}

/* site → {at, rows, since} from the last check. Module state, not S: a floor between
 * network requests is a fact about this tab's session, not about the library. */
const _checked = new Map();
/** Forget every check — after an erase, or in a test. */
export function resetTracker() { _checked.clear(); }
/** The last check's stamp for a site, for a caller that wants to say "checked 12 minutes ago". */
export function lastChecked(site) { const c = _checked.get(site); return c ? c.at : 0; }

/**
 * Chess.com has no `since`; the current month's archive is the smallest thing it
 * serves. When the watermark sits in the month before, that month is asked too — a
 * game played on the 31st and imported on the 1st is exactly the kind of news this
 * exists to notice, and it costs one more request at most.
 */
async function chesscomSince(user, since) {
  const now = new Date();
  const months = [[now.getUTCFullYear(), now.getUTCMonth()]];
  const then = new Date(since);
  const gap = (now.getUTCFullYear() * 12 + now.getUTCMonth()) - (then.getUTCFullYear() * 12 + then.getUTCMonth());
  if (gap === 1) months.push([then.getUTCFullYear(), then.getUTCMonth()]);
  const rows = [];
  for (const [y, m] of months) {
    const d = await getJSON(CHESSCOM_API + encodeURIComponent(lower(user)) + '/games/' + y + '/' + pad2(m + 1), 'chesscom', user);
    for (const g of (d.games || [])) { const row = normaliseChesscom(g, user); if (row && row.endTime > since) rows.push(row); }
  }
  rows.sort((a, b) => b.endTime - a.endTime);
  return rows;
}

/**
 * What has happened on `site` since the newest game imported from it. Resolves
 * {count, since} (since in ms — the watermark, for "since Tuesday"), or null when there
 * is nothing to ask about: no saved username, no games imported from that site yet
 * (a handle with no games behind it is the reader the import button is for), or the
 * site would not answer. Within TRACKER_GAP_MS of the last check the last answer is
 * returned again, re-counted against the current watermark, without a request.
 */
export async function checkNewGames(site, now = Date.now()) {
  if (!TRACKER_SITES.includes(site)) return null;
  const user = savedUser(site);
  if (!user) return null;
  const since = newestImported(site);
  if (!since) return null;
  const prev = _checked.get(site);
  if (prev && now - prev.at < TRACKER_GAP_MS) {
    if (!prev.rows) return null;
    return { count: prev.rows.filter(r => r.endTime > since).length, since };
  }
  // Stamped before the request, so a second press while the first is in flight, or a
  // site that refuses, both wait the full gap. A rate-limiting site is the last one
  // worth asking again in thirty seconds.
  const entry = { at: now, rows: null, user, since };
  _checked.set(site, entry);
  try {
    const rows = site === 'lichess'
      ? await fetchLichess(user, { max: TRACKER_MAX, since: since + 1 })
      : await chesscomSince(user, since);
    entry.rows = rows.filter(r => r.endTime > since).slice(0, TRACKER_MAX);
    return { count: entry.rows.length, since };
  } catch (e) {
    return null;
  }
}

/**
 * Import exactly the games the last check counted. A press, so it may fetch: with no
 * check behind it (or a stale one) it asks first, ignoring the floor — the floor is for
 * checks nobody asked for, not for a reader pressing "import". Resolves loadPGNText's
 * result, or null when there was nothing to import.
 */
export async function importNewGames(site) {
  const user = savedUser(site);
  const since = newestImported(site);
  if (!user || !since) return null;
  let entry = _checked.get(site);
  if (!entry || !entry.rows || entry.user !== user) {
    _checked.delete(site);
    if (!(await checkNewGames(site))) return null;
    entry = _checked.get(site);
  }
  const rows = entry.rows.filter(r => r.endTime > since);
  if (!rows.length) return null;
  const res = await loadPGNText(rows.map(r => r.pgn).join('\n\n'), site);
  // What was news is now history; the watermark has moved with the library.
  entry.rows = [];
  return res;
}

/* ===================================================================================
 * The dialog. Nothing above this line names `document`.
 * =================================================================================== */

export function openImport(tab) {
  const dlg = $('dlg-import');
  if (!dlg) return;
  if (tab) showImportTab(tab);
  if (!dlg.open) dlg.showModal();
  prefillUsers();
  const pane = document.querySelector('#dlg-import [data-pane]:not(.hidden)');
  const first = pane && pane.querySelector('textarea, input:not([type=file])');
  if (first) first.focus();
}
export function closeImport() { const dlg = $('dlg-import'); if (dlg && dlg.open) dlg.close(); }

export function showImportTab(tab) {
  for (const b of document.querySelectorAll('#import-tabs .tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('#dlg-import [data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== tab);
  // The browser belongs to the tab that filled it; another tab's pane should not sit
  // above a list of a different site's games.
  const br = $('source-browser');
  if (br) br.classList.toggle('hidden', !(_browser.rows.length && _browser.site === tab));
}

/* ----- The panes ----- */

function paneHTML(site) {
  if (site === 'url') {
    return '<form class="src-form" id="form-url" novalidate>' +
      '<label class="src-field">URL of a .pgn file<input type="url" id="url-input" placeholder="https://…/games.pgn" autocomplete="off" spellcheck="false"></label>' +
      '<button class="btn btn-primary" type="submit" id="btn-url-fetch">Fetch</button></form>' +
      '<p class="hint src-status" id="status-url" role="status"></p>';
  }
  const name = SITE_NAMES[site];
  return '<form class="src-form" id="form-' + site + '" novalidate>' +
    '<label class="src-field">' + name + ' username<input type="text" id="' + site + '-user" autocomplete="off" spellcheck="false" autocapitalize="off"></label>' +
    '<button class="btn btn-primary" type="submit" id="btn-' + site + '-lookup">Look up</button></form>' +
    '<p class="hint src-status" id="status-' + site + '" role="status"></p>';
}

function setStatus(site, text, err) {
  const el = $('status-' + site);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('src-err', !!err);
}

/* The field follows the setting, not the other way round: a handle typed here becomes
 * the default only after a lookup finds games (see remember()). */
function prefillUsers() {
  for (const site of TRACKER_SITES) {
    const el = $(site + '-user');
    if (el && !el.value.trim()) el.value = site === 'lichess' ? S.lichessUser : S.chesscomUser;
  }
}

/** A successful lookup is the point at which a typed handle becomes trusted. */
function remember(site, display) {
  const key = site === 'lichess' ? 'lichessUser' : 'chesscomUser';
  if (S[key] === display) return;
  S[key] = display;
  saveSettings();
  document.dispatchEvent(new CustomEvent('cr:setting', { detail: { key } }));
}

async function runURL() {
  const input = $('url-input');
  const url = input.value.trim();
  if (!url) { setStatus('url', 'Type or paste a URL first.', true); input.focus(); return; }
  setStatus('url', 'Fetching…');
  $('btn-url-fetch').disabled = true;
  const r = await fetchPGNFromURL(url);
  $('btn-url-fetch').disabled = false;
  if (!r.ok) { setStatus('url', r.error, true); input.focus(); return; }
  setStatus('url', '');
  closeImport();
  await loadPGNText(r.text, 'url');
  input.value = '';
}

async function runLookup(site) {
  const input = $(site + '-user');
  const display = input.value.trim();
  const name = SITE_NAMES[site];
  if (!display) { setStatus(site, 'Type a ' + name + ' username first.', true); input.focus(); return; }
  const btn = $('btn-' + site + '-lookup');
  btn.disabled = true;
  hideBrowser();
  setStatus(site, 'Asking ' + name + ' about ' + display + '…');
  try {
    const rows = site === 'lichess'
      ? await fetchLichess(display, { max: LOOKUP_MAX, onProgress: n => setStatus(site, plural(n, 'game') + ' received…') })
      : await lookupChesscom(display, { max: LOOKUP_MAX, onProgress: (n, i, total) => setStatus(site, plural(n, 'game') + ' so far — month ' + i + ' of ' + total + '…') });
    if (!rows.length) { setStatus(site, 'No games for ' + display + ' on ' + name + ' yet. Check the spelling, or try the other site.', true); input.focus(); return; }
    remember(site, display);
    setStatus(site, plural(rows.length, 'game') + ' from ' + name + ' for ' + display + '. Choose below.');
    showBrowser(site, display, rows);
  } catch (e) {
    setStatus(site, (e && e.message) || (name + ' did not answer.'), true);
    input.focus();
  } finally {
    btn.disabled = false;
  }
}

/* ----- The source browser ----- */

const _browser = { site: '', user: '', rows: [], selected: new Set(), tc: 'all', result: 'all', opp: '' };

function hideBrowser() {
  _browser.rows = []; _browser.selected = new Set();
  const br = $('source-browser'); if (br) { br.classList.add('hidden'); br.innerHTML = ''; }
}

function showBrowser(site, user, rows) {
  Object.assign(_browser, { site, user, rows, selected: new Set(rows.map((_, i) => i)), tc: 'all', result: 'all', opp: '' });
  const br = $('source-browser');
  if (!br) return;
  const classes = [...new Set(rows.map(r => r.timeClass))];
  br.innerHTML =
    '<div class="src-bar"><span class="src-title" id="src-title"></span><span class="src-meta num" id="src-meta"></span></div>' +
    '<div class="src-filters">' +
      '<label>Time<select id="src-f-tc"><option value="all">All</option>' + classes.map(c => '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>').join('') + '</select></label>' +
      '<label>Result<select id="src-f-result"><option value="all">All</option><option value="w">Wins</option><option value="l">Losses</option><option value="d">Draws</option></select></label>' +
      '<label class="src-f-opp">Opponent<input type="text" id="src-f-opp" placeholder="Anyone" autocomplete="off"></label>' +
    '</div>' +
    '<div class="src-actions">' +
      '<button class="btn btn-sm" type="button" id="src-all">Select all shown</button>' +
      '<button class="btn btn-sm" type="button" id="src-none">Select none</button>' +
      '<span class="src-count num" id="src-count"></span>' +
      '<button class="btn btn-primary" type="button" id="src-import">Import selected</button>' +
    '</div>' +
    '<div class="src-list" id="src-list"></div>';
  br.classList.remove('hidden');
  renderBrowser();
  $('src-f-tc').focus();
}

function visibleIndices() {
  const out = [];
  _browser.rows.forEach((r, i) => {
    if (_browser.tc !== 'all' && r.timeClass !== _browser.tc) return;
    if (_browser.result !== 'all' && r.result !== _browser.result) return;
    if (_browser.opp && !lower(r.opponent).includes(_browser.opp)) return;
    out.push(i);
  });
  return out;
}

const RESULT_WORD = { w: 'Win', l: 'Loss', d: 'Draw' };

function renderBrowser() {
  const { rows, selected, site, user } = _browser;
  const vis = visibleIndices();
  $('src-title').textContent = user + ' on ' + SITE_NAMES[site];
  $('src-meta').textContent = vis.length + ' of ' + plural(rows.length, 'game') + ' shown';
  $('src-count').textContent = plural(selected.size, 'game') + ' selected';
  $('src-import').disabled = !selected.size;
  const list = $('src-list');
  if (!vis.length) { list.innerHTML = emptyHTML('No games match those filters.', 'Clear the filters', 'src-clear'); return; }
  let html = '<table class="src-table"><thead><tr><th class="src-check"><span class="sr-only">Select</span></th><th>When</th><th>White</th><th>Black</th><th>Time</th><th>Result</th><th>How</th></tr></thead><tbody>';
  for (const i of vis) {
    const r = rows[i];
    const rate = n => (n ? ' <span class="src-rating num">' + n + '</span>' : '');
    html += '<tr data-i="' + i + '" class="src-row src-' + r.result + '">' +
      '<td class="src-check"><input type="checkbox" data-i="' + i + '"' + (selected.has(i) ? ' checked' : '') + ' aria-label="Select game ' + (i + 1) + '"></td>' +
      '<td class="num">' + escHtml(fmtDate(r.endTime)) + '</td>' +
      '<td>' + escHtml(r.white) + rate(r.whiteRating) + '</td>' +
      '<td>' + escHtml(r.black) + rate(r.blackRating) + '</td>' +
      '<td>' + escHtml(r.timeClass) + '</td>' +
      '<td class="src-result">' + RESULT_WORD[r.result] + '</td>' +
      '<td class="src-reason">' + escHtml(r.reason) + '</td></tr>';
  }
  list.innerHTML = html + '</tbody></table>';
}

function wireBrowser() {
  const br = $('source-browser');
  if (!br) return;
  br.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'src-f-tc') { _browser.tc = t.value; renderBrowser(); }
    else if (t.id === 'src-f-result') { _browser.result = t.value; renderBrowser(); }
    else if (t.type === 'checkbox' && t.dataset.i != null) {
      if (t.checked) _browser.selected.add(+t.dataset.i); else _browser.selected.delete(+t.dataset.i);
      $('src-count').textContent = plural(_browser.selected.size, 'game') + ' selected';
      $('src-import').disabled = !_browser.selected.size;
    }
  });
  let oppTimer = 0;
  br.addEventListener('input', e => {
    if (e.target.id !== 'src-f-opp') return;
    clearTimeout(oppTimer);
    oppTimer = setTimeout(() => { _browser.opp = lower(e.target.value); renderBrowser(); }, 150);
  });
  br.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'src-all') { for (const i of visibleIndices()) _browser.selected.add(i); renderBrowser(); }
    else if (b.id === 'src-none') { _browser.selected.clear(); renderBrowser(); }
    else if (b.dataset.act === 'src-clear') {
      _browser.tc = 'all'; _browser.result = 'all'; _browser.opp = '';
      $('src-f-tc').value = 'all'; $('src-f-result').value = 'all'; $('src-f-opp').value = '';
      renderBrowser();
    }
    else if (b.id === 'src-import') {
      const rows = [..._browser.selected].sort((a, b2) => a - b2).map(i => _browser.rows[i]);
      if (!rows.length) return;
      const site = _browser.site;
      closeImport();
      hideBrowser();
      await loadPGNText(rows.map(r => r.pgn).join('\n\n'), site);
      // The library moved, so the news did too.
      const c = _checked.get(site); if (c && c.rows) { const since = newestImported(site); c.rows = c.rows.filter(r => r.endTime > since); }
    }
  });
}

export function wireSources() {
  $('import-tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) openImport(b.dataset.tab); });
  $('btn-paste-load').addEventListener('click', async () => {
    const text = $('pgn-text').value;
    if (!text.trim()) { toast('Paste a game first.'); return; }
    closeImport();
    await loadPGNText(text, 'paste');
    $('pgn-text').value = '';
  });
  $('pgn-file').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const text = await f.text();
    closeImport();
    await loadPGNText(text, 'paste');
    e.target.value = '';
  });
  document.addEventListener('cr:import', () => openImport());
  document.addEventListener('click', e => { const b = e.target.closest('[data-act="import"]'); if (b) openImport(); });

  // The three fetching panes. Forms, so Enter submits and the whole dialog works by keyboard.
  for (const site of ['url', 'chesscom', 'lichess']) {
    const pane = $('pane-' + site);
    if (!pane) continue;
    pane.innerHTML = paneHTML(site);
    $('form-' + site).addEventListener('submit', e => { e.preventDefault(); site === 'url' ? runURL() : runLookup(site); });
  }
  prefillUsers();
  // Settings' fields and these agree in both directions.
  document.addEventListener('cr:setting', e => {
    const k = e.detail && e.detail.key;
    if (k === 'chesscomUser' || k === 'lichessUser') { const el = $(k === 'lichessUser' ? 'lichess-user' : 'chesscom-user'); if (el) el.value = S[k]; }
  });
  // An erased library has no watermark; a cached count against the old one would be a lie.
  document.addEventListener('cr:games-removed', resetTracker);
  wireBrowser();
}
