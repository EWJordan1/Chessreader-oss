/*
 * Prep: the list, the watermark, the crossing, the briefing and the engine pass.
 *
 * Node environment, no DOM — every claim below is arithmetic over two tries, a row
 * shape or a fetch, which is the whole reason those are the exported functions. The
 * claims pinned are the ones a bug would falsify *silently*: a crossing ranked by how
 * often a line came up rather than by what it cost, a gap row quietly dropped so the
 * room reports only the repertoire you already have, a floor that stopped being a
 * floor, a refresh that asked for the archive again, a briefing that said the record
 * first, an eviction that kept the wrong end of the archive.
 *
 * Two header dialects on purpose: `chesscom.pgn` writes `ECOUrl`, `lichess.pgn` writes
 * `Opening`, and Prep reads neither — it reads `TimeControl`, which is what lets both
 * land in the same format bucket.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/* ---------- the disk, in memory ----------
   Prep's three stores behave enough like IndexedDB for the row shapes to matter: keys
   are the stores' own keys, and `by-opp` is a bounded range over [oppId, endTime]. */
const mem = vi.hoisted(() => {
  const stores = new Map();
  const store = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const keyOf = (name, row) => (name === 'opponents' ? row.id : row.key);
  return { stores, store, keyOf, reset: () => stores.clear() };
});
vi.mock('../src/memory.js', () => ({
  dbGet: async (s, k) => mem.store(s).get(k),
  dbAll: async s => [...mem.store(s).values()],
  dbCount: async s => mem.store(s).size,
  dbPut: async (s, row) => { mem.store(s).set(mem.keyOf(s, row), row); return true; },
  dbPutAll: async (s, rows) => { for (const r of rows) mem.store(s).set(mem.keyOf(s, r), r); return true; },
  dbDelete: async (s, k) => { mem.store(s).delete(k); return true; },
  dbClear: async s => { mem.store(s).clear(); return true; },
  dbIndexRange: async (s, index, lower, upper) => [...mem.store(s).values()]
    .filter(r => r && r.oppId === lower[0] && (r.endTime || 0) >= lower[1] && (r.endTime || 0) <= upper[1])
    .sort((a, b) => (a.endTime || 0) - (b.endTime || 0)),
}));

const said = vi.hoisted(() => ({ list: [] }));
vi.mock('../src/speech/provider.js', () => ({
  speak: (text, onDone) => { said.list.push(text); if (onDone) onDone(); return 1; },
  cancelSpeech: () => {},
  apiVoiceActive: () => false,
}));

/* The engine, stubbed. Only the pass reaches it, and only by dynamic import. */
const eng = vi.hoisted(() => ({ calls: [], onCall: null, cp: 100 }));
vi.mock('../src/engine/provider.js', () => ({
  analyse: async (fen, opts) => {
    eng.calls.push({ fen, opts });
    if (eng.onCall) await eng.onCall(eng.calls.length);
    return { cp: eng.cp, pv: ['e2e4', 'e7e5'], depth: opts.depth };
  },
}));

import { S } from '../src/state.js';
import { loadGames, parseGame, headersOf } from '../src/pgn.js';
import { addToBook, removeLine, bookLines, bookTrie } from '../src/learn/book.js';
import { playerKey, scorePct } from '../src/insights.js';
import {
  SITES, FORMATS, DEFAULT_FORMAT, OPP_GAME_CAP, FETCH_MAX,
  CROSS_MAX_PLY, CROSS_MIN_PLY, CROSS_MIN_GAMES, CROSS_ROWS,
  PASS_DEPTH, PASS_MOVETIME, PASS_BUILD,
  oppKeyOf, opponents, findOpponent, addOpponent, removeOpponent,
  formatOf, inFormat, filterFormat, monthsSince, oppGameRow, evictOldest,
  fetchOpponent, oppGames, oppTrie, crossing, passOrder,
  buildReport, lineText, lineSpeech, briefingParts, briefing,
  passRow, applyPassRow, passState, stopPass, startPass, rowSentence, boot,
} from '../src/prep.js';

/* ===================================================================================
 * Fixtures
 * =================================================================================== */

const FIX = new URL('./fixtures/', import.meta.url);
const read = name => readFileSync(new URL(name, FIX), 'utf8');

let CHESSCOM = [];      // 34 real games, ECOUrl dialect
let LICHESS = [];       // 17 real games, Opening dialect

/** One person's games out of a fixture archive. */
const theirs = (key, games) => games.filter(g =>
  playerKey(g.headers.White) === key || playerKey(g.headers.Black) === key);
/** An opponent corpus: their stored `oppgames` rows, exactly as a fetch would write them. */
const corpusRows = (oppId, games) => games.map(g => oppGameRow(oppId, { pgn: g.pgn })).filter(Boolean);
/** …and the same corpus as parsed games, which is what every pure function here takes. */
const corpus = games => games.map(g => parseGame(g.pgn)).filter(Boolean);

beforeAll(async () => {
  CHESSCOM = (await loadGames(read('chesscom.pgn'))).games;
  LICHESS = (await loadGames(read('lichess.pgn'))).games;
});

