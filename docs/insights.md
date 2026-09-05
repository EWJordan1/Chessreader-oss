# Insights

Eight panes of arithmetic over the loaded games. Nothing here is fetched, analysed or
uploaded; the one row the module ever writes is `meta/recsHidden`, which remembers the
recommendations the reader waved away.

Files: `src/insights.js`, `css/insights.css`, `test/insights.test.js`, this file.
Mount: `#insights-body`. Room: `insights`, registered in `boot()`.

## What exists

| Pane | Built from | Reads the engine |
| --- | --- | --- |
| 1 The record | `computeStats` | no |
| 2 Form | `formReport` + `meanAccuracy` | for the accuracy tile |
| 3 The clock | `clockReport` | for what a move cost |
| 4 Habits | `habitReport` | no |
| 5 Compare | `compareSets` + `compareRows` | for the accuracy row |
| 6 The opening explorer | `buildExplorer` + `explorerWalk` | no |
| 7 Where it goes wrong | `patternReport` | yes, entirely |
| 8 What to work on | `recommendations` | for three of its six generators |

`renderReport(container, games, heroKey, {about, name, room})` paints all eight into any
container. Prep points it at an opponent's archive with `about: 'them'` and gets the same
report in the third person; there is one report per container, held in a module-level set,
so Insights and Prep can each hold one without either knowing about the other.

Every pane is a pure function of `(games, heroKey)`. The room is a thin shell: resolve the
subject, draw the header and the picker, call `renderReport`.

### The second paint

The engine-fed half paints twice — from the headers on arrival, and again when
`cr:analysis-done` lands. `scheduleEngineRepaint` debounces the burst a sweep produces
(300ms), then `repaintEngine` bumps a per-pane generation counter and queues the paint;
only the newest generation for a pane is allowed to land, so a slow paint queued first
cannot overwrite a newer one. `cr:games-added`, `cr:games-removed` and `cr:restored` drop
every cache and repaint the room if it is the one on screen.

## The decisions

### The subject is inferred, not configured

A PGN carries no "you". `resolveHero(games)` takes the name appearing in the most games;
`S.heroOverride` wins when it names somebody present; a tie at the top is broken by the
remembered Chess.com or Lichess handle, and only a tie — a remembered handle never
overturns a clear winner. Changing the pick calls `dropCaches()`, because every figure on
the page derives from that one choice. `'?'` is PGN for "nobody", so `playerKey` maps it
to the empty string and it is never a candidate.

### The rules with teeth

Each of these has a comment in the source saying why the obvious alternative is wrong, and
a test that would fail if it were quietly undone.

- **Time trouble is the last tenth of that game's own base clock** (`TROUBLE_FRACTION`),
  never a number of seconds. A minute is the whole game in bullet and nothing in
  classical; a fixed threshold would report the time control rather than the habit. The
  same twenty seconds on the clock is comfortable in a 1+0 and squarely inside trouble in
  a 10+0, and `test/insights.test.js` pins exactly that pair. `timeTrouble` returns
  **null, not false**, when there is no clock to ask (no readings, a dropped series, a
  correspondence game, a ply past the end), so an archive without clocks counts towards
  nothing rather than towards "never in trouble".
- **Clock readings come off the raw PGN.** `cleanPGN` strips `{[%clk …]}` on the way to a
  move list, so `clockSeries` reads `game.pgn` with a regex. Both dialects are matched —
  Chess.com's `{[%clk 0:01:00]}` and Lichess's `{ [%clk 0:01:00] }`.
- **A file whose reading count does not equal its move count is dropped whole**
  (`clockSeries` → `null`). One short, and every reading after the gap belongs to the
  wrong move: figures that are wrong and plausible at once. Readings inside a variation
  push the count the other way and drop the game just the same. The clock pane counts
  those games in `dropped` and says so in its footer, rather than losing them silently.
