/*
 * "Why?" — one position explained, on an explicit press (§8).
 *
 * The whole feature is one request: the position as a FEN, the engine's numbers for it,
 * and the move that was played, sent to whatever OpenAI-compatible chat endpoint the
 * user named in Settings. Three rules shape it, and each is a decision rather than a
 * mechanism:
 *
 * 1. **The button is not drawn when no provider is configured.** A card that is absent
 *    cannot say what it would have held, but a button that errors is worse — it offers
 *    the reader something the app cannot do and then blames them for pressing it.
 * 2. **The verdict is validated before asking.** Only a move classifyMove() calls an
 *    error gets a question, and anything else is dropped silently. Without that guard
 *    the app pays a stranger to explain a forced recapture.
 * 3. **Rate-limited on this side of the wire.** The user's key, the user's bill: a
 *    press every few seconds and a session ceiling, so a stuck finger is not an invoice.
 */
import { S, aiConfigured, currentGame } from '../state.js';
import { $, escHtml, toast } from '../dom.js';
import { onRender, stageOwner } from '../render.js';
import { classifyMove, analysisReady } from '../review.js';

/* A press every four seconds is faster than anyone reads an answer, and forty in one
   session is more explaining than a game contains. Both are about the user's bill. */
export const EXPLAIN_GAP_MS = 4000;
export const EXPLAIN_SESSION_MAX = 40;

const _cache = new Map();      // fen + '|' + played → the answer, so re-asking is free
let _lastAt = 0;
let _spent = 0;
let _busy = false;
/*
 * Latched when the endpoint refuses us — a bad key or a model this server does not
 * have is not a thing that fixes itself between two presses, and asking again is
 * another charge for the same error message.
 */
let _refused = false;

export function explainAvailable() { return aiConfigured() && !_refused && _spent < EXPLAIN_SESSION_MAX; }

/** What the model is told. Short on purpose: the position and the numbers, no prose. */
export function buildPrompt({ fen, played, best, verdict, evalBefore, evalAfter }) {
  const num = e => (e == null ? 'unknown' : e.mate !== undefined ? 'mate in ' + Math.abs(e.mate) : (e.cp / 100).toFixed(2));
  return [
    'You are a chess coach. Explain in at most three sentences, in plain English, why the move played was a ' + verdict + '.',
    'Name the tactical or positional idea; do not give a long variation and do not restate the evaluation numbers.',
    '',
    'Position (FEN): ' + fen,
    'Move played: ' + played,
    'The engine prefers: ' + (best || 'unknown'),
    'Evaluation before, from White\'s side: ' + num(evalBefore),
    'Evaluation after: ' + num(evalAfter),
  ].join('\n');
}

/**
 * Ask the configured chat endpoint. Resolves {text} or {error} — never throws, because
 * every caller is a button and a button that throws is a button that lies.
 */
export async function askExplain(job, fetchImpl = globalThis.fetch) {
  const key = job.fen + '|' + job.played;
  if (_cache.has(key)) return { text: _cache.get(key), cached: true };
  if (!aiConfigured()) return { error: 'No AI provider is configured.' };
  if (_refused) return { error: 'The endpoint refused an earlier question, so nothing more is being asked this session.' };
  const now = Date.now();
  if (now - _lastAt < EXPLAIN_GAP_MS) return { error: 'One question at a time — try again in a moment.' };
  if (_spent >= EXPLAIN_SESSION_MAX) return { error: 'That is as many explanations as this session asks for.' };
  _lastAt = now;
  _spent++;
  let res;
  try {
    res = await fetchImpl(S.aiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.aiKey },
      body: JSON.stringify({ model: S.aiChatModel, messages: [{ role: 'user', content: buildPrompt(job) }], max_tokens: 220 }),
    });
  } catch (e) {
    // A network-level throw from a cross-origin fetch is the CORS case, and it is a
    // different problem from a refused key: say which, because the fixes differ.
    return { error: 'Your browser was not allowed to ask that endpoint (CORS), or the address is wrong. The README has a four-line proxy.' };
  }
  if (res.status === 401 || res.status === 403) { _refused = true; return { error: 'The endpoint refused your key.' }; }
  if (res.status === 429) return { error: 'The endpoint is rate-limiting you.' };
  if (!res.ok) return { error: 'The endpoint answered HTTP ' + res.status + '.' };
  let text = '';
  try {
    const json = await res.json();
    text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').trim();
  } catch (e) { return { error: 'The endpoint answered something this app could not read.' }; }
  if (!text) return { error: 'The endpoint answered nothing.' };
  _cache.set(key, text);
  return { text };
}