/* A synthetic game: small on purpose, so the claim each one pins is visible. */
function pgnOf({ white, black, result, tc = '180', date = '2026.02.01', time = '12:00:00', moves }) {
  let body = '';
  moves.forEach((san, i) => { if (i % 2 === 0) body += (i / 2 + 1) + '. '; body += san + ' '; });
  return [
    '[Event "Live Chess"]', '[Site "Chess.com"]', '[Date "' + date + '"]',
    '[White "' + white + '"]', '[Black "' + black + '"]', '[Result "' + result + '"]',
    '[UTCDate "' + date + '"]', '[UTCTime "' + time + '"]',
    '[WhiteElo "2000"]', '[BlackElo "2000"]',
    '[TimeControl "' + tc + '"]', '[Termination "Normal"]',
    '[EndDate "' + date + '"]', '[EndTime "' + time + '"]', '',
    body + result,
  ].join('\n');
}
function synth(o) {
  const g = parseGame(pgnOf(o));
  if (!g) throw new Error('fixture PGN does not parse: ' + o.moves.join(' '));
  return g;
}

const THEM = 'villain';
const asBlack = (moves, result, n = 1) => Array.from({ length: n }, (_, i) =>
  synth({ white: 'hero', black: THEM, result, moves, time: '1' + (i % 5) + ':0' + (i % 6) + ':00' }));

const RUY = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
/*
 * Their archive, built so the two rankings disagree: they win every Ruy (three games,
 * a score of 100) and score even in twenty Sicilians. A crossing ranked by count puts
 * the Sicilian first; ranked by what it costs, the Ruy.
 */
function theirArchive() {
  return [
    ...asBlack([...RUY, 'Ba4', 'Nf6'], '0-1', 1),
    ...asBlack([...RUY, 'Bxc6', 'dxc6'], '0-1', 1),
    ...asBlack([...RUY, 'Bxc6', 'bxc6'], '0-1', 1),
    ...asBlack(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4'], '0-1', 10),
    ...asBlack(['e4', 'c5', 'Nf3', 'd6', 'd4', 'Nf6'], '1-0', 10),
    ...asBlack(['e4', 'd5', 'exd5', 'Qxd5'], '1-0', 4),
    ...asBlack(['e4', 'g6', 'd4', 'Bg7'], '1/2-1/2', 1),
  ];
}
/** My White book: the Ruy a move deeper than they mostly go, and a short Sicilian. */
function myWhiteBook() {
  addToBook('w', [...RUY, 'Ba4'], 'Ruy Lopez');
  addToBook('w', ['e4', 'c5', 'Nf3', 'd6'], 'Sicilian');
}

/** The trie the room walks: Learn's own, never a hand-built stand-in. */
const bookOf = color => bookTrie(color);
/* Learn memoises its trie and drops the memo on a write, so an empty book is emptied
   through Learn rather than by clearing S.book behind its back. */
const emptyTheBook = () => { for (const row of [...bookLines('w'), ...bookLines('b')]) removeLine(row.key); };

/* ---------- a fetch stub, routed by substring ---------- */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, opts) => {
    url = String(url);
    calls.push(url);
    for (const [needle, answer] of routes) {
      if (!url.includes(needle)) continue;
      const body = typeof answer === 'function' ? answer(url) : answer;
      return {
        ok: true, status: 200, body: null,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    }
    return { ok: false, status: 404, body: null, json: async () => ({}), text: async () => '' };
  });
  return calls;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  mem.reset();
  said.list = [];
  eng.calls = []; eng.onCall = null; eng.cp = 100;
  S.opponents = [];
  S.book = new Map();
  S.games = [];
  S.heroOverride = '';
  for (const g of [...CHESSCOM, ...LICHESS]) { delete g._facts; delete g._clk; delete g._acc; }
});
afterEach(() => { globalThis.fetch = realFetch; stopPass(); });

/* ===================================================================================
 * The list
 * =================================================================================== */

