/*
 * PGN → games. splitPGN cuts a file into games, cleanPGN makes real-world PGN
 * acceptable to the parser, parseGame produces the shape every other module reads:
 *
 *   { id, pgn, headers, moves, fens }
 *
 * fens[n] is the position after n plies and fens[0] the start, so S.ply indexes it
 * directly. Every FEN is banked at parse time (§4): seeking is an array index, not a
 * replay, and that is what makes scrubbing, the explorer trie and the review free.
 */
import { Chess } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Cut a multi-game file into per-game chunks: a header block after movetext is a new game. */
export function splitPGN(text) {
  text = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^﻿/, '');
  const games = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (/^\s*\[Event\s/.test(line) && cur.trim()) { games.push(cur.trim()); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) games.push(cur.trim());
  // A file with no [Event] tags at all, but several header blocks: split on any header
  // that follows movetext instead.
  if (games.length === 1) {
    const alt = [];
    let c2 = '', seen = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (/^\[/.test(t) && seen) { if (c2.trim()) alt.push(c2.trim()); c2 = ''; seen = false; }
      if (t && !/^\[/.test(t)) seen = true;
      c2 += line + '\n';
    }
    if (c2.trim()) alt.push(c2.trim());
    if (alt.length > 1) return alt;
  }
  return games;
}

/*
 * Strip NAGs, both comment forms and variations (by paren depth, movetext only).
 * Kept even though chess.js now has its own PGN grammar, because real-world PGN is
 * still dirtier than any parser: nested variations inside comments, stray `$` codes,
 * annotator's `;` lines. The clock readings live in the `{[%clk …]}` comments this
 * removes, which is why insights.js reads clocks off the raw PGN and never off this.
 */
export function cleanPGN(pgn) {
  pgn = String(pgn || '').replace(/\$\d+/g, '').replace(/\{[^}]*\}/g, '').replace(/;[^\n]*/g, '');
  const lines = pgn.split('\n');
  let inHeaders = true, out = '', depth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (inHeaders && t && !t.startsWith('[')) inHeaders = false;
    if (inHeaders) { out += line + '\n'; continue; }
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (depth === 0) out += ch;
    }
    out += '\n';
  }
  return out;
}

/*
 * A 53-bit hash of the cleaned, whitespace-flattened PGN — the game's id. Content
 * addressing is load-bearing (§4): an import merges by it, deck cards and eval rows
 * reference games by it, and sync is a union of keys. The same game exported twice —
 * once with clock comments, once wrapped at another column — is one game. A collision
 * costs one dropped duplicate, which is why 53 bits is enough and SHA-256 would be
 * theatre. The algorithm is the original app's, so an export from it merges cleanly.
 */
export function pgnId(cleaned) {
  const s = cleaned.replace(/\s+/g, ' ').trim();
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The headers of one game's text, without asking chess.js to like the movetext. */
export function headersOf(pgn) {
  const h = {};
  for (const m of String(pgn || '').matchAll(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/gm)) {
    h[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return h;
}

/** One game, or null when it will not parse. Never throws: a bad game is counted, not fatal. */
export function parseGame(pgnText) {
  try {
    const cleaned = cleanPGN(pgnText);
    const chess = new Chess();
    chess.loadPgn(cleaned, { strict: false });
    const headers = chess.getHeaders ? chess.getHeaders() : chess.header();
    const moves = chess.history({ verbose: true });
    // chess.js banks the position after every move on the move itself, which is the
    // FEN-per-ply this app wants — no second pass of move generation.
    const fens = [moves.length ? moves[0].before : chess.fen()];
    for (const m of moves) fens.push(m.after);
    // A "game" with no moves parses, but it is a header block, not a game.
    if (!moves.length && !/\d+\.\s*\S/.test(cleaned.replace(/^\[.*$/gm, ''))) {
      if (!/^\s*(1-0|0-1|1\/2-1\/2|\*)\s*$/m.test(cleaned)) return null;
    }
    return { id: pgnId(cleaned), pgn: pgnText.trim(), headers, moves, fens };
  } catch (e) {
    return null;
  }
}

/*
 * An import of a few hundred games is seconds of unbroken main-thread work if done in
 * one pass — the spinner stops, no click lands. So the work is sliced on a frame budget
 * and the thread handed back between slices. Not rAF: that stops dead in a background tab.
 */
export const PARSE_SLICE_MS = 40;

function yieldToPaint() {
  if (typeof scheduler === 'object' && scheduler && scheduler.yield) return scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Parse a whole file. Resolves {games, skipped}; games that fail to parse are counted,
 * never fatal. onProgress(done, total) is called between slices.
 */
export async function loadGames(text, onProgress) {
  const chunks = splitPGN(text);
  const games = [];
  let skipped = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let mark = now();
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].trim()) {
      const g = parseGame(chunks[i]);
      if (g) games.push(g); else skipped++;
    }
    if (now() - mark >= PARSE_SLICE_MS) {
      if (onProgress) onProgress(i + 1, chunks.length);
      await yieldToPaint();
      mark = now();
    }
  }
  if (onProgress) onProgress(chunks.length, chunks.length);
  return { games, skipped };
}

/**
 * Merge parsed games into a list by id: drop the ones already present, count them.
 * Returns {added, dupes}. This is the one merge every import and every sync goes through.
 */
export function mergeGames(into, incoming) {
  const have = new Set(into.map(g => g.id));
  let added = 0, dupes = 0;
  for (const g of incoming) {
    if (have.has(g.id)) { dupes++; continue; }
    have.add(g.id);
    into.push(g);
    added++;
  }
  return { added, dupes };
}

/** "12." or "12…" — the move tree's own numbering seen from a zero-based ply index. */
export function moveNumberLabel(n) {
  return (Math.floor(n / 2) + 1) + (n % 2 === 0 ? '.' : '…');
}

/** The zero-based ply a FEN stands at, from its fullmove field and side to move. */
export function fenPly(fen) {
  const f = String(fen || '').split(' ');
  return (Math.max(1, parseInt(f[5], 10) || 1) - 1) * 2 + (f[1] === 'b' ? 1 : 0);
}
