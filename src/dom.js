/* Leaf helpers with no dependencies, so every module can import them without a cycle. */

export const $ = id => document.getElementById(id);

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/*
 * The one corner toast. It never interrupts the transport: it is a sentence in the
 * corner with a dismiss, and the caller decides whether it also gets an action.
 * `sticky` keeps it until dismissed; otherwise it goes after a while.
 */
let _toastTimer = 0;
export function toast(text, { action, onAction, sticky = false, ms = 6000 } = {}) {
  const el = $('toast');
  if (!el) return;
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.classList.toggle('hidden', !action);
  btn.textContent = action || '';
  btn.onclick = onAction ? () => { onAction(); hideToast(); } : null;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  if (!sticky) _toastTimer = setTimeout(hideToast, ms);
}
export function hideToast() { const el = $('toast'); if (el) el.classList.add('hidden'); }

/** The loading overlay, for work past a second: a sentence and a bar. */
export function showLoading(text, frac) {
  const el = $('loading');
  if (!el) return;
  if (!el.open) { try { el.showModal(); } catch (e) { el.setAttribute('open', ''); } }
  $('loading-text').textContent = text || 'Working…';
  $('loading-bar').style.width = Math.round((frac || 0) * 100) + '%';
}
export function hideLoading() { const el = $('loading'); if (el && el.open) el.close(); }

/** An empty state is a sentence and a door — never a blank panel. */
export function emptyHTML(sentence, doorLabel, doorAction) {
  return '<p class="empty"><span>' + escHtml(sentence) + '</span>' +
    (doorLabel ? '<button class="btn btn-sm" data-act="' + escHtml(doorAction || '') + '">' + escHtml(doorLabel) + '</button>' : '') + '</p>';
}

export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
