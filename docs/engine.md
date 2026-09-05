# Engine

What analysis is, what it stores, and where the arguments were.

## What exists

| File | |
| --- | --- |
| `src/engine/uci.js` | the text both engines speak: `parseInfo`, `parseBestmove`, `newSearch`, `goCommand`, `PV_PLIES` |
| `src/engine/local.js` | the vendored WebAssembly Stockfish, driven from the main thread |
| `src/engine/remote.js` | the two remote transports, the health check, and `normaliseResult` |
| `src/engine/provider.js` | one `analyse()` over both, selected per job kind |
| `src/engine/analyse.js` | the jobs, the queue, the cache, the second pass, and the panels |
| `src/engine/sweep.js` | the archive pass: consent, pause, pace, the measured estimate, the queue list |
| `server/` | the optional reference server — see `server/README.md` for the wire format |
| `css/engine.css` | the tools, the marks, the Engine panel, the sweep bar and its list |

### The API (contract §Engine API)

```js
// provider.js
analyse(fen, {depth, multipv, movetimeMs, signal, kind}) → {cp?, mate?, pv, depth, lines?}
analyseBatch(items, {kind}), engineStatus(), providerFor(kind), batchable(kind), onFallback(fn)
// analyse.js
analyseGame(game, opts?), probe(fen, depth), analysisReady(game), classifyable(game, ply)
ENGINE_BUILD, SCAN_DEPTH = 18, SCAN_MOVETIME = 600, PROBE_MOVETIME = 6000
applyEvalRow(game, row), evalRow(game), boot()
// sweep.js
startSweep(), pauseSweep(byUser), resumeSweep(byUser = true), stopSweep(), sweepState(), boot()
```

Everything the contract names is exported with the shape it names. The additions are all
either test seams or things another module of mine needed:

- `analyseGame(game, opts)` takes `{kind, paceMs, noAlts}` — the sweep's own call.
- `resumeSweep(byUser = true)` takes the flag `pauseSweep` takes, for the same reason:
  an auto-resume must lift only its own press. A bare `resumeSweep()` is the reader's.
- `hydrate`, `isCached`, `forgetCache`, `cancelGame`, `cancelScans`, `onSearch`,
  `jobState`, `persistAllRows`, `flushRow`, `blankAnalysis`, `whitePositive`,
  `altsShortlist`, the row codecs, `_resetAnalyse`.
- sweep: `resumeFromCursor`, `paused`, `estimateMs`, `etaText`, `feedSearch`,
  `searchCostMs`, `skipRatio`, `sweepOrder`, `gameTime`, `skip/unskip/reanalyseGame`,
  `EMA_MIN_SEARCHES`, `_resetSweep`.

## The decisions

**The cache stamp is checked, never reconciled.** `applyEvalRow` returns false and
changes *nothing* when the row's `build` or `depth` disagrees, or when its ply count
belongs to another game. Merging the agreeing half would be worse than dropping the row:
one evaluation from a shallower search sitting between two deep ones turns a forced
recapture into a blunder, and there is no later stage that can notice. A **partial** row
is a different thing and is kept — it is honest about what it contains, and the scan
queues only the holes. A merge only ever fills holes, so a number the engine produced
this session is never overwritten by one off the disk.

The stamp is `sf17.1-lite` at depth 18. Changing either constant invalidates every
stored row, which is the point of it being two constants rather than a version bump.

**A disagreeing row is ignored, not deleted.** The next scan overwrites it. Erasing a
reader's whole eval cache because a build string moved is the worse of the two failures,
and one press of Analyse recovers from the milder one.

**White-positive happens once, at the commit.** The provider hands back what UCI says,
which is from the side to move. `commit()` converts and everything downstream —
`review.js`, `deck.js`, `insights.js` — reads White-positive without knowing this
existed. A remote server that "helpfully" converts first inverts every Black-to-move
evaluation in the archive; `server/README.md` says so in bold.

**A probe jumps the queue and the scan it interrupted is re-queued whole.** The
in-flight search is aborted and its numbers dropped on the floor — a search stopped at a
depth it never meant to reach must not be committed beside deep ones. Because the task
resumes by recomputing what is still missing, "whole" costs one re-search of one ply.

**The row is debounced, not written per ply.** Two seconds of quiet, or every forty
plies, so a scan the reader closes at move ten has still written move ten.

**`best` is not stored.** It is `pv[i][0]`; two spellings of one fact is how the two
drift. `lines` is most of the row's size (~7KB against a 2KB PGN) and is kept anyway:
after a scan the engine never runs again, so a line dropped from the cache is a line
missing from every explanation the reader ever asks for.

**The second pass is a shortlist, not the game.** *Great* and *Brilliant* are claims
about the moves that were **not** played, and the scan runs MultiPV 1. Inferring "only
move" from the evaluation delta is the one guess a reader would believe, so the answer
is asked for: MultiPV 2 over plies where the played move was already the engine's, in
contested positions only (win probability 10–90), capped at 24, sharpest first — sharp
being the size of the swing across the move, which is the cheapest honest proxy for a
position where the second-best line falls away. Answers land in `alts[]`: `undefined`
never asked, `null` asked and forced, `{cp}|{mate}` the second-best evaluation. The row
has no `altsDone` column and does not need one — the pass writes its whole shortlist at
once, so a complete scan carrying any alt has had its pass.

**The sweep does not run the second pass.** Its job is the deck, which needs the
evaluations and nothing else. Twenty-four extra searches a game to settle two words in a
review nobody has opened is the wrong trade at archive scale; a reader's own press
covers the games they actually read.

