/*
 * The boot sequence. Order matters and the comments say why.
 */
import { S, loadSettings, saveSettings, applyTheme, applySpeakScope } from './state.js';
import { $ } from './dom.js';
import { route, registerRoom, onRoute, navigate, ROOMS } from './route.js';
import { updateAll, renderStage, renderBoard, notationLine, onRender } from './render.js';
import * as pb from './playback.js';
import { wireKeyboard, toggleKeymap } from './keys.js';
import { wireSettings, renderSettings } from './settings.js';
import { wireSources, openImport } from './sources.js';
import { onDegraded } from './speech/provider.js';

function wireTransport() {
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('btn-play', pb.togglePlay);
  on('btn-next-move', () => { const line = notationLine(); if (line && typeof line.act === 'function') line.act(line.at + 1); else pb.nextMove(); });
  on('btn-prev-move', () => { const line = notationLine(); if (line && typeof line.act === 'function') line.act(line.at - 1); else pb.prevMove(); });
  on('btn-restart', () => { const line = notationLine(); if (line && typeof line.act === 'function') line.act(0); else pb.restartGame(); });
  on('btn-next-game', pb.nextGame);
  on('btn-prev-game', pb.prevGame);
  on('btn-flip', pb.flipBoard);
  on('btn-keys', toggleKeymap);
  on('btn-import', () => openImport());
  on('btn-settings', () => navigate(document.getElementById('view-settings').classList.contains('hidden') ? 'settings' : 'home'));
  $('ply-slider').addEventListener('input', e => pb.goToPly(+e.target.value));
  // The score: a press on a move walks the claim's line. Listen's act is the ply
  // cursor; other rooms install a function (see stageClaim's `line.act`).
  $('move-tree').addEventListener('click', e => {
    const v = e.target.closest('[data-var]');
    if (v) { pb.varGoTo(+v.dataset.var); return; }
    const m = e.target.closest('[data-ply]');
    if (!m) return;
    const line = notationLine();
    if (line && typeof line.act === 'function') line.act(+m.dataset.ply);
    else pb.goToPly(+m.dataset.ply);
  });
  $('queue-list').addEventListener('click', e => { const r = e.target.closest('[data-gi]'); if (r) pb.setGame(+r.dataset.gi); });
  $('queue-list').addEventListener('keydown', e => { if (e.key === 'Enter') { const r = e.target.closest('[data-gi]'); if (r) pb.setGame(+r.dataset.gi); } });
  // Listen's own reading controls
  const sel = (id, key, coerce = v => v) => { const el = $(id); if (!el) return; el.value = String(S[key]); el.addEventListener('change', () => { S[key] = coerce(el.value); saveSettings(); }); };
  sel('set-verbosity', 'verbosity');
  sel('set-interval', 'interval', Number);
  sel('set-repeat', 'repeat');
  const chk = (id, key) => { const el = $(id); if (!el) return; el.checked = !!S[key]; el.addEventListener('change', () => { S[key] = el.checked; saveSettings(); }); };
  chk('set-black-pause', 'blackPause');
  chk('set-announce', 'announce');
  $('toast-close').addEventListener('click', () => $('toast').classList.add('hidden'));
  $('dlg-import-close').addEventListener('click', () => $('dlg-import').close());
  $('dlg-keys-close').addEventListener('click', () => $('dlg-keys').close());
}

export async function init() {
  loadSettings();
  applyTheme();          // S and the document agree even when storage was unreadable
  applySpeakScope();
  document.addEventListener('cr:setting', e => { if (e.detail && e.detail.key === 'speakEverywhere') applySpeakScope(); });
  wireTransport();
  wireSettings();
  wireSources();
  wireKeyboard();
  onDegraded(renderSettings);
  registerRoom('settings', renderSettings);
  // Listen paints its claim on arrival; other rooms register their own painters.
  registerRoom('play', () => renderBoard());
  onRoute(() => renderStage());

  // Every module attaches itself here through one boot(). Memory first, because the
  // rest read what it restores; then the arithmetic modules; then the rooms. Each is
  // independent — a module that throws is skipped and the rest of the app still works.
  const boot = (p, fn = 'boot') => p.then(m => m[fn] && m[fn]()).catch(e => console.warn('module skipped:', e));
  await boot(import('./memory.js'), 'bootMemory');
  await Promise.all([
    boot(import('./engine/analyse.js')),
    boot(import('./engine/sweep.js')),
    boot(import('./review.js')),
    boot(import('./insights.js')),
    boot(import('./deck.js')),
    boot(import('./learn/lessons.js')),
    boot(import('./learn/book.js')),
    boot(import('./learn/drills.js')),
    boot(import('./prep.js')),
    boot(import('./ai/explain.js')),
    boot(import('./sync/client.js')),
    boot(import('./home.js')),
  ]);
  await boot(import('./rooms.js'), 'bootRooms');   // stub painters for rooms no module claimed

  window.addEventListener('hashchange', route);
  route();
  updateAll();
}

init();
