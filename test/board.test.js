import { describe, it, expect } from 'vitest';
import { boardHTML, expandFEN, PIECE_ART, arrowsSVG } from '../src/board.js';
import { START_FEN } from '../src/pgn.js';

describe('expandFEN', () => {
  it('expands digits to empty cells', () => {
    expect(expandFEN('8')).toEqual([null, null, null, null, null, null, null, null]);
    expect(expandFEN('r3k2r')).toEqual(['r', null, null, null, 'k', null, null, 'r']);
  });
});

describe('boardHTML', () => {
  it('emits 64 squares with a8 first and h1 last', () => {
    const html = boardHTML(START_FEN);
    expect(html.match(/class="sq /g)).toHaveLength(64);
    const light = html.match(/sq-light/g).length, dark = html.match(/sq-dark/g).length;
    expect(light).toBe(32); expect(dark).toBe(32);
  });
  it('flips by index, not by rotation: the first square becomes h1', () => {
    const up = boardHTML(START_FEN, { interactive: true });
    const down = boardHTML(START_FEN, { interactive: true, flipped: true });
    expect(up.indexOf('data-square="a8"')).toBeLessThan(up.indexOf('data-square="h1"'));
    expect(down.indexOf('data-square="h1"')).toBeLessThan(down.indexOf('data-square="a8"'));
  });
  it('lights the from and to squares', () => {
    const html = boardHTML(START_FEN, { from: 'e2', to: 'e4', interactive: true });
    expect(html).toMatch(/sq-hl-from" data-square="e2"/);
    expect(html).toMatch(/sq-hl-to" data-square="e4"/);
  });
  it('uses only --pc-* custom properties for piece colour', () => {
    for (const art of Object.values(PIECE_ART)) {
      expect(art).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
      expect(art).toMatch(/var\(--pc-/);
    }
    expect(Object.keys(PIECE_ART).sort().join('')).toBe('BKNPQRbknpqr');
  });
  it('puts coordinates inside the edge squares only', () => {
    const html = boardHTML(START_FEN, { coords: true });
    expect(html.match(/sq-file/g)).toHaveLength(8);
    expect(html.match(/sq-rank/g)).toHaveLength(8);
  });
});

describe('arrowsSVG', () => {
  it('draws in board space with one unit per square', () => {
    const svg = arrowsSVG([{ from: 'e2', to: 'e4', kind: 'best' }], false);
    expect(svg).toMatch(/x1="4.5" y1="6.5"/);
    expect(arrowsSVG([], false)).toBe('');
  });
});
