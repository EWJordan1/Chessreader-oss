# The review module

`src/review.js`, `css/review.css`, `test/review.test.js`, `openings/eco.json` (read only).
Mounts: `#review-mount` (the Review card), `#turn-strip` (the three chips in the Score
header), and the move tree's marks through `setTreeMark`.

## What exists

The middle between a move and the archive: how one game was played. Everything here is
arithmetic over `game.analysis` (the engine's) and `game.fens` (the parser's). The module
makes no engine requests; the only thing it fetches is the opening table.

### The API (contract "Review API")

| Export | Answer |
| --- | --- |
| `classifyMove(game, n)` | `inaccuracy` (50cp) · `mistake` (100) · `blunder` (300) · `null` |
| `reviewClass(game, n)` | one of `REVIEW_WORDS`, or `null` when the ply is unjudged |
| `winProb(cp)` | Lichess's curve, White-positive, clamped at ±1500 |
| `moveLoss(game, n)` | centipawns the mover lost, floored at 0, capped at `LOSS_CAP` (1000); `null` when unjudged |
| `gameReview(game)` | `{accuracy:{w,b}, plies, phases, moments, opening, counts, bounds, complete, judged, sig}` |
| `ecoLookup(fen)` | `{eco, name}` or `null` (null too while the table is not loaded) |
| `verdictSpeech(game, n)` | `"Mistake. The engine preferred knight f3."` or `''` |
| `boot()` | installs the tree mark, the card, the chips, the repaints |

Also exported, for tests and for the modules that want the figure rather than the word:
`analysisReady`, `moveAccuracy`, `aggregateAccuracy`, `gameOpening`, `headerOpening`,
`gamePhases`, `isEndgame`, `setEcoTable`, `loadEcoTable`, `ecoLoaded`, and the constants
`SWING`, `DECIDED_WIN_PCT`, `LOSS_CAP`, `ENDGAME_POINTS`, `REVIEW_WORDS`, `ERROR_WORDS`.

`n` is the move index: move `n` goes from `fens[n]` to `fens[n+1]`; `evals[i]` evaluates
`fens[i]`, White-positive.

## The decisions

**Two functions, on purpose.** `classifyMove()` is guarded: `null` when the played move
*is* `analysis.best[n]` (compared as UCI, promotion included — two depth-limited searches
drift, and without this a forced recapture picks up 100–300cp of drift and gets called a
mistake), `null` when the mover's win probability before the move was ≤ 5% (already lost),
and `null` when it was ≥ 95% before *and* after (still won — +12 to +9 is nothing). The
guard is a win-probability floor rather than a centipawn one because only the curve knows
that +2→+4 is enormous and +9→+11 is nothing.

