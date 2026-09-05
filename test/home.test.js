/*
 * Home: the wording and the week, not the mark-up. Node environment — nothing here
 * touches `document`, and neither does anything in home.js above its painters.
 *
 * The claims pinned are the ones a bug would falsify quietly: a watermark said as the
 * wrong day, a week counted over a queue that is still arriving, "0 new games" printed
 * as if it were news, a door pointing at a game that is not in the queue.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { S } from '../src/state.js';
import { loadGames } from '../src/pgn.js';
import { fmtDate } from '../src/dom.js';
import { resolveHero } from '../src/insights.js';
import {
  DAY_MS, RECENT_MAX,
  greeting, sinceWording, newsLine, newsParts, gameIndexOf, weekReport, recentGames,
} from '../src/home.js';

const WEEK_MS = 7 * DAY_MS;
const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const { games } = await loadGames(fixture('chesscom.pgn'));

/* A card, exactly the contract's shape in the fields Home reads. */
function card(over = {}) {
  return {
    key: (over.gameId || 'g1') + ':' + (over.ply ?? 10),
    gameId: 'g1', ply: 10,
    fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
    played: 'a1b1', previous: 'h1g1', answer: 'a1a2',
    before: { cp: 50 }, after: { cp: -250 },
    color: 'w', player: 'You', opponent: 'Them', date: '4 Mar 2025', site: 'chesscom',
    box: 1, due: 0, seen: 0, passes: 0, fails: 0, lastAt: 0, addedAt: 0,
    ...over,
  };
}

const NOW = Date.UTC(2025, 2, 12, 15, 0, 0);   // a Wednesday afternoon

beforeEach(() => {
  S.deck = new Map();
  S.tactics = new Map();
  S.book = new Map();
  S.games = [];
  S._restoring = false;
});
afterEach(() => { S._restoring = true; });      // back to the app's own initial state

/* ===== The greeting ===== */

describe('the greeting', () => {
  it('follows the clock', () => {
    const at = h => greeting(new Date(2025, 2, 12, h, 0, 0).getTime());
    expect(at(8)).toBe('Good morning');
    expect(at(13)).toBe('Good afternoon');
    expect(at(21)).toBe('Good evening');
  });
});

/* ===== "since Tuesday" ===== */

describe('sinceWording', () => {
  const at = (d, h = 12) => new Date(2025, 2, d, h, 0, 0).getTime();
  const now = at(12);                            // Wednesday 12 March 2025, noon

  it('says a day name for a timestamp two days back, inside this week', () => {
    expect(sinceWording(at(10), now)).toBe('Monday');
    expect(sinceWording(at(7), now)).toBe('Friday');   // five days: still a name
  });

  it('says yesterday and today rather than naming those days', () => {
    expect(sinceWording(at(11), now)).toBe('yesterday');
    expect(sinceWording(at(12, 2), now)).toBe('today');
  });

  it('counts whole days, not elapsed hours', () => {
    // 23 hours back is still yesterday; 25 hours back is not two days ago.
    expect(sinceWording(at(11, 13), at(12, 12))).toBe('yesterday');
    expect(sinceWording(at(11, 11), at(12, 12))).toBe('yesterday');
  });

  it('gives a date once the day name would be ambiguous', () => {
    // Seven days back wears today's own name — "since Wednesday" would read as today.
    const week = sinceWording(at(5), now);
    expect(week).not.toBe('Wednesday');
    expect(week).toBe(fmtDate(at(5)));
    const eleven = sinceWording(at(1), now);
    expect(eleven).toBe(fmtDate(at(1)));
    expect(eleven).toMatch(/2025/);
  });

  it('says nothing without a watermark', () => {
    expect(sinceWording(0, now)).toBe('');
  });
});

/* ===== The news line ===== */

describe('the news line', () => {
  const since = new Date(2025, 2, 10, 9, 0, 0).getTime();   // Monday
  const now = new Date(2025, 2, 12, 12, 0, 0).getTime();

  it('writes nothing at all for no new games', () => {
    // Not "0 new games since Monday": a line that reports the absence of news as news
    // is a line the reader learns to skip.
    expect(newsLine('chesscom', { count: 0, since }, now)).toBe(null);
    expect(newsParts('chesscom', { count: 0, since }, now)).toBe(null);
    expect(newsLine('chesscom', null, now)).toBe(null);
  });

  it('is singular for one', () => {
    expect(newsLine('chesscom', { count: 1, since }, now)).toBe('1 new game on Chess.com since Monday.');
  });

  it('is plural for many, and names the site', () => {
    expect(newsLine('lichess', { count: 7, since }, now)).toBe('7 new games on Lichess since Monday.');
  });

  it('keeps the count separable, so the painter can set it in the sans', () => {
    const p = newsParts('chesscom', { count: 7, since }, now);
    expect(p.count).toBe(7);
    expect(p.count + ' ' + p.tail).toBe(newsLine('chesscom', { count: 7, since }, now));
  });
});

/* ===== The week ===== */

