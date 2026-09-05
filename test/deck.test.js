import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// Memory, in memory: the deck writes rows and never reads them back, so the stub only
// has to record what was put.
const puts = [];
vi.mock('../src/memory.js', () => ({
  dbPutAll: async (store, rows) => { puts.push(...rows.map(r => ({ store, key: r.key }))); return true; },
  dbPut: async (store, row) => { puts.push({ store, key: row.key }); return true; },
  dbDelete: async () => true,
  dbAll: async () => [],
}));
const spoken = [];
vi.mock('../src/speech/provider.js', () => ({
  speak: (text, onDone) => { spoken.push(text); if (onDone) onDone(); return 1; },
  cancelSpeech: () => {},
}));

import { S } from '../src/state.js';
import { loadGames, START_FEN } from '../src/pgn.js';
import {
  DECK_SWING, TACTIC_BAND, DECK_BOXES, DECK_RETRY_MS,
  harvestDeck, mergeDeck, deckDue, tacticsDue, gradeCard, removeCard, cardLoss,
  deckCardHTML, cardClaim, cardAnswerSpeech, speakCard, weekStats, onAnalysisDone, boot,
} from '../src/deck.js';

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const evals = JSON.parse(fixture('evals.json'));
const { games } = await loadGames(fixture('chesscom.pgn'));
for (const g of games) g.analysis = evals[g.id];

const DAY = 24 * 60 * 60 * 1000;
const FIELDS = ['key', 'gameId', 'ply', 'fen', 'played', 'previous', 'answer', 'before', 'after', 'color',
  'player', 'opponent', 'date', 'site', 'box', 'due', 'seen', 'passes', 'fails', 'lastAt', 'addedAt'];

function harvestAll(heroKey = null) {
  const deck = [], tactics = [];
  for (const g of games) { const h = harvestDeck(g, heroKey); deck.push(...h.deck); tactics.push(...h.tactics); }
  return { deck, tactics };
}

// A card by hand: 1. e4 e5 2. Nf3 Nc6 3. Bc4 — and Black played 3…Nf6 where the fixture
// says the engine wanted 3…Bc5. Evaluations are White-positive.
function card(over = {}) {
  return {
    key: 'g1:4', gameId: 'g1', ply: 4,
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
    played: 'g8f6', previous: 'f1c4', answer: 'f8c5',
    before: { cp: 20 }, after: { cp: 380 }, color: 'b',
    player: 'Elliott', opponent: 'Someone', date: '4 Mar 2025', site: 'Chess.com',
    box: 0, due: 1000, seen: 0, passes: 0, fails: 0, lastAt: 0, addedAt: 1000, ...over,
  };
}

beforeEach(() => { S.deck.clear(); S.tactics.clear(); S.hero = null; puts.length = 0; spoken.length = 0; });

describe('constants', () => {
  it('are the spec’s: 300, [200,300), 1/3/7/21/60 days, ten minutes', () => {
    expect(DECK_SWING).toBe(300);
    expect(TACTIC_BAND).toEqual([200, 300]);
    expect(DECK_BOXES).toEqual([1, 3, 7, 21, 60]);
    expect(DECK_RETRY_MS).toBe(10 * 60 * 1000);
  });
});