`reviewClass()` is a second function over the same figures. It tests the error words
first, *off `classifyMove()`*, so the two can never disagree about whether a move was an
error — pinned in the test: `classifyMove ≠ null ⇒ reviewClass ∈ {inaccuracy, mistake,
miss, blunder}`. Then: `book` (the move comes before the game's book-exit ply), `best`
(played = best; `great`/`brilliant` when the second pass allows), else
`excellent` (< 20cp) / `good`. A guarded move that was not the engine's is `excellent` or
`good` by its loss — never an error word, since the trainer's voice already refused to
call it one. An inaccuracy played inside a book line is still an inaccuracy: the table
names positions, it does not vouch for them.

**`book` is cut on the exit ply, not asked position by position.** The table is a list of
named *lines*, so it has holes: in the Giuoco Pianissimo it names the position after 5.Nc3
and the one after 6.Bg5 but not the one after 5…d6 between them. Judging each position on
its own would demote that one move out of the book and leave the card's `book` count
disagreeing with the opening phase the same exit ply cuts — a hole in the table showing
through as something that happened at the board. Pinned in the test, at that exact ply.
`gameOpening()` is memoised per game on the table's epoch (`game._opening`), because
`reviewClass()` asks per ply and the answer is thirty lookups.

**The vocabulary is ten words.** The spec says eleven and lists ten; the original's
eleventh was `forced`, which the contract's list and `TREE_MARKS` both omit. A move with
no alternative is `best` here.

**Miss.** The mover *had* a win — a mate for them, or ≥ +300cp from their side — played a
mistake or worse (loss ≥ 100), and no longer has the win by the same bar afterwards. +15
to +12 is a mistake, not a miss; the win is still there.

**Great and Brilliant wait for `alts`.** `alts[n] === undefined` (never asked) and
`alts[n] === null` (asked, forced) both mean `best` — never a guess; a wrong Brilliant is
the one error a reader believes. With an answer in: Great when the second-best is ≥ 100cp
worse for the mover *and* the mover's win probability before the move was inside 10–90%
(at +7 "the only move that keeps +7" is bookkeeping). Brilliant when Great and the move is
a sacrifice: the moved piece can be taken next ply by something cheaper, or by anything
with no recapture; or the engine's own line (`pv[n]`) ends with the mover ≥ 200cp down.
`chess.js` is the rules authority for both.

**Mates.** A mate becomes ±10000cp before the curve — past the clamp, so every mate is
99.6% whatever its distance. Loss between a mate and a centipawn eval is then capped at
1000 by `LOSS_CAP`. A `mate: 0` (the mated position itself) is read off whose move it is.

**Accuracy is from win probability, not loss.** Per move: `103.1668·e^(−0.04354·drop) −
3.1669`, clamped 0..100, where `drop = max(0, winBefore − winAfter)` from the mover's
side — only losses count. Per player per game: Lichess's aggregate — a volatility-weighted
mean (each move weighted by the standard deviation of the win probability over a short
window around it, floored at 0.5) averaged with the harmonic mean, which punishes a single
catastrophe rather than diluting it. This is non-linear, so an archive's accuracy is the
mean of its games' figures, never the aggregate over concatenated moves; the test builds
two half-games and shows the two differ. Phase accuracy is the same aggregate over the
phase's moves.

**Phases.** The opening ends at the book-exit ply: the deepest position (≤ 30 plies) the
table names; else the ply the Chess.com `ECOUrl` slug ends at; else 20. The endgame begins
at the first ply from there on where *both* sides have ≤ 13 points of non-pawn material
(Q9 R5 B3 N3 — two rooks and a minor, or a queen and a minor). `ENDGAME_POINTS` is named
so the number a phase accuracy is cut on can be argued with. `review.bounds =
{opening, endgame}` carries the cuts.

**Moments.** The three largest swings in win probability, from the mover's side, among
*errors only* — a big swing on a fine move is two searches disagreeing, not the game
turning. Never padded: a clean game has no moments and the card says so in a sentence.
`{ply, tier, color, swing, loss}`, sorted by swing.

**The opening.** `gameOpening()` reads the table (deepest hit) and falls back to the
headers — the `ECOUrl` slug gives both a name and an exit ply, a Lichess `Opening` header
gives a name only. The table wins wherever it has an answer, and is more conservative
than Chess.com's slugs: this table names 1.e4 g6 "Modern Defense" and has no entry after
2.d4, so that game's book exits at ply 2 where the header says 3.

**The table is fetched lazily and once.** `boot()` never fetches. `paint()` starts the
download the first time a game with analysis is on screen; the promise is memoised so
forty games ask once; a failure resolves to "no table" and the card names openings from
the headers for the session. When it lands the tree is repainted and the card redrawn.
Lookups drop the en-passant field on a second try, because the table writes `e3` after
1.e4 and chess.js writes `-` unless a capture is actually possible.

**The cache.** `game._review` carries `sig = done:altsDone:ecoEpoch`; a review taken
halfway through a scan, before the second pass, or before the table landed is replaced,
not believed. `gameReview()` returns `null` for a game with no analysis and a partial
review flagged `complete: false` while a scan runs.

**The UI.** The tree wears the review's words once `analysisReady`, and `classifyMove()`'s
three while a scan is still running — a partial review would say `book` and `best` of the
analysed half and nothing of the rest. The card is a `.panel` appended to
`#review-mount` (`#review-section`), hidden — not emptied — when the current game has no
analysis: two accuracy tiles, the ten words × two players, accuracy by phase (only the
phases the game reached), the three moments as chips, the opening and its ECO. The same
three chips go in `#turn-strip`, only while `stageOwner() === 'play'`. A chip calls
`goToPly(ply + 1)` then `showBoard()`. Repaints on `cr:analysis`, `cr:analysis-done`,
`cr:alts-done` (for the current game only) and on the `all` and `board` render hooks;
both the card and the strip are guarded by a signature so a scan does not rebuild the
table two hundred times. Sentences take the serif (`.rev-sentence`), numbers the sans.

**`verdictSpeech`** speaks the *three-word* verdict — the spoken register is the trainer's
— then the engine's move built as a chess.js verbose move on `fens[n]` and said through
`moveToSpeech(…, 'natural')`. Empty for a fine move, so a caller can speak it
unconditionally. `boot()` installs it through `setVerdictSpeech()`, which `playStep()`
appends to the move's sentence — so an error is heard in the same breath as the move, and
`classifyMove()`'s guard is what keeps a forced recapture from being called a blunder
aloud. The wider vocabulary is deliberately *not* what is installed: a reading that
announced "Book" and "Excellent" after every move would be unlistenable.

## Row shapes

Nothing stored. `game._review` is a per-session cache, underscore-prefixed per the contract.

## Tests

`test/review.test.js`, 19 cases, node environment, over the 34 `chesscom.pgn` games with
`evals.json` attached, `lichess.pgn` for the other half of the header fallback (a plain
`Opening` header and no `ECOUrl`, so a name and no exit ply), and toy games built from SAN. What is pinned: the two vocabularies
stay apart and never disagree about an error; the engine's own move is never an error;
silence from an already-lost position, at the centipawn the *curve* puts the 5% floor on
rather than a round number; `moveLoss` floored and capped; both accuracy constants written
out; per-game aggregation differing from the concatenated one; the review cache falling
when `done`, `altsDone` or the table moves; three distinct moments largest-first, and none
at all in a clean game; `book` running to the exit ply across the table's hole; both
header fallbacks while the table is out.

Three of the failing expectations this module inherited were the test's rather than the
module's and were corrected against reality: `eco.json` names 1.e4 "King's Pawn Game", not
"King's Pawn Opening"; the toy continuation `Bxg5` was illegal in the position it was
played from; and the published accuracy constants do not meet at exactly 100 for a
lossless move (103.1668 − 3.1669 = 99.9999), so the tolerance gave way rather than the
constants. A fourth had the sign of a Black mover's win backwards, and a fifth called a
retreat that saves a bishop (7.Bh4) a sacrifice — replaced with one that is (7.Bxf7+).

## Asks

- **`S.analysisOn`.** The review ignores it and reviews whatever `game.analysis` holds.
  If the engine module empties `game.analysis` when the reader turns analysis off, nothing
  is needed; if it keeps the evals and expects the review to hide, the review needs a word
  from the contract on which flag to honour.
- **`emptyHTML`'s door** takes an action string; the review's clean-game sentence has no
  sensible door, so it is a plain `.rev-sentence` rather than `emptyHTML()`.
- The spec's "eleven words" should read ten, or the contract should add `forced` back to
  `TREE_MARKS` and the list.
