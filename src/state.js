/*
 * S — the single source of truth (§2.4).
 *
 * One mutable object. Render functions read it and never hold their own copies;
 * anything that changes state calls an update function. Settings are the subset of it
 * named in SETTINGS below; the rest is session state and dies with the tab.
 */

export const SKEY = 'chessReaderSettings';

/*
 * The only list that says what a valid theme is. A stored value not in it is ignored
 * rather than applied, so a hand-edited blob cannot leave <html> wearing an attribute
 * no stylesheet answers. First is the default — and it is also the one on bare :root
 * and the one the pre-paint lines in index.html know about. Three places, on purpose.
 */
export const THEMES = ['analysis', 'midnight', 'wood', 'green'];
export const THEME_NAMES = { analysis: 'Analysis', midnight: 'Midnight board', wood: 'Wood & ink', green: 'Tournament green' };

export const VERBOSITIES = ['full', 'natural', 'short'];
export const REPEATS = ['off', 'game', 'queue'];
export const PROBE_DEPTHS = [18, 22, 26];
/* The sweep's duty cycle: idle gap between searches, in ms. Never a depth (§7). */
export const SWEEP_PACES = { fast: 0, steady: 600, gentle: 1800 };
/* Which engine answers which kind of job (§7). */
export const ENGINE_MODES = ['local', 'remote', 'split'];
export const TTS_BACKENDS = ['browser', 'api'];

export const S = {
  // the library and the cursor
  games: [],
  gi: 0,            // current game index
  ply: 0,           // 0 = start position, n = after the nth half-move
  hero: null,       // the inferred subject, {name, key}; resolved by insights

  // transport
  playing: false,
  timer: null,      // the pending inter-move timeout
  uttId: 0,         // the utterance ticket — see speech/provider.js
  announced: false, // this game's announcement has been spoken
  openingSaid: false,
  awaitingGuess: false,
  flipped: false,

  // a variation is a position the game never reached, so it is not a ply (§7)
  varFrom: -1, varMoves: [], varFens: [], varAt: 0,

  // settings — see SETTINGS for the schema; defaults are filled in below
  // session-only latches
  _restoring: true,   // the library is still coming back off the disk
  _memToldOff: false, // the storage-unavailable sentence has been said this session
  _failCount: 0,      // consecutive TTS API failures
  _degraded: false,   // latched: the API voice is out for the session
  _noticeShown: false,
  _seq: 0,

  // analysis
  analysisOn: false,
  _scanGen: 0,

  // the sweep
  _sweepAutoPaused: false,

  // the deck, book, tactics and opponents are Maps filled by memory.js
  deck: new Map(),
  tactics: new Map(),
  book: new Map(),
  opponents: [],
};

/*
 * The settings schema. Every persisted field is a row here: its default, and a guard
 * that says whether a stored value may be applied. loadSettings() walks the table, so a
 * blob written by an older version, a hand-edited one, or one with keys this version
 * has never heard of all load without a migration — a field the guard refuses keeps
 * its default, and a key not in the table is ignored.
 *
 * Prefer a guard that returns false over one that coerces: a stored depth of 400 would
 * hang the engine on the first question anyone asked, and a stored theme nobody
 * defines would leave the page unstyled.
 */
const str = v => typeof v === 'string';
const bool = v => typeof v === 'boolean';
const oneOf = list => v => list.includes(v);
const num = (lo, hi) => v => Number.isFinite(v) && v >= lo && v <= hi;

