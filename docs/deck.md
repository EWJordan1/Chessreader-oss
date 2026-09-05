# The deck

`src/deck.js`, `css/deck.css`, `test/deck.test.js`. The module owns the two earned
stores — `deck` and `tactics` — their harvest, their Leitner schedule, the one card
renderer, the card's stage claim, and its speech. It has no mount of its own: Learn's
drill runner (`src/learn/drills.js`) deals cards in Listen through this API, and Home
reads `weekStats()`.

## What exists

```js
DECK_SWING = 300            // a card is a move that cost the mover ≥ 3 pawns
TACTIC_BAND = [200, 300]    // a missed tactic: the half-open band below
DECK_BOXES = [1, 3, 7, 21, 60]   // days; box = consecutive passes, interval = DECK_BOXES[box-1]
DECK_RETRY_MS = 10 * 60 * 1000   // a miss returns in ten minutes, not tomorrow

harvestDeck(game, heroKey?) → {deck: card[], tactics: card[]}
mergeDeck(cards, store='deck'|'tactics') → added
deckDue(now?), tacticsDue(now?) → card[]          // due ≤ now, oldest due first, then most-missed
gradeCard(card, pass, now?, store?) → card         // store defaults to storeOf(card)
removeCard(key, store='deck') → bool
deckCardHTML(card, {revealed}) → html
cardClaim(card, {revealed}) → stage pos | null
speakCard(card, {revealed}), cardAnswerSpeech(card) → string
weekStats(now?) → {drilled, due, grew, worst: card|null}
boot()                                             // listens for cr:analysis-done
```

Beyond the contract, also exported (small, and the runner and Home will want them):
`cardLoss(card)`, `lossBetween(before, after, color)`, `cardMated(card)`, `cardMove(fen, uci)`
(a chess.js verbose move from a card's position), `fmtEval(ev)`, `cardLabel(card)`,
`cardQuestion(card)`, `dateLabel(headers)`, `storeOf(card)`, `onAnalysisDone(game)`.

## The row

Exactly the contract's shape, in both stores:

```js
{ key: gameId + ':' + ply, gameId, ply,
  fen, played, previous, answer,           // fens[ply]; UCI ×3 ('' for previous at ply 0)
  before, after,                           // {cp}|{mate}, White-positive, as the engine stored them
  color, player, opponent, date, site,     // date is the label form, "4 Mar 2025" ('' when unknown)
  box, due, seen, passes, fails, lastAt, addedAt }
```

There is no `loss` field: the figure is read off `before`/`after` by `cardLoss()`, so the
stored row cannot disagree with the sentence printed about it.

## Decisions

- **Harvest only when `analysis.done === fens.length`.** A half-scanned game would earn
  half a deck and the rest would land later with fresh `addedAt`s, so Home's "how the
  deck grew" would count one game twice.
- **Loss is from the mover's view, floored at zero, mate = ±10000.** A mate outranks any
  material; ten thousand keeps it a figure a sentence can still contain. Mate-to-mate
  (a slower mate) is a loss of zero and never a card.
- **A move the engine would have played is never a card**, whatever the two evaluations
  say. `before` and `after` are two independent depth-limited searches and drift between
  them; a forced recapture would otherwise be filed as a blunder, which teaches
  something false. The comparison is on the first four UCI characters. A ply with no
  `best[n]` is skipped: a card that cannot reveal itself is not a card.
- **Whose mistakes.** `harvestDeck(game, heroKey)`: a key harvests only that player;
  `undefined` reads `S.hero?.key`; `null`/`''` harvests both colours. The boot handler
  passes nothing, so it follows whatever Insights resolved into `S.hero`.
- **Merging never resets a schedule.** An existing card keeps every schedule field and
  gains only fields it lacked (which is also how an older row grows the shape). Only
  new or filled rows are written, in one `dbPutAll`.
- **Nothing is deleted by a re-harvest.** The original reconciled cards against
  re-judged plies; here the stores are earned history and the engine's build stamp
  already discards a disagreeing eval row whole, so a card, once earned, stays until
  the reader removes it.
- **Leitner.** `box` counts consecutive passes (0 = the front); a pass earns
  `DECK_BOXES[box-1]` days and caps at the last box; a miss sets `box = 0` and
  `due = now + DECK_RETRY_MS`. The book should climb the same ladder — two
  spaced-repetition clocks in one app is one too many.
- **The card names nothing before the reveal** except whose move, which move number,
  against whom and when. Naming the played move turns "find a move here" into "find
  the refutation of Bxf7+".
- **Grading is the reader's own** (Got it / Missed). Nothing here can hear a move said
  out loud, and entering it on the board would take the drill off the ear.
- **Speech.** `speakCard(card)` says `positionSpeech(fen)` then the question, chained on
  completion (a second `speak()` in the same tick would cancel the first);
  `{revealed: true}` says `cardAnswerSpeech`, which uses the `natural` grammar level
  regardless of `S.verbosity` — "You played black knight from f6 to e5, takes pawn" is
  not a sentence.
- **`weekStats` counts both stores** once each, the way the Learn badge does; `worst`
  is the largest-loss card *added this week*, null when nothing was.
- **The toast** ("2 cards earned from this game.") fires once per game per session and
  only when something was added.

## Rendering

`deckCardHTML(card, {revealed})` is the one renderer. It contains no board — the position
is on the stage via `cardClaim()`. Markup, for the runner to delegate on:

```
.deck-card[data-key]
  p.card-label        "Drill card · Black to move, move 23 · vs opponent · 4 Mar 2025"
  p.card-question     "What should Black play here?"
  unrevealed:  .card-actions  button[data-act=speak]  button[data-act=reveal]
  revealed:    p.card-answer  (SAN of played and answer in .san)
               p.card-evals   ("+2.6 before, −0.4 after. It cost 3.0." / "It walked into mate.")
               div.card-why[data-key]     ← the ai module fills this
               .card-actions  button[data-act=speak]  button[data-grade=pass]  button[data-grade=fail]
```

`cardClaim(card, {revealed})` → `{fen, from, to, flipped, label, arrows, line}`: the
preceding move lit (context, not a hint), flipped for Black, an empty `line` whose
`from` is `fenPly(fen)`, and after the reveal two arrows — the answer as `best`, the
played move as `missed` — matching the legend the stage already wears.

## Events

Listens: `cr:analysis-done` `{game}` → harvest → merge both stores → toast.
Dispatches: `cr:deck-changed` after any merge that wrote, any grade, any removal.
`cr:games-removed` is deliberately ignored: cards survive eviction by design.

## Asks

- **`docs/contract.md`**: the Deck API line for `gradeCard` reads `(card, pass, now)`;
  the implementation takes an optional fourth `store` argument (defaulting to
  `storeOf(card)`), and `speakCard` takes `{revealed}`. Worth folding in.
- **`src/learn/drills.js`** (learn module): the runner should delegate on
  `[data-act="reveal"|"speak"]` and `[data-grade="pass"|"fail"]` inside `.deck-card`,
  call `stageClaim('play', cardClaim(card, {revealed}))` and, after a grade, deal the
  next of `deckDue()`/`tacticsDue()`.
- **`src/ai/explain.js`**: fill `.card-why[data-key]`; the card carries `fen`, `played`,
  `answer`, `before`, `after` — everything the prompt needs without the game.
- **`src/home.js`**: `weekStats()` is ready; `worst` is a full card, so `cardLabel()`
  and `cardLoss()` print it.
- No change needed in any shared file.
