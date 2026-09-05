import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { splitPGN, parseGame } from '../src/pgn.js';
import {
  classifyMove, reviewClass, winProb, moveLoss, gameReview, ecoLookup, verdictSpeech,
  setEcoTable, gameOpening, gamePhases, isEndgame, aggregateAccuracy, moveAccuracy,
  REVIEW_WORDS, ERROR_WORDS, LOSS_CAP, DECIDED_WIN_PCT,
} from '../src/review.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const evals = JSON.parse(read('./fixtures/evals.json'));
const ecoTable = JSON.parse(read('../openings/eco.json'));
const games = splitPGN(read('./fixtures/chesscom.pgn')).map(parseGame).filter(Boolean);
for (const g of games) g.analysis = evals[g.id];
/* Lichess writes a plain `Opening` header and no ECOUrl, so it is the other half of the
   header fallback: a name, and nothing about where the book ended. */
const lichess = splitPGN(read('./fixtures/lichess.pgn')).map(parseGame).filter(Boolean);

const THREE = ['inaccuracy', 'mistake', 'blunder'];
const uci = m => m.from + m.to + (m.promotion || '');

/** A game from SAN, with a flat evaluation everywhere unless told otherwise. */
function toyGame(sans, { evalAt = () => ({ cp: 20 }), best, alts, headers = {} } = {}) {
  const chess = new Chess();
  const fens = [chess.fen()];
  const moves = [];
  for (const s of sans) { moves.push(chess.move(s)); fens.push(chess.fen()); }
  const analysis = {
    build: 'toy', depth: 12,
    evals: fens.map((f, i) => evalAt(i, f)),
    best: best || moves.map(uci),
    pv: [],
    done: fens.length,
    altsDone: !!alts,
  };
  if (alts !== undefined) analysis.alts = alts;
  return { id: 'toy-' + sans.join(''), headers, moves, fens, analysis };
}

const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3', 'Nf6', 'Nc3', 'd6', 'Bg5', 'h6', 'Bh4', 'g5', 'Bg3', 'Bg4'];

