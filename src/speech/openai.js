/*
 * Any OpenAI-compatible /audio/speech endpoint (§8). The key is the user's, stored on
 * the user's machine, and the app talks to whatever base URL they name.
 *
 * The request is built with trimmed text and a fixed parameter order because that
 * string is the in-memory cache key — two spellings of one utterance are two paid calls.
 * No speed parameter: playback speed is not a control, so every utterance is generated
 * once at 1.0 and every listener shares the entry.
 */
import { S } from '../state.js';

const _cache = new Map();   // request body → object URL
const CACHE_MAX = 400;
let _audio = null;

export function cancel() {
  if (_audio) { try { _audio.pause(); } catch (e) { /* ignore */ } _audio = null; }
}

function requestBody(text) {
  // Fixed order, trimmed text: this string is the cache key.
  return JSON.stringify({ model: S.aiSpeechModel, input: text.trim(), voice: S.aiVoice, response_format: 'mp3' });
}

export async function fetchSpeech(text) {
  const body = requestBody(text);
  if (_cache.has(body)) return _cache.get(body);
  const res = await fetch(S.aiBase.replace(/\/$/, '') + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.aiKey },
    body,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    URL.revokeObjectURL(_cache.get(oldest));
    _cache.delete(oldest);
  }
  _cache.set(body, url);
  return url;
}

export function speak(text, { onStart, onDone, onError, onSuccess } = {}) {
  cancel();
  const token = {};
  _audio = token;   // marks "in flight" so a cancel before the fetch lands is honoured
  fetchSpeech(text).then(url => {
    if (_audio !== token) return;   // cancelled while fetching
    onSuccess && onSuccess();
    const a = new Audio(url);
    _audio = a;
    let started = false;
    const begin = () => {
      if (started || _audio !== a) return;
      started = true;
      a.play().then(() => onStart && onStart()).catch(() => onError && onError(new Error('play refused')));
    };
    // Wait for canplaythrough before play(), with a backstop: starting an unbuffered
    // half-second clip lets the browser swallow the opening consonant.
    a.addEventListener('canplaythrough', begin, { once: true });
    setTimeout(begin, 400);
    a.onended = () => { if (_audio === a) _audio = null; onDone && onDone(); };
    a.onerror = () => { if (_audio === a) _audio = null; onError && onError(new Error('audio error')); };
  }).catch(err => {
    if (_audio !== token) return;
    _audio = null;
    onError && onError(err);
  });
}

/*
 * The Settings test button: one round trip, reporting the actual error. A CORS failure
 * and a bad key are different problems and must not print the same sentence.
 */
export async function testEndpoint() {
  const base = (S.aiBase || '').replace(/\/$/, '');
  if (!base) return { ok: false, text: 'No base URL.' };
  if (!S.aiKey) return { ok: false, text: 'No API key.' };
  let res;
  try {
    res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + S.aiKey } });
  } catch (e) {
    return { ok: false, text: 'Your browser was not allowed to ask: the endpoint did not answer a cross-origin request (CORS), or the address is wrong. See the README for the four-line proxy.' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, text: 'The endpoint refused your key (HTTP ' + res.status + ').' };
  if (!res.ok) return { ok: false, text: 'The endpoint answered HTTP ' + res.status + '.' };
  return { ok: true, text: 'Connected. The endpoint accepted the key.' };
}