describe('the list', () => {
  it('keys a person by site and handle, case and space folded', () => {
    expect(oppKeyOf('chesscom', ' Hikaru ')).toBe('chesscom:hikaru');
    expect(oppKeyOf('LICHESS', 'DrNykterstein')).toBe('lichess:drnykterstein');
  });

  it('adds a person once: the second press is the same row, not a second one', () => {
    const a = addOpponent('chesscom', 'Hikaru', 'blitz');
    const b = addOpponent('chesscom', 'hikaru', 'rapid');
    expect(b).toBe(a);
    expect(opponents()).toHaveLength(1);
    expect(a.format).toBe('blitz');
  });

  it('coerces an unknown site or format and refuses an empty handle', () => {
    const row = addOpponent('twitch', 'someone', 'hyperbullet');
    expect(row.site).toBe(SITES[0]);
    expect(row.format).toBe(DEFAULT_FORMAT);
    expect(addOpponent('chesscom', '   ', 'blitz')).toBeNull();
    expect(opponents()).toHaveLength(1);
  });

  it('lands empty: adding fetches nothing, because nothing runs without a press', () => {
    globalThis.fetch = vi.fn();
    const row = addOpponent('chesscom', 'Hikaru', 'blitz');
    expect(row.readAt).toBe(0);
    expect(row.count).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('removing a person takes their games and their evaluations with them', async () => {
    const row = addOpponent('chesscom', 'Hikaru', 'blitz');
    const rows = corpusRows(row.id, CHESSCOM.slice(0, 3));
    for (const r of rows) {
      mem.store('oppgames').set(r.key, r);
      mem.store('oppevals').set(r.key, { key: r.key, oppId: row.id, build: PASS_BUILD });
    }
    const other = addOpponent('lichess', 'someone', 'bullet');
    mem.store('oppgames').set(other.id + ':x', { key: other.id + ':x', oppId: other.id, endTime: 1 });

    expect(await removeOpponent(row.id)).toBe(true);
    expect(findOpponent(row.id)).toBeNull();
    expect(mem.store('opponents').has(row.id)).toBe(false);
    expect([...mem.store('oppgames').values()].filter(r => r.oppId === row.id)).toHaveLength(0);
    expect(mem.store('oppevals').size).toBe(0);
    // …and nobody else's.
    expect(mem.store('oppgames').size).toBe(1);
    expect(await removeOpponent('chesscom:nobody')).toBe(false);
  });
});

/* ===================================================================================
 * The format filter
 * =================================================================================== */

describe('the format filter', () => {
  it('reads TimeControl, so both header dialects land in the same bucket', () => {
    // The fixtures disagree about everything else: ECOUrl on one side, Opening on the other.
    expect(CHESSCOM.every(g => 'ECOUrl' in g.headers)).toBe(true);
    expect(LICHESS.every(g => 'Opening' in g.headers)).toBe(true);
    expect(CHESSCOM.some(g => 'Opening' in g.headers)).toBe(false);

    expect(formatOf({ TimeControl: '180' })).toBe('blitz');
    expect(formatOf({ TimeControl: '60+1' })).toBe('bullet');     // base plus forty increments
    expect(formatOf({ TimeControl: '180+0' })).toBe('blitz');
    expect(formatOf({ TimeControl: '1/259200' })).toBe('daily');
    expect(formatOf({})).toBeNull();
    expect(inFormat({}, 'blitz')).toBe(false);                     // no header, no guess
    expect(inFormat({ TimeControl: '180' }, '')).toBe(false);
  });

  it('drops the games outside the format entirely rather than sorting them', () => {
    const rows = corpusRows('chesscom:hikaru', CHESSCOM);
    const blitz = filterFormat(rows, 'blitz');
    const bullet = filterFormat(rows, 'bullet');
    const daily = filterFormat(rows, 'daily');
    expect(rows).toHaveLength(34);
    expect(blitz).toHaveLength(12);
    expect(bullet).toHaveLength(16);
    expect(daily).toHaveLength(6);
    // Dropped, not merely ordered: not one 60-second game is anywhere in the blitz list,
    // and a game whose header cannot say is in no list at all rather than in the default one.
    expect(blitz.every(r => headersOf(r.pgn).TimeControl === '180')).toBe(true);
    expect(bullet.some(r => headersOf(r.pgn).TimeControl === '180')).toBe(false);
    const unsaid = { pgn: pgnOf({ white: 'a', black: 'b', result: '1-0', tc: '-', moves: ['e4', 'e5'] }) };
    for (const f of FORMATS) expect(filterFormat([unsaid], f)).toEqual([]);
    // The other dialect, filtered by the same rule: 15+0 and 60+0 are bullet, 180+0 blitz.
    const li = corpusRows('lichess:x', LICHESS);
    expect(filterFormat(li, 'bullet')).toHaveLength(16);
    expect(filterFormat(li, 'blitz')).toHaveLength(1);
  });

  it('says so when a person has no games in the chosen format', async () => {
    const opp = addOpponent('lichess', 'HrishikeshPs', 'blitz');    // they play 15+0 only
    for (const r of corpusRows(opp.id, theirs('hrishikeshps', LICHESS))) mem.store('oppgames').set(r.key, r);
    const games = await oppGames(opp.id);
    expect(games).toHaveLength(0);                                   // filtered again at the read

    const rep = buildReport(opp, games);
    const parts = briefingParts(rep);
    expect(parts).toHaveLength(1);
    expect(parts[0].key).toBe('none');
    expect(parts[0].text).toContain('no blitz games');
    expect(parts[0].text).toContain('Lichess');
    // The row says it too, rather than showing a zero.
    opp.readAt = Date.now(); opp.count = 0;
    expect(rowSentence(opp)).toContain('No blitz games');
  });
});

/* ===================================================================================
 * What is new, never the archive again
 * =================================================================================== */

describe('the watermark', () => {
  const M = (y, m) => 'https://api.chess.com/pub/player/villain/games/' + y + '/' + String(m).padStart(2, '0');

  it('never asks for a month that ended before the watermark', () => {
    const urls = [M(2026, 3), M(2026, 2), M(2026, 1), M(2025, 12)];   // newest first
    expect(monthsSince(urls, 0)).toEqual(urls);
    // Mid-February: February is still running, January ended before it.
    expect(monthsSince(urls, Date.UTC(2026, 1, 10))).toEqual([M(2026, 3), M(2026, 2)]);
    // The first instant of March is the end of February, and a month that ended *at*
    // the watermark holds nothing newer than it.
    expect(monthsSince(urls, Date.UTC(2026, 2, 1))).toEqual([M(2026, 3)]);
  });

  it('asks for a month URL it cannot read rather than guessing at it', () => {
    const odd = 'https://api.chess.com/pub/player/villain/games/latest';
    expect(monthsSince([odd, M(2025, 1)], Date.UTC(2026, 0, 1))).toEqual([odd]);
  });

  it('refreshing asks Chess.com only for the months since the last read', async () => {
    const opp = addOpponent('chesscom', 'villain', 'blitz');
    const jan = pgnOf({ white: 'villain', black: 'other', result: '1-0', date: '2026.01.15', moves: ['e4', 'e5'] });
    const feb = pgnOf({ white: 'villain', black: 'other', result: '1-0', date: '2026.02.20', moves: ['d4', 'd5'] });
    const feb2 = pgnOf({ white: 'villain', black: 'other', result: '0-1', date: '2026.02.25', moves: ['c4', 'c5'] });
    const cc = (pgn, at) => ({
      pgn, rules: 'chess', time_class: 'blitz', end_time: at / 1000, url: 'u',
      white: { username: 'villain', rating: 2000, result: 'win' },
      black: { username: 'other', rating: 2000, result: 'resigned' },
    });
    const routes = [
      ['/games/archives', { archives: [M(2026, 1), M(2026, 2)] }],
      ['/2026/01', { games: [cc(jan, Date.UTC(2026, 0, 15))] }],
      ['/2026/02', { games: [cc(feb, Date.UTC(2026, 1, 20)), cc(feb2, Date.UTC(2026, 1, 25))] }],
    ];

    let calls = stubFetch(routes);
    expect(await fetchOpponent(opp.id)).toBe(3);                 // a cold row reads the archive
    expect(calls.some(u => u.includes('/2026/01'))).toBe(true);
    expect(opp.count).toBe(3);
    expect(opp.readAt).toBeGreaterThan(0);
    expect(opp.since).toBe(Date.UTC(2026, 0, 15));               // the oldest it holds

    // The night before: one more February game has been played since.
    const feb3 = pgnOf({ white: 'villain', black: 'other', result: '1-0', date: '2026.02.26', moves: ['Nf3', 'Nf6'] });
    routes[2] = ['/2026/02', { games: [cc(feb, Date.UTC(2026, 1, 20)), cc(feb2, Date.UTC(2026, 1, 25)), cc(feb3, Date.UTC(2026, 1, 26))] }];
    opp.readAt = Date.UTC(2026, 1, 25, 12);
    calls = stubFetch(routes);
    expect(await fetchOpponent(opp.id)).toBe(1);                 // what is new, not the archive again
    expect(calls.some(u => u.includes('/2026/01'))).toBe(false); // January is never asked for a second time
    expect(calls.some(u => u.includes('/2026/02'))).toBe(true);
    expect(mem.store('oppgames').size).toBe(4);                  // and nothing was stored twice
  });

  it('carries the watermark to Lichess as the query it takes', async () => {
    const opp = addOpponent('lichess', 'villain', 'bullet');
    opp.readAt = Date.UTC(2026, 1, 10);
    const line = JSON.stringify({
      id: 'abc12345', variant: 'standard', speed: 'bullet', status: 'resign', winner: 'white',
      lastMoveAt: Date.UTC(2026, 1, 20),
      players: { white: { user: { name: 'villain' }, rating: 2000 }, black: { user: { name: 'other' }, rating: 2000 } },
      pgn: pgnOf({ white: 'villain', black: 'other', result: '1-0', tc: '60+0', date: '2026.02.20', moves: ['e4', 'e5'] }),
    });
    const calls = stubFetch([['lichess.org/api/games/user/', line]]);
    expect(await fetchOpponent(opp.id)).toBe(1);
    expect(calls[0]).toContain('since=' + Date.UTC(2026, 1, 10));
    expect(calls[0]).toContain('max=' + FETCH_MAX);
  });

  it('asks for the archive again only when told to explicitly', async () => {
    const opp = addOpponent('lichess', 'villain', 'bullet');
    opp.readAt = Date.UTC(2026, 1, 10);
    const calls = stubFetch([['lichess.org/api/games/user/', '']]);
    await fetchOpponent(opp.id, { since: 0 });
    expect(calls[0]).not.toContain('since=');
  });

  it('stores only the chosen format, so the cap is spent on the games you will face', async () => {
    const opp = addOpponent('chesscom', 'villain', 'blitz');
    const cc = (pgn, at, cls) => ({
      pgn, rules: 'chess', time_class: cls, end_time: at / 1000, url: 'u',
      white: { username: 'villain', rating: 2000, result: 'win' },
      black: { username: 'other', rating: 2000, result: 'resigned' },
    });
    const blitz = pgnOf({ white: 'villain', black: 'other', result: '1-0', tc: '180', date: '2026.02.20', moves: ['e4', 'e5'] });
    const bullet = pgnOf({ white: 'villain', black: 'other', result: '1-0', tc: '60', date: '2026.02.21', moves: ['d4', 'd5'] });
    stubFetch([
      ['/games/archives', { archives: ['https://api.chess.com/pub/player/villain/games/2026/02'] }],
      ['/2026/02', { games: [cc(blitz, Date.UTC(2026, 1, 20), 'blitz'), cc(bullet, Date.UTC(2026, 1, 21), 'bullet')] }],
    ]);
    expect(await fetchOpponent(opp.id)).toBe(1);
    expect(mem.store('oppgames').size).toBe(1);
    expect([...mem.store('oppgames').values()][0].headers.TimeControl).toBe('180');
  });
});

/* ===================================================================================
 * The cap
 * =================================================================================== */

describe('the cap', () => {
  const row = (n, t) => ({ key: 'o:' + n, oppId: 'o', endTime: t });

  it('evicts oldest first', () => {
    const rows = [row(1, 300), row(2, 100), row(3, 200)];
    const { keep, drop } = evictOldest(rows, 2);
    expect(drop.map(r => r.key)).toEqual(['o:2']);
    expect(keep.map(r => r.key)).toEqual(['o:3', 'o:1']);   // oldest first among the kept
  });

  it('drops nothing under the cap and does not mutate what it was given', () => {
    const rows = [row(1, 300), row(2, 100)];
    const { keep, drop } = evictOldest(rows, 5);
    expect(drop).toEqual([]);
    expect(keep).toHaveLength(2);
    expect(rows[0].key).toBe('o:1');
  });

  it('one person cannot fill the disk: the fetch evicts from both stores', async () => {
    const opp = addOpponent('chesscom', 'villain', 'blitz');
    for (let i = 0; i < OPP_GAME_CAP; i++) {
      const key = opp.id + ':old' + i;
      mem.store('oppgames').set(key, { key, oppId: opp.id, pgn: '', headers: {}, endTime: 1000 + i });
      mem.store('oppevals').set(key, { key, oppId: opp.id, build: PASS_BUILD });
    }
    const fresh = pgnOf({ white: 'villain', black: 'other', result: '1-0', date: '2026.02.20', moves: ['e4', 'e5'] });
    stubFetch([
      ['/games/archives', { archives: ['https://api.chess.com/pub/player/villain/games/2026/02'] }],
      ['/2026/02', { games: [{
        pgn: fresh, rules: 'chess', time_class: 'blitz', end_time: Date.UTC(2026, 1, 20) / 1000, url: 'u',
        white: { username: 'villain', rating: 2000, result: 'win' },
        black: { username: 'other', rating: 2000, result: 'resigned' },
      }] }],
    ]);
    await fetchOpponent(opp.id);
    expect(mem.store('oppgames').size).toBe(OPP_GAME_CAP);
    expect(mem.store('oppgames').has(opp.id + ':old0')).toBe(false);   // the oldest went
    expect(mem.store('oppevals').has(opp.id + ':old0')).toBe(false);   // and so did what was found in it
    expect(mem.store('oppgames').has(opp.id + ':old1')).toBe(true);
    expect(opp.count).toBe(OPP_GAME_CAP);
  });
});

/* ===================================================================================
 * The crossing — the room's reason to exist
 * =================================================================================== */

describe('the crossing', () => {
  let games;
  beforeEach(() => { games = theirArchive(); myWhiteBook(); });

  it('walks the two tries and reports the deepest node they share', () => {
    const c = crossing(games, bookOf('w'), { oppKey: THEM, color: 'w' });
    expect(c.color).toBe('w');
    expect(c.theirColor).toBe('b');
    expect(c.games).toBe(28);
    expect(c.deepest).not.toBeNull();
    expect(c.deepest.path).toEqual([...RUY]);        // six plies: as deep as both have games
    expect(c.deepest.n).toBe(3);
    expect(c.deepest.plies).toBe(6);
  });

  it('reports the worst line by their score, not by how often it came up', () => {
    const c = crossing(games, bookOf('w'), { oppKey: THEM, color: 'w' });
    const worst = c.shared[0];
    expect(worst.path).toEqual([...RUY]);
    expect(Math.round(worst.score)).toBe(100);
    expect(worst.n).toBe(3);
    // The line they played twenty times is in the report, and it is second.
    const sicilian = c.shared.find(r => r.path.join(' ') === 'e4 c5 Nf3 d6');
    expect(sicilian).toBeTruthy();
    expect(sicilian.n).toBe(20);
    expect(Math.round(sicilian.score)).toBe(50);
    expect(c.shared.indexOf(sicilian)).toBeGreaterThan(0);
    // Ranked by count it would lead; that is exactly the bug this pins.
    expect(sicilian.n).toBeGreaterThan(worst.n);
  });

  it('turns a line it has no answer to into an Add one row rather than a silence', () => {
    const c = crossing(games, bookOf('w'), { oppKey: THEM, color: 'w' });
    const gap = c.gaps.find(r => r.path.join(' ') === 'e4 d5');
    expect(gap).toBeTruthy();                       // the one finding a self-report cannot make
    expect(gap.gap).toBe(true);
    expect(gap.n).toBe(4);
    expect(gap.walk).toEqual({ room: 'learn', arg: 'openings' });
    expect(c.rows).toContain(gap);                  // it reaches the table
    expect(c.shared).not.toContain(gap);            // and is not filed as a line you have
    // Gaps lead with how often they play it: no answer to something they play often.
    expect(c.gaps[0]).toBe(gap);
  });

  it('keeps CROSS_MIN_GAMES a real floor, in both directions', () => {
    const c = crossing(games, bookOf('w'), { oppKey: THEM, color: 'w' });
    expect(CROSS_MIN_GAMES).toBe(2);
    // They played 1...g6 once. One game is not a finding, so nothing is written.
    expect(c.rows.some(r => r.path.join(' ') === 'e4 g6')).toBe(false);
    expect(c.rows.every(r => r.n >= CROSS_MIN_GAMES)).toBe(true);
    expect(c.deepest.n).toBeGreaterThanOrEqual(CROSS_MIN_GAMES);

    // …and it is the floor doing it, not an accident of the archive.
    const low = crossing(games, bookOf('w'), { oppKey: THEM, color: 'w', minGames: 1 });
    expect(low.gaps.some(r => r.path.join(' ') === 'e4 g6')).toBe(true);
    expect(low.deepest.plies).toBe(7);              // the single Ba4 game is now deep enough
  });

  it('does not let a below-floor branch swallow the row above it', () => {
    // Exactly one of the three Ruy games goes on to 4.Ba4, which is under the floor.
    // Walking into it and finding nothing there must not lose the six-ply row.
    const c = crossing(games, bookOf('w'), { oppKey: THEM, color: 'w' });
    expect(c.shared.some(r => r.path.join(' ') === RUY.join(' '))).toBe(true);
  });

  it('ends the branch where a move of your book has never come up against them', () => {
    addToBook('b', ['e4', 'c5', 'Nf3', 'd6'], 'Najdorf-ish');
    const theirs = Array.from({ length: 4 }, () =>
      synth({ white: THEM, black: 'hero', result: '1-0', moves: ['e4', 'c5', 'Nf3', 'Nc6'] }));
    const c = crossing(theirs, bookOf('b'), { oppKey: THEM, color: 'b' });
    expect(c.theirColor).toBe('w');
    expect(c.games).toBe(4);
    // Your 3...d6 is not what they have faced; the crossing stops at their 3.Nf3.
    expect(c.deepest.path).toEqual(['e4', 'c5', 'Nf3']);
    expect(c.shared[0].path).toEqual(['e4', 'c5', 'Nf3']);
    expect(Math.round(c.shared[0].score)).toBe(100);
  });

  it('is an empty report, never a throw, with no book or no games', () => {
    const empty = crossing([], bookOf('w'), { oppKey: THEM, color: 'w' });
    expect(empty.games).toBe(0);
    expect(empty.deepest).toBeNull();
    expect(empty.rows).toEqual([]);
    emptyTheBook();
    const noBook = crossing(games, bookOf('w'), { oppKey: THEM, color: 'w' });
    expect(noBook.deepest).toBeNull();
    expect(noBook.rows).toEqual([]);
    expect(crossing(games, null, { oppKey: THEM, color: 'w' }).rows).toEqual([]);
  });

  it('respects CROSS_MIN_PLY: one move is a move, not a line', () => {
    expect(CROSS_MIN_PLY).toBe(2);
    addToBook('w', ['d4'], 'Queen’s pawn');
    const theirs = Array.from({ length: 5 }, () =>
      synth({ white: 'hero', black: THEM, result: '1-0', moves: ['d4', 'd5'] }));
    const c = crossing(theirs, bookOf('w'), { oppKey: THEM, color: 'w' });
    expect(c.shared).toEqual([]);          // "after 1.d4 they score 20%" is the archive with a move in front
    expect(c.deepest.path).toEqual(['d4']);
  });

  it('tallies their trie from their side', () => {
    const t = oppTrie(games, THEM, 'b');
    expect(t.n).toBe(28);
    expect(t.w).toBe(13);                 // three Ruys and ten Sicilians
    expect(t.l).toBe(14);
    expect(t.d).toBe(1);
    expect(Math.round(scorePct(t))).toBe(48);
    const e4 = t.children.get('e4');
    expect(e4.n).toBe(28);
    expect(e4.children.get('e5').n).toBe(3);
    expect(e4.children.get('c5').n).toBe(20);
    // Their games as White are not in a trie of their games as Black.
    expect(oppTrie(games, THEM, 'w').n).toBe(0);
    expect(t.children.get('e4').gis).toHaveLength(28);
    // Bounded: the trie is no deeper than it was asked for.
    const shallow = oppTrie(games, THEM, 'b', 2);
    expect(shallow.children.get('e4').children.get('e5').children.size).toBe(0);
    expect(CROSS_MAX_PLY).toBe(24);
    expect(CROSS_ROWS).toBe(6);
  });
});

/* ===================================================================================
 * The briefing
 * =================================================================================== */

describe('the briefing', () => {
  let opp, games, rep;
  beforeEach(() => {
    myWhiteBook();
    opp = addOpponent('chesscom', THEM, 'blitz');
    games = theirArchive();
    rep = buildReport(opp, games);
  });

  it('says the crossing before the record', () => {
    const keys = briefingParts(rep).map(p => p.key);
    expect(keys[0]).toBe('read');
    const firstCross = keys.findIndex(k => k.startsWith('cross'));
    const record = keys.indexOf('record');
    expect(firstCross).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(-1);
    expect(firstCross).toBeLessThan(record);
    // …and the order below it is fixed too.
    expect(keys.indexOf('record')).toBeLessThan(keys.findIndex(k => k.startsWith('opening')));
  });

  it('reads the crossing as speech, not as SAN letters', () => {
    const parts = briefingParts(rep);
    const cross = parts.find(p => p.key === 'cross-w');
    expect(cross.text).toContain('knight f3');    // "Nf3" spoken, not spelled out letter by letter
    expect(cross.text).not.toContain('Nf3');
    expect(cross.text).toContain('3 of their games');
    const gap = parts.find(p => p.key === 'cross-gap-w');
    expect(gap.text).toContain('no answer to');
    expect(gap.text).toContain('Add one in Learn.');
  });

  it('is the parts in order, and the record counts what it counted', () => {
    const parts = briefingParts(rep);
    expect(briefing(rep)).toEqual(parts.map(p => p.text));
    const record = parts.find(p => p.key === 'record').text;
    expect(record).toContain('13 wins');
    expect(record).toContain('14 losses');
    expect(record).toContain('1 draw');
  });

  it('is one sentence, not an empty report, when there is nothing to read', () => {
    const parts = briefingParts(buildReport(opp, []));
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('no blitz games');
    expect(parts[0].text).toContain('check the handle');
  });

  it('says the two never meet rather than printing a line nobody played', () => {
    S.book = new Map();
    addToBook('w', ['d4', 'd5', 'c4'], 'Queen’s Gambit');
    const only = buildReport(opp, games);
    const cross = briefingParts(only).find(p => p.key === 'cross-w');
    expect(cross.text).toContain('never meet');
    expect(only.cross.w.deepest).toBeNull();
  });

  it('builds its report off real games of both dialects', () => {
    const hikaru = addOpponent('chesscom', 'Hikaru', 'blitz');
    const blitz = corpus(CHESSCOM).filter(g => g.headers.TimeControl === '180');
    const r = buildReport(hikaru, blitz);
    expect(r.oppKey).toBe(playerKey('Hikaru'));
    expect(r.name).toBe('Hikaru');                  // spelled as their own PGNs spell it
    expect(r.stats.counted).toBe(12);
    expect(briefing(r)[0]).toContain('12 blitz games');
    expect(r.since).toBeGreaterThan(0);

    const li = addOpponent('lichess', 'HrishikeshPs', 'bullet');
    const lg = corpus(LICHESS).filter(g => playerKey(g.headers.White) === 'hrishikeshps' || playerKey(g.headers.Black) === 'hrishikeshps');
    const lr = buildReport(li, lg);
    expect(lr.stats.counted).toBe(6);
    expect(briefing(lr)[0]).toContain('Lichess');
  });

  it('writes a line the way a person reads it, and says it the way a person says it', () => {
    expect(lineText(['e4', 'c5', 'Nf3'])).toBe('1. e4 c5 2. Nf3');
    expect(lineText([])).toBe('');
    expect(lineSpeech(['e4', 'e5'])).toBe('pawn e4, pawn e5');
    expect(lineSpeech(['e4', 'e5', 'Nf3'])).toContain('knight f3');
    // A path that is not a legal game falls back to the SAN rather than throwing.
    expect(lineSpeech(['Qz9', 'Kx1'])).toBe('Qz9 Kx1');
    expect(lineSpeech([])).toBe('');
  });
});

/* ===================================================================================
 * The engine pass
 * =================================================================================== */

describe('the engine pass', () => {
  const OPP = 'chesscom:villain';
  let games, cross;

  beforeEach(() => {
    myWhiteBook();
    games = [
      synth({ white: 'hero', black: THEM, result: '1-0', moves: ['d4', 'd5', 'c4', 'e6'] }),
      synth({ white: 'hero', black: THEM, result: '0-1', moves: ['c4', 'e5', 'Nc3', 'Nf6'] }),
      ...asBlack([...RUY], '0-1', 2),
    ];
    games.forEach((g, i) => { g.oppKey = OPP + ':g' + i; });
    // The pass takes the report's pair of crossings, which is what the room hands it.
    cross = buildReport(addOpponent('chesscom', THEM, 'blitz'), games).cross;
  });

  it('puts the games from the crossing first and every other game once', () => {
    const order = passOrder(games, cross);
    expect(order.slice(0, 2).sort()).toEqual([2, 3]);       // the two Ruy games
    expect(order).toHaveLength(games.length);
    expect(new Set(order).size).toBe(games.length);
    // Hand-built, so the rule is visible without the crossing: rows first, in row order.
    expect(passOrder(games, { w: { rows: [{ gis: [3, 1] }] }, b: { rows: [{ gis: [1] }] } }))
      .toEqual([3, 1, 0, 2]);
    expect(passOrder(games, null)).toEqual([0, 1, 2, 3]);
  });

  it('evaluates in that order and stores White-positive', async () => {
    const order = passOrder(games, cross);
    const found = await startPass(OPP, games, cross);
    const total = games.reduce((n, g) => n + g.fens.length, 0);
    expect(found).toBe(total);
    expect(eng.calls).toHaveLength(total);
    expect(eng.calls[0].fen).toBe(games[order[0]].fens[0]);
    expect(eng.calls[0].opts.depth).toBe(PASS_DEPTH);
    expect(eng.calls[0].opts.movetimeMs).toBe(PASS_MOVETIME);
    expect(eng.calls[0].opts.kind).toBe('scan');
    // The provider answers from the side to move; the store is White-positive.
    const a = games[0].analysis;
    expect(a.build).toBe(PASS_BUILD);
    expect(a.depth).toBe(PASS_DEPTH);
    expect(a.evals[0]).toEqual({ cp: 100 });      // White to move
    expect(a.evals[1]).toEqual({ cp: -100 });     // Black to move, same raw score
    expect(a.best[0]).toBe('e2e4');
    expect(a.done).toBe(games[0].fens.length);
    expect(passState().on).toBe(false);
  });

  it('is stoppable and resumes where it stopped', async () => {
    eng.onCall = n => { if (n === 3) stopPass(); };
    const first = await startPass(OPP, games, cross);
    expect(first).toBe(3);
    expect(passState().on).toBe(false);
    expect(eng.calls).toHaveLength(3);
    // What was committed is on the disk, which is what makes the resume a resume.
    const stored = [...mem.store('oppevals').values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].build).toBe(PASS_BUILD);

    eng.onCall = null;
    const total = games.reduce((n, g) => n + g.fens.length, 0);
    const second = await startPass(OPP, games, cross);
    expect(second).toBe(total - 3);               // the three already found are not asked again
    expect(eng.calls).toHaveLength(total);
    expect(games.every(g => g.analysis.done === g.fens.length)).toBe(true);
  });

  it('will not run twice at once', async () => {
    let reentered = null;
    eng.onCall = async n => { if (n === 1) reentered = await startPass(OPP, games, cross); };
    await startPass(OPP, games, cross);
    expect(reentered).toBe(0);
  });

  it('says where it is while it runs', async () => {
    const seen = [];
    eng.onCall = n => { if (n === 1) seen.push(passState()); };
    await startPass(OPP, games, cross);
    expect(seen[0].on).toBe(true);
    expect(seen[0].id).toBe(OPP);
    expect(seen[0].games).toBe(games.length);
    expect(seen[0].total).toBe(games.reduce((n, g) => n + g.fens.length, 0));
  });
});

/* ===================================================================================
 * The stored evaluations
 * =================================================================================== */

describe('the oppevals row', () => {
  const OPP = 'chesscom:villain';
  let game;
  beforeEach(async () => {
    game = synth({ white: 'hero', black: THEM, result: '1-0', moves: ['d4', 'd5', 'c4', 'e6'] });
    game.oppKey = OPP + ':g0';
    await startPass(OPP, [game], null);
  });

  it('round-trips through a fresh copy of the same game', () => {
    const row = passRow(OPP, game);
    expect(row.key).toBe(game.oppKey);
    expect(row.build).toBe(PASS_BUILD);
    expect(row.depth).toBe(PASS_DEPTH);
    expect(row.plies).toBe(game.fens.length);
    expect(row.bytes).toBeGreaterThan(0);

    const fresh = parseGame(game.pgn);
    expect(applyPassRow(fresh, row)).toBe(true);
    expect(fresh.analysis.done).toBe(game.fens.length);
    expect(fresh.analysis.evals).toEqual(game.analysis.evals);
    expect(fresh.analysis.best[0]).toBe('e2e4');
    expect(fresh.analysis.pv[0]).toEqual(['e2e4', 'e7e5']);
  });

  it('has nothing to write when nothing was found', () => {
    const cold = parseGame(game.pgn);
    cold.oppKey = OPP + ':cold';
    expect(passRow(OPP, cold)).toBeNull();
  });

  it('refuses a row from another build, depth or game', () => {
    const row = passRow(OPP, game);
    const fresh = () => { const g = parseGame(game.pgn); g.oppKey = game.oppKey; return g; };

    const a = fresh();
    expect(applyPassRow(a, { ...row, build: 'sf17.1-lite' })).toBe(false);
    expect(a.analysis).toBeUndefined();            // and nothing of it was taken on the way

    const b = fresh();
    expect(applyPassRow(b, { ...row, depth: PASS_DEPTH + 4 })).toBe(false);
    expect(b.analysis).toBeUndefined();

    // The same key over a different game: the ply count is the only thing that can say so.
    const c = fresh();
    expect(applyPassRow(c, { ...row, plies: row.plies + 2 })).toBe(false);
    expect(c.analysis).toBeUndefined();

    expect(applyPassRow(null, row)).toBe(false);
    expect(applyPassRow(fresh(), null)).toBe(false);
  });

  it('comes back with the games when they are read off the disk', async () => {
    const opp = addOpponent('chesscom', THEM, 'blitz');
    const stored = oppGameRow(opp.id, { pgn: game.pgn, endTime: Date.UTC(2026, 1, 1) });
    mem.store('oppgames').set(stored.key, stored);
    const row = passRow(opp.id, { ...game, oppKey: stored.key });
    mem.store('oppevals').set(row.key, row);

    const back = await oppGames(opp.id);
    expect(back).toHaveLength(1);
    expect(back[0].analysis.build).toBe(PASS_BUILD);
    expect(back[0].analysis.done).toBe(game.fens.length);
    // The report reads it: the engine pass is what the pass summary counts.
    const rep = buildReport(opp, back);
    expect(rep.pass.games).toBe(1);
  });
});

/* ===================================================================================
 * What the room says
 * =================================================================================== */

describe('the row sentence', () => {
  it('says what it read, or that it has read nothing', () => {
    const opp = addOpponent('chesscom', 'Hikaru', 'blitz');
    expect(rowSentence(opp)).toContain('Not read yet');

    opp.readAt = Date.UTC(2026, 2, 1);
    opp.count = 142;
    opp.since = Date.UTC(2026, 2, 1);
    const line = rowSentence(opp);
    expect(line).toContain('142 blitz games');
    expect(line).toContain('since');

    opp.count = 0;
    expect(rowSentence(opp)).toContain('No blitz games');
    expect(rowSentence(opp)).toContain('Chess.com');
  });

  it('boots without a document', () => {
    expect(() => boot()).not.toThrow();
    expect(FORMATS).toEqual(['bullet', 'blitz', 'rapid', 'classical', 'daily']);
  });
});
