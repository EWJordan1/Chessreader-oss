# Learn

`src/learn/lessons.js`, `src/learn/book.js`, `src/learn/drills.js`, `css/learn.css`,
`test/learn.test.js`. The module owns the Learn room and its three sections, the `book`
store, and the drill runner that deals questions in **Listen**.

The split that shapes everything here is by *act*, not by object (§6 Learn;
`docs/openings.md` §1, §4). **Openings** is deciding — the lessons, the library, the
book and its editor. **Tactics** is the collection. **Drills** is *choosing* what to be
asked. Being asked happens in Listen's `#drill-body`, so a reader held on a guess never
changes rooms to answer.

## What exists

```js
// book.js — the repertoire the reader decided
BOXES, RETRY_MS                            // the deck's ladder, imported not copied
bookKey(color, sans) → 'w:<hash>'
walkLine(moves) → {sans, fens, verbose} | null      // SAN or UCI in, canonical SAN out
bookLine(color, moves, name, now?) → row | null
bookLines(color?) → row[]                  // add order
bookTrie(color) → root                     // no tallies; see below
bookNodeAt(color, path) → node | null
addToBook(color, sanMoves, name, now?) → row | null   // the ONE writer; dupe → null
removeLine(key) → bool
bookDue(now?) → row[]                      // most-failed first, then longest-waiting
gradeLine(row, pass, now?) → row
bookName(row), dueLabel(row, now?)
studyRef(text) → {study, chapter} | null, studyURL(ref)
IMPORT_MAX = 200, importBookPGN(text, color, max?) → {added, dupes, skipped, total, over, rows}
boot()

// lessons.js — the room
loadIndex(), loadLibrary(), loadLesson(id)        // fetched only when opened
primeCatalogue({index, library, lessons})         // tests hand the JSON in directly
lessonStep(lesson, k) → {fen, from, to, moves} | null
nearestStep(lesson, n, cur?) → step index
movetextSANs(text) → SAN[]
familyOfGame(headers, names) → family | null, familyPlayCounts(games, families) → Map
renderLearn(), boot()

// drills.js — the runner, in Listen
startDrill(kind, opts) → state | null      // 'deck' | 'tactics' | 'book' | 'guess'
stopDrill({quiet}?) → bool
drillState() → {kind, i, total, right, asked, revealed, side, at, msg, key} | null
answerDrill(text), revealDrill()           // the field's two presses
judgeAnswer(fen, text, expected) → 'right' | 'legal' | 'illegal'
moveOn(fen, text) → verbose move | null
guessGuard(game, ply) → bool               // what playback.setGuessGuard is given
boot()
```

## The rows

### A book line (store `book`, key `w|b` + `:` + hash of the SAN moves)

```js
{ key, color, moves: [SAN], name,
  box, due, seen, passes, fails, lastAt, addedAt }
```

Exactly the contract's shape. `moves` is always canonical SAN from the start position —
`walkLine()` normalises UCI and refuses anything illegal, so **a row in the store can
never be illegal**, which is what lets every other reader (Prep's crossing, the drill,
the trie) walk it without a `try`.

### The trie (derived, never stored)

```js
{ fen, children: Map<san, node>, line? }
```

Three keys, and **no tallies at all**. A decision has no denominator, and a node
carrying `n: 0` is a percentage waiting to be printed by accident. `line` sits on the
node the row ends at — including an interior node, so a line that is a prefix of a
longer one is still its own scheduled unit. The cache is invalidated on
`cr:book-changed` and `cr:restored`, because rows arrive from disk behind the room's
back.

## Decisions

- **`addToBook()` is the only door into the book.** The lessons, the library, the
  editor and the PGN/study import all end in that one call. Your book is what you
  decided, not what you were shown — so a lesson offers its lines and nothing crosses
  without a press.
- **A line *is* its own identity.** The key is the colour plus `pgnId` over the SAN
  joined by spaces — the same 53-bit hash games use. The same line typed by hand,
  adopted from a lesson variation and imported from a study all land on one key, and
  the second copy is a duplicate rather than a second row. A duplicate returns `null`
  rather than throwing: it is the reader agreeing with themselves, and the caller says
  so in a sentence.