- **Accuracy is aggregated per game and then averaged across games.** `gameAccuracy`
  means over one game's judged plies for one colour; `meanAccuracy` means over games. A
  move is weighted by the volatility of the evaluation around it, and across a join those
  neighbours are somebody else's game — and a pooled mean lets one long game outvote ten.
  The test builds two toy games where the mean of means and the pooled mean differ by more
  than a point and asserts the module gives the former. `clockReport` folds the same way:
  its `accSum`/`lossSum` are sums of per-game means, so a bullet marathon cannot outvote
  the archive.
- **Per-move loss is floored at zero as well as capped** (`LOSS_CAP` = 1000, ten pawns).
  A mate escaped is a difference of ~99,000 with a sign on it; one of those in a bucket is
  the whole of that bucket's mean, and a negative mean says the mover gained material by
  moving. Both `plyLoss` and the local fallback `moveLossLocal` floor and cap.
- **The time bands carry a confound and the card says it out loud.** A long think is
  usually a hard position, so a curve over thinking time is partly reporting which moves
  were difficult. The clock pane therefore *leads* with the comparison that holds
  difficulty still — the same moves, made with under a tenth of the clock left, against
  the rest — and prints a note under the bands table saying what the curve is really
  about.
- **A tally is the node.** Explorer nodes extend the same `{n, w, d, l}` shape rather than
  keeping a count in a field of its own: a counter and a tally that drift apart is how
  every percentage in a tree comes to read an honest-looking zero.
- **The explorer path is a list of SAN, not node references**, so it survives a rebuild.
  `explorerWalk` stops at the last node that still exists rather than throwing or
  returning the root.
- **A rating trend needs an order.** `computeStats.rating` reports `first`/`last`/`delta`
  only when at least two games carry a date; `peak` needs no order and is always given.
- **The rolling form curve is held back until its window is full** (`ROLL_WINDOW` = 20).
  A rolling average over the first four games is those four games, and drawn, it is noise
  settling — which reads as improvement and is not.
- **Tilt pairs need two real times.** A date-only archive puts every game at noon, which
  would make every consecutive pair "twenty minutes apart"; `computeFacts` records
  `timed`, and `habitReport` skips any pair where either end is only a date.
- **Stalemate is read before mate.** `"Game drawn by stalemate"` contains `"mate"`; filed
  by the bare fallback it becomes a checkmate sitting among the draws, and nothing
  downstream could tell. (This was a real bug, found by the fixture — `chesscom.pgn` has
  exactly one stalemate.)

### Every recommendation generator sits behind a sample floor

Advice is the strongest register the app speaks in, and advice drawn from six games is a
horoscope. A generator that cannot clear its floor writes nothing at all — it does not
write a hedged version. `FLOORS`:

| Floor | Value | Guards |
| --- | --- | --- |
| `colour` | 20 games as **each** colour | the colour-gap row (plus a 10-point gap) |
| `tilt` | 10 games on each side | the after-a-loss row (plus an 8-point gap) |
| `endings` | 10 losses | the flag row (≥25% on time) and the mated row (≥30%) |
| `clocked` | 15 analysed games with a clock | what time trouble costs |
| `bandMoves` | 20 moves each side | ...and the comparison inside it |
| `line` | 8 games through a line | the "rethink this line" row |
| `lineRatio` | 1.5× the baseline | ...and how far above it the line must sit |
| `collapse` | 10 analysed games, 3 collapses | the thrown-away-wins row |
| `habit` | 5 games in a bucket | a habits or clock sub-table being drawn at all |
| `compare` | 5 games a side | a set being offered in the Compare picker |

The pattern report has three of its own: `PATTERN_MIN_GAMES` (3) is how many of the
subject's games must have passed through a node before it can name a line,
`PATTERN_MIN_ERRORS` (3) is how many errors make a habit rather than an afternoon, and
`PATTERN_MIN_PLIES` (2) is the shallowest thing that names a line at all — the root is not
an opening.

Rows are ranked by `weight`: a base per generator plus the effect size, so the list leads
with whatever this archive says costs the most. Each row carries `numbers` (the figures
that earned it) and `walk` (a room and an argument), and the room's control walks there.
Dismissals live in `_hidden` and are written to `meta/recsHidden`; the footer offers them
back. `dbPut` resolves `false` when storage is off, and the set still stands for the
session.

