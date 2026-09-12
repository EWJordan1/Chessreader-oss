/*
 * The compact spellings the `evals` and `oppevals` rows are written in.
 *
 * A leaf: this file imports nothing, and it is owned by neither of the two modules that
 * store an analysis. The scan queue writes `evals` for the reader's own games and Prep
 * writes `oppevals` for an opponent's, in the same format — and it was the same format
 * spelled out twice until this file existed, which is how two spellings of one object
 * drift apart. Anything that reads or writes a stored analysis comes through here.
 */

/*
 * The compact spellings the row uses (see the contract): an evaluation is a plain
 * centipawn number or `m` and a mate distance, an empty field is "not evaluated", and
 * in the alts column `n` is "asked, and the position was forced". Three states, and the
 * decoder has to keep them apart — `undefined` and `null` mean different words in the
 * review, so a decoder that returned 0 for both would invent a Brilliant.
 */
export function encodeEval(ev) {
  if (ev === null) return 'n';
  if (ev === undefined) return '';
  if (ev.mate !== undefined) return 'm' + ev.mate;
  return String(ev.cp);
}
export function decodeEval(s) {
  if (s === '') return undefined;
  if (s === 'n') return null;
  if (s[0] === 'm') { const v = Number(s.slice(1)); return Number.isFinite(v) ? { mate: v } : undefined; }
  const v = Number(s);
  return Number.isFinite(v) ? { cp: v } : undefined;
}

/** An eval array → "30,25,m2,,-40". Trailing empties are trimmed; `plies` restores the length. */
export function encodeEvalList(list, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(encodeEval(list ? list[i] : undefined));
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join(',');
}
export function decodeEvalList(str, n) {
  const out = [];
  out.length = n;
  if (!str) return out;
  const parts = String(str).split(',');
  for (let i = 0; i < parts.length && i < n; i++) {
    const v = decodeEval(parts[i]);
    if (v !== undefined) out[i] = v;
  }
  return out;
}

/** The principal variations → "e2e4 e7e5|g1f3|". best[i] is pv[i][0], so it is not stored twice. */
export function encodeLines(pv, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pv && pv[i] && pv[i].length ? pv[i].join(' ') : '');
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('|');
}
export function decodeLines(str, n) {
  const pv = []; const best = [];
  pv.length = n; best.length = n;
  if (!str) return { pv, best };
  const parts = String(str).split('|');
  for (let i = 0; i < parts.length && i < n; i++) {
    if (!parts[i]) continue;
    const moves = parts[i].split(' ').filter(Boolean);
    if (!moves.length) continue;
    pv[i] = moves;
    best[i] = moves[0];
  }
  return { pv, best };
}