describe('the week dashboard', () => {
  function stock() {
    S.deck.set('a', card({ key: 'a', lastAt: NOW - 2 * DAY_MS, addedAt: NOW - 2 * DAY_MS, due: NOW - DAY_MS }));
    S.deck.set('b', card({ key: 'b', lastAt: NOW - 30 * DAY_MS, addedAt: NOW - 30 * DAY_MS, due: NOW + DAY_MS }));
    S.tactics.set('c', card({ key: 'c', lastAt: 0, addedAt: NOW - DAY_MS, due: NOW - 60000 }));
  }

  it('refuses to paint while the library is still arriving', () => {
    stock();
    S._restoring = true;
    // A week counted over half a queue is a *wrong* week, not a smaller one.
    expect(weekReport(NOW)).toBe(null);
  });

  it('paints the same data the moment restoring is over', () => {
    stock();
    S._restoring = true;
    expect(weekReport(NOW)).toBe(null);
    S._restoring = false;
    const rep = weekReport(NOW);
    expect(rep).not.toBe(null);
    expect(rep.drilled).toBe(1);      // only the card touched inside the week
    expect(rep.grew).toBe(2);         // both cards added inside it
    expect(rep.due).toBe(2);          // due ≤ now, across both stores
    expect(rep.cards).toBe(3);
  });

  it('counts a window of exactly seven days, inclusive at one end only', () => {
    S.deck.set('edge', card({ key: 'edge', lastAt: NOW - WEEK_MS, addedAt: NOW - WEEK_MS, due: NOW + DAY_MS }));
    expect(weekReport(NOW).drilled).toBe(0);
    expect(weekReport(NOW).grew).toBe(0);

    S.deck.set('inside', card({ key: 'inside', lastAt: NOW - WEEK_MS + 1, addedAt: NOW - WEEK_MS + 1, due: NOW + DAY_MS }));
    expect(weekReport(NOW).drilled).toBe(1);
    expect(weekReport(NOW).grew).toBe(1);

    // The near end is inclusive: a card due at this instant is due now.
    S.deck.set('now', card({ key: 'now', lastAt: NOW, addedAt: NOW, due: NOW }));
    expect(weekReport(NOW).due).toBe(1);
    expect(weekReport(NOW).drilled).toBe(2);
  });

  it('reads the week\'s worst move off the deck rows, with a door when its game is loaded', () => {
    S.games = games.slice(0, 3);
    S.deck.set('small', card({ key: 'small', gameId: S.games[0].id, ply: 8, addedAt: NOW - DAY_MS, before: { cp: 0 }, after: { cp: -320 } }));
    S.deck.set('big', card({ key: 'big', gameId: S.games[2].id, ply: 41, addedAt: NOW - DAY_MS, before: { cp: 120 }, after: { cp: -600 } }));
    const rep = weekReport(NOW);
    expect(rep.worst.key).toBe('big');
    expect(rep.worstLoss).toBe(720);
    expect(rep.worstAt).toBe(2);      // the door: setGame(2, 41)
    expect(rep.worst.ply).toBe(41);
  });

  it('draws no door when the worst card\'s game is not in the queue', () => {
    S.deck.set('big', card({ key: 'big', gameId: 'not-loaded', addedAt: NOW - DAY_MS }));
    expect(weekReport(NOW).worstAt).toBe(-1);
    expect(gameIndexOf('not-loaded')).toBe(-1);
  });

  it('has no worst move when nothing was earned this week', () => {
    S.deck.set('old', card({ key: 'old', addedAt: NOW - 30 * DAY_MS, lastAt: NOW - DAY_MS }));
    const rep = weekReport(NOW);
    expect(rep.grew).toBe(0);
    expect(rep.worst).toBe(null);
    expect(rep.worstLoss).toBe(null);
    expect(rep.worstAt).toBe(-1);
  });
});

/* ===== The strip ===== */

describe('the newest in the queue', () => {
  it('is newest first and never longer than the strip', () => {
    S.games = games;
    const hero = resolveHero(games);
    const rows = recentGames(S.games, hero.key);
    expect(rows.length).toBe(RECENT_MAX);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].when).toBeGreaterThanOrEqual(rows[i].when);
    for (const r of rows) {
      expect(S.games[r.gi]).toBeTruthy();
      expect(['w', 'l', 'd']).toContain(r.result);
      expect(r.opponent).not.toBe('');
      expect(r.plies).toBeGreaterThan(0);
    }
  });

  it('falls back to when a dateless game was imported', () => {
    const g = { id: 'x', headers: { White: 'A', Black: 'B' }, moves: [{}, {}], addedAt: NOW };
    S.games = [games[0], g];
    const rows = recentGames(S.games, null);
    expect(rows[0].gi).toBe(1);         // imported a minute ago, so it is the newest
    expect(rows[0].players).toBe('A – B');
    expect(rows[0].date).toBe(null);
  });

  it('says the players when there is no subject to read a result from', () => {
    S.games = games.slice(0, 2);
    const rows = recentGames(S.games, null);
    expect(rows[0].result).toBe(null);
    expect(rows[0].players).toContain(' – ');
  });
});