describe('harvestDeck', () => {
  it('yields deck rows at loss ≥ 300 and tactics in [200, 300), and finds some of each in the corpus', () => {
    const { deck, tactics } = harvestAll();
    expect(deck.length).toBeGreaterThan(0);
    expect(tactics.length).toBeGreaterThan(0);
    for (const c of deck) expect(cardLoss(c)).toBeGreaterThanOrEqual(DECK_SWING);
    for (const c of tactics) { expect(cardLoss(c)).toBeGreaterThanOrEqual(200); expect(cardLoss(c)).toBeLessThan(300); }
  });
  it('makes every row self-contained and keyed gameId:ply, with fen === fens[ply] and played ≠ answer', () => {
    const { deck, tactics } = harvestAll();
    const byId = new Map(games.map(g => [g.id, g]));
    for (const c of [...deck, ...tactics]) {
      for (const f of FIELDS) expect(c, f).toHaveProperty(f);
      expect(c.key).toBe(c.gameId + ':' + c.ply);
      const g = byId.get(c.gameId);
      expect(c.fen).toBe(g.fens[c.ply]);
      expect(c.played).not.toBe(c.answer);
      expect(c.played).toMatch(/^[a-h][1-8][a-h][1-8]/);
      expect(c.answer).toMatch(/^[a-h][1-8][a-h][1-8]/);
      expect(c.color).toBe(g.moves[c.ply].color);
      expect(c.player).toBe(g.headers[c.color === 'w' ? 'White' : 'Black']);
      expect(c.previous).toBe(c.ply > 0 ? g.moves[c.ply - 1].from + g.moves[c.ply - 1].to + (g.moves[c.ply - 1].promotion || '') : '');
      expect(c.date).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
      expect(c.box).toBe(0); expect(c.seen).toBe(0); expect(c.due).toBe(c.addedAt);
    }
  });
  it('yields nothing while the scan is unfinished', () => {
    const g = games.find(x => harvestDeck(x, null).deck.length);
    const partial = { ...g, analysis: { ...g.analysis, done: g.fens.length - 1 } };
    expect(harvestDeck(partial, null)).toEqual({ deck: [], tactics: [] });
    expect(harvestDeck({ ...g, analysis: undefined }, null)).toEqual({ deck: [], tactics: [] });
  });
  it('treats a mate as ±10000 before comparing: throwing away mate in 3 is a card', () => {
    const g = games[0];
    const n = 20;
    const a = { ...g.analysis, evals: g.analysis.evals.slice(), best: g.analysis.best.slice() };
    const color = g.moves[n].color;
    a.evals[n] = { mate: color === 'w' ? 3 : -3 };
    a.evals[n + 1] = { cp: 0 };
    a.best[n] = 'a1a1';  // anything but the move played
    const { deck } = harvestDeck({ ...g, analysis: a }, null);
    const c = deck.find(x => x.ply === n);
    expect(c).toBeTruthy();
    expect(c.before).toEqual({ mate: color === 'w' ? 3 : -3 });
    expect(cardLoss(c)).toBe(10000);
  });
  it('skips a move the engine would have played, whatever the numbers say', () => {
    const g = games[0];
    const n = 10;
    const a = { ...g.analysis, evals: g.analysis.evals.slice(), best: g.analysis.best.slice() };
    a.evals[n] = { cp: 500 }; a.evals[n + 1] = { cp: -500 };
    a.best[n] = g.moves[n].from + g.moves[n].to;
    expect(harvestDeck({ ...g, analysis: a }, null).deck.find(x => x.ply === n)).toBeUndefined();
  });
  it('harvests only the subject’s moves when a hero key is given, and reads S.hero by default', () => {
    const both = harvestAll();
    const names = new Set([...both.deck, ...both.tactics].map(c => c.player.toLowerCase()));
    expect(names.size).toBeGreaterThan(1);
    const hero = [...names][0];
    const mine = harvestAll(hero);
    for (const c of [...mine.deck, ...mine.tactics]) expect(c.player.toLowerCase()).toBe(hero);
    expect(mine.deck.length + mine.tactics.length).toBeLessThan(both.deck.length + both.tactics.length);
    S.hero = { name: hero, key: hero };
    const viaS = [];
    for (const g of games) viaS.push(...harvestDeck(g).deck, ...harvestDeck(g).tactics);
    expect(viaS.length).toBe(mine.deck.length + mine.tactics.length);
  });
});

