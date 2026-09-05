/*
 * Settings: a room with no tab, reachable from everywhere. renderSettings() paints from
 * S; every control writes S, saves, and repaints what the change touches.
 */
import { S, THEMES, THEME_NAMES, saveSettings, applyTheme, SWEEP_PACES } from './state.js';
import { $, toast } from './dom.js';
import { renderStage } from './render.js';
import { testEndpoint } from './speech/openai.js';

const THEME_ART = {
  analysis: { bg: '#000000', lt: '#b8c2cc', dk: '#46525e' },
  midnight: { bg: '#14120f', lt: '#c3b393', dk: '#6e5d45' },
  wood: { bg: '#17110c', lt: '#d6be96', dk: '#7c5433' },
  green: { bg: '#101512', lt: '#e4e7d6', dk: '#6e8b5b' },
};

export function themeSwatchesHTML() {
  return THEMES.map(k => {
    const a = THEME_ART[k];
    return '<button class="theme-swatch" type="button" data-theme="' + k + '" aria-pressed="' + (S.theme === k) + '" style="--s-bg:' + a.bg + ';--s-lt:' + a.lt + ';--s-dk:' + a.dk + '">' +
      '<span class="theme-chip" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="theme-name">' + THEME_NAMES[k] + '</span></button>';
  }).join('');
}

/* Field id → S key, for the plain text/select fields. Checkboxes are listed apart. */
const TEXT_FIELDS = {
  'set-engine-url': 'engineUrl', 'set-engine-token': 'engineToken', 'set-engine-mode': 'engineMode',
  'set-ai-base': 'aiBase', 'set-ai-key': 'aiKey', 'set-ai-speech-model': 'aiSpeechModel', 'set-ai-voice': 'aiVoice',
  'set-ai-chat-model': 'aiChatModel', 'set-tts-backend': 'ttsBackend', 'set-sweep-pace': 'sweepPace',
  'set-sync-url': 'syncUrl', 'set-sync-token': 'syncToken',
  'set-chesscom': 'chesscomUser', 'set-lichess': 'lichessUser',
};
const BOOL_FIELDS = { 'set-coords': 'coords', 'set-remember': 'remember', 'set-speak-everywhere': 'speakEverywhere', 'set-sync-on': 'syncOn' };

export function renderSettings() {
  const mount = $('theme-mount');
  if (mount) mount.innerHTML = themeSwatchesHTML();
  for (const [id, key] of Object.entries(TEXT_FIELDS)) { const el = $(id); if (el) el.value = S[key]; }
  for (const [id, key] of Object.entries(BOOL_FIELDS)) { const el = $(id); if (el) el.checked = !!S[key]; }
  const pace = $('set-sweep-pace');
  if (pace && !pace.options.length) for (const k of Object.keys(SWEEP_PACES)) pace.add(new Option(k, k));
  if (pace) pace.value = S.sweepPace;
  const chip = $('voice-chip');
  if (chip) chip.textContent = S.ttsBackend === 'api' ? (S._degraded ? 'Browser voice (the API stopped answering)' : 'Configured voice') : 'Browser voice';
  document.dispatchEvent(new CustomEvent('cr:settings-painted'));
}

export function wireSettings() {
  const view = $('view-settings');
  if (!view) return;
  view.addEventListener('click', e => {
    const sw = e.target.closest('.theme-swatch');
    if (sw) { S.theme = sw.dataset.theme; saveSettings(); applyTheme(); renderSettings(); }
  });
  view.addEventListener('change', e => {
    const id = e.target.id;
    if (TEXT_FIELDS[id]) { S[TEXT_FIELDS[id]] = e.target.value.trim(); saveSettings(); }
    if (BOOL_FIELDS[id]) {
      S[BOOL_FIELDS[id]] = e.target.checked; saveSettings();
      if (id === 'set-coords') renderStage();
      document.dispatchEvent(new CustomEvent('cr:setting', { detail: { key: BOOL_FIELDS[id] } }));
    }
    if (TEXT_FIELDS[id]) document.dispatchEvent(new CustomEvent('cr:setting', { detail: { key: TEXT_FIELDS[id] } }));
    renderSettings();
  });
  const test = $('btn-ai-test');
  if (test) test.addEventListener('click', async () => {
    const out = $('ai-test-result');
    out.textContent = 'Asking…';
    const r = await testEndpoint();
    out.textContent = r.text;
    out.style.color = r.ok ? 'var(--good)' : 'var(--danger)';
  });
}
