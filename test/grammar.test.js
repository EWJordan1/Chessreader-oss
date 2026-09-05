import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { moveToSpeech, resultSpeech, announcementSpeech, openingAnnouncement, positionSpeech, timeControlPhrase } from '../src/speech/grammar.js';

function mv(pgn) { const c = new Chess(); c.loadPgn(pgn); const h = c.history({ verbose: true }); return h[h.length - 1]; }

describe('moveToSpeech', () => {
  it('returns a sentence at every level: capitalised and ending in a full stop', () => {
    const m = mv('1. e4 e5 2. Nf3');
    for (const v of ['full', 'natural', 'short']) {
      const s = moveToSpeech(m, v);
      expect(s).toMatch(/^[A-Z]/); expect(s).toMatch(/\.$/);
    }
  });
  it('full names colour and origin square, with the preposition only between squares', () => {
    expect(moveToSpeech(mv('1. e4 e5 2. Nf3'), 'full')).toBe('White knight from g1 to f3.');
    expect(moveToSpeech(mv('1. e4'), 'full')).toBe('White pawn from e2 to e4.');
  });
  it('natural is how a commentator says it', () => {
    expect(moveToSpeech(mv('1. e4 e5 2. Nf3'), 'natural')).toBe('Knight f3.');
    expect(moveToSpeech(mv('1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5'), 'natural')).toBe('Pawn takes d5.');
  });
  it('short is the notation', () => {
    expect(moveToSpeech(mv('1. e4 e5 2. Nf3'), 'short')).toBe('Nf3.');
  });
  it('appends check and checkmate as comma clauses', () => {
    expect(moveToSpeech(mv('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#'), 'natural')).toBe('Queen takes f7, checkmate.');
    expect(moveToSpeech(mv('1. e4 f5 2. Qh5+'), 'natural')).toBe('Queen h5, check.');
  });
  it('handles castling, en passant and promotion', () => {
    expect(moveToSpeech(mv('1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O'), 'natural')).toBe('Castles kingside.');
    expect(moveToSpeech(mv('1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O'), 'full')).toBe('White castles kingside.');
    expect(moveToSpeech(mv('1. e4 a6 2. e5 d5 3. exd6'), 'natural')).toBe('Pawn takes d6, en passant.');
    expect(moveToSpeech(mv('1. h4 g5 2. hxg5 f6 3. gxf6 Nc6 4. fxe7 Nf6 5. exd8=Q+'), 'natural')).toBe('Pawn takes d8, promoting to queen, check.');
    expect(moveToSpeech(mv('1. h4 g5 2. hxg5 f6 3. gxf6 Nc6 4. fxe7 Nf6 5. exd8=Q+'), 'full')).toBe('White pawn from e7 to d8, takes queen, promoting to queen, check.');
  });
  it('names the whole origin square when the notation is disambiguated', () => {
    const m = mv('1. Nf3 d5 2. Nc3 d4 3. Nb5 e5 4. Nbxd4');
    expect(moveToSpeech(m, 'natural')).toBe('Knight from b5 takes d4.');
  });
});

describe('the bookends', () => {
  it('reads the result with its reason', () => {
    expect(resultSpeech({ Result: '1-0', Termination: 'alpha won by resignation' })).toBe('White wins by resignation.');
    expect(resultSpeech({ Result: '1/2-1/2', Termination: 'Normal' })).toBe('Draw.');
    expect(resultSpeech({ Result: '*' })).toBe('');
  });
  it('announces the players and the time control', () => {
    expect(timeControlPhrase({ TimeControl: '180' })).toBe('3 minute blitz');
    expect(timeControlPhrase({ TimeControl: '600+5' })).toBe('10 minute plus 5 rapid');
    expect(announcementSpeech({ White: 'A', Black: 'B', TimeControl: '180' })).toBe('A against B, 3 minute blitz.');
  });
  it('lands the opening name at the ply where the ECOUrl line ends', () => {
    const op = openingAnnouncement({ ECOUrl: 'https://www.chess.com/openings/Scandinavian-Defense-2.exd5-Qxd5' });
    expect(op.ply).toBe(4);
    expect(op.clause).toBe(', the Scandinavian Defense');
    const li = openingAnnouncement({ Opening: 'Italian Game' });
    expect(li.ply).toBe(0);
    expect(openingAnnouncement({})).toBeNull();
  });
});

describe('positionSpeech', () => {
  it('is two sentences, a side each, king first and pawns last', () => {
    const s = positionSpeech('4k3/4p3/8/8/8/8/4P3/4K3 w - - 0 1');
    expect(s).toBe('White: king on e1; pawn on e2. Black: king on e8; pawn on e7. White to move.');
  });
});
