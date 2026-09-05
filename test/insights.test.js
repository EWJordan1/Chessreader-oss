/*
 * Insights: the arithmetic, not the mark-up. Every claim here is one a bug would
 * falsify quietly — a clock series a move out of step, a mean of the wrong things, a
 * recommendation drawn from six games — rather than one that would throw.
 *
 * Node environment: nothing below touches `document`, which is the point. renderReport()
 * and the room are left to the walk tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { S } from '../src/state.js';
import { loadGames, parseGame } from '../src/pgn.js';
import {
  playerKey, scorePct, heroCandidates, resolveHero,
  timeClassOf, timeBudget, endingOf, endingLabel, gameFacts,
  computeStats, orderedGames, formReport,
  clockSeries, timeTrouble, clockReport,
  evalToCp, analysed, moveLossLocal, plyLoss, moveAccuracy, gameAccuracy, meanAccuracy,
  habitReport, compareSets, compareRows,
  buildExplorer, explorerWalk, patternLineFor, patternReport,
  recommendations,
  EXPLORER_MAX_PLY, TROUBLE_FRACTION, LOSS_CAP, PATTERN_MIN_GAMES, FLOORS,
} from '../src/insights.js';

/* ===== Fixtures ===== */

const FIX = new URL('./fixtures/', import.meta.url);
const read = name => readFileSync(new URL(name, FIX), 'utf8');

const EVALS = JSON.parse(read('evals.json'));
let ARCHIVE = [];       // chesscom.pgn — 34 games, bullet through daily, evals attached
let LICHESS = [];       // lichess.pgn — the other header dialect, 15+0 through 180+0
let MALFORMED = [];     // malformed.pgn
const HERO = 'hikaru';

beforeAll(async () => {
  ARCHIVE = (await loadGames(read('chesscom.pgn'))).games;
  for (const g of ARCHIVE) g.analysis = EVALS[g.id];
  LICHESS = (await loadGames(read('lichess.pgn'))).games;
  MALFORMED = (await loadGames(read('malformed.pgn'))).games;
});

beforeEach(() => {
  // gameFacts, clockSeries and gameAccuracy all cache on the game, keyed by hero or by
  // nothing at all. A cache carried between tests would hide the staleness it can cause,
  // so every test starts from cold games.
  for (const g of [...ARCHIVE, ...LICHESS, ...MALFORMED]) { delete g._facts; delete g._clk; delete g._acc; }
  S.games = [];
  S.heroOverride = '';
  S.chesscomUser = '';
  S.lichessUser = '';
});
afterEach(() => { S.heroOverride = ''; S.chesscomUser = ''; S.lichessUser = ''; });

/** The malformed game whose clock series is one reading short of its moves. */
const shortClockGame = () => MALFORMED.find(g => g.headers.Event === 'Clock series one reading short');

/* ----- Toy games: headers I control, so a floor can be walked up to ----- */

const DEFAULT_MOVES = '1. e4 e5 2. Nf3 Nc6';

/** A game built from headers. `date` is a PGN date; `movetext` excludes the result. */
function toy(opts = {}) {
  const h = {
    Event: 'Toy', Site: '?',
    Date: opts.date || '2025.01.01',
    White: opts.white || 'hero', Black: opts.black || 'foe',
    Result: opts.result || '1-0',
    TimeControl: opts.tc === undefined ? '180' : opts.tc,
    ...(opts.headers || {}),
  };
  const text = Object.entries(h).map(([k, v]) => '[' + k + ' "' + v + '"]').join('\n') +
    '\n\n' + (opts.movetext || DEFAULT_MOVES) + ' ' + h.Result;
  const g = parseGame(text);
  if (!g) throw new Error('toy game did not parse');
  if (opts.analysis) g.analysis = opts.analysis;
  return g;
}

/** Distinct dates, far enough apart that nothing here counts as a tilt pair. */
const nthDate = i => '2025.' + String(1 + Math.floor(i / 28)).padStart(2, '0') + '.' + String(1 + (i % 28)).padStart(2, '0');

/** A flat analysis over a toy game: one eval per FEN, the scan declared complete. */
function analysisOf(game, evals) {
  return { build: 'test', depth: 12, evals, best: [], pv: [], alts: [], done: game.fens.length, altsDone: false };
}

/* ===== Whose games these are ===== */

