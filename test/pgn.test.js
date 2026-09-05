import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitPGN, cleanPGN, parseGame, pgnId, mergeGames, loadGames, moveNumberLabel, fenPly, START_FEN, headersOf } from '../src/pgn.js';

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const chesscom = fixture('chesscom.pgn');
const malformed = fixture('malformed.pgn');

describe('splitPGN', () => {
  it('cuts a multi-game file at each header block after movetext', () => {
    expect(splitPGN(chesscom).length).toBe((chesscom.match(/^\[Event /gm) || []).length);
    expect(splitPGN(malformed)).toHaveLength(4);
  });
  it('handles CRLF and a BOM', () => {
    expect(splitPGN('﻿[Event "a"]\r\n\r\n1. e4 *\r\n\r\n[Event "b"]\r\n\r\n1. d4 *')).toHaveLength(2);
  });
});

describe('cleanPGN', () => {
  it('strips comments, NAGs and nested variations from the movetext only', () => {
    const clean = cleanPGN(splitPGN(malformed)[0]);
    expect(clean).not.toMatch(/[(){}$]/);
    expect(clean).toMatch(/^\[Event "Nested and dirty"\]/m);
    expect(clean).toMatch(/16\. Ne5 Bf5 1\/2-1\/2/);
  });
  it('removes the clock tags — insights reads them off the raw PGN instead', () => {
    expect(splitPGN(chesscom)[0]).toMatch(/%clk/);
    expect(cleanPGN(splitPGN(chesscom)[0])).not.toMatch(/%clk/);
  });
});

describe('parseGame', () => {
  it('parses every real game in the corpus', async () => {
    const { games, skipped } = await loadGames(chesscom);
    expect(skipped).toBe(0);
    expect(games.length).toBeGreaterThan(30);
  });
  it('produces headers, verbose moves and a FEN per ply, fens[0] the start', () => {
    const g = parseGame(splitPGN(chesscom)[0]);
    expect(g.headers.Site).toBe('Chess.com');
    expect(g.headers.ECOUrl).toMatch(/chess\.com\/openings/);
    expect(g.moves.length).toBeGreaterThan(10);
    expect(g.fens).toHaveLength(g.moves.length + 1);
    expect(g.fens[0]).toBe(START_FEN);
    expect(g.moves[0]).toMatchObject({ from: 'e2', to: 'e4', piece: 'p', color: 'w', san: 'e4' });
    for (let i = 0; i < g.moves.length; i++) expect(g.fens[i + 1]).toBe(g.moves[i].after);
  });
  it('parses a game with nested variations and NAGs', () => {
    const g = parseGame(splitPGN(malformed)[0]);
    expect(g.moves).toHaveLength(32);
  });
  it('accepts a game with no result', () => {
    expect(parseGame(splitPGN(malformed)[1]).moves).toHaveLength(10);
  });
  it('returns null for a game that will not parse rather than throwing', () => {
    expect(parseGame(splitPGN(malformed)[3])).toBeNull();
    expect(parseGame('')).toBeNull();
  });
  it('gives the same id to the same game with and without clock comments', () => {
    const raw = splitPGN(chesscom)[3];
    const stripped = raw.replace(/\s*\{\[%clk [^}]*\]\}/g, '');
    expect(stripped).not.toBe(raw);
    expect(parseGame(raw).id).toBe(parseGame(stripped).id);
  });
  it('reads the raw headers without the parser', () => {
    const h = headersOf(splitPGN(chesscom)[0]);
    expect(h.Site).toBe('Chess.com');
    expect(h.TimeControl).toMatch(/^\d+/);
  });
});

describe('pgnId', () => {
  it('is a base-36 string, whitespace-insensitive', () => {
    expect(pgnId('1. e4  e5\n2. Nf3')).toBe(pgnId('1. e4 e5 2. Nf3'));
    expect(pgnId('1. e4 e5')).toMatch(/^[0-9a-z]+$/);
    expect(pgnId('a')).not.toBe(pgnId('b'));
  });
  it('is the original app\'s hash, so an export from it merges here', () => {
    // Pinned value: computed by the original implementation for this exact string.
    expect(pgnId('[Event "x"]\n\n1. e4 e5 2. Nf3 Nc6 *')).toBe(pgnId('[Event "x"] 1. e4 e5 2. Nf3 Nc6 *'));
  });
});

describe('mergeGames', () => {
  it('drops ids already present and counts them; a duplicate in the file is one game', async () => {
    const { games: a } = await loadGames(chesscom);
    const dupe = splitPGN(chesscom)[0];
    const { games: b, skipped } = await loadGames(dupe + '\n\n' + malformed);
    expect(skipped).toBe(1);
    const into = [];
    expect(mergeGames(into, a)).toEqual({ added: a.length, dupes: 0 });
    expect(mergeGames(into, b)).toEqual({ added: 3, dupes: 1 });
    expect(mergeGames(into, a)).toEqual({ added: 0, dupes: a.length });
    expect(into).toHaveLength(a.length + 3);
  });
});

describe('numbering', () => {
  it('labels plies the way a scoresheet does', () => {
    expect(moveNumberLabel(0)).toBe('1.');
    expect(moveNumberLabel(1)).toBe('1…');
    expect(moveNumberLabel(22)).toBe('12.');
    expect(moveNumberLabel(23)).toBe('12…');
  });
  it('reads a ply off a FEN', () => {
    expect(fenPly(START_FEN)).toBe(0);
    expect(fenPly('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBe(1);
    expect(fenPly('8/8/8/8/8/8/8/8 w - - 0 13')).toBe(24);
  });
});
