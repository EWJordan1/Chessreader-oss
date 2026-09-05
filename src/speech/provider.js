/*
 * speak() is the only way to make sound (§2.5), and the ticket is the only way to
 * cancel one. Nothing else calls a speech backend.
 *
 * Before dispatching, speak() cancels whatever is in flight and takes a ticket
 * (++S.uttId). Every completion callback checks its ticket before firing, so a skip,
 * seek or pause mid-utterance cannot resurrect a stale completion and advance the ply.
 * That is what keeps the transport responsive.
 *
 * Two backends, and only one is a choice: the browser's SpeechSynthesis is the default
 * and the fallback; the configured OpenAI-compatible endpoint is opt-in in Settings.
 *
 * The degradation latch: falling back per utterance is right but expensive when the
 * endpoint is simply down. Consecutive failures are counted and reset on any success,
 * so one 503 between good responses is absorbed. Two in a row latch the session to the
 * browser voice and nothing calls the API again — which is why the latch has no reset:
 * there is no later success to observe.
 */
import { S, saveSettings } from '../state.js';
import { toast } from '../dom.js';
import * as browser from './browser.js';
import * as api from './openai.js';

export const DEGRADE_AFTER = 2;

let _onDegraded = null;
/** main.js registers the settings repaint so the voice chip can say what is speaking. */
export function onDegraded(fn) { _onDegraded = fn; }

export function apiVoiceActive() {
  return S.ttsBackend === 'api' && !S._degraded && !!(S.aiBase && S.aiKey);
}

/** Stop whatever is speaking. The ticket moves on, so no in-flight completion lands. */
export function cancelSpeech() {
  S.uttId++;
  browser.cancel();
  api.cancel();
}

/**
 * Speak one utterance. onDone fires once, only if this utterance was not superseded.
 * onStart (optional) fires when audio actually begins, for the spoken-line paint.
 */
export function speak(text, onDone, onStart) {
  cancelSpeech();
  const id = S.uttId;
  const live = () => id === S.uttId;
  const done = () => { if (live()) onDone && onDone(); };
  const started = () => { if (live()) onStart && onStart(); };
  if (!text) { setTimeout(done, 0); return id; }

  if (apiVoiceActive()) {
    api.speak(text, { onStart: started, onDone: done, onError: () => {
      if (!live()) return;
      if (++S._failCount >= DEGRADE_AFTER) degrade();
      // This utterance still gets said — by the browser, once.
      browser.speak(text, { onStart: started, onDone: done, onError: done });
    }, onSuccess: () => { S._failCount = 0; } });
    return id;
  }
  browser.speak(text, { onStart: started, onDone: done, onError: done });
  return id;
}

function degrade() {
  if (S._degraded) return;
  S._degraded = true;
  if (_onDegraded) _onDegraded();
  if (S.ttsFallbackNoticeDismissed || S._noticeShown) return;
  S._noticeShown = true;
  // A corner toast that never interrupts the transport, dismissible for good.
  toast('The configured voice is not answering, so the browser’s own voice is reading for the rest of this session.', {
    action: 'Don’t tell me again', sticky: true,
    onAction: () => { S.ttsFallbackNoticeDismissed = true; saveSettings(); },
  });
}
