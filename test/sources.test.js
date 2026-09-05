import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { S } from '../src/state.js';
import { headersOf } from '../src/pgn.js';
import {
  normaliseChesscom, normaliseLichessLine, withLichessHeaders, fetchPGNFromURL,
  lookupChesscom, fetchLichess, gameEndMs, newestImported, checkNewGames, resetTracker,
  TRACKER_GAP_MS, TRACKER_MAX,
} from '../src/sources.js';

/* ----- Fixtures, inline: small on purpose, so the claim each pins is visible ----- */

const CC_PGN = '[Event "Live Chess"]\n[Site "Chess.com"]\n[White "hero"]\n[Black "villain"]\n[Result "1-0"]\n[UTCDate "2026.09.01"]\n[UTCTime "10:00:00"]\n[EndDate "2026.09.01"]\n[EndTime "10:05:00"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';

const ccGame = (over = {}) => ({
  url: 'https://www.chess.com/game/live/1', pgn: CC_PGN, time_class: 'blitz', rules: 'chess', end_time: 1756720000,
  white: { username: 'Hero', rating: 1500, result: 'win' }, black: { username: 'Villain', rating: 1480, result: 'checkmated' },
  ...over,
});

const LI_PGN = '[Event "Rated Blitz game"]\n[Site "https://lichess.org/abc12345"]\n[White "hero"]\n[Black "villain"]\n[Result "0-1"]\n[UTCDate "2026.09.01"]\n[UTCTime "23:58:00"]\n\n1. e4 e5 2. Nf3 Nc6 0-1';

const liLine = (over = {}) => ({
  id: 'abc12345', rated: true, variant: 'standard', speed: 'blitz', perf: 'blitz', status: 'resign', winner: 'black',
  // Started 23:58 UTC on the 1st, finished 00:03 on the 2nd: the finish is on another day.
  createdAt: Date.UTC(2026, 8, 1, 23, 58, 0), lastMoveAt: Date.UTC(2026, 8, 2, 0, 3, 0),
  players: { white: { user: { name: 'hero', id: 'hero' }, rating: 1800 }, black: { user: { name: 'villain', id: 'villain' }, rating: 1790 } },
  opening: { eco: 'C44', name: "King's Knight Opening", ply: 4 },
  pgn: LI_PGN,
  ...over,
});

/** A fetch stub: routes by substring of the URL. Unmatched → 404. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, opts) => {
    url = String(url);
    calls.push({ url, opts });
    for (const [needle, answer] of routes) {
      if (!url.includes(needle)) continue;
      const a = typeof answer === 'function' ? answer(url) : answer;
      if (a instanceof Error) throw a;
      const status = a.status || 200;
      const body = a.body;
      return {
        ok: status >= 200 && status < 300, status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        body: null,
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '', body: null };
  });
  return calls;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); resetTracker(); S.games = []; S.chesscomUser = ''; S.lichessUser = ''; });

/* ----- Chess.com ----- */

describe('normaliseChesscom', () => {
  it('scores the result from the looked-up user\'s side, whichever colour they had', () => {
    const asWhite = normaliseChesscom(ccGame(), 'hero');
    expect(asWhite.result).toBe('w');
    expect(asWhite.opponent).toBe('Villain');
    const asBlack = normaliseChesscom(ccGame(), 'villain');
    expect(asBlack.result).toBe('l');
    expect(asBlack.opponent).toBe('Hero');
    // The same game, a different reader: the row is about the reader, not about White.
    expect(asWhite.pgn).toBe(asBlack.pgn);
  });
  it('reads a draw off either side and names the reason from the loser\'s code', () => {
    const drawn = normaliseChesscom(ccGame({ white: { username: 'Hero', result: 'repetition' }, black: { username: 'Villain', result: 'repetition' } }), 'hero');
    expect(drawn.result).toBe('d');
    expect(drawn.reason).toBe('repetition');
    const lost = normaliseChesscom(ccGame({ white: { username: 'Hero', result: 'timeout' }, black: { username: 'Villain', result: 'win' } }), 'hero');
    expect(lost.result).toBe('l');
    expect(lost.reason).toBe('time');
  });
  it('drops variants and games without a PGN rather than offering rows that will not parse', () => {
    expect(normaliseChesscom(ccGame({ rules: 'chess960' }), 'hero')).toBeNull();
    expect(normaliseChesscom(ccGame({ rules: 'bughouse' }), 'hero')).toBeNull();
    expect(normaliseChesscom(ccGame({ pgn: '' }), 'hero')).toBeNull();
    expect(normaliseChesscom(null, 'hero')).toBeNull();
  });
  it('carries the shape the browser and the tracker share, with endTime in ms', () => {
    const r = normaliseChesscom(ccGame(), 'hero');
    expect(r).toMatchObject({ site: 'chesscom', white: 'Hero', black: 'Villain', whiteRating: 1500, blackRating: 1480, timeClass: 'blitz', reason: 'checkmate', url: 'https://www.chess.com/game/live/1' });
    expect(r.endTime).toBe(1756720000 * 1000);
  });
});

