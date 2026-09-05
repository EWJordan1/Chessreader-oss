/*
 * UCI, the part both engines speak. The local worker and a WebSocket bridge produce the
 * same text, so the parsing lives here once and both read through it.
 *
 * Two lines matter: the deepest `info` carrying a score (one per MultiPV slot), and the
 * `bestmove` that ends the search. `info` lines arrive continuously as the search
 * deepens, so each slot is overwritten rather than accumulated — the last arrival is the
 * answer — and the result is taken on `bestmove`. That is also what makes a search cut
 * short by `stop` or `movetime` still answer with the depth it reached.
 */

/*
 * How much of the principal variation to keep. Eight plies is four moves each side,
 * which is as far as a spoken or written explanation can carry a reader before it turns
 * into a recital; the row stores every line, so every ply beyond it is cache spent on
 * moves nobody will be shown.
 */
export const PV_PLIES = 8;

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
export function isUciMove(s) { return UCI_MOVE.test(String(s || '')); }

/**
 * One `info` line → {depth, multipv, score:{cp}|{mate}, pv:[]}, or null for the lines
 * without a score ("info depth 1 currmove …", "info string …").
 */
export function parseInfo(line) {
  if (typeof line !== 'string' || !line.startsWith('info ')) return null;
  const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  if (!score) return null;
  const d = /\bdepth (\d+)/.exec(line);
  const mp = /\bmultipv (\d+)/.exec(line);
  // The whole line, not its first move. `\bpv` does not match inside "multipv": there
  // is no word boundary in the middle of a word.
  const pv = /\bpv ((?:[a-h][1-8][a-h][1-8][qrbn]?(?: |$))+)/.exec(line);
  return {
    depth: d ? Number(d[1]) : 0,
    multipv: mp ? Number(mp[1]) : 1,
    // Aspiration-window lines: the score is a bound, not an answer. Kept as a flag so a
    // collector can skip them without a second regex.
    bound: /\b(lower|upper)bound\b/.test(line),
    score: score[1] === 'mate' ? { mate: Number(score[2]) } : { cp: Number(score[2]) },
    pv: pv ? pv[1].trim().split(/\s+/) : [],
  };
}

/** `bestmove e2e4 ponder …` → 'e2e4'; `bestmove (none)` → null; any other line → undefined. */
export function parseBestmove(line) {
  const m = /^bestmove (\S+)/.exec(String(line || ''));
  if (!m) return undefined;
  return m[1] === '(none)' ? null : m[1];
}

/**
 * A search's collector. `feed(line)` returns true once the `bestmove` arrives; `result()`
 * is the provider shape — cp/mate from the SIDE TO MOVE's view, as the engine said it.
 *
 *   { cp?, mate?, pv: string[], depth, lines: [{cp?, mate?, pv, depth}] }
 *
 * `lines` is every MultiPV slot that answered, best first. A mated side to move answers
 * "score mate 0" and "bestmove (none)": pv is empty and mate is 0, which the committer
 * turns into a decided evaluation rather than a mate the side is about to deliver.
 */
export function newSearch(multipv = 1) {
  const slots = [];
  let depth = 0;
  let best = undefined;
  return {
    feed(line) {
      const info = parseInfo(line);
      if (info) {
        if (info.bound) return false;
        const idx = info.multipv - 1;
        if (idx >= 0 && idx < Math.max(1, multipv)) {
          slots[idx] = { ...info.score, pv: info.pv.slice(0, PV_PLIES), depth: info.depth };
        }
        if (info.depth > depth) depth = info.depth;
        return false;
      }
      const bm = parseBestmove(line);
      if (bm === undefined) return false;
      best = bm;
      return true;
    },
    result() {
      const lines = slots.filter(Boolean);
      const top = lines[0];
      const out = {
        pv: top && top.pv.length ? top.pv : (best ? [best] : []),
        depth: top ? top.depth : depth,
        lines,
      };
      if (top) {
        if (top.mate !== undefined) out.mate = top.mate;
        else out.cp = top.cp;
      }
      return out;
    },
  };
}

/** The `go` command for a job: depth and movetime together, whichever ends first. */
export function goCommand({ depth, movetimeMs }) {
  const parts = ['go'];
  if (depth) parts.push('depth', String(Math.max(1, Math.round(depth))));
  if (movetimeMs) parts.push('movetime', String(Math.max(1, Math.round(movetimeMs))));
  return parts.join(' ');
}
