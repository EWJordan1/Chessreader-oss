/*
 * The keyboard (§10). One table is both the handler and the map on screen, so the map
 * cannot lie about a key. The room digits are generated from the rail's own list.
 */
import { S } from './state.js';
import { $ } from './dom.js';
import { NAV_ROOMS, ROOM_NAMES, navigate, currentRoom } from './route.js';
import * as pb from './playback.js';

const KEYS = [
  { keys: ['Space', 'k'], what: 'Play / pause', run: () => pb.togglePlay(), group: 'Transport' },
  { keys: ['ArrowRight', 'l'], what: 'Next move', run: () => pb.nextMove() },
  { keys: ['ArrowLeft', 'j'], what: 'Previous move', run: () => pb.prevMove() },
  { keys: ['Home'], what: 'Start of game', run: () => pb.goToPly(0) },
  { keys: ['End'], what: 'End of game', run: () => { const g = S.games[S.gi]; if (g) pb.goToPly(g.moves.length); } },
  { keys: ['Shift+ArrowRight', 'n'], what: 'Next game', run: () => pb.nextGame() },
  { keys: ['Shift+ArrowLeft', 'p'], what: 'Previous game', run: () => pb.prevGame() },
  { keys: ['f'], what: 'Flip the board', run: () => pb.flipBoard(), group: 'Board' },
  { keys: ['Escape'], what: 'Leave a variation', run: () => pb.exitVariation() },
  { keys: ['L'], what: 'Engine lines for this position', run: () => document.dispatchEvent(new CustomEvent('cr:lines')) },
  { keys: ['a'], what: 'Analyse this game', run: () => document.dispatchEvent(new CustomEvent('cr:analyse')) },
  ...NAV_ROOMS.map((room, i) => ({ keys: [String(i + 1)], what: 'Go to ' + ROOM_NAMES[room], run: () => navigate(room), group: i === 0 ? 'Rooms' : undefined })),
  { keys: ['i'], what: 'Import games', run: () => document.dispatchEvent(new CustomEvent('cr:import')), group: 'App' },
  { keys: [','], what: 'Settings', run: () => navigate(currentRoom() === 'settings' ? 'home' : 'settings') },
  { keys: ['?'], what: 'This map', run: () => toggleKeymap() },
];

function comboOf(e) {
  const k = e.key === ' ' ? 'Space' : e.key;
  return (e.shiftKey && k.length > 1 ? 'Shift+' : '') + k;
}

export function wireKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing && e.key !== 'Escape') return;
    if (document.querySelector('dialog[open]') && e.key !== 'Escape' && e.key !== '?') return;
    const combo = comboOf(e);
    const hit = KEYS.find(k => k.keys.includes(combo));
    if (!hit) return;
    e.preventDefault();
    hit.run();
  });
  const dlg = $('dlg-keys');
  if (dlg) dlg.querySelector('.keymap').innerHTML = keymapHTML();
}

export function keymapHTML() {
  let html = '';
  for (const k of KEYS) {
    if (k.group) html += '<h3 style="grid-column:1/-1">' + k.group + '</h3>';
    html += '<span class="keys">' + k.keys.map(x => '<kbd>' + x.replace('Arrow', '').replace('Shift+', '⇧ ') + '</kbd>').join('') + '</span><span>' + k.what + '</span>';
  }
  return html;
}

export function toggleKeymap() {
  const dlg = $('dlg-keys');
  if (!dlg) return;
  if (dlg.open) dlg.close(); else dlg.showModal();
}
