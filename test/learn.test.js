/*
 * Learn: the book, the lessons, the import and the drill runner.
 *
 * The claims here are the ones a bug would falsify silently — a trie that quietly
 * grew a tally, a key that stopped being content-addressed so the same line entered
 * twice, a lesson whose fourth step drifted one move out of legality, a guard that
 * held a second time on a ply it had already released. Mechanics are not pinned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { Chess } from 'chess.js';

/* Memory, in memory: the book writes rows and reads them back off S, so the stub only
   has to record what was put and never refuse. */
const puts = [];
vi.mock('../src/memory.js', () => ({
  dbGet: async () => undefined,
  dbPut: async (store, row) => { puts.push({ store, key: row.key }); return true; },
  dbPutAll: async () => true,
  dbDelete: async (store, key) => { puts.push({ store, key, gone: true }); return true; },
  dbAll: async () => [],
}));
const spoken = [];
vi.mock('../src/speech/provider.js', () => ({
  speak: (text, onDone) => { spoken.push(text); if (onDone) onDone(); return 1; },
  cancelSpeech: () => {},
  apiVoiceActive: () => false,
}));
/* The transport is the integrator's; the drill only has to ask it to carry on. */
const transport = { guard: null, plays: 0, pauses: 0 };
vi.mock('../src/playback.js', () => ({
  setGuessGuard: fn => { transport.guard = fn; },
  play: () => { transport.plays++; },
  pause: () => { transport.pauses++; },
}));

import { S } from '../src/state.js';
import { pgnId, START_FEN } from '../src/pgn.js';
import {
  BOXES, RETRY_MS, bookKey, walkLine, bookLines, bookTrie, bookNodeAt,
  addToBook, removeLine, bookDue, gradeLine, bookName, dueLabel, studyRef, importBookPGN,
} from '../src/learn/book.js';
import { lessonStep, nearestStep, movetextSANs, familyOfGame, familyPlayCounts } from '../src/learn/lessons.js';
import { startDrill, stopDrill, drillState, guessGuard, judgeAnswer, answerDrill, revealDrill } from '../src/learn/drills.js';
import { DECK_BOXES, DECK_RETRY_MS } from '../src/deck.js';

const DAY = 24 * 60 * 60 * 1000;
const root = new URL('../', import.meta.url);
const readJSON = rel => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));

const LESSON_FILES = readdirSync(new URL('lessons/', root)).filter(f => f.endsWith('.json') && f !== 'index.json');
const INDEX = readJSON('lessons/index.json');
const LIBRARY = readJSON('openings/library.json');

const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
const CARO = ['e4', 'c6', 'd4', 'd5'];

beforeEach(() => {
  S.book = new Map();
  S.deck = new Map();
  S.tactics = new Map();
  S.games = [];
  S.gi = 0; S.ply = 0; S.awaitingGuess = false;
  puts.length = 0; spoken.length = 0;
  transport.guard = null; transport.plays = 0; transport.pauses = 0;
  stopDrill({ quiet: true });
});

/* ===== The book ===== */