describe('the subject is inferred, not configured', () => {
  it('takes the name that appears in the most games', () => {
    const cands = heroCandidates(ARCHIVE);
    expect(cands[0]).toMatchObject({ name: 'Hikaru', key: 'hikaru', n: 24 });
    expect(cands[0].n).toBeGreaterThan(cands[1].n);
    expect(resolveHero(ARCHIVE)).toEqual({ name: 'Hikaru', key: 'hikaru' });
  });

  it('lets S.heroOverride win over the count', () => {
    S.heroOverride = 'erik';
    expect(resolveHero(ARCHIVE)).toEqual({ name: 'erik', key: 'erik' });
  });

  it('ignores an override naming somebody who is not here', () => {
    S.heroOverride = 'nobody-at-all';
    expect(resolveHero(ARCHIVE).key).toBe('hikaru');
  });

  it('breaks a tie with the remembered handle, and only a tie', () => {
    // Two names, two games each: the count cannot separate them.
    const tied = [
      toy({ white: 'alpha', black: 'beta', date: nthDate(0) }),
      toy({ white: 'beta', black: 'alpha', date: nthDate(1) }),
    ];
    expect(heroCandidates(tied).map(c => c.n)).toEqual([2, 2]);
    S.chesscomUser = 'Beta';                       // case is not part of the key
    expect(resolveHero(tied).key).toBe('beta');
    S.chesscomUser = '';
    S.lichessUser = 'alpha';
    expect(resolveHero(tied).key).toBe('alpha');
    // ...and a remembered handle does not overturn a clear winner.
    S.lichessUser = 'erik';
    expect(resolveHero(ARCHIVE).key).toBe('hikaru');
  });

  it('is null when nobody is named, and "?" is nobody', () => {
    expect(resolveHero([])).toBe(null);
    expect(playerKey('?')).toBe('');
    expect(playerKey('  Hikaru ')).toBe('hikaru');
    const anon = [toy({ white: '?', black: '?' })];
    expect(heroCandidates(anon)).toEqual([]);
    expect(resolveHero(anon)).toBe(null);
  });
});

/* ===== One game, reduced ===== */

describe('gameFacts', () => {
  it('is null for a game the subject did not play', () => {
    expect(gameFacts(ARCHIVE[0], 'nobody')).toBe(null);
    expect(gameFacts(ARCHIVE[0], '')).toBe(null);
    expect(gameFacts(null, HERO)).toBe(null);
  });

  it('is null for a game with no result, even for a player in it', () => {
    const noResult = MALFORMED.find(g => g.headers.Event === 'No result');
    expect(noResult.headers.White).toBe('alpha_player');
    expect(gameFacts(noResult, 'alpha_player')).toBe(null);
  });

  it('reads the same game from both sides', () => {
    const g = toy({ white: 'hero', black: 'foe', result: '1-0', headers: { WhiteElo: '1500', BlackElo: '1400' } });
    expect(gameFacts(g, 'hero')).toMatchObject({ color: 'w', result: 'w', rating: 1500, oppRating: 1400, opponent: 'foe' });
    expect(gameFacts(g, 'foe')).toMatchObject({ color: 'b', result: 'l', rating: 1400, oppRating: 1500, opponent: 'hero' });
    const drawn = toy({ result: '1/2-1/2' });
    expect(gameFacts(drawn, 'hero').result).toBe('d');
    expect(gameFacts(drawn, 'foe').result).toBe('d');
  });

  it('carries the ending, the class and the length off a real game', () => {
    const g = ARCHIVE[0];
    expect(g.headers.Termination).toBe('Arystanner won by resignation');
    expect(gameFacts(g, HERO)).toMatchObject({
      color: 'b', result: 'l', ending: 'resignation', timeClass: 'blitz',
      length: g.moves.length, opponent: 'Arystanner',
    });
  });

  it('re-derives when the hero changes rather than serving the cached row', () => {
    const g = ARCHIVE[0];
    expect(gameFacts(g, HERO).color).toBe('b');
    expect(gameFacts(g, 'arystanner').color).toBe('w');
    expect(gameFacts(g, HERO).color).toBe('b');
  });
});

