/*
 * The browser voice: SpeechSynthesisUtterance with the system default. No picker, no
 * pitch, no rate — it is a fallback, not a feature, so it has no settings to get wrong.
 * This is the default and works with no configuration at all.
 */
let _current = null;

export function available() { return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'; }

export function cancel() {
  if (!available()) return;
  _current = null;
  try { speechSynthesis.cancel(); } catch (e) { /* nothing to cancel */ }
}

export function speak(text, { onStart, onDone, onError } = {}) {
  if (!available()) { setTimeout(() => onDone && onDone(), 300); return; }
  const u = new SpeechSynthesisUtterance(text);
  _current = u;
  let ended = false;
  const end = () => { if (ended) return; ended = true; if (_current === u) _current = null; onDone && onDone(); };
  u.onstart = () => onStart && onStart();
  u.onend = end;
  u.onerror = e => {
    // 'interrupted' and 'canceled' are our own cancel(); the ticket already moved on
    // and the callback will be ignored, so which one we call does not matter.
    if (e && (e.error === 'interrupted' || e.error === 'canceled')) { end(); return; }
    onError ? onError(e) : end();
  };
  try { speechSynthesis.speak(u); } catch (e) { end(); }
}

/*
 * Chrome stops a long utterance after ~15 seconds unless the synthesiser is nudged.
 * A pause/resume every 12 seconds while speaking keeps a position read-out alive.
 */
if (available()) {
  setInterval(() => {
    try { if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); speechSynthesis.resume(); } } catch (e) { /* ignore */ }
  }, 12000);
}