export const SETTINGS = {
  verbosity: { def: 'full', ok: oneOf(VERBOSITIES) },
  interval: { def: 3000, ok: num(0, 60000) },
  repeat: { def: 'off', ok: oneOf(REPEATS) },
  blackPause: { def: false, ok: bool },
  announce: { def: true, ok: bool },
  speakEverywhere: { def: false, ok: bool },
  theme: { def: THEMES[0], ok: oneOf(THEMES) },
  coords: { def: false, ok: bool },
  chesscomUser: { def: '', ok: str },
  lichessUser: { def: '', ok: str },
  remember: { def: true, ok: bool },         // absent means on: an old blob is not a "no"
  probeDepth: { def: 22, ok: v => PROBE_DEPTHS.includes(v) },
  // the sweep: consent and the reader's own pause survive the tab; an auto-pause does not
  sweepOn: { def: false, ok: bool },
  sweepPaused: { def: false, ok: bool },
  sweepPace: { def: 'steady', ok: v => Object.prototype.hasOwnProperty.call(SWEEP_PACES, v) },
  // the engine (§7)
  engineMode: { def: 'local', ok: oneOf(ENGINE_MODES) },
  engineUrl: { def: '', ok: str },
  engineToken: { def: '', ok: str },
  // the AI provider block (§8) — one block serving the voice and the explanations.
  // The key is stored in localStorage and the Settings card says so beside the field.
  ttsBackend: { def: 'browser', ok: oneOf(TTS_BACKENDS) },
  aiBase: { def: 'https://api.openai.com/v1', ok: str },
  aiKey: { def: '', ok: str },
  aiSpeechModel: { def: 'gpt-4o-mini-tts', ok: str },
  aiVoice: { def: 'nova', ok: str },
  aiChatModel: { def: 'gpt-4o-mini', ok: str },
  ttsFallbackNoticeDismissed: { def: false, ok: bool },
  // optional sync (§9)
  syncOn: { def: false, ok: bool },
  syncUrl: { def: '', ok: str },
  syncToken: { def: '', ok: str },
  // the Insights subject, when the reader overrides the inferred one (§6): a player key
  heroOverride: { def: '', ok: str },
  // where Learn was last stood in
  learnSection: { def: 'openings', ok: oneOf(['openings', 'tactics', 'drills']) },
};

for (const [k, row] of Object.entries(SETTINGS)) S[k] = row.def;

/** Apply a stored blob to S, guarding every field individually. Exported for the test. */
export function applySettings(d) {
  if (!d || typeof d !== 'object') return;
  for (const [k, row] of Object.entries(SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(d, k) && row.ok(d[k])) S[k] = d[k];
  }
}

export function loadSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(SKEY);
    if (raw) applySettings(JSON.parse(raw));
  } catch (e) { /* the defaults stand */ }
}

export function saveSettings(storage = globalThis.localStorage) {
  const out = {};
  for (const k of Object.keys(SETTINGS)) out[k] = S[k];
  try { storage && storage.setItem(SKEY, JSON.stringify(out)); } catch (e) { /* full or refused */ }
}

/*
 * One attribute on <html> is the whole mechanism. Every colour comes from a custom
 * property, so the stylesheet does the rest and nothing needs re-rendering — not the
 * board, not the pieces. The pre-paint lines in index.html did the same thing a frame
 * earlier from localStorage directly; this call is what makes S and the document
 * agree even when storage was unreadable.
 */
export function applyTheme() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = S.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.content = bg;
  }
}

/* Where the Speak buttons are allowed to be, written onto <html> so the stylesheet
   decides it rather than a call at the end of every renderer. */
export function applySpeakScope() {
  if (typeof document === 'undefined') return;
  if (S.speakEverywhere) document.documentElement.dataset.speakAll = '';
  else delete document.documentElement.dataset.speakAll;
}

export function currentGame() { return S.games[S.gi] || null; }
export function inVariation() { return S.varFrom >= 0; }

/** The position on the board: the variation's while walking one, the game's if not. */
export function viewFEN() {
  if (inVariation()) return S.varFens[S.varAt] || null;
  const g = currentGame();
  return g ? (g.fens[S.ply] || g.fens[0]) : null;
}

/*
 * The one place that decides whether the AI block is configured. A "Why?" button or an
 * API voice offered without a key is a button that errors, which is worse than no
 * button (§8).
 */
export function aiConfigured() { return !!(S.aiBase && S.aiKey); }