### Caches

Per-game caches are underscore-prefixed and never stored: `_facts` (keyed by hero, so
changing the subject re-derives rather than serving a stale row), `_clk`, `_acc`. Per-report
caches hang off a signature of `games.length | heroKey | last game id` and are dropped
whenever it changes; `dropEngineCaches` drops only the engine-fed ones on a second paint.
`dropCaches()` is exported for the hero picker and the games-changed listeners.

## Shapes

```js
// Constants
EXPLORER_MAX_PLY = 12, TROUBLE_FRACTION = 0.1, LOSS_CAP = 1000
SWING = {inaccuracy: 50, mistake: 100, blunder: 300}      // only used when review.js is absent
PATTERN_MIN_GAMES = 3, PATTERN_MIN_ERRORS = 3, PATTERN_MIN_PLIES = 2
FLOORS = {colour, clocked, bandMoves, tilt, line, lineRatio, endings, collapse, habit, compare}

// Whose games these are
playerKey(name) → string                       // lowercased, trimmed; '?' → ''
heroCandidates(games) → [{name, key, n}]       // most games first
resolveHero(games) → {name, key} | null

// One game
timeClassOf(tc) → 'bullet'|'blitz'|'rapid'|'classical'|'daily'|null   // base + 40×inc
timeBudget(game) → {base, inc} (seconds) | null                       // null for correspondence
endingOf(game) → 'checkmate'|'resignation'|'time'|'stalemate'|'repetition'|'agreement'|
                 'insufficient'|'fifty-move'|'abandonment'|'draw'|null
endingLabel(key) → string
gameFacts(game, heroKey) → null | {
  color: 'w'|'b', result: 'w'|'l'|'d', ending, timeClass, length,      // length is in plies
  rating, oppRating, opponent, date,          // date is ms, or null
  timed,                                      // false = placed at noon from a date alone
  endDate, hourLocal }                        // hourLocal is this device's clock, or null

// The record
scorePct({n,w,d,l}) → 0..100                   // a draw is half a point
computeStats(games, heroKey) → {
  total, counted, overall, white, black,       // tallies: {n, w, d, l}
  endings: {w: {ending: n}, d: {…}, l: {…}},
  controls: {timeClass: tally},
  rating: {peak, first, last, delta, n} | null,
  length: {avg, longest: {gi, plies}, shortest} | null }
orderedGames(games, heroKey) → [{gi, f}]       // dated only, oldest first
formReport(games, heroKey) → null | {
  n, marks: ['w'|'d'|'l'], last: tally, lastN, run: {result, n}, roll: [pct] | null,
  bestRun, worstRun, unbeaten, months: [tally + {label}], from, to }

// The clock
clockSeries(game) → number[] (seconds, one per ply) | null
timeTrouble(game, ply) → bool | null
clockReport(games, heroKey) → {
  counted, tagged, clocked, dropped, moves, low, reached, calm, median,
  flag: {timeClass: n}, onTime, losses, analysed,
  same: {low: side, rest: side},                       // side = {games, moves, acc, loss, errors, …}
  bands: [side + {label, spoken}] }

// The engine's numbers
evalToCp(ev) → cp | null,  winProb(cp) → 0..100,  analysed(game) → bool
moveLossLocal(game, n) → cp ≥ 0 | null         // fallback; review.moveLoss is preferred
classify(game, n) → 'inaccuracy'|'mistake'|'blunder'|null
plyLoss(game, n) → 0..LOSS_CAP | null
moveAccuracy(game, n) → 0..100 | null
gameAccuracy(game, color) → {accuracy, moves} | null
meanAccuracy(games, heroKey) → {accuracy, games, moves} | null

// Habits and compare
habitReport(games, heroKey) → {counted, dated, tilt: {afterLoss, afterWin, pairs} | null,
  day: [tally + {part}], hours: [tally] | [], opponents: [tally + {name}], losses, onTime}
compareSets(games, heroKey) → [{key, label, gis}]      // only sets clearing FLOORS.compare
compareRows(games, heroKey, a, b) → {rows: [{label, a, b}], a: stats, b: stats, swing}

// The explorer
buildExplorer(games, heroKey, color, maxPly = 12) → node
//   node = {n, w, d, l, san, move, fen, games: [gi], children: Map<san, node>}
//   fen comes from fens[depth] of the FIRST game through the node
explorerWalk(root, path) → {node, path}                // path is the prefix that still exists

// The pattern report
patternLineFor(root, sans, minGames = 3) → [san] | null   // deepest node ≥ minGames games
patternReport(games, heroKey, color, minGames = 3) → [{
  key, color, path, games, analysed, withError, errors, rate, tiers: {blunder, mistake, inaccuracy},
  plies: [n], score: tally, clock: {errors, low}, sample: {gi, ply, tier} | null }]
//   sorted by errors per analysed game — repetition, not severity

// What to work on
recommendations(games, heroKey) → [{id, weight, text, numbers, walk: {room, arg}}]

// Drawing and the room
renderReport(container, games, heroKey, {about: 'you'|'them', name, room})
dropCaches(), boot()
```