describe('the book', () => {
  it('walks a line to canonical SAN, and refuses one that is not legal', () => {
    expect(walkLine(['e4', 'e5', 'Nf3']).sans).toEqual(['e4', 'e5', 'Nf3']);
    expect(walkLine(['e2e4', 'e7e5']).sans).toEqual(['e4', 'e5']);   // UCI in, SAN out
    expect(walkLine(['e4', 'e4'])).toBeNull();
    expect(walkLine([])).toBeNull();
  });

  it('is content-addressed: a line typed by hand and the same line out of a lesson share one key', () => {
    // The lesson variation arrives as a movetext string; the editor as typed SAN. If
    // the key were anything but a hash of the moves, these would be two rows.
    const fromLesson = movetextSANs('1. e4 e5 2. Nf3 Nc6 3. Bc4');
    const typed = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
    expect(fromLesson).toEqual(typed);
    expect(bookKey('w', fromLesson)).toBe(bookKey('w', typed));
    // …and UCI typed into the editor normalises to the same key through walkLine.
    expect(bookKey('w', walkLine(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']).sans)).toBe(bookKey('w', typed));
    // The colour is part of the identity: the same moves as Black is a different row.
    expect(bookKey('b', typed)).not.toBe(bookKey('w', typed));
    expect(bookKey('w', typed)).toBe('w:' + pgnId(typed.join(' ')));
  });

  it('addToBook dedupes by key and returns null on the duplicate', () => {
    const first = addToBook('w', ITALIAN, 'Italian');
    expect(first).toBeTruthy();
    expect(S.book.size).toBe(1);
    // The same line adopted a second time — from a lesson, say — is the reader agreeing
    // with themselves, not a second row.
    expect(addToBook('w', ITALIAN, 'Italian again')).toBeNull();
    expect(addToBook('w', movetextSANs('1. e4 e5 2. Nf3 Nc6 3. Bc4'), '')).toBeNull();
    expect(S.book.size).toBe(1);
    expect(S.book.get(first.key).name).toBe('Italian');   // the first name stands
    expect(addToBook('w', ['e4', 'e4'], 'nonsense')).toBeNull();   // illegal is null too
    expect(addToBook('x', ITALIAN, 'no colour')).toBeNull();
  });

  it('a new line is due now, in box 0, and removeLine takes it back out', () => {
    const row = addToBook('b', CARO, 'Caro-Kann');
    expect(row.box).toBe(0);
    expect(row.due).toBeLessThanOrEqual(Date.now());
    expect(dueLabel(row)).toBe('due now');
    expect(bookName(row)).toBe('Caro-Kann');
    expect(removeLine(row.key)).toBe(true);
    expect(removeLine(row.key)).toBe(false);
    expect(S.book.size).toBe(0);
  });

  it('names a nameless line by its own moves and never invents one', () => {
    const row = addToBook('w', ITALIAN, '');
    expect(bookName(row)).toBe('1.e4 e5 2.Nf3 Nc6 3.Bc4');
  });
});

describe('the trie', () => {
  beforeEach(() => {
    addToBook('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], 'Italian');
    addToBook('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], 'Ruy Lopez');
    addToBook('w', ['e4', 'e5', 'Nf3'], 'Just the knight');
    addToBook('b', CARO, 'Caro-Kann');
  });

  it('carries no tallies anywhere: a decision has no denominator', () => {
    const seen = [];
    (function walk(node) {
      seen.push(node);
      for (const kid of node.children.values()) walk(kid);
    })(bookTrie('w'));
    expect(seen.length).toBeGreaterThan(5);
    for (const node of seen) {
      // A node with n: 0 on it is a percentage waiting to be printed by accident.
      for (const banned of ['n', 'w', 'd', 'l', 'count', 'games', 'total', 'plays']) {
        expect(node[banned]).toBeUndefined();
      }
      expect(Object.keys(node).sort()).toEqual(node.line ? ['children', 'fen', 'line'] : ['children', 'fen']);
    }
  });

  it('branches by SAN and puts the row at the leaf it ends on', () => {
    const root = bookTrie('w');
    expect(root.fen).toBe(START_FEN);
    expect([...root.children.keys()]).toEqual(['e4']);
    const nf3 = bookNodeAt('w', ['e4', 'e5', 'Nf3']);
    expect([...nf3.children.keys()]).toEqual(['Nc6']);
    expect([...bookNodeAt('w', ['e4', 'e5', 'Nf3', 'Nc6']).children.keys()].sort()).toEqual(['Bb5', 'Bc4']);
    expect(bookNodeAt('w', ['e4', 'e5', 'Nf3', 'Bc4'])).toBeNull();
    expect(bookNodeAt('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']).line.name).toBe('Italian');
    expect(bookNodeAt('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']).line.name).toBe('Ruy Lopez');
    // A line that is a prefix of another is still its own scheduled unit, so the
    // interior node carries its row too.
    expect(nf3.line.name).toBe('Just the knight');
    // One trie per colour, and Black's does not see White's.
    expect([...bookTrie('b').children.keys()]).toEqual(['e4']);
    expect(bookNodeAt('b', ['e4', 'e5'])).toBeNull();
  });

  it('the trie follows the store rather than outliving it', () => {
    expect(bookNodeAt('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])).toBeTruthy();
    removeLine(bookKey('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']));
    expect(bookNodeAt('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])).toBeNull();
    expect(bookNodeAt('w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])).toBeTruthy();
  });
});

describe('the schedule', () => {
  it('is the deck\'s ladder, by import rather than by coincidence', () => {
    expect(BOXES).toEqual(DECK_BOXES);
    expect(RETRY_MS).toBe(DECK_RETRY_MS);
    expect(RETRY_MS).toBe(10 * 60 * 1000);
  });

  it('a pass climbs a box and comes back in that box\'s days', () => {
    const now = 1_700_000_000_000;
    const row = addToBook('w', ITALIAN, 'Italian', now);
    gradeLine(row, true, now);
    expect(row.box).toBe(1);
    expect(row.passes).toBe(1);
    expect(row.due).toBe(now + BOXES[0] * DAY);
    gradeLine(row, true, now);
    expect(row.box).toBe(2);
    expect(row.due).toBe(now + BOXES[1] * DAY);
    // The last box is the ceiling, not a step off the end of the array.
    for (let i = 0; i < 10; i++) gradeLine(row, true, now);
    expect(row.box).toBe(BOXES.length);
    expect(row.due).toBe(now + BOXES[BOXES.length - 1] * DAY);
  });

  it('a miss returns in ten minutes, not tomorrow', () => {
    const now = 1_700_000_000_000;
    const row = addToBook('w', ITALIAN, 'Italian', now);
    gradeLine(row, true, now);
    gradeLine(row, true, now);
    expect(row.box).toBe(2);
    gradeLine(row, false, now);
    expect(row.box).toBe(0);
    expect(row.fails).toBe(1);
    expect(row.due).toBe(now + RETRY_MS);
    expect(row.due - now).toBeLessThan(DAY);   // the whole point of the constant
    expect(dueLabel(row, now)).toBe('in 10 min');
  });
});

describe('bookDue', () => {
  it('is what you failed first, then what has waited longest, and nothing not yet due', () => {
    const now = 1_700_000_000_000;
    const patient = addToBook('w', ['d4', 'd5'], 'patient', now - 5 * DAY);
    const recent = addToBook('w', ['c4', 'e5'], 'recent', now - 1000);
    const failed = addToBook('w', ['Nf3', 'd5'], 'failed', now - 2 * DAY);
    const later = addToBook('w', ['g3', 'd5'], 'later', now);

    patient.due = now - 5 * DAY;
    recent.due = now - 1000;
    failed.due = now - 1000; failed.fails = 3;
    later.due = now + DAY;

    const due = bookDue(now);
    expect(due.map(r => r.name)).toEqual(['failed', 'patient', 'recent']);
    // A line not yet due is not "a smaller amount of due".
    expect(due.some(r => r.name === 'later')).toBe(false);
    expect(bookDue(now + 2 * DAY).map(r => r.name)).toContain('later');
  });
});

/* ===== Import: a study is two games and two leaf lines ===== */

const STUDY_PGN = `[Event "My repertoire: Caro-Kann, Advance"]
[Site "https://lichess.org/study/abcdefgh/11112222"]
[Result "*"]
[UTCDate "2026.01.01"]

1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3 e6 5. Be2 *

[Event "My repertoire: Caro-Kann, Exchange"]
[Site "https://lichess.org/study/abcdefgh/33334444"]
[Result "*"]
[UTCDate "2026.01.01"]

1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Bd3 Nc6 (4... Nf6 5. c3) 5. c3 *
`;

describe('importing a study', () => {
  it('reads a study URL, chapter and all', () => {
    expect(studyRef('https://lichess.org/study/abcdefgh')).toEqual({ study: 'abcdefgh', chapter: '' });
    expect(studyRef('https://lichess.org/study/abcdefgh/11112222')).toEqual({ study: 'abcdefgh', chapter: '11112222' });
    expect(studyRef('not a study')).toBeNull();
  });

  it('turns a two-game study PGN into two leaf lines named by their chapters', () => {
    const r = importBookPGN(STUDY_PGN, 'b');
    expect(r.total).toBe(2);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
    expect(S.book.size).toBe(2);
    const rows = bookLines('b');
    // Lichess writes "Study: Chapter" into [Event]; the chapter is what names the line.
    expect(rows.map(x => x.name)).toEqual(['Caro-Kann, Advance', 'Caro-Kann, Exchange']);
    expect(rows[0].moves).toEqual(['e4', 'c6', 'd4', 'd5', 'e5', 'Bf5', 'Nf3', 'e6', 'Be2']);
    // The variation in chapter two is dropped: a chapter's main line is the decision.
    expect(rows[1].moves).toEqual(['e4', 'c6', 'd4', 'd5', 'exd5', 'cxd5', 'Bd3', 'Nc6', 'c3']);
    // Each is its own leaf, with its own box, so a sideline comes due by itself.
    for (const row of rows) { expect(row.box).toBe(0); expect(row.color).toBe('b'); }
    // Re-importing the same study writes nothing.
    const again = importBookPGN(STUDY_PGN, 'b');
    expect(again).toMatchObject({ added: 0, dupes: 2 });
    expect(S.book.size).toBe(2);
  });

  it('refuses a whole database rather than writing two hundred lines', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      '[Event "g' + i + '"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n').join('\n');
    const r = importBookPGN(many, 'w', 3);
    expect(r.over).toBe(5);
    expect(r.added).toBe(0);
    expect(S.book.size).toBe(0);
  });
});

/* ===== The lessons ===== */

describe('the lesson catalogue', () => {
  it('ships twenty-three lessons and one row each in the index', () => {
    expect(LESSON_FILES.length).toBe(23);
    expect(INDEX.lessons.length).toBe(23);
    const ids = new Set(INDEX.lessons.map(l => l.id));
    for (const f of LESSON_FILES) expect(ids.has(f.replace(/\.json$/, ''))).toBe(true);
    // Every catalogue row is drawn in a group that exists.
    const groups = new Set(INDEX.groups.map(g => g.id));
    for (const l of INDEX.lessons) expect(groups.has(l.group)).toBe(true);
  });

  it('every step of every lesson is a legal sequence from the start', () => {
    for (const file of LESSON_FILES) {
      const lesson = readJSON('lessons/' + file);
      expect(lesson.id, file).toBe(file.replace(/\.json$/, ''));
      expect(['w', 'b'], file).toContain(lesson.color);
      expect(lesson.steps.length, file).toBeGreaterThan(0);
      lesson.steps.forEach((step, k) => {
        const where = file + ' step ' + (k + 1);
        // A step's moves are SAN from the START, not from the step before it — which
        // is what lets a lesson double back to move three and take the other branch.
        expect(walkLine(step.moves), where).not.toBeNull();
        expect(String(step.note || '').length, where).toBeGreaterThan(20);
      });
      for (const ln of lesson.lines || []) {
        expect(walkLine(ln.moves), file + ' line "' + ln.name + '"').not.toBeNull();
      }
    }
  });

  it('every lesson\'s family exists in the library', () => {
    const names = new Set(LIBRARY.families.map(f => f.name));
    for (const l of INDEX.lessons) {
      // A lesson whose family has been renamed out from under it loses its shelf and
      // its "more lines in the …" offer, in silence. This is the check for that.
      expect(names.has(l.family), l.id + ' → ' + l.family).toBe(true);
    }
  });

  it('the walker\'s FEN for step k is exactly what replaying that step\'s moves gives', () => {
    for (const file of LESSON_FILES) {
      const lesson = readJSON('lessons/' + file);
      lesson.steps.forEach((step, k) => {
        const pos = lessonStep(lesson, k);
        const chess = new Chess();
        let last = null;
        for (const san of step.moves) last = chess.move(san);
        expect(pos.fen, file + ' step ' + (k + 1)).toBe(chess.fen());
        expect(pos.from).toBe(last ? last.from : null);
        expect(pos.to).toBe(last ? last.to : null);
      });
      expect(lessonStep(lesson, lesson.steps.length)).toBeNull();
    }
  });

  it('a press on the score lands on a step the lesson actually taught', () => {
    const lesson = readJSON('lessons/italian-game.json');
    for (let cur = 0; cur < lesson.steps.length; cur++) {
      for (let n = 0; n <= 8; n++) {
        const k = nearestStep(lesson, n, cur);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThan(lesson.steps.length);
      }
    }
    // Standing on step 0 and pressing the move it is showing keeps you there.
    expect(nearestStep(lesson, lesson.steps[0].moves.length, 0)).toBe(0);
  });

  it('reads the family off a game\'s headers, and guesses nothing from ECO alone', () => {
    const names = new Set(['Italian Game', "Queen's Gambit", "Queen's Gambit Declined"]);
    expect(familyOfGame({ Opening: 'Italian Game: Giuoco Piano' }, names)).toBe('Italian Game');
    // The longest matching slug wins, so Declined beats the shorter family.
    expect(familyOfGame({ ECOUrl: 'https://chess.com/openings/Queens-Gambit-Declined-Main-Line' }, names))
      .toBe("Queen's Gambit Declined");
    expect(familyOfGame({ ECO: 'C50' }, names)).toBeNull();
    const counts = familyPlayCounts(
      [{ headers: { Opening: 'Italian Game: Two Knights' } }, { headers: { Opening: 'Italian Game' } }, { headers: {} }],
      [{ name: 'Italian Game' }],
    );
    expect(counts.get('Italian Game')).toBe(2);
  });
});

/* ===== The drill runner ===== */

const toyGame = (sans, id = 'g1') => {
  const chess = new Chess();
  const moves = sans.map(s => chess.move(s));
  const fens = [START_FEN];
  const c2 = new Chess();
  for (const s of sans) { c2.move(s); fens.push(c2.fen()); }
  return { id, headers: { White: 'A', Black: 'B' }, moves, fens };
};

describe('the judge', () => {
  it('says right, legal or illegal and never a fourth thing', () => {
    expect(judgeAnswer(START_FEN, 'e4', 'e4')).toBe('right');
    expect(judgeAnswer(START_FEN, 'e2e4', 'e4')).toBe('right');   // SAN and UCI meet here
    expect(judgeAnswer(START_FEN, 'e4', 'e2e4')).toBe('right');
    expect(judgeAnswer(START_FEN, 'd4', 'e4')).toBe('legal');
    expect(judgeAnswer(START_FEN, 'e5', 'e4')).toBe('illegal');
    expect(judgeAnswer(START_FEN, '', 'e4')).toBe('illegal');
    // Nothing to compare against never claims the answer was right.
    expect(judgeAnswer(START_FEN, 'e4', '')).toBe('legal');
  });
});

describe('the guess guard', () => {
  const GAME = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];

  it('holds only for the chosen side', () => {
    const g = toyGame(GAME);
    S.games = [g]; S.gi = 0; S.ply = 0;
    expect(startDrill('guess', { side: 'w' })).toBeTruthy();
    expect(transport.guard).toBe(guessGuard);
    expect(guessGuard(g, 0)).toBe(true);    // 1.e4 — White
    expect(guessGuard(g, 1)).toBe(false);   // 1…e5 — Black
    expect(guessGuard(g, 2)).toBe(true);
    expect(guessGuard(g, 99)).toBe(false);  // past the end of the game

    startDrill('guess', { side: 'b' });
    expect(guessGuard(g, 0)).toBe(false);
    expect(guessGuard(g, 1)).toBe(true);

    startDrill('guess', { side: 'both' });
    expect(guessGuard(g, 0)).toBe(true);
    expect(guessGuard(g, 1)).toBe(true);
  });

  it('never holds twice on a ply it has already shown', () => {
    const g = toyGame(GAME);
    S.games = [g]; S.gi = 0; S.ply = 0;
    startDrill('guess', { side: 'w' });
    expect(guessGuard(g, 0)).toBe(true);

    // A right answer releases the hold. Releasing is play(), which re-enters the loop
    // at the same ply — so a guard that did not remember would hold on it forever.
    S.awaitingGuess = true;
    answerDrill('e4');
    expect(S.awaitingGuess).toBe(false);
    expect(transport.plays).toBeGreaterThan(0);
    expect(guessGuard(g, 0)).toBe(false);
    expect(guessGuard(g, 2)).toBe(true);
    expect(drillState().right).toBe(1);

    // Reveal releases it too, and costs the point rather than the question.
    S.ply = 2; S.awaitingGuess = true;
    revealDrill();
    expect(guessGuard(g, 2)).toBe(false);
    expect(drillState()).toMatchObject({ right: 1, asked: 2 });
  });

  it('a wrong answer spends nothing: the hold stays and the question is still open', () => {
    const g = toyGame(GAME);
    S.games = [g]; S.gi = 0; S.ply = 0;
    startDrill('guess', { side: 'w' });
    S.awaitingGuess = true;
    answerDrill('d4');           // legal, but not what was played
    expect(S.awaitingGuess).toBe(true);
    expect(guessGuard(g, 0)).toBe(true);
    answerDrill('Kd4');          // not a move at all
    expect(S.awaitingGuess).toBe(true);
    expect(drillState().asked).toBe(0);
  });

  it('stops with no drill running and takes the guard back off the transport', () => {
    const g = toyGame(GAME);
    S.games = [g];
    startDrill('guess', { side: 'w' });
    expect(drillState().kind).toBe('guess');
    stopDrill();
    expect(drillState()).toBeNull();
    expect(transport.guard).toBeNull();
    expect(guessGuard(g, 0)).toBe(false);
  });

  it('refuses to start on an empty queue and says nothing false about it', () => {
    S.games = [];
    expect(startDrill('guess')).toBeNull();
    expect(startDrill('deck')).toBeNull();
    expect(startDrill('book')).toBeNull();
    expect(startDrill('tactics')).toBeNull();
    expect(startDrill('nonsense')).toBeNull();
    expect(drillState()).toBeNull();
  });
});

describe('drilling the book', () => {
  it('plays the other side itself and asks for every move of yours', () => {
    const now = Date.now();
    addToBook('b', ['e4', 'c6', 'd4', 'd5'], 'Caro-Kann', now);
    const st = startDrill('book');
    expect(st).toMatchObject({ kind: 'book', total: 1 });
    // White's 1.e4 played itself before the first question, and was spoken.
    expect(drillState().at).toBe(1);
    expect(spoken.length).toBe(1);
    answerDrill('c6');
    // …and 2.d4 followed on its own, leaving the reader's second move in hand.
    expect(drillState().at).toBe(3);
    answerDrill('d5');
    const row = [...S.book.values()][0];
    expect(row.box).toBe(1);        // every ply right first time: the line passes
    expect(row.passes).toBe(1);
    expect(row.due).toBeGreaterThan(now + BOXES[0] * DAY - 5000);
    expect(drillState().right).toBe(1);
  });

  it('one miss fails the line, and the line comes back in ten minutes', () => {
    const now = Date.now();
    addToBook('b', ['e4', 'c6', 'd4', 'd5'], 'Caro-Kann', now);
    startDrill('book');
    answerDrill('e6');              // legal, but not the reader's own decision
    answerDrill('d5');              // right, but the line is already spent
    const row = [...S.book.values()][0];
    expect(row.box).toBe(0);
    expect(row.fails).toBe(1);
    expect(row.due - now).toBeLessThan(DAY);
    expect(row.due - now).toBeGreaterThan(RETRY_MS - 5000);
    expect(drillState().right).toBe(0);
  });

  it('deals every due line in bookDue order and then has nothing left', () => {
    const now = Date.now() - DAY;
    addToBook('w', ['e4', 'e5', 'Nf3'], 'one', now);
    addToBook('w', ['d4', 'd5', 'c4'], 'two', now + 1);
    const st = startDrill('book');
    expect(st.total).toBe(2);
    answerDrill('e4'); answerDrill('Nf3');
    expect(drillState().i).toBe(1);
    answerDrill('d4'); answerDrill('c4');
    // The run stays open on its report; there is simply no line in hand.
    expect(drillState()).toMatchObject({ i: 2, right: 2, asked: 2, key: '' });
  });
});