- **The colour is part of the key.** The same moves as White and as Black are two
  different decisions on two different schedules.
- **The schedule is the deck's, by import.** `BOXES`/`RETRY_MS` read `DECK_BOXES` and
  `DECK_RETRY_MS` off `src/deck.js` rather than restating them. Two spaced-repetition
  clocks in one app is one too many: a reader who learns "a miss comes back in ten
  minutes" from the deck must find the book keeping the same promise.
- **A new line is due now, in box 0**, so *learn it, then answer it* is the default
  path rather than a feature.
- **A lesson's step moves are SAN from the START, not from the step before it.** That
  is what lets a lesson double back to move three and take the other branch, and what
  lets every step be validated on its own. `lessonStep()` replays them; the test
  asserts the walker's FEN equals that replay for all 23 lessons.
- **A lesson file is fetched only when opened.** The catalogue and the library are
  fetched on arrival in Openings; a reader who never opens a lesson never pays for it.
- **`familyOfGame()` guesses nothing from the ECO code alone.** Lichess writes
  `Family: Variation` into `[Opening]`; Chess.com writes a slug into `[ECOUrl]`, and
  the longest family the slug opens with wins so *Queen's Gambit Declined* beats
  *Queen's Gambit*. A wrong shelf is worse than no shelf.
- **A library line that does not walk never becomes a button.** `library.json` is
  data, and a data bug must not put an unaddable line on screen.
- **An import writes at most `IMPORT_MAX` (200) lines and refuses a bigger file
  whole**, by name — a whole study, not a whole database. Variations are dropped by
  `cleanPGN`: a chapter's main line is the decision the chapter states.

### The drill runner

- **One run at a time**, in one module-level object. Starting a drill stops the one
  before it: two questions on one board is two answers with one field.
- **Three verdicts, never four** — `right`, `legal`, `illegal`. One judge
  (`judgeAnswer`) serves all three kinds, and SAN and UCI meet in it, so the field
  cannot disagree with itself about what a move is called. An `illegal` answer reveals
  nothing and the question stays open: a typo is not a wrong answer.
- **Who grades differs by kind, and the difference is the point.**
  The deck self-grades (Got it / Missed) because the engine's one line cannot see the
  second-best move, and a field that graded would teach something false. The one
  exception is a typed answer that *matches* `card.answer`: matching the engine's own
  move is transcription, not judgement, so it passes the card outright. A wrong typed
  answer grades nothing — it says so and leaves the reveal's two buttons in charge.
  **The book grades and the reader does not**: the right answer is the reader's own
  earlier decision, written down.
- **A book line passes only when every one of your plies came out right first time**;
  one miss fails it and it returns in `RETRY_MS`. The miss is recorded against the
  *ply* (`missedAt`, a Set), not as a boolean — a multi-question line must know *which*
  ply went wrong, and a flag cannot express "already answered".
- **The other side plays itself, chained on the end of speech.** `speak()` cancels
  whatever is in flight, so firing a run of moves in one tick would be heard as only
  the last one. The board shows only the plies already played: a run showing the whole
  line is the answer printed above the question.
- **The guess guard remembers what it released.** Releasing a hold is `play()`, which
  re-enters `playStep()` at the *same* ply — so a guard that only checked the side
  would hold on that ply forever. `shown` is a Set of `gameId:ply`, and the guard
  answers false for the wrong side, for a ply past the end, and for anything already
  shown.
- **Stopping hands the board back with `renderBoard()`.** A card left on the stage
  after its drill is a position nobody is being asked about.
- **The panel repaints on the board's beat.** Playback has no "held" callback, so
  `onRender('board', …)` is the signal; a signature check skips every repaint that does
  not change the question, because rewriting the panel would blow away the field the
  reader is typing in.
- **Nothing due says so in a sentence** and does not open an empty panel.

## Rendering

`css/learn.css` styles the shelf, the library, the lesson walker, the editor, the
import pane, the book table, the tactics table and the drill prompt. Every colour is a
token; nothing declares a font-family except the import textarea, which has to be
monospaced to show a PGN honestly. The two genuinely wide things — a long move run and
the tactics table — scroll inside their own container, because the column beside the
board must shrink in both axes or it steals the board's width.