describe('lookupChesscom', () => {
  it('walks months newest first and stops once it has enough', async () => {
    const month = (n, k) => ({ body: { games: Array.from({ length: k }, (_, i) => ccGame({ end_time: n * 1000 + i })) } });
    const calls = stubFetch([
      ['/games/archives', { body: { archives: ['https://api.chess.com/pub/player/hero/games/2026/07', 'https://api.chess.com/pub/player/hero/games/2026/08', 'https://api.chess.com/pub/player/hero/games/2026/09'] } }],
      ['/2026/09', month(9, 3)], ['/2026/08', month(8, 3)], ['/2026/07', month(7, 3)],
    ]);
    const rows = await lookupChesscom('Hero', { max: 5 });
    expect(rows.length).toBe(5);
    expect(rows[0].endTime).toBeGreaterThan(rows[4].endTime);
    const months = calls.map(c => c.url).filter(u => /\/\d{4}\/\d{2}$/.test(u));
    expect(months).toEqual(['https://api.chess.com/pub/player/hero/games/2026/09', 'https://api.chess.com/pub/player/hero/games/2026/08']);
  });
  it('says "no such player" for a 404 on the archive index', async () => {
    stubFetch([['/games/archives', { status: 404 }]]);
    await expect(lookupChesscom('nobody')).rejects.toThrow(/No Chess.com player called nobody/);
  });
});

/* ----- Lichess ----- */

describe('normaliseLichessLine', () => {
  it('puts the finish into EndDate/EndTime in UTC, and the opening name into Opening', () => {
    const r = normaliseLichessLine(liLine(), 'hero');
    const h = headersOf(r.pgn);
    expect(h.EndDate).toBe('2026.09.02');    // the game crossed midnight UTC: the finish, not the start
    expect(h.EndTime).toBe('00:03:00');
    expect(h.Opening).toBe("King's Knight Opening");
    expect(h.UTCDate).toBe('2026.09.01');    // the start is left alone
    // Injected into the header block, above the movetext, so the parser still sees one game.
    expect(r.pgn.indexOf('[EndDate')).toBeLessThan(r.pgn.indexOf('\n\n1. e4'));
  });
  it('leaves headers already present alone', () => {
    const pgn = '[Event "x"]\n[EndDate "2000.01.01"]\n[EndTime "01:02:03"]\n[Opening "Mine"]\n\n1. e4 *';
    expect(withLichessHeaders(pgn, Date.UTC(2026, 8, 2), 'Theirs')).toBe(pgn);
  });
  it('scores from the user\'s side and maps the vocabulary', () => {
    const r = normaliseLichessLine(liLine(), 'hero');
    expect(r).toMatchObject({ site: 'lichess', result: 'l', reason: 'resignation', timeClass: 'blitz', opponent: 'villain', whiteRating: 1800, blackRating: 1790, endTime: Date.UTC(2026, 8, 2, 0, 3, 0), url: 'https://lichess.org/abc12345' });
    expect(normaliseLichessLine(liLine(), 'villain').result).toBe('w');
    expect(normaliseLichessLine(liLine({ winner: undefined, status: 'draw' }), 'hero').result).toBe('d');
    expect(normaliseLichessLine(liLine({ speed: 'correspondence' }), 'hero').timeClass).toBe('daily');
  });
  it('drops aborted games and variants', () => {
    expect(normaliseLichessLine(liLine({ status: 'aborted' }), 'hero')).toBeNull();
    expect(normaliseLichessLine(liLine({ variant: 'atomic' }), 'hero')).toBeNull();
    expect(normaliseLichessLine({ id: 'x' }, 'hero')).toBeNull();
  });
});