## Tests

`test/insights.test.js`, 67 tests, node environment — nothing below `renderReport` touches
`document`, which is why the arithmetic is testable at all. Fixtures: `chesscom.pgn` (34
games, `evals.json` attached as `game.analysis`), `lichess.pgn` (17 games, the other header
dialect and the shorter controls), `malformed.pgn` (the game whose clock series is one
reading short, and the one with no result). Games are parsed once and their caches cleared
between tests, so a cache carried forward cannot hide the staleness it can cause.

Two bugs were found by writing them, and both are fixed in `src/insights.js`:

1. `endingOf` matched `'mate'` before `'stalemate'`, so `"Game drawn by stalemate"` was
   filed as a checkmate. The fixture has one, and it was showing in the draws column as a
   mate.
2. `moveLossLocal` floored at zero but never capped, so the exported local fallback
   returned ~99,900 for a mate escaped where `review.moveLoss` returns 1000 — the exact
   failure the "floored *and* capped" rule exists to prevent, in the function that runs
   when review.js is not there to prevent it.

A third, cosmetic: two recommendation rows read `plural(n, 'loss')` → "10 losss", and the
collapse row's verb did not agree with its plural subject.

## Asks

Nothing blocking. Four things a shared file could do better, all worked around locally:

1. **`components.css` puts `.hint` in the serif, and a data row marked `.hint` for its
   colour then reads as prose.** The recommendation numbers line (`.hint.num
   .ins-rec-nums`) and the figures inside `.lede` sentences are data, so `insights.css`
   names `var(--font-sans)` for them by hand. A muted-but-sans class in `components.css`
   — the colour of `.hint` without its face — would let every module stop doing this.
2. **`.cards` is `minmax(260px, 1fr)`**, which is a card grid rather than a report grid.
   Insights overrides it to two equal columns and spans most panes across both. If a
   second module wants the same, it belongs in `layout.css` as a modifier.
3. **`registerRoom`'s `enter(arg)` gives no way to know whether the arrival was a fresh
   navigation or a repaint**, so `handleArg` re-scrolls the pane into view on every
   arrival with an argument. Harmless, but a `first` flag would be better.
4. **`renderReport` takes a fourth option the contract does not list: `room`.** The
   contract has `{about, name}`; the explorer also has to claim and release the stage, and
   a claim is attributed to a room, so Prep must be able to say which room it is painting
   into. It defaults to `currentRoom()`, so a caller that omits it still works — but the
   contract line should read `{about, name, room}`.

One known limitation of my own, written down so it is not mistaken for a bug: `dropCaches()`
walks `S.games`, so a report Prep points at an opponent's archive keeps its `_facts` until
that archive is rebuilt. Prep rebuilds its list on every fetch, so nothing stale can be
shown today; if that changes, `dropCaches` should take the list to clear.

The module reads `S.heroOverride`, `S.chesscomUser` and `S.lichessUser` from `state.js`
and `meta/recsHidden` from `memory.js`; all three already exist and none needed a change.