describe('the two vocabularies stay apart', () => {
  beforeAll(() => setEcoTable(ecoTable));
  afterAll(() => setEcoTable(null));

  it('classifyMove says three words, reviewClass eleven, and an error is an error in both', () => {
    let errors = 0, judged = 0;
    for (const g of games) {
      for (let n = 0; n < g.moves.length; n++) {
        const three = classifyMove(g, n);
        const word = reviewClass(g, n);
        expect(three === null || THREE.includes(three)).toBe(true);
        expect(word === null || REVIEW_WORDS.includes(word)).toBe(true);
        if (word) judged++;
        if (three) { errors++; expect(ERROR_WORDS).toContain(word); }
        // The engine's own move is never an error, whatever the drift between two searches says.
        if (g.analysis.best[n] === uci(g.moves[n])) expect(three).toBeNull();
      }
    }
    expect(judged).toBeGreaterThan(2000);
    expect(errors).toBeGreaterThan(50);
  });

  it('reviewClass answers for every judged ply — the counts sum to the game', () => {
    const g = games[0];
    const r = gameReview(g);
    const total = REVIEW_WORDS.reduce((a, t) => a + r.counts.w[t] + r.counts.b[t], 0);
    expect(total).toBe(g.moves.length);
    expect(r.plies.filter(Boolean)).toHaveLength(g.moves.length);
  });

  it('never says Great or Brilliant on a guess: never asked is `best`, asked-and-forced is `forced`', () => {
    for (const g of games) {
      expect(g.analysis.alts).toBeUndefined();
      for (let n = 0; n < g.moves.length; n++) expect(['great', 'brilliant']).not.toContain(reviewClass(g, n));
    }
    // An alts column that exists but was never asked at this ply is the same answer.
    const g = toyGame(ITALIAN, { alts: [] });
    for (let n = 0; n < g.moves.length; n++) expect(['great', 'brilliant']).not.toContain(reviewClass(g, n));
    // Asked and forced is the engine's own answer, not an inference from the delta, so
    // it earns the eleventh word — and is still neither Great nor Brilliant.
    g.analysis.alts[13] = null; delete g._review;
    expect(reviewClass(g, 13)).toBe('forced');
    expect(['great', 'brilliant']).not.toContain(reviewClass(g, 13));
  });

  it('says Great when the second-best trails by the gap, Brilliant when the move is a sacrifice', () => {
    const alts = [];
    alts[13] = { cp: 170 };   // 7…g5: Black's second-best hands White +1.7
    const g = toyGame(ITALIAN, { alts });
    expect(reviewClass(g, 13)).toBe('great');
    // The same gap over a move that gives material away is the other word. 7.Bh4 is not
    // that move — ...g5 attacks the bishop and Bg3 saves it — so the sacrifice is a real
    // one: 7.Bxf7+ leaves the bishop to be taken by the king, and the position it reaches
    // is past the end of the book, so `book` does not get there first.
    const sacAlts = [];
    sacAlts[12] = { cp: -150 };
    const s = toyGame(ITALIAN.slice(0, 12).concat(['Bxf7+']), { alts: sacAlts });
    expect(reviewClass(s, 12)).toBe('brilliant');
    // Neither word is a claim classifyMove makes.
    expect(classifyMove(s, 12)).toBeNull();
    expect(classifyMove(g, 13)).toBeNull();
  });

  it('says Miss when a win was let go, Blunder when nothing was there to miss', () => {
    // Move 7 is Black's (4…Nf6) and the evaluations are White-positive, so the win Black
    // lets go is a negative number: −6.0 before the move, −0.5 after it.
    const g = toyGame(ITALIAN, { best: ITALIAN.map(() => 'a2a3'), evalAt: i => (i === 7 ? { cp: -600 } : i === 8 ? { cp: -50 } : { cp: 20 }) });
    expect(classifyMove(g, 7)).toBe('blunder');
    expect(reviewClass(g, 7)).toBe('miss');
    const h = toyGame(ITALIAN, { best: ITALIAN.map(() => 'a2a3'), evalAt: i => (i === 7 ? { cp: -20 } : i === 8 ? { cp: 400 } : { cp: 20 }) });
    expect(reviewClass(h, 7)).toBe('blunder');
  });

  it('is silent from an already-lost position — a win-probability floor, not a centipawn one', () => {
    // Black to move at −900 (3.6% for Black): dropping to −1400 is not a blunder anyone needs told.
    const g = toyGame(ITALIAN, { best: ITALIAN.map(() => 'a2a3'), evalAt: i => (i === 9 ? { cp: 900 } : i === 10 ? { cp: 1400 } : { cp: 20 }) });
    expect(classifyMove(g, 9)).toBeNull();
    expect(ERROR_WORDS).not.toContain(reviewClass(g, 9));
    // But throwing a won game away is said out loud.
    const h = toyGame(ITALIAN, { best: ITALIAN.map(() => 'a2a3'), evalAt: i => (i === 9 ? { cp: -900 } : i === 10 ? { cp: 0 } : { cp: 20 }) });
    expect(classifyMove(h, 9)).toBe('blunder');
    expect(reviewClass(h, 9)).toBe('miss');
    // And the floor sits where the curve puts it, not on a round centipawn number: the
    // same 500cp giveaway is said at −7.8 and silent at −8.1, because that is where
    // Black's winning chances cross DECIDED_WIN_PCT.
    const lost = cp => toyGame(ITALIAN, { best: ITALIAN.map(() => 'a2a3'), evalAt: i => (i === 9 ? { cp } : i === 10 ? { cp: cp + 500 } : { cp: 20 }) });
    expect(100 - winProb(780)).toBeGreaterThan(DECIDED_WIN_PCT);
    expect(100 - winProb(810)).toBeLessThan(DECIDED_WIN_PCT);
    expect(classifyMove(lost(780), 9)).toBe('blunder');
    expect(classifyMove(lost(810), 9)).toBeNull();
  });
});