describe('fetchLichess', () => {
  it('asks for NDJSON with the PGN inside, and reads it line by line', async () => {
    const calls = stubFetch([['lichess.org/api/games/user/hero', { body: JSON.stringify(liLine()) + '\n' + JSON.stringify(liLine({ id: 'def', lastMoveAt: Date.UTC(2026, 8, 2, 0, 3, 10) })) + '\nnot json\n' }]]);
    const rows = await fetchLichess('hero', { max: 50, since: 1000 });
    expect(rows.length).toBe(2);
    expect(rows[0].url).toBe('https://lichess.org/def');   // newest first
    const req = calls[0];
    expect(req.opts.headers.Accept).toBe('application/x-ndjson');
    const u = new URL(req.url);
    expect(u.searchParams.get('pgnInJson')).toBe('true');
    expect(u.searchParams.get('max')).toBe('50');
    expect(u.searchParams.get('since')).toBe('1000');
    expect(u.searchParams.get('perfType')).toContain('correspondence');
  });
  it('tells a missing user and a rate limit apart', async () => {
    stubFetch([['lichess.org', { status: 404 }]]);
    await expect(fetchLichess('ghost')).rejects.toThrow(/No Lichess player called ghost/);
    stubFetch([['lichess.org', { status: 429 }]]);
    await expect(fetchLichess('hero')).rejects.toThrow(/rate-limiting/);
  });
});

/* ----- URL ----- */

describe('fetchPGNFromURL', () => {
  it('returns the text on success', async () => {
    stubFetch([['example.org', { body: CC_PGN }]]);
    const r = await fetchPGNFromURL('https://example.org/games.pgn');
    expect(r.ok).toBe(true);
    expect(r.text).toBe(CC_PGN);
  });
  it('names CORS on failure, because that is what decides — and offers the file door', async () => {
    stubFetch([['example.org', new TypeError('Failed to fetch')]]);
    const r = await fetchPGNFromURL('https://example.org/games.pgn');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/example\.org/);
    expect(r.error).toMatch(/CORS headers decide whether a browser may fetch/);
    expect(r.error).toMatch(/Paste tab/);
  });
  it('treats an HTTP error the same way', async () => {
    stubFetch([['example.org', { status: 403, body: '' }]]);
    const r = await fetchPGNFromURL('https://example.org/x.pgn');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 403/);
  });
});

/* ----- The tracker ----- */

const game = (source, headers) => ({ id: Math.random().toString(36), source, headers, pgn: '', moves: [], fens: [] });

describe('the watermark', () => {
  it('reads the finish off EndDate/EndTime, falls back to the start, and refuses a date alone', () => {
    expect(gameEndMs(game('chesscom', { EndDate: '2026.09.01', EndTime: '10:05:00' }))).toBe(Date.UTC(2026, 8, 1, 10, 5, 0));
    expect(gameEndMs(game('lichess', { UTCDate: '2026.09.01', UTCTime: '09:00:00', Date: '2026.09.01' }))).toBe(Date.UTC(2026, 8, 1, 9, 0, 0));
    expect(gameEndMs(game('paste', { Date: '2026.09.01' }))).toBeNull();
    expect(gameEndMs(game('paste', {}))).toBeNull();
  });
  it('is the newest imported game from that site only', () => {
    S.games = [
      game('chesscom', { EndDate: '2026.08.30', EndTime: '10:00:00' }),
      game('chesscom', { EndDate: '2026.09.01', EndTime: '10:05:00' }),
      game('lichess', { EndDate: '2026.09.03', EndTime: '10:00:00' }),
      game('paste', { EndDate: '2026.09.04', EndTime: '10:00:00' }),
    ];
    expect(newestImported('chesscom')).toBe(Date.UTC(2026, 8, 1, 10, 5, 0));
    expect(newestImported('lichess')).toBe(Date.UTC(2026, 8, 3, 10, 0, 0));
    expect(newestImported('url')).toBe(0);
  });
});