describe('mergeDeck', () => {
  it('adds new cards, persists them, and counts only the new ones', () => {
    const { deck } = harvestAll();
    expect(mergeDeck(deck, 'deck')).toBe(deck.length);
    expect(S.deck.size).toBe(deck.length);
    expect(puts.filter(p => p.store === 'deck').length).toBe(deck.length);
    expect(mergeDeck(deck, 'deck')).toBe(0);
  });
  it('never resets a schedule: merge, grade, merge again keeps the box', () => {
    mergeDeck([card()], 'deck');
    const c = S.deck.get('g1:4');
    gradeCard(c, true, 5000);
    gradeCard(c, true, 5000 + 2 * DAY);
    expect(c.box).toBe(2);
    mergeDeck([card()], 'deck');
    const again = S.deck.get('g1:4');
    expect(again).toBe(c);
    expect(again.box).toBe(2);
    expect(again.passes).toBe(2);
    expect(again.due).toBe(5000 + 2 * DAY + 3 * DAY);
  });
  it('fills a field an older row lacks without touching the rest', () => {
    const old = card({ box: 3 }); delete old.site;
    mergeDeck([old], 'deck');
    mergeDeck([card({ site: 'Lichess', player: 'Nobody' })], 'deck');
    const c = S.deck.get('g1:4');
    expect(c.site).toBe('Lichess');
    expect(c.player).toBe('Elliott');
    expect(c.box).toBe(3);
  });
  it('keeps the tactics store apart', () => {
    mergeDeck([card({ key: 'g1:6', ply: 6 })], 'tactics');
    expect(S.tactics.size).toBe(1);
    expect(S.deck.size).toBe(0);
    expect(puts[0].store).toBe('tactics');
  });
});

describe('gradeCard', () => {
  it('climbs 1, 3, 7, 21, 60 days on passes and caps at the last box', () => {
    const c = card();
    let now = 10 ** 6;
    for (const days of DECK_BOXES) {
      gradeCard(c, true, now, 'deck');
      expect(c.due).toBe(now + days * DAY);
      now = c.due;
    }
    expect(c.box).toBe(DECK_BOXES.length);
    gradeCard(c, true, now, 'deck');
    expect(c.box).toBe(DECK_BOXES.length);
    expect(c.due).toBe(now + 60 * DAY);
    expect(c.passes).toBe(6); expect(c.seen).toBe(6); expect(c.lastAt).toBe(now);
  });
  it('a miss returns in ten minutes, not tomorrow, and goes back to the front', () => {
    const c = card({ box: 4 });
    gradeCard(c, false, 5000, 'deck');
    expect(c.box).toBe(0);
    expect(c.due).toBe(5000 + DECK_RETRY_MS);
    expect(c.fails).toBe(1);
    expect(puts).toEqual([{ store: 'deck', key: 'g1:4' }]);
  });
  it('writes to the store the card lives in', () => {
    const c = card({ key: 'g1:8', ply: 8 });
    S.tactics.set(c.key, c);
    gradeCard(c, true, 1);
    expect(puts[0].store).toBe('tactics');
  });
});

describe('due lists', () => {
  it('return cards with due ≤ now, oldest due first', () => {
    mergeDeck([card({ key: 'a:1', due: 300 }), card({ key: 'a:2', due: 100 }), card({ key: 'a:3', due: 900 }), card({ key: 'a:4', due: 200 })], 'deck');
    expect(deckDue(300).map(c => c.key)).toEqual(['a:2', 'a:4', 'a:1']);
    expect(deckDue(50)).toEqual([]);
    mergeDeck([card({ key: 't:1', due: 5 })], 'tactics');
    expect(tacticsDue(10).map(c => c.key)).toEqual(['t:1']);
    expect(deckDue(10)).toEqual([]);
  });
  it('removeCard drops the row', () => {
    mergeDeck([card()], 'deck');
    expect(removeCard('g1:4', 'deck')).toBe(true);
    expect(S.deck.size).toBe(0);
    expect(removeCard('g1:4', 'deck')).toBe(false);
  });
});

describe('weekStats', () => {
  it('counts drilled, due and grew over the last seven days and names the worst new card', () => {
    const now = 100 * DAY;
    mergeDeck([
      card({ key: 'a:1', addedAt: now - DAY, due: now - 1, lastAt: now - 2 * DAY, before: { cp: 0 }, after: { cp: 350 } }),
      card({ key: 'a:2', addedAt: now - 2 * DAY, due: now + DAY, lastAt: 0, before: { cp: 0 }, after: { cp: 900 } }),
      card({ key: 'a:3', addedAt: now - 30 * DAY, due: now, lastAt: now - 8 * DAY, before: { cp: 0 }, after: { mate: 1 } }),
    ], 'deck');
    mergeDeck([card({ key: 't:1', addedAt: now - 3 * DAY, due: now - 5, lastAt: now - 1000, before: { cp: 0 }, after: { cp: 250 } })], 'tactics');
    const w = weekStats(now);
    expect(w.drilled).toBe(2);
    expect(w.due).toBe(3);
    expect(w.grew).toBe(3);
    expect(w.worst.key).toBe('a:2');
  });
  it('has no worst card when nothing was earned this week', () => {
    mergeDeck([card({ addedAt: 0 })], 'deck');
    expect(weekStats(100 * DAY).worst).toBeNull();
  });
});

