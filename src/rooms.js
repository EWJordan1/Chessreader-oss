/*
 * The rooms' own painters register here. Each room carries its own empty state — one
 * sentence about what fills it, next to the door that does — and is always reachable.
 * Room modules (home, insights, learn, prep) replace these stubs as they land.
 */
import { S } from './state.js';
import { $, emptyHTML } from './dom.js';
import { registerRoom, hasRoom } from './route.js';

export function bootRooms() {
  const stub = (room, fn) => { if (!hasRoom(room)) registerRoom(room, fn); };
  stub('home', () => {
    const el = $('home-body'); if (!el) return;
    el.innerHTML = '<p class="greeting">Good ' + partOfDay() + '.</p>' +
      (S.games.length ? '<p class="hint">' + S.games.length + ' games loaded. Listen reads them; Insights counts them.</p>'
        : emptyHTML('Nothing here yet. Import a few games and this page fills with your week.', 'Import games', 'import'));
  });
  stub('learn', () => {
    const el = $('learn-body'); if (!el) return;
    el.innerHTML = emptyHTML('The lessons, your book and the drills arrive with the Learn module.', '', '');
  });
  stub('insights', () => {
    const el = $('insights-body'); if (!el) return;
    el.innerHTML = S.games.length ? '<p class="hint">Insights is arithmetic over your ' + S.games.length + ' games; the panes arrive with the Insights module.</p>'
      : emptyHTML('Insights is counted from your games, and there are none loaded yet.', 'Import games', 'import');
  });
  stub('prep', () => {
    const el = $('prep-body'); if (!el) return;
    el.innerHTML = emptyHTML('Add the person you are about to play and their public games are read here.', '', '');
  });
}

function partOfDay() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; }