/**
 * The job for one move of one game, or null when there is nothing worth asking about.
 * Null is the answer for a move the three words do not call an error — that guard is
 * what keeps the feature from explaining a forced recapture.
 */
export function jobForMove(game, n) {
  if (!game || !analysisReady || !game.analysis) return null;
  const verdict = classifyMove(game, n);
  if (!verdict) return null;
  const m = game.moves[n];
  if (!m) return null;
  return {
    fen: game.fens[n], played: m.san, best: bestSAN(game, n), verdict,
    evalBefore: game.analysis.evals[n], evalAfter: game.analysis.evals[n + 1],
  };
}

/** The engine's move as SAN, for the prompt: UCI in a sentence reads as noise. */
function bestSAN(game, n) {
  const uci = game.analysis && game.analysis.best && game.analysis.best[n];
  return uci || '';
}

/** A deck card asks the same question about its own position. */
export function jobForCard(card) {
  if (!card) return null;
  return { fen: card.fen, played: card.played, best: card.answer, verdict: 'mistake', evalBefore: card.before, evalAfter: card.after };
}

/* ----- The DOM half ----- */

function panelHTML(state, text) {
  return '<section class="panel" id="explain-panel"><header class="panel-head"><h2>Why?</h2>' +
    (state === 'ready' ? '<button class="btn btn-sm" id="btn-explain" type="button">Explain this move</button>' : '') +
    '</header><div class="panel-body"><p class="hint" id="explain-text">' + escHtml(text) + '</p></div></section>';
}

function paintExplain() {
  const mount = $('explain-mount');
  if (!mount) return;
  // Only over Listen's own board: an explanation shown against another position is a
  // caption on the wrong picture.
  const g = currentGame();
  const job = stageOwner() === 'play' && g && S.ply > 0 ? jobForMove(g, S.ply - 1) : null;
  if (!job || !explainAvailable()) { mount.innerHTML = ''; return; }
  const key = job.fen + '|' + job.played;
  if (_cache.has(key)) { mount.innerHTML = panelHTML('done', _cache.get(key)); return; }
  mount.innerHTML = panelHTML('ready', 'The engine calls this a ' + job.verdict + '. Ask why, and the answer comes from the endpoint you configured.');
  const btn = $('btn-explain');
  if (btn) btn.addEventListener('click', () => runExplain(job, $('explain-text'), btn));
}

async function runExplain(job, out, btn) {
  if (_busy) return;
  _busy = true;
  if (btn) { btn.disabled = true; }
  if (out) out.textContent = 'Asking…';
  const r = await askExplain(job);
  _busy = false;
  if (btn) btn.disabled = false;
  if (out) out.textContent = r.text || r.error;
  if (r.error && !r.text) toast(r.error);
  if (r.text) paintExplain();
}

/* The deck's cards carry their own empty container; fill it on a press. */
function wireCards() {
  document.addEventListener('click', async e => {
    const box = e.target.closest('.card-why');
    const btn = e.target.closest('[data-act="why"]');
    if (!btn && !box) return;
    const host = btn ? btn.closest('[data-key]') || document.querySelector('.card-why[data-key]') : box;
    if (!host) return;
    const card = S.deck.get(host.dataset.key) || S.tactics.get(host.dataset.key);
    const job = jobForCard(card);
    if (!job || !explainAvailable()) return;
    await runExplain(job, host, null);
  });
  // A card is drawn without a Why button when nothing is configured; when something is,
  // put one in. The deck renderer stays ignorant of the AI module either way.
  onRender('board', () => {
    if (!explainAvailable()) return;
    for (const box of document.querySelectorAll('.card-why[data-key]:empty')) {
      box.innerHTML = '<button class="btn btn-sm" data-act="why" type="button">Why?</button>';
    }
  });
}

export function boot() {
  if (typeof document === 'undefined') return;
  onRender('board', paintExplain);
  document.addEventListener('cr:analysis-done', paintExplain);
  document.addEventListener('cr:setting', e => { if (e.detail && String(e.detail.key || '').startsWith('ai')) paintExplain(); });
  wireCards();
}

/** For the tests: forget the session's spending and its latch. */
export function _reset() { _cache.clear(); _lastAt = 0; _spent = 0; _refused = false; _busy = false; }