describe('checkNewGames', () => {
  const since = Date.UTC(2026, 8, 1, 10, 5, 0);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
    S.games = [game('chesscom', { EndDate: '2026.09.01', EndTime: '10:05:00' }), game('lichess', { EndDate: '2026.09.01', EndTime: '10:05:00' })];
  });

  it('is null with no saved username, and null with a username but nothing imported from that site', async () => {
    const calls = stubFetch([]);
    expect(await checkNewGames('chesscom')).toBeNull();
    S.chesscomUser = 'hero';
    S.games = [];
    expect(await checkNewGames('chesscom')).toBeNull();
    expect(calls.length).toBe(0);   // never a request it cannot make sense of
  });

  it('asks Chess.com for the current month only and counts what is newer than the watermark', async () => {
    S.chesscomUser = 'hero';
    const calls = stubFetch([['/games/2026/09', { body: { games: [
      ccGame({ end_time: since / 1000 - 60 }),        // before the watermark: already here
      ccGame({ end_time: since / 1000 }),             // at it: already here
      ccGame({ end_time: since / 1000 + 3600 }),
      ccGame({ end_time: since / 1000 + 7200, rules: 'chess960' }),   // a variant is not news
      ccGame({ end_time: since / 1000 + 9000 }),
    ] } }]]);
    const r = await checkNewGames('chesscom');
    expect(r).toEqual({ count: 2, since });
    expect(calls.map(c => c.url)).toEqual(['https://api.chess.com/pub/player/hero/games/2026/09']);
  });

  it('asks Lichess with since= just past the watermark', async () => {
    S.lichessUser = 'hero';
    const calls = stubFetch([['lichess.org', { body: JSON.stringify(liLine({ lastMoveAt: since + 5000 })) + '\n' }]]);
    const r = await checkNewGames('lichess');
    expect(r).toEqual({ count: 1, since });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('since')).toBe(String(since + 1));
    expect(u.searchParams.get('max')).toBe(String(TRACKER_MAX));
  });

  it('asks a site at most once per thirty minutes, answering from the last check in between', async () => {
    S.chesscomUser = 'hero';
    const calls = stubFetch([['/games/2026/09', { body: { games: [ccGame({ end_time: since / 1000 + 3600 })] } }]]);
    expect(await checkNewGames('chesscom')).toEqual({ count: 1, since });
    vi.advanceTimersByTime(TRACKER_GAP_MS - 1000);
    expect(await checkNewGames('chesscom')).toEqual({ count: 1, since });
    expect(calls.length).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(await checkNewGames('chesscom')).toEqual({ count: 1, since });
    expect(calls.length).toBe(2);
  });

  it('holds the floor after a refusal too — a rate-limiting site is not asked again in a minute', async () => {
    S.lichessUser = 'hero';
    const calls = stubFetch([['lichess.org', { status: 429 }]]);
    expect(await checkNewGames('lichess')).toBeNull();
    vi.advanceTimersByTime(60 * 1000);
    expect(await checkNewGames('lichess')).toBeNull();
    expect(calls.length).toBe(1);
  });

  it('re-counts a cached answer against a watermark that has since moved', async () => {
    S.chesscomUser = 'hero';
    stubFetch([['/games/2026/09', { body: { games: [ccGame({ end_time: since / 1000 + 3600 }), ccGame({ end_time: since / 1000 + 7200 })] } }]]);
    expect((await checkNewGames('chesscom')).count).toBe(2);
    // The reader imported the first of the two by another door.
    S.games.push(game('chesscom', { EndDate: '2026.09.01', EndTime: '11:05:00' }));
    const r = await checkNewGames('chesscom');
    expect(r.count).toBe(1);
    expect(r.since).toBe(since + 3600 * 1000);
  });
});