describe('deckCardHTML', () => {
  it('hides the answer until revealed, then shows played and answer as SAN, both evaluations and grade buttons', () => {
    const hidden = deckCardHTML(card(), { revealed: false });
    expect(hidden).toContain('Drill card · Black to move, move 3 · vs Someone · 4 Mar 2025');
    expect(hidden).toContain('What should Black play here?');
    expect(hidden).not.toContain('Nf6');
    expect(hidden).not.toContain('Bc5');
    expect(hidden).not.toContain('data-grade');
    expect(hidden).toContain('data-act="reveal"');
    const shown = deckCardHTML(card(), { revealed: true });
    expect(shown).toContain('<span class="san">Nf6</span>');
    expect(shown).toContain('<span class="san">Bc5</span>');
    expect(shown).toContain('+0.2');
    expect(shown).toContain('+3.8');
    expect(shown).toContain('It cost 3.6.');
    expect(shown).toContain('data-grade="pass"');
    expect(shown).toContain('data-grade="fail"');
    expect(shown).toContain('<div class="card-why" data-key="g1:4"></div>');
  });
  it('says mate in words and escapes what it prints', () => {
    const html = deckCardHTML(card({ after: { mate: 2 }, opponent: '<b>' }), { revealed: true });
    expect(html).toContain('walked into mate');
    expect(html).toContain('+M2');
    expect(html).toContain('vs &lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('cardClaim', () => {
  it('flips for Black, lights the previous move, and carries no arrows until revealed', () => {
    const pos = cardClaim(card(), { revealed: false });
    expect(pos.fen).toBe(card().fen);
    expect(pos.flipped).toBe(true);
    expect(pos.from).toBe('f1'); expect(pos.to).toBe('c4');
    expect(pos.arrows).toEqual([]);
    expect(pos.label).toMatch(/^Drill card · Black to move, move 3/);
    expect(pos.line).toEqual({ moves: [], at: 0, from: 5 });
  });
  it('draws the answer as best and the played move as missed once revealed; White is not flipped', () => {
    const pos = cardClaim(card({ color: 'w', previous: '' }), { revealed: true });
    expect(pos.flipped).toBe(false);
    expect(pos.from).toBeNull();
    expect(pos.arrows).toEqual([{ from: 'f8', to: 'c5', kind: 'best' }, { from: 'g8', to: 'f6', kind: 'missed' }]);
  });
});

describe('speech', () => {
  it('cardAnswerSpeech names both moves as one sentence pair', () => {
    expect(cardAnswerSpeech(card())).toBe('You played knight f6. The engine plays bishop c5.');
    expect(cardAnswerSpeech(card({ fen: START_FEN, played: 'e2e4', answer: 'd2d4' }))).toBe('You played pawn e4. The engine plays pawn d4.');
  });
  it('speakCard speaks the position, then the question, through speak() only', () => {
    speakCard(card());
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toMatch(/^White: king on e1/);
    expect(spoken[0]).toMatch(/Black to move\.$/);
    expect(spoken[1]).toBe('What should Black play here?');
    speakCard(card(), { revealed: true });
    expect(spoken[2]).toBe('You played knight f6. The engine plays bishop c5.');
  });
});

describe('boot', () => {
  it('tolerates no document', () => { expect(() => boot()).not.toThrow(); });
  it('onAnalysisDone harvests into both stores and counts what was added', () => {
    const g = games.find(x => { const h = harvestDeck(x, null); return h.deck.length && h.tactics.length; });
    const h = harvestDeck(g, null);
    expect(onAnalysisDone(g)).toBe(h.deck.length + h.tactics.length);
    expect(S.deck.size).toBe(h.deck.length);
    expect(S.tactics.size).toBe(h.tactics.length);
    expect(onAnalysisDone(g)).toBe(0);
  });
});