Deck cards inside a drill are drawn by `deckCardHTML()` and styled by `css/deck.css`;
Learn adds nothing to `.deck-card` — one renderer per thing.

## Events

Listens: `cr:book-changed`, `cr:deck-changed`, `cr:restored` (repaint the room, the
badge and the trie cache), `cr:games-added` (the "openings you play" counts),
`cr:games-removed` (stop a guess drill whose game is gone).
Dispatches: `cr:book-changed` after any write to the book.

Installs: `setDueCounter(() => deckDue().length + bookDue().length + tacticsDue().length)`
— deck cards, book lines and tactics counted **once each** — and
`setGuessGuard(guessGuard)` while a guess drill runs.

## Tests

`test/learn.test.js`, 30 checks, node environment. `src/memory.js`,
`src/speech/provider.js` and `src/playback.js` are `vi.mock`ed; `src/deck.js` is the
real module, because the point of several checks is that the two schedules agree.

The suite walks all 23 shipped lesson files and asserts every step is a legal sequence
under chess.js, every lesson's `family` exists in `openings/library.json`, and the
walker's FEN for step *k* is exactly what replaying that step's moves gives. It also
pins: the trie carries none of `n/w/d/l/count/games/total/plays` on any node; the key
is content-addressed across the editor, a lesson variation and UCI; `gradeLine` uses
`DECK_BOXES`/`DECK_RETRY_MS` and a miss returns in ten minutes rather than tomorrow;
`bookDue` ordering; a two-chapter study PGN importing as two leaf lines with the
variation dropped; and the guess guard holding only for the chosen side and never twice
on a ply already shown.

## Asks

- **`docs/contract.md`, the Learn API block.** Three small drifts from what is written
  there, all additive:
  1. `startDrill(kind, opts)` takes a fourth kind, **`'guess'`**, with
     `opts.side` of `'w' | 'b' | 'both'`. The contract lists only
     `'deck'|'tactics'|'book'`, but §6 Learn specifies "Guess the move" as a drill and
     Learn's Drills section already offers it.
  2. `drills.js` also exports `answerDrill(text)`, `revealDrill()`,
     `judgeAnswer(fen, text, expected)`, `moveOn(fen, text)` and `guessGuard(game, ply)`.
     The first two are the field's two presses; the last three are the judge and the
     guard, exported so they can be tested without a document.
  3. `book.js` exports more than the contract's line lists — `bookKey`, `walkLine`,
     `bookLine`, `bookNodeAt`, `bookName`, `dueLabel`, `studyRef`, `studyURL`,
     `importBookPGN`, `BOXES`, `RETRY_MS`, `IMPORT_MAX`. Prep will want `walkLine` and
     `bookTrie` for the crossing.
- **`src/render.js`** — no change needed, but noting the dependency: the drill panel
  repaints off `onRender('board', …)` because `playback.js` has no callback for "the
  loop is holding". If a `onGuessHold(fn)` ever lands in `playback.js`, this should
  move onto it; the signature check that makes the current arrangement safe is the only
  thing standing between the reader and a field that clears itself mid-word.
- **`app.html`** — `#drill-section` is always visible and carries an idle sentence
  ("Choose a drill in Learn → Drills and it runs here"). If the integrator would rather
  the panel were hidden until a drill starts, the runner can toggle it; say which.
- **`src/ai/explain.js`** — a drill card's `.card-why[data-key]` is in the DOM under
  `#drill-body` as well as in Learn's tactics panel. Both are `deckCardHTML()` output,
  so one delegation covers them.
- **`src/insights.js`** — `docs/openings.md` §4 specifies a fourth book verdict,
  `played`: "Bc4 is what you play — nine games. Your book says Nf3." It needs the habit
  trie at the node being asked. Not built: it wants a lookup on the explorer trie that
  `buildExplorer()` does not currently expose by path. Worth a small
  `explorerNodeAt(root, sans)` if Insights ever adds one.