describe('the figures', () => {
  it('winProb is the Lichess curve, constant for constant', () => {
    expect(winProb(0)).toBe(50);
    expect(winProb(1500)).toBeCloseTo(99.6, 1);
    expect(winProb(1500) + winProb(-1500)).toBeCloseTo(100, 9);
    expect(winProb(10000)).toBe(winProb(1500));   // clamped
    expect(winProb(100)).toBeCloseTo(59.1, 1);
  });

  it('moveLoss is floored at zero and capped, with a mate read as ±10000 before the curve', () => {
    for (const g of games) for (let n = 0; n < g.moves.length; n++) {
      const l = moveLoss(g, n);
      expect(l).not.toBeNull();
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(LOSS_CAP);
    }
    const gain = toyGame(['e4', 'e5'], { evalAt: i => ({ cp: i * 100 }) });
    expect(moveLoss(gain, 0)).toBe(0);
    const mated = toyGame(['e4', 'e5'], { evalAt: i => (i === 1 ? { mate: -3 } : { cp: 0 }) });
    expect(moveLoss(mated, 0)).toBe(LOSS_CAP);
    expect(moveLoss(mated, 5)).toBeNull();          // no such move
    expect(moveLoss({ moves: [], fens: [] }, 0)).toBeNull();
  });

  it('per-move accuracy is the published formula and only losses count', () => {
    // The published constants do not quite meet at 100 with no loss (103.1668 − 3.1669 =
    // 99.9999), and the point of using them is that they are the published ones — so the
    // tolerance gives way here rather than the constants.
    expect(moveAccuracy(50, 50)).toBeCloseTo(100, 3);
    expect(moveAccuracy(50, 70)).toBeCloseTo(100, 3);
    expect(moveAccuracy(80, 50)).toBeCloseTo(103.1668 * Math.exp(-0.04354 * 30) - 3.1669, 6);
    expect(moveAccuracy(100, 0)).toBe(0);
  });

  it('aggregates per game, so an archive averages the games — not the concatenated moves', () => {
    const whole = games.find(g => g.id === '22uqzv10wrk') || games[0];
    const cut = Math.floor(whole.moves.length / 2);
    const slice = (from, to) => ({
      id: whole.id + from, headers: {}, moves: whole.moves.slice(from, to), fens: whole.fens.slice(from, to + 1),
      analysis: { evals: whole.analysis.evals.slice(from, to + 1), best: whole.analysis.best.slice(from, to + 1), pv: [], done: to - from + 1 },
    });
    const a = gameReview(slice(0, cut)), b = gameReview(slice(cut, whole.moves.length)), all = gameReview(whole);
    const meanOfMeans = (a.accuracy.w + b.accuracy.w) / 2;
    expect(Math.abs(meanOfMeans - all.accuracy.w)).toBeGreaterThan(0.05);
    // And the plain helper agrees with itself: the same moves in one bucket give one figure.
    expect(aggregateAccuracy([100, 100, 100], [50, 50, 50])).toBeCloseTo(100, 5);
    expect(aggregateAccuracy([], [])).toBeNull();
  });
});

describe('gameReview', () => {
  it('returns null without analysis and a partial, flagged review during a scan', () => {
    expect(gameReview({ moves: [], fens: [] })).toBeNull();
    const g = { ...games[0], analysis: { ...games[0].analysis, evals: games[0].analysis.evals.slice(0, 10), done: 10 } };
    const r = gameReview(g);
    expect(r.complete).toBe(false);
    expect(r.judged).toBe(9);
    expect(gameReview(games[0]).complete).toBe(true);
  });

  it('is cached on the game and replaced when the scan moves on', () => {
    const g = games[1];
    const r1 = gameReview(g);
    expect(gameReview(g)).toBe(r1);
    g.analysis.done += 1;
    const r2 = gameReview(g);
    expect(r2).not.toBe(r1);
    g.analysis.done -= 1;
    g.analysis.altsDone = true;
    expect(gameReview(g)).not.toBe(r2);
    delete g.analysis.altsDone;
  });

  it('names three distinct moments, largest swing first, each an error word', () => {
    const g = games.find(x => gameReview(x).moments.length === 3);
    const { moments } = gameReview(g);
    expect(new Set(moments.map(m => m.ply)).size).toBe(3);
    for (let i = 1; i < 3; i++) expect(moments[i - 1].swing).toBeGreaterThanOrEqual(moments[i].swing);
    for (const m of moments) {
      expect(ERROR_WORDS).toContain(m.tier);
      expect(reviewClass(g, m.ply)).toBe(m.tier);
      expect(m.swing).toBeGreaterThan(0);
    }
    // A game nobody misplayed has no moment to point at — never a padded three.
    const clean = toyGame(ITALIAN);
    expect(gameReview(clean).moments).toEqual([]);
  });

  it('carries accuracy for both players and per phase', () => {
    const r = gameReview(games[0]);
    for (const c of ['w', 'b']) { expect(r.accuracy[c]).toBeGreaterThan(0); expect(r.accuracy[c]).toBeLessThanOrEqual(100); }
    expect(Object.keys(r.phases)).toEqual(['opening', 'middlegame', 'endgame']);
    expect(r.phases.opening.moves + r.phases.middlegame.moves + r.phases.endgame.moves).toBe(games[0].moves.length);
  });
});