**Pace is a duty cycle, never a depth.** A game swept at depth 12 would be discarded
whole by the very stamp rule above, so the sweep's only lever is the idle gap between
searches (0 / 600 / 1800ms). The gap is interruptible: a probe cuts it short and the
sweep gives up its turn rather than making the reader wait on a setting they chose for
the background.

**The estimate is measured.** An EMA (α 0.1) of what a search actually costs on this
machine, silent until thirty searches have fed it, "about" for the life of the feature.
The pace's gap is priced in per search. What is left is counted exactly for games whose
row has been read, and discounted by the observed skip ratio for games whose row is
still on the disk — some proportion of them will need no searches at all, and pretending
otherwise makes the first estimate of a returning reader's session absurd.

**Three flags, three lifetimes.** `S.sweepOn` (consent) and `S.sweepPaused` (the
reader's pause) are settings and survive a reload; `S._sweepAutoPaused` (a hidden tab)
is session state and dies with the tab. A resume lifts only its own press. This is the
one place in the app that starts work without a press in front of it, and it is the
spec's rule: a sweep started yesterday picks up this morning, skipping what is cached.

**A stale loop is fenced by a generation.** Stopping and starting again would otherwise
leave yesterday's `loop()` walking today's queue from inside an `await`.

## The row

`evals`, keyed on `gameId` (memory owns the store, this module owns the row):

```js
{ gameId, build: 'sf17.1-lite', depth: 18, plies: 41,
  evals: '30,25,m2,,-40',        // per ply, White-positive; empty = not evaluated
  lines: 'e2e4 e7e5|g1f3|',      // per ply, UCI, 8 plies max; best[i] is lines[i][0]
  alts:  ',n,,0',                // per ply; empty = never asked, n = asked and forced
  bytes }                        // the row's own size, so memUsage() need not re-measure
```

Trailing empties are trimmed; `plies` restores the length, and a `plies` that disagrees
with `game.fens.length` rejects the row.

## The panels

- `#btn-analyse` (the press), `#analysis-tools` (the three probe depths and **Lines**).
- `#analysis-status`: one sentence — loading, analysing *n* of *m* at the depth actually
  reached, or what the cache holds. Never taller than a line.
- `#scrub-marks`: one mark per move `classifyMove()` calls an error, at its place along
  the slider. The *guarded* three-word vocabulary, imported from `review.js` rather than
  re-thresholded here, so the mark, the arrow and the spoken verdict cannot disagree.
- `#analysis-mount` grows an **Engine** panel: up to three lines from the last probe,
  each a score and a `moveRunHTML(…, {style:'line'})` run. A press on a move walks the
  line as a variation of the reader's own (`enterVariation`), so nothing downstream
  needs a second kind of "position on screen".
- `#sweep-bar` (Start/Pause/Resume/Stop, progress, the hedged estimate) repaints on a
  1Hz tick as well as at game boundaries, so a long game does not look like a stall.
- `#sweep-settings`: the controls plus **Show the games** — every game, what the engine
  has done to it, and the one action that makes sense there (skip / take back /
  re-analyse).

## Asks

Things needed from files this module does not own. Nothing here blocks anything: each
has a working shim in place.

1. **`engine/` must be copied into the build.** `vite build` does not copy the vendored
   `engine/*.js` and `engine/*.wasm` — dev works because Vite serves the project root,
   the built site would 404. Either move `engine/` into a `public/` directory or add a
   copy step to `vite.config.js`. The local engine is *dev-only* until this lands.
   (`ENGINE_URL` is root-relative on purpose: a `new URL(…, import.meta.url)` would let
   Vite hash-rename the loader, and the loader derives its `.wasm` path from its own
   filename.)
2. **`index.html`: the analysis tools live outside the panel head.** `#analysis-tools`
   sits in the transport row, so the depth buttons stand beside ⇅ Flip rather than with
   the Engine panel they feed. Not wrong, but a `.tools` span in the Engine panel's
   header would read better once one exists.
3. **`state.js`: `S.sweepPace` has no label table.** Settings paints the raw keys
   (`fast` / `steady` / `gentle`) into `#set-sweep-pace`. A `SWEEP_PACE_NAMES` beside
   `SWEEP_PACES`, spelled like `THEME_NAMES`, would let it say "Gentle — a pause between
   positions" instead.
4. **A `cr:sweep`-aware place for the bar.** `#sweep-bar` is painted here and hidden
   when idle; if the shell ever wants it in the rail instead, the event carries the
   whole state object already.
5. **`memory.js`: nothing.** The ask in `docs/memory.md` — that the engine write its
   rows when `remember` goes on — is answered: `analyse.js` listens for `cr:setting`
   with `key: 'remember'` and writes every session game whose `analysis.done > 0`.

## Tests

`test/engine.test.js` (27) — the UCI parsing; the provider contract over **both**
transports against a stub HTTP + WebSocket server started in the test, including the
one-toast fallback; the row codecs and every stamp rule; the queue (a probe jumping, an
abandoned scan re-queued whole, a half-scanned game resuming, a cached game costing
nothing); the shortlist over `fixtures/evals.json` + `chesscom.pgn`.

`test/sweep.test.js` (17) — the order; the estimate's silence, its average, the pace
priced in, the skip-ratio discount; user-vs-auto pause; the cursor written, resumed
from, and skipping what the cache covers.

`test/engine-live.spec.js` — the one thing no unit test can prove: the real wasm engine
loading in a real browser. Excluded from `npm run walk` by `playwright.config.js`'s
`testMatch`; run it with `npx playwright test --config test/engine-live.config.js`.