describe('the ending', () => {
  it('reads Termination, and reads stalemate before mate', () => {
    // "Game drawn by stalemate" contains "mate": filed as a checkmate it is a decisive
    // ending sitting among the draws, and nothing downstream could tell.
    expect(endingOf(toy({ result: '1/2-1/2', headers: { Termination: 'Game drawn by stalemate' } }))).toBe('stalemate');
    expect(endingOf(toy({ headers: { Termination: 'hero won by checkmate' } }))).toBe('checkmate');
    expect(endingOf(toy({ headers: { Termination: 'hero won on time' } }))).toBe('time');
    expect(endingOf(toy({ headers: { Termination: 'foe won by resignation' } }))).toBe('resignation');
    expect(endingOf(toy({ result: '1/2-1/2', headers: { Termination: 'Game drawn by repetition' } }))).toBe('repetition');
    // Chess.com's "timeout vs insufficient material" is not a flag fall.
    expect(endingOf(toy({ result: '1/2-1/2', headers: { Termination: 'Game drawn by timeout vs insufficient material' } }))).toBe('insufficient');
  });

  it('falls back to the last move, then to the result, then to null', () => {
    const mated = toy({ movetext: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#' });
    expect(endingOf(mated)).toBe('checkmate');
    expect(endingOf(toy({ result: '1/2-1/2' }))).toBe('draw');
    expect(endingOf(toy({ result: '1-0' }))).toBe(null);
    expect(endingLabel(null)).toBe('unrecorded');
  });

  it('files the fixture stalemate as a drawn stalemate', () => {
    const st = computeStats(ARCHIVE, HERO);
    expect(st.endings.d).toEqual({ stalemate: 1 });
    expect(st.endings.d.checkmate).toBeUndefined();
  });
});

describe('the time class comes off TimeControl', () => {
  it('reads base plus forty increments', () => {
    expect(timeClassOf('60')).toBe('bullet');
    expect(timeClassOf('180')).toBe('blitz');
    expect(timeClassOf('600+5')).toBe('rapid');
    expect(timeClassOf('1/259200')).toBe('daily');
    // 60+1 is a bullet game on both sites: 60 + 40×1 = 100, still under three minutes.
    expect(timeClassOf('60+1')).toBe('bullet');
    expect(timeClassOf('180+2')).toBe('blitz');
    expect(timeClassOf('1800')).toBe('classical');
  });

  it('is null rather than a guess when there is nothing to read', () => {
    for (const tc of ['', '-', '?', 'nonsense', null, undefined]) expect(timeClassOf(tc)).toBe(null);
  });

  it('gives a budget for a real clock and none for correspondence', () => {
    expect(timeBudget(toy({ tc: '600+5' }))).toEqual({ base: 600, inc: 5 });
    expect(timeBudget(toy({ tc: '180' }))).toEqual({ base: 180, inc: 0 });
    // Time trouble is not a thing that happens at three days a move.
    expect(timeBudget(toy({ tc: '1/259200' }))).toBe(null);
    expect(timeBudget(toy({ tc: '-' }))).toBe(null);
  });
});

/* ===== The clock ===== */

describe('the clock series', () => {
  it('reads the raw PGN, one reading per move', () => {
    const g = ARCHIVE[0];
    // cleanPGN strips the comments, so the series has to come off the untouched text.
    expect(g.pgn).toContain('[%clk');
    const clk = clockSeries(g);
    expect(clk).not.toBe(null);
    expect(clk.length).toBe(g.moves.length);
    expect(clk.every(s => Number.isFinite(s) && s >= 0)).toBe(true);
    // "0:03:00" is 180 seconds, not three.
    expect(clk[0]).toBe(180);
    expect(clk[0]).toBeLessThanOrEqual(timeBudget(g).base);
  });

  it('every game in the archive keeps one reading per move', () => {
    for (const g of ARCHIVE) expect(clockSeries(g).length).toBe(g.moves.length);
  });

  it('drops a game whole when the readings are one short of the moves', () => {
    const g = shortClockGame();
    expect((g.pgn.match(/%clk/g) || []).length).toBe(g.moves.length - 1);
    // Not "use what is there": a series a move out of step is wrong and plausible at once.
    expect(clockSeries(g)).toBe(null);
  });

  it('drops a game whose variations carry readings of their own', () => {
    const g = toy({ movetext: '1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} (1... c5 {[%clk 0:02:59]}) 2. Nf3 {[%clk 0:02:58]} Nc6 {[%clk 0:02:57]}' });
    expect(g.moves.length).toBe(4);
    expect((g.pgn.match(/%clk/g) || []).length).toBe(5);
    expect(clockSeries(g)).toBe(null);
  });

  it('is null, not empty, for a game with no clock at all', () => {
    expect(clockSeries(toy())).toBe(null);
    expect(clockSeries(null)).toBe(null);
  });

  it('caches on the game', () => {
    const g = ARCHIVE[0];
    expect(clockSeries(g)).toBe(clockSeries(g));
    expect(g._clk).toBe(clockSeries(g));
  });
});

describe('the other dialect: Lichess headers', () => {
  it('reads a clock series through braces spelled with spaces', () => {
    // Chess.com writes `{[%clk 0:01:00]}`, Lichess `{ [%clk 0:01:00] }`. One reading per
    // move either way, or the game is dropped.
    expect(LICHESS.length).toBe(17);
    expect(LICHESS[0].pgn).toContain('{ [%clk ');
    for (const g of LICHESS) {
      const clk = clockSeries(g);
      expect(clk).not.toBe(null);
      expect(clk.length).toBe(g.moves.length);
    }
    expect(clockSeries(LICHESS[0])[0]).toBe(60);
  });

  it('classes the short controls off TimeControl, not off the Event line', () => {
    // The Event says "rated bullet game"; the class comes from the header either way.
    const byClass = {};
    for (const g of LICHESS) {
      const c = timeClassOf(g.headers.TimeControl);
      (byClass[c] ||= new Set()).add(g.headers.TimeControl);
    }
    expect([...byClass.bullet].sort()).toEqual(['15+0', '60+0', '60+1']);
    expect([...byClass.blitz]).toEqual(['180+0']);
  });

  it('reads an ending off a Termination that names no player', () => {
    // Lichess writes "Normal" or "Time forfeit" — neither carries a name, so a decisive
    // Normal falls through to the last move.
    const forfeit = LICHESS.find(g => g.headers.Termination === 'Time forfeit');
    expect(endingOf(forfeit)).toBe('time');
    const mated = LICHESS.find(g => g.headers.Termination === 'Normal' && /#$/.test(g.moves[g.moves.length - 1].san));
    expect(endingOf(mated)).toBe('checkmate');
    const f = gameFacts(forfeit, playerKey(forfeit.headers.White));
    expect(f).toMatchObject({ color: 'w', ending: 'time' });
    expect(f.result).toBe(forfeit.headers.Result === '1-0' ? 'w' : 'l');
  });

  it('breaks a real tie at the top with the remembered handle', () => {
    const cands = heroCandidates(LICHESS);
    expect(cands[0].n).toBe(cands[1].n);        // two players on six games each
    expect(resolveHero(LICHESS).key).toBe(cands[0].key);
    S.lichessUser = cands[1].name;
    expect(resolveHero(LICHESS).key).toBe(cands[1].key);
  });
});

describe('time trouble', () => {
  const CLK = '1. e4 {[%clk 0:00:20]} e5 {[%clk 0:00:20]} 2. Nf3 {[%clk 0:00:20]} Nc6 {[%clk 0:00:20]}';

  it('is the last tenth of that game\'s own base clock, not a number of seconds', () => {
    // The same twenty seconds on the clock: nowhere near trouble in a one-minute game,
    // squarely inside it in a ten-minute one. A fixed threshold reports the time control.
    const bullet = toy({ tc: '60', movetext: CLK });
    const rapid = toy({ tc: '600', movetext: CLK });
    expect(TROUBLE_FRACTION).toBe(0.1);
    expect(timeTrouble(bullet, 0)).toBe(false);   // 20s > 60 × 0.1
    expect(timeTrouble(rapid, 0)).toBe(true);     // 20s ≤ 600 × 0.1
    // ...and the boundary sits exactly on the tenth.
    expect(timeTrouble(toy({ tc: '200', movetext: CLK }), 0)).toBe(true);
    expect(timeTrouble(toy({ tc: '201', movetext: CLK }), 0)).toBe(true);
    expect(timeTrouble(toy({ tc: '199', movetext: CLK }), 0)).toBe(false);
  });

  it('is null, never false, when there is no clock to ask', () => {
    expect(timeTrouble(toy(), 0)).toBe(null);                                  // no readings
    expect(timeTrouble(shortClockGame(), 0)).toBe(null);                       // readings dropped whole
    expect(timeTrouble(toy({ tc: '1/259200', movetext: CLK }), 0)).toBe(null); // no base clock
    expect(timeTrouble(toy({ tc: '60', movetext: CLK }), 99)).toBe(null);      // past the last move
  });
});

describe('the clock report', () => {
  it('counts what it could use and what it had to drop', () => {
    const c = clockReport(ARCHIVE, HERO);
    expect(c.counted).toBe(24);
    expect(c.tagged).toBe(24);
    expect(c.clocked).toBe(24);
    expect(c.dropped).toBe(0);
    expect(c.moves).toBe(ARCHIVE.reduce((n, g) => {
      const f = gameFacts(g, HERO);
      return f ? n + Math.ceil((g.moves.length - (f.color === 'w' ? 0 : 1)) / 2) : n;
    }, 0));
    expect(c.low).toBeLessThanOrEqual(c.moves);
  });

  it('counts a game with a mismatched series as dropped rather than clocked', () => {
    const c = clockReport([shortClockGame()], 'alpha_player');
    expect(c).toMatchObject({ counted: 1, tagged: 1, clocked: 0, dropped: 1, moves: 0 });
  });

  it('averages accuracy and cost per game, not per move', () => {
    const c = clockReport(ARCHIVE, HERO);
    expect(c.same.rest.games).toBeGreaterThan(0);
    // lossSum is a sum of per-game means, so the settled figure is a mean of means.
    expect(c.same.rest.loss).toBeCloseTo(c.same.rest.lossSum / c.same.rest.games, 10);
    expect(c.same.rest.acc).toBeCloseTo(c.same.rest.accSum / c.same.rest.games, 10);
  });
});

/* ===== The engine's numbers ===== */

describe('per-move loss', () => {
  /** Four plies, hero as White, with the evals handed in. */
  const withEvals = evals => {
    const g = toy({ movetext: '1. e4 e5 2. Nf3 Nc6' });
    g.analysis = analysisOf(g, evals);
    return g;
  };

  it('is floored at zero: a move that improved the position cost nothing', () => {
    // Without the floor a bucket's mean can go negative, which reads as "gained material
    // by moving" — arithmetic that is not wrong so much as meaningless.
    const g = withEvals([{ cp: 0 }, { cp: 300 }, { cp: 300 }, { cp: 300 }, { cp: 300 }]);
    expect(plyLoss(g, 0)).toBe(0);
    expect(moveLossLocal(g, 0)).toBe(0);
    const black = withEvals([{ cp: 0 }, { cp: 0 }, { cp: -300 }, { cp: -300 }, { cp: -300 }]);
    expect(plyLoss(black, 1)).toBe(0);
  });

  it('is capped: a mate escaped is not ninety-nine thousand centipawns of blame', () => {
    const g = withEvals([{ cp: 0 }, { mate: -1 }, { mate: -1 }, { mate: -1 }, { mate: -1 }]);
    expect(evalToCp({ mate: -1 })).toBeLessThan(-9000);
    expect(plyLoss(g, 0)).toBe(LOSS_CAP);
    expect(moveLossLocal(g, 0)).toBe(LOSS_CAP);
  });

  it('is null, not zero, for a ply the engine has not judged', () => {
    const g = withEvals([{ cp: 0 }, { cp: 0 }]);
    expect(plyLoss(g, 2)).toBe(null);
    expect(plyLoss(g, 0)).toBe(0);
    expect(moveLossLocal(toy(), 0)).toBe(null);
  });

  it('never exceeds the cap anywhere in the archive', () => {
    for (const g of ARCHIVE) {
      for (let n = 0; n < g.moves.length; n++) {
        const l = plyLoss(g, n);
        if (l === null) continue;
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(LOSS_CAP);
      }
    }
  });
});

describe('accuracy', () => {
  /** A game whose White accuracy is exactly 100: every move keeps the evaluation. */
  const flat = () => {
    const g = toy({ movetext: '1. e4 e5' });
    g.analysis = analysisOf(g, [{ cp: 0 }, { cp: 0 }, { cp: 0 }]);
    return g;
  };
  /** A longer game where White gives away three pawns a move. */
  const sloppy = () => {
    const g = toy({ movetext: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6' });
    g.analysis = analysisOf(g, [
      { cp: 0 }, { cp: -300 }, { cp: -300 }, { cp: -600 },
      { cp: -600 }, { cp: -900 }, { cp: -900 }, { cp: -1200 }, { cp: -1200 },
    ]);
    return g;
  };

  it('is aggregated per game and then averaged across games', () => {
    const a = flat(), b = sloppy();
    expect(analysed(a)).toBe(true);
    expect(analysed(b)).toBe(true);
    const ga = gameAccuracy(a, 'w'), gb = gameAccuracy(b, 'w');
    expect(ga).toEqual({ accuracy: 100, moves: 1 });
    expect(gb.moves).toBe(4);
    expect(gb.accuracy).toBeLessThan(100);

    const meanOfMeans = (ga.accuracy + gb.accuracy) / 2;
    const pooled = (ga.accuracy * ga.moves + gb.accuracy * gb.moves) / (ga.moves + gb.moves);
    // The two really do differ here — otherwise this test proves nothing.
    expect(Math.abs(meanOfMeans - pooled)).toBeGreaterThan(1);

    const got = meanAccuracy([a, b], 'hero');
    expect(got.games).toBe(2);
    expect(got.moves).toBe(5);
    expect(got.accuracy).toBeCloseTo(meanOfMeans, 10);
    expect(got.accuracy).not.toBeCloseTo(pooled, 1);
  });

  it('counts only the subject\'s own moves', () => {
    const g = sloppy();
    // Black's evaluation rises on every one of its moves, so Black is perfect here.
    expect(gameAccuracy(g, 'b').accuracy).toBe(100);
    expect(gameAccuracy(g, 'b').moves).toBe(4);
  });

  it('is null rather than a figure when the engine has not finished', () => {
    const g = toy({ movetext: '1. e4 e5' });
    g.analysis = { build: 'test', depth: 12, evals: [{ cp: 0 }, { cp: 0 }], done: 2 };
    expect(analysed(g)).toBe(false);
    expect(gameAccuracy(g, 'w')).toBe(null);
    expect(meanAccuracy([g], 'hero')).toBe(null);
    expect(moveAccuracy(toy(), 0)).toBe(null);
  });

  it('gives the archive one figure per analysed game', () => {
    const acc = meanAccuracy(ARCHIVE, HERO);
    expect(acc.games).toBe(computeStats(ARCHIVE, HERO).counted);
    expect(acc.accuracy).toBeGreaterThan(0);
    expect(acc.accuracy).toBeLessThanOrEqual(100);
  });
});

/* ===== The record ===== */

describe('the record', () => {
  it('counts the games the subject played to a result, and says how many it dropped', () => {
    const st = computeStats(ARCHIVE, HERO);
    expect(st.total).toBe(34);
    expect(st.counted).toBe(24);
    expect(st.overall).toEqual({ n: 24, w: 18, d: 1, l: 5 });
    expect(st.white.n + st.black.n).toBe(st.counted);
    expect(st.white).toEqual({ n: 13, w: 11, d: 0, l: 2 });
    expect(st.black).toEqual({ n: 11, w: 7, d: 1, l: 3 });
  });

  it('scores a draw as half a point, and says nothing for a colour never played', () => {
    expect(scorePct({ n: 4, w: 2, d: 0, l: 2 })).toBe(50);
    expect(scorePct({ n: 4, w: 1, d: 2, l: 1 })).toBe(50);
    expect(scorePct({ n: 0, w: 0, d: 0, l: 0 })).toBe(0);
    const st = computeStats([toy({ white: 'hero' })], 'hero');
    expect(st.black.n).toBe(0);
  });

  it('splits the endings by result and the games by time control', () => {
    const st = computeStats(ARCHIVE, HERO);
    const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    expect(sum(st.endings.w)).toBe(st.overall.w);
    expect(sum(st.endings.d)).toBe(st.overall.d);
    expect(sum(st.endings.l)).toBe(st.overall.l);
    expect(Object.values(st.controls).reduce((a, t) => a + t.n, 0)).toBe(st.counted);
    expect(Object.keys(st.controls).sort()).toEqual(['blitz', 'bullet']);
  });

  it('reports a rating trend only when the games can be ordered', () => {
    const st = computeStats(ARCHIVE, HERO);
    expect(st.rating.peak).toBeGreaterThanOrEqual(st.rating.last);
    expect(st.rating.delta).toBe(st.rating.last - st.rating.first);
    const undated = computeStats([
      toy({ date: '????.??.??', headers: { WhiteElo: '1500' } }),
      toy({ date: '????.??.??', headers: { WhiteElo: '1600' } }),
    ], 'hero');
    expect(undated.rating).toMatchObject({ peak: 1600, first: null, last: null, delta: 0 });
  });

  it('orders the dated games oldest first', () => {
    const list = orderedGames(ARCHIVE, HERO);
    expect(list.length).toBe(24);
    for (let i = 1; i < list.length; i++) expect(list[i].f.date).toBeGreaterThanOrEqual(list[i - 1].f.date);
  });
});

describe('form', () => {
  it('reads the results in the order they happened', () => {
    const f = formReport(ARCHIVE, HERO);
    const list = orderedGames(ARCHIVE, HERO);
    expect(f.n).toBe(24);
    expect(f.marks).toEqual(list.map(e => e.f.result));
    expect(f.last.n).toBe(10);
    expect(f.run.result).toBe(f.marks[f.marks.length - 1]);
  });

  it('holds the rolling curve back until the window is full', () => {
    // A "rolling average" over the first four games is those four games; drawn, it is
    // noise settling, and noise settling reads as improvement.
    const short = Array.from({ length: 12 }, (_, i) => toy({ date: nthDate(i) }));
    expect(formReport(short, 'hero').roll).toBe(null);
    const f = formReport(ARCHIVE, HERO);
    expect(f.roll.length).toBe(f.n - 20 + 1);
  });

  it('is null when nothing carries a date', () => {
    expect(formReport([toy({ date: '????.??.??' })], 'hero')).toBe(null);
    expect(formReport([], 'hero')).toBe(null);
  });
});

describe('habits', () => {
  it('pairs a game with the one before only when both carry a real time', () => {
    const h = habitReport(ARCHIVE, HERO);
    expect(h.counted).toBe(24);
    expect(h.dated).toBe(24);
    expect(h.tilt.afterLoss.n + h.tilt.afterWin.n).toBeLessThanOrEqual(h.tilt.pairs);
    // A date-only archive puts every game at noon; pairing on that would make every
    // consecutive game "twenty minutes apart".
    const dateOnly = Array.from({ length: 6 }, (_, i) => toy({ date: nthDate(i) }));
    expect(habitReport(dateOnly, 'hero').tilt).toBe(null);
  });

  it('lists who the subject keeps losing to, not who they played most', () => {
    const h = habitReport(ARCHIVE, HERO);
    expect(h.opponents.every(o => o.l > 0)).toBe(true);
    for (let i = 1; i < h.opponents.length; i++) expect(h.opponents[i - 1].l).toBeGreaterThanOrEqual(h.opponents[i].l);
    expect(h.losses).toBe(computeStats(ARCHIVE, HERO).overall.l);
  });
});

describe('compare', () => {
  it('offers no set that cannot clear the floor', () => {
    const sets = compareSets(ARCHIVE, HERO);
    expect(sets.length).toBeGreaterThan(1);
    for (const s of sets) expect(s.gis.length).toBeGreaterThanOrEqual(FLOORS.compare);
    expect(sets.map(s => s.key)).toContain('color:w');
    expect(compareSets(ARCHIVE.slice(0, 4), HERO)).toEqual([]);
  });

  it('runs the same record twice and reports the swing between them', () => {
    const sets = compareSets(ARCHIVE, HERO);
    const w = sets.find(s => s.key === 'color:w'), b = sets.find(s => s.key === 'color:b');
    const cmp = compareRows(ARCHIVE, HERO, w, b);
    expect(cmp.a.counted).toBe(13);
    expect(cmp.b.counted).toBe(11);
    expect(cmp.swing).toBe(Math.round(scorePct(cmp.a.overall)) - Math.round(scorePct(cmp.b.overall)));
    expect(cmp.rows[0]).toEqual({ label: 'Games', a: 13, b: 11 });
  });
});

/* ===== The explorer ===== */

/** Every node in the trie with the SAN path that reaches it. */
function eachNode(root, fn, path = []) {
  fn(root, path);
  for (const [san, kid] of root.children) eachNode(kid, fn, path.concat(san));
}

describe('the opening explorer', () => {
  it('is a trie over the subject\'s games as one colour, and the counts sum', () => {
    const st = computeStats(ARCHIVE, HERO);
    for (const color of ['w', 'b']) {
      const root = buildExplorer(ARCHIVE, HERO, color);
      expect(root.n).toBe(color === 'w' ? st.white.n : st.black.n);
      expect(root.w + root.d + root.l).toBe(root.n);
      // Every game here has moves, so nothing is lost between a node and its children.
      const kidSum = [...root.children.values()].reduce((a, k) => a + k.n, 0);
      expect(kidSum).toBe(root.n);
      eachNode(root, node => {
        expect(node.games.length).toBe(node.n);
        expect(node.w + node.d + node.l).toBe(node.n);
        const kids = [...node.children.values()].reduce((a, k) => a + k.n, 0);
        expect(kids).toBeLessThanOrEqual(node.n);
      });
    }
  });

  it('holds on each node the game indices that reached it', () => {
    const root = buildExplorer(ARCHIVE, HERO, 'w');
    eachNode(root, (node, path) => {
      for (const gi of node.games) {
        const g = ARCHIVE[gi];
        expect(gameFacts(g, HERO).color).toBe('w');
        expect(g.moves.slice(0, path.length).map(m => m.san)).toEqual(path);
      }
    });
  });

  it('takes each node\'s position from fens[depth] of the first game through it', () => {
    for (const color of ['w', 'b']) {
      const root = buildExplorer(ARCHIVE, HERO, color);
      eachNode(root, (node, path) => {
        expect(node.fen).toBe(ARCHIVE[node.games[0]].fens[path.length]);
      });
    }
  });

  it('stops at the depth it was given', () => {
    const root = buildExplorer(ARCHIVE, HERO, 'w');
    let deepest = 0;
    eachNode(root, (_n, path) => { deepest = Math.max(deepest, path.length); });
    expect(deepest).toBe(EXPLORER_MAX_PLY);
    const shallow = buildExplorer(ARCHIVE, HERO, 'w', 2);
    let d2 = 0;
    eachNode(shallow, (_n, path) => { d2 = Math.max(d2, path.length); });
    expect(d2).toBe(2);
  });

  it('walks a path of SAN, so it survives a rebuild', () => {
    const first = buildExplorer(ARCHIVE, HERO, 'w');
    const path = ARCHIVE[first.children.get('e4').games[0]].moves.slice(0, 3).map(m => m.san);
    const there = explorerWalk(first, path);
    expect(there.path).toEqual(path);
    expect(there.node.n).toBeGreaterThan(0);
    // A node reference would be stale here; the SAN is not.
    const rebuilt = buildExplorer(ARCHIVE, HERO, 'w');
    const again = explorerWalk(rebuilt, path);
    expect(again.path).toEqual(path);
    expect(again.node).not.toBe(there.node);
    expect(again.node.n).toBe(there.node.n);
    expect(again.node.fen).toBe(there.node.fen);
  });

  it('stops at the last node that still exists', () => {
    const root = buildExplorer(ARCHIVE, HERO, 'w');
    const walked = explorerWalk(root, ['e4', 'Qh4xz', 'e5']);
    expect(walked.path).toEqual(['e4']);
    expect(walked.node).toBe(root.children.get('e4'));
    expect(explorerWalk(root, []).node).toBe(root);
  });

  it('is empty, not wrong, for a colour never played', () => {
    const root = buildExplorer([toy({ white: 'hero' })], 'hero', 'b');
    expect(root.n).toBe(0);
    expect(root.children.size).toBe(0);
  });
});

/* ===== The pattern report ===== */

describe('the pattern report', () => {
  it('attributes a game to the deepest node three of the subject\'s games passed through', () => {
    const games = [
      toy({ white: 'foe', black: 'hero', result: '1-0', date: nthDate(0), movetext: '1. d4 g6 2. c4 Bg7' }),
      toy({ white: 'foe', black: 'hero', result: '1-0', date: nthDate(1), movetext: '1. d4 g6 2. Nf3 Bg7' }),
      toy({ white: 'foe', black: 'hero', result: '1-0', date: nthDate(2), movetext: '1. d4 g6 2. e4 d6' }),
    ];
    const root = buildExplorer(games, 'hero', 'b');
    expect(root.children.get('d4').n).toBe(3);
    expect(root.children.get('d4').children.get('g6').n).toBe(3);
    // Three games reached d4 g6; only one reached each third move, so that is the line.
    const sans = games[0].moves.map(m => m.san);
    expect(patternLineFor(root, sans)).toEqual(['d4', 'g6']);
  });

  it('drops a one-off rather than filing it at the root', () => {
    const games = [
      toy({ white: 'foe', black: 'hero', result: '1-0', date: nthDate(0), movetext: '1. d4 g6' }),
      toy({ white: 'foe', black: 'hero', result: '1-0', date: nthDate(1), movetext: '1. d4 g6' }),
      toy({ white: 'foe', black: 'hero', result: '1-0', date: nthDate(2), movetext: '1. e4 c5' }),
    ];
    const root = buildExplorer(games, 'hero', 'b');
    expect(patternLineFor(root, ['e4', 'c5'])).toBe(null);   // one game through it
    expect(patternLineFor(root, ['d4', 'g6'])).toBe(null);   // two: still under the floor
  });

  it('is the deepest such node for every attributed game in the archive', () => {
    for (const color of ['w', 'b']) {
      const root = buildExplorer(ARCHIVE, HERO, color);
      for (const g of ARCHIVE) {
        const f = gameFacts(g, HERO);
        if (!f || f.color !== color) continue;
        const sans = g.moves.slice(0, EXPLORER_MAX_PLY).map(m => m.san);
        const path = patternLineFor(root, sans);
        if (!path) continue;
        const node = explorerWalk(root, path).node;
        expect(node.n).toBeGreaterThanOrEqual(PATTERN_MIN_GAMES);
        // Deepest: the game's own next move is either off the end or under the floor.
        const next = sans[path.length];
        if (next !== undefined && path.length < EXPLORER_MAX_PLY) {
          const kid = node.children.get(next);
          expect(kid.n).toBeLessThan(PATTERN_MIN_GAMES);
        }
      }
    }
  });

  it('counts every judged ply under a line and keeps the tiers apart', () => {
    const rows = patternReport(ARCHIVE, HERO, 'b');
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.path.length).toBeGreaterThanOrEqual(2);
      expect(p.analysed).toBeGreaterThanOrEqual(PATTERN_MIN_GAMES);
      expect(p.errors).toBeGreaterThanOrEqual(3);
      expect(p.tiers.blunder + p.tiers.mistake + p.tiers.inaccuracy).toBe(p.errors);
      expect(p.plies.length).toBe(p.errors);
      expect(p.errors).toBe(p.plies.length);
      expect(p.rate).toBeCloseTo(p.errors / p.analysed, 10);
      expect(p.withError).toBeLessThanOrEqual(p.analysed);
      expect(p.score.n).toBe(p.games);
      // Black's plies only: the report is about the subject's own moves.
      for (const n of p.plies) expect(n % 2).toBe(1);
      expect(p.clock.low).toBeLessThanOrEqual(p.clock.errors);
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].rate).toBeGreaterThanOrEqual(rows[i].rate);
  });

  it('writes nothing when nothing has been analysed', () => {
    const bare = ARCHIVE.map(g => Object.assign(Object.create(Object.getPrototypeOf(g)), g, { analysis: undefined, _facts: undefined }));
    expect(patternReport(bare, HERO, 'b')).toEqual([]);
    expect(patternReport(bare, HERO, 'w')).toEqual([]);
  });
});

/* ===== What to work on ===== */

describe('recommendations', () => {
  it('writes nothing from five games — every generator sits behind a floor', () => {
    expect(recommendations(ARCHIVE.slice(0, 5), HERO)).toEqual([]);
    expect(recommendations([], HERO)).toEqual([]);
    expect(recommendations(ARCHIVE, '')).toEqual([]);
  });

  it('carries the numbers that earned the row, and somewhere to walk', () => {
    const recs = recommendations(ARCHIVE, HERO);
    expect(recs.length).toBeGreaterThan(0);
    for (let i = 1; i < recs.length; i++) expect(recs[i - 1].weight).toBeGreaterThanOrEqual(recs[i].weight);
    for (const r of recs) {
      expect(typeof r.id).toBe('string');
      expect(r.text.length).toBeGreaterThan(20);
      expect(r.numbers).toBeTruthy();
      expect(r.walk.room).toBeTruthy();
      expect(r.text).not.toMatch(/losss|NaN|undefined|Infinity/);
      expect(r.numbers).not.toMatch(/losss|NaN|undefined|Infinity/);
    }
    const collapse = recs.find(r => r.id === 'collapse');
    expect(collapse).toBeTruthy();
    // The row names the evidence, and the evidence is really there.
    const [gi, ply1] = String(collapse.walk.arg).split(':').map(Number);
    expect(collapse.walk.room).toBe('play');
    const g = ARCHIVE[gi];
    const f = gameFacts(g, HERO);
    expect(f.result).not.toBe('w');
    expect(analysed(g)).toBe(true);
    const n = ply1 - 1;
    expect(g.moves[n].color).toBe(f.color);
    expect(plyLoss(g, n)).toBeGreaterThanOrEqual(300);
    expect(collapse.numbers).toContain('of 24 analysed games');
  });

  it('holds the colour gap back until there are twenty games as each colour', () => {
    // Wins with White and losses with Black: a hundred-point gap, and still nothing to
    // say from nineteen games a side. Advice from a small sample is a horoscope.
    const archive = per => {
      const gs = [];
      for (let i = 0; i < per; i++) gs.push(toy({ white: 'hero', black: 'foe' + i, result: '1-0', date: nthDate(i) }));
      for (let i = 0; i < per; i++) gs.push(toy({ white: 'foe' + i, black: 'hero', result: '1-0', date: nthDate(i) }));
      return gs;
    };
    expect(FLOORS.colour).toBe(20);
    expect(recommendations(archive(FLOORS.colour - 1), 'hero')).toEqual([]);
    const recs = recommendations(archive(FLOORS.colour), 'hero');
    const colour = recs.find(r => r.id === 'colour:b');
    expect(colour).toBeTruthy();
    expect(colour.text).toContain('Black');
    expect(colour.numbers).toBe('0% over 20 games · 100% over 20 games');
    expect(colour.walk).toEqual({ room: 'insights', arg: 'explorer:b' });
  });

  it('holds the flag row back until there are ten losses', () => {
    const archive = n => Array.from({ length: n }, (_, i) => toy({
      white: 'foe' + i, black: 'hero', result: '1-0', date: nthDate(i),
      headers: { Termination: 'foe' + i + ' won on time' },
    }));
    expect(FLOORS.endings).toBe(10);
    expect(recommendations(archive(FLOORS.endings - 1), 'hero')).toEqual([]);
    const recs = recommendations(archive(FLOORS.endings), 'hero');
    expect(recs.map(r => r.id)).toEqual(['flag']);
    expect(recs[0].text).toContain('10 of 10 losses');
    expect(recs[0].numbers).toBe('100% of losses on time');
    expect(recs[0].walk).toEqual({ room: 'insights', arg: 'clock' });
  });
});