describe('the opening table', () => {
  afterAll(() => setEcoTable(null));

  it('falls back to the headers while the table is out, so playback never waits on it', () => {
    setEcoTable(null);
    expect(ecoLookup(games[0].fens[1])).toBeNull();
    // Chess.com's ECOUrl slug carries the line, and so an exit ply.
    const op = gameOpening(games[0]);
    expect(op.name).toBe('Modern Defense with 1.e4');
    expect(op.eco).toBe('B06');
    expect(op.exitPly).toBe(3);
    // Lichess's plain Opening header carries a name and nothing else, so the phase cut
    // falls back to ply 20 rather than pretending to know where the book ended.
    const lg = lichess[0];
    expect(lg.headers.ECOUrl).toBeUndefined();
    const lop = gameOpening(lg);
    expect(lop).toEqual({ eco: 'A07', name: "King's Indian Attack, with e6", exitPly: null });
    expect(gamePhases(lg).opening).toBe(20);
    // No headers, no table: the opening is unknown and the phases fall back to ply 20.
    const bare = toyGame(ITALIAN.concat(['h3', 'Bxf3', 'Qxf3', 'Nd4', 'Qd1']));
    expect(gameOpening(bare)).toBeNull();
    expect(gamePhases(bare).opening).toBe(20);
    expect(gameReview(bare).opening).toBeNull();
  });

  it('finds the Italian Game and the ply it was left at', () => {
    setEcoTable(ecoTable);
    const g = toyGame(ITALIAN);
    expect(ecoLookup(g.fens[1])).toEqual({ eco: 'B00', name: "King's Pawn Game" });
    expect(ecoLookup(g.fens[5])).toEqual({ eco: 'C50', name: 'Italian Game' });
    const op = gameOpening(g);
    expect(op.eco).toBe('C50');
    expect(op.name).toBe('Italian Game: Giuoco Pianissimo, Canal Variation');
    expect(op.exitPly).toBe(11);
    // The table's ply wins over the header's, and cuts the opening phase.
    g.headers = { ECO: 'C50', ECOUrl: 'https://www.chess.com/openings/Italian-Game-2...Nc6' };
    expect(gameOpening(g).exitPly).toBe(11);
    expect(gamePhases(g).opening).toBe(11);
    // Book runs to the exit ply, not position by position: the table names fens[9] and
    // fens[11] but not fens[10], and one move demoted out of the book between two that
    // stayed in would be a hole in the table showing through the card.
    expect(ecoLookup(g.fens[10])).toBeNull();
    for (let n = 0; n < 11; n++) expect(reviewClass(g, n)).toBe('book');
    expect(reviewClass(g, 11)).toBe('best');
    const r = gameReview(g);
    expect(r.counts.w.book + r.counts.b.book).toBe(11);
  });

  it('the review cache follows the table landing', () => {
    setEcoTable(null);
    const g = toyGame(ITALIAN);
    const r1 = gameReview(g);
    expect(r1.opening).toBeNull();
    setEcoTable(ecoTable);
    const r2 = gameReview(g);
    expect(r2).not.toBe(r1);
    expect(r2.opening.eco).toBe('C50');
  });
});

describe('phases', () => {
  it('calls it an endgame when both sides are down to thirteen points of pieces', () => {
    expect(isEndgame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(false);
    expect(isEndgame('4k3/8/8/8/8/8/8/R3K2R w - - 0 1')).toBe(true);         // two rooks against a king
    expect(isEndgame('r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1')).toBe(true);       // rook ending, 10 each
    expect(isEndgame('3qk3/8/8/8/8/8/8/R3K1NR w - - 0 1')).toBe(true);       // Q9 vs R5+R5+N3 = 13
    expect(isEndgame('2rqk3/8/8/8/8/8/8/R3K1NR w - - 0 1')).toBe(false);     // Q+R = 14 on one side
    const cuts = gamePhases(games[0]);
    expect(cuts.opening).toBeLessThanOrEqual(cuts.endgame);
    expect(cuts.endgame).toBeLessThanOrEqual(games[0].moves.length);
  });
});

describe('verdictSpeech', () => {
  it('says the three-word verdict and the move the engine preferred, or nothing', () => {
    const g = games[0];
    const n = g.moves.findIndex((m, i) => classifyMove(g, i));
    expect(verdictSpeech(g, n)).toMatch(/^(Inaccuracy|Mistake|Blunder)\. The engine preferred [a-z].*\.$/);
    const fine = g.moves.findIndex((m, i) => !classifyMove(g, i));
    expect(verdictSpeech(g, fine)).toBe('');
    const toy = toyGame(['e4', 'e5'], { best: ['g1f3', 'e7e5'], evalAt: i => (i === 1 ? { cp: -120 } : { cp: 0 }) });
    expect(verdictSpeech(toy, 0)).toBe('Mistake. The engine preferred knight f3.');
  });
});
