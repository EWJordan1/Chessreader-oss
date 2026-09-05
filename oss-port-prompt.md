# Build prompt — open-source ChessReader

*Paste everything below the line into a fresh Claude Code session in an empty repo.*

---

# ChessReader OSS — build specification

You are building a **free, open-source, desktop-only chess analysis and training web
app** from scratch in this empty repository. This document is the specification. Read
it fully before writing code, then work through the build order at the end.

This is a port of a closed-source product. The port drops everything that existed to
serve a paid tier — accounts, subscriptions, entitlement gates, serverless proxies,
cloud analysis, mobile layouts, a demo mode — and keeps the whole of the actual
product. Where the original hid a capability behind a subscription, this version
exposes it as a setting the user points at their own infrastructure.

## 1. What the app is

Paste a PGN, fetch one from a URL, or pull a public Chess.com or Lichess archive, and
the app reads your games back to you the way a coach would: what you got wrong, what
you keep getting wrong, and what to do about it. Games can also be read *aloud*, move
by move — an optional feature, not the point.

Everything is computed in the browser. Games live in IndexedDB on the device. Nothing
is uploaded unless the user has explicitly configured an endpoint to upload it to.

## 2. Hard constraints

These are not preferences. Violating one is a bug.

1. **Desktop only.** Target viewports ≥1100px. No phone rail collapse, no mobile
   breakpoints, no touch affordances. Below the minimum width, say so in one sentence
   rather than reflowing.
2. **No accounts, no auth, no payments, no entitlement, no server you have to run.**
   `npm run dev` and a browser is the complete environment. Every feature works with
   no network beyond the chess-site fetches the user asks for.
3. **Zero required third-party services.** The engine and the voice both have a local
   default. Remote providers are opt-in, user-configured, and every failure path falls
   back to the local one rather than to an error.
4. **`S` is the single source of truth.** One mutable state object. Render functions
   read it and never hold their own copies; anything that changes state calls an update
   function.
5. **`speak()` is the only way to make sound**, and the utterance ticket is the only
   way to cancel one. Nothing calls a speech backend directly.
6. **Every storage failure path is "carry on in memory."** No IndexedDB, a private
   window, a refused open, a quota error — the app works for the session and says one
   sentence about why nothing will be remembered.
7. **Nothing analyses, fetches or uploads without a press.** No idle-time jobs, no
   polling, no background sync. Consent is a button.

## 3. Stack and repository layout

Vanilla JS, ES modules, **Vite** as the bundler and dev server. No framework. No
TypeScript (the original is JS and the port should stay readable to its author);
JSDoc types where a shape is non-obvious. Vitest for unit tests, Playwright for the
headless walk.

```
index.html            Shell markup only — the rooms, the board, the dialogs
src/
  main.js             init(), wiring, the boot sequence
  state.js            S, loadSettings/saveSettings, the settings schema
  pgn.js              splitPGN, cleanPGN, parseGame, the game id hash
  sources.js          Paste / URL / Chess.com / Lichess importers
  memory.js           IndexedDB: open, migrate, the nine stores, memUsage
  board.js            boardHTML, expandFEN, PIECE_ART, flip
  render.js           updateAll and the four repaint functions
  route.js            hash routing, the rooms, ROOM_ALIASES
  engine/
    provider.js       The analysis provider interface + selection
    local.js          Stockfish wasm in a worker
    remote.js         The HTTP/WebSocket provider (see §7)
    analyse.js        Scans, probes, the queue, the eval cache
    sweep.js          The archive pass: pause, pace, estimate, queue list
  review.js           gameReview, reviewClass, accuracy, the three moments
  insights.js         gameFacts, computeStats, habits, explorer, patterns, recs
  deck.js             harvestDeck, mergeDeck, Leitner scheduling, tactics
  learn/
    lessons.js        Lesson loading and the step walker
    book.js           The repertoire store, the trie, add-to-book
    drills.js         Drilling the book and the deck
  prep.js             Opponents, their archives, the crossing, the briefing
  speech/
    provider.js       speak(), the ticket, the degradation latch
    browser.js        SpeechSynthesis
    openai.js         Any OpenAI-compatible /audio/speech endpoint
    grammar.js        moveToSpeech, utterance, announcements, positionSpeech
  ai/
    explain.js        "Why?" against any OpenAI-compatible /chat/completions
  sync/
    client.js         Optional self-hosted sync (see §8)
css/
  tokens.css          The three token groups; the four themes
  layout.css          The rail, the rooms, the board pair, the window
  components.css      Cards, tables, buttons, the move tree, SAN
lessons/              23 lesson JSON files + index.json (ported)
openings/             eco.json, library.json (ported)
engine/               Stockfish wasm, vendored (see §11 on licensing)
server/               Reference remote-engine server (optional, documented)
test/
  fixtures/           Small PGN corpora the checks compute over
  *.test.js           Vitest suites, one per surface
  walk.spec.js        Playwright: a headless walk of every room
docs/                 architecture.md, and the reference docs
```

## 4. The pipeline

```
PGN text ──► parse ──► games[] ──► playback loop ──► speech
(paste,      moves +   cursor      timer + ply       browser or
 URL,        FENs      (gi, ply)   cursor            configured API
 archives)                            │
                                      ├──► board render (FEN → grid)
                                      └──► UI updates
```

### Parsing

`splitPGN()` cuts a multi-game file into chunks by watching for a header block starting
after a movetext block. `cleanPGN()` strips comments, variations (by brace/paren depth)
and NAGs. `parseGame()` produces:

```js
{ headers,   // Event, White, Black, Result, ECO, Termination, ...
  moves,     // verbose: san, piece, color, from, to, flags, captured
  fens }     // fens[n] = position after n plies; fens[0] is the start
```

**Precompute every FEN at parse time.** Seeking to a ply is then an array index, not a
replay — this is what makes scrubbing, the explorer trie and the review free. Games
that fail to parse are counted and reported, never abort the load. Parsing is sliced on
a 40ms budget with a loading overlay past 20 games.

Use `chess.js` from npm (current version — the original was pinned to 0.10.3 by its
no-build constraint, which no longer applies; adapt the API but keep `cleanPGN` since
real-world PGN is still dirtier than the parser).

### The ply axis

`S.ply` is the axis the whole app turns on. `0` is the start position, `n` is after the
nth half-move, so `fens[S.ply]` and `moves[S.ply - 1]` are always in step. Every
navigation action moves the cursor and then either re-enters the playback loop or
repaints. There is no separate seek path.

### The game id

`id` is a 53-bit hash of the cleaned, whitespace-flattened PGN. **Content-addressing is
load-bearing in three places**: an import merges rather than replaces (drop ids already
present, count them, say so), deck cards and eval rows reference games by it, and any
sync is a union of keys rather than a reconciliation with a "which copy do you want?"
dialog. Do not replace it with a UUID.

## 5. Storage

IndexedDB database `chessreader`, nine stores. `onupgradeneeded` creates only missing
stores; every migration is additive.

| Store | Key | Holds |
| --- | --- | --- |
| `games` | `id` (PGN hash) | `pgn`, `headers`, `source`, `addedAt`, `seq`, `bytes`, `lastPly`, `lastPlayedAt` |
| `evals` | `gameId` | `build`, `depth`, `plies`, `evals`, `lines`, `alts`, `bytes` |
| `deck` | `gameId:ply` | Schedule + `fen`, UCI `played`/`previous`/`answer`, `before`/`after`, player, opponent, date |
| `tactics` | `gameId:ply` | The deck's row shape at the 200–300cp band |
| `book` | `w\|b` + hash of moves | `color`, `moves` (SAN from start), `name`, six memory fields |
| `meta` | `k` | `cursor` `{id, ply}`, `hero`, `schema`, `sweepCursor`, `recsHidden` |
| `opponents` | `site:handle` | The prep list: who, which format, what has been read |
| `oppgames` | `oppId:pgnId`, index `[oppId, endTime]` | An opponent's public games, bounded per opponent |
| `oppevals` | `oppId:pgnId` | What the engine found in them |

**Four stores are not caches and must never be blanket-wiped.** `deck` and `tactics`
are *earned* — each row is self-contained (position, played move, preceding highlight,
engine line, evaluations, player, opponent, date) so it survives its game's eviction and
can draw, speak, reveal and explain itself alone. `book` is *authored*, which is
stronger: a line was typed or played in by the user and exists nowhere upstream.
`opponents` is a record of someone's weekend.

Rules that break silently if forgotten:

- **Only the PGN is stored, so every boot re-parses.** A FEN per ply is ~3× the size of
  the game producing it.
- **Never read across an `await` inside a transaction.** A transaction idle for a
  microtask is one the browser may close, and the bug is intermittent by construction.
  Each helper is one transaction with one request.
- **Cap at 2,000 games, oldest `seq` first**, sparing whatever is on screen. Evicting a
  game takes its reconstructible `evals` row; its deck cards remain.
- **The cursor is debounced 1.5s** and written only if the game's row is already there —
  a blind put resurrects evicted games.
- **Turning memory off erases immediately**, it does not merely stop writing. What stays
  is what is on screen; this session's work is not what is being withdrawn.

Settings persist to `localStorage`. `loadSettings()` guards every field individually and
ignores unknown keys, so older blobs load without migration.

## 6. The rooms

Hash routing, five rooms on a left rail. `route()` is the only thing that decides which
is live; it toggles a `hidden` class and calls `renderNav()`. `hashchange` calls
`route()`, so Back and Forward work with no extra code.

| | Room | What it is |
| --- | --- | --- |
| `#/` | **Home** | the greeting, the news, the last seven days |
| `#/learn` | **Learn** | three sections: Openings, Tactics, Drills |
| `#/insights` | **Insights** | the record, the habits, the opening explorer |
| `#/prep` | **Prep** | the people you are about to play |
| `#/play` | **Listen** | the player: a queue of games, read aloud |

Learn takes a second segment: `#/learn/openings`, `#/learn/tactics`, `#/learn/drills`.
Bare `#/learn` lands on whichever section was last stood in. One due badge on Learn
counting deck cards, book lines and tactics once each.

**Two things are deliberately not rooms.** Settings is a child of the view container
rather than of any one view, so it is reachable everywhere. Importing games is a
`<dialog>` opened over whichever room you are in — nobody's mental model of a chess
trainer has "importing" as a place you can be.

**Every room is always reachable and carries its own empty state** — one sentence about
what fills it, next to the door that does. A room that blocks itself while its store is
empty is a room with no way to put the first thing in it.

**`route()` never touches playback.** Walking to another room while a game is being read
leaves it reading. That is the point: you line up the next game while this one plays.

### The board pair

One board serves every room. The board and what stands beside it are a single element
in the shell — board left, the score and the board's own bar right, nothing else
horizontal — and each room's panels stack full-width underneath. A room is a **window,
not a document**: it fills the viewport, and nothing in it scrolls but the column beside
the board.

Everything in that column must be shrinkable in **both axes** or it steals the board's
width — a grid item's automatic minimum is its min-content and so is a flex item's. Wide
panels scroll their own bodies sideways.

Every board claim carries a label saying whose position it is — *Listen · white vs
black · after 29. cxd4*, *Drill card · Black to move*, *Lesson · the Italian Game*.

`boardHTML(fen, {flipped, from, to})` expands the FEN's rank rows and builds the grid as
one HTML string. Pieces are **inline SVG** (the Cburnett set) so there are no image
assets. Every colour in that markup is a `--pc-*` custom property. **Flipping is an
index transform, not a CSS rotation.**

### Home

The greeting, and the last seven days: drilled this week, due today, how the deck grew,
and the week's single most expensive move read off the deck rows. Once a saved username
has games behind it, Home opens with what has happened since — "7 new games since
Tuesday" — and one button imports exactly those. The browser asks the site directly, at
most twice an hour; nothing polls on anyone's behalf.

`_restoring` is true from load until the library is off the disk, and three things read
it: Home holds its empty state, the week dashboard refuses to paint (a week computed
over half a queue is a *wrong* week, not a smaller one), and the cursor is not written
from a queue still arriving.

### Listen

The player. Transport controls, per-move scrubbing, repeat modes (`game` / `queue` /
`off`), adjustable pause between moves, the queue list, and the drill prompt when a
drill is running.

`playStep()` is a **self-rescheduling state machine**, not a fixed-interval tick, so the
gap between moves is measured from the *end* of speech:

```
playStep()
  ply === 0, not announced  ──► speak(announcement) ──┐
  ply === opening ply       ──► speak(opening) ───────┤
  ply >= moves.length       ──► speak(result) ──► endOfGame()
  otherwise                 ──► speak(move) ──► ply++ ┤
                                                      │
                     setTimeout(playStep, S.interval) ◄┘
```

### Insights

Eight panes, all arithmetic over the loaded games — nothing fetched, nothing uploaded,
nothing stored:

1. **The record** — score by colour, how games end, time controls, rating, game length
2. **Form** — results over time
3. **The clock** — time trouble, and what it costs
4. **Habits** — tilt, time of day, who you keep losing to
5. **Compare** — two periods, or two openings
6. **The opening explorer** — a trie over the first twelve plies of the games the
   subject played with one colour. Each node *is* a tally, holds the game indices that
   reached it, and takes its position from `fens[depth]` of the first game through it.
   The path is a list of SAN rather than node references so it survives a rebuild.
7. **The pattern report** — the same tree read for errors instead of results: attribute
   each game to the deepest explorer node at least three of the subject's games also
   passed through, count every judged ply under it, report the tiers apart. This says
   which of your lines keeps handing you a position you play badly.
8. **What to work on** — every other card reports what happened; each row here says
   what to do about it, with the numbers that earned it and a control that walks to the
   evidence. Ranked by a weight per generator scaled by effect size. **Every generator
   sits behind a sample floor** — advice is the strongest register the app speaks in and
   advice drawn from six games is a horoscope. A generator that cannot clear its floor
   writes nothing. Dismissed rows are remembered; the footer offers them back.

`gameFacts(game, heroKey)` reduces one game to the six things a record is made of —
colour, result, ending, time class, length, rating — and returns `null` for a game the
subject did not play. Every card is built from it. The card says how many of the loaded
games it counted.

**The subject is inferred, not configured.** There is no "you" in a PGN, so take the
name appearing in the most games, break the tie with the remembered handle, and offer a
picker to override. Changing it drops every cache.

Rules with teeth:

- **Time trouble is the last tenth of that game's own base clock**, never a fixed number
  of seconds — a minute is the whole game in bullet and nothing in classical. The
  predicate returns `null` rather than `false` when there is no clock to ask.
- **Clock readings come from the raw PGN**, since `cleanPGN` strips `{[%clk …]}`. A file
  whose reading count does not equal its move count is **dropped whole**: a clock series
  one move out of step yields figures that are wrong and plausible at once.
- **Accuracy is aggregated per game and then averaged across games**, never by
  concatenating the archive's moves into one array — a move is weighted by the
  volatility of the evaluation *around* it, and across a join those neighbours are
  somebody else's game.
- **Per-move loss is floored at zero as well as capped.** A mate escaped is a difference
  of ~99,000 with a sign on it; one of those in a bucket is the whole of that bucket's
  mean, and a negative average loss says the player gained material by moving.
- The time bands carry a confound the card must say out loud: a long think is usually a
  hard position, so a curve that rises with the clock is partly reporting which moves
  were difficult. Lead with the comparison that holds difficulty still — the same moves,
  made with a tenth of the clock left.

The engine-fed half of Insights paints **twice**: what the headers can say on arrival,
and again when the eval reads land. Guard each pane with a counter so a slow read cannot
overwrite a newer paint.

### Learn

Three sections, split by *act* — acquiring material against practising it.

**Openings.** 23 lessons ship (Italian, Ruy Lopez, Sicilian, French, Caro-Kann, King's
Indian, Catalan, English, and the rest). A lesson steps through a line position by
position and says why it goes that way; at the end it offers the variations. The format:

```json
{ "id": "italian-game", "name": "The Italian Game", "color": "w", "eco": "C50",
  "blurb": "...",
  "steps": [ { "moves": ["e4"], "note": "1.e4. The move takes the centre..." }, ... ] }
```

`lessons/index.json` is the catalogue — one row per lesson, grouped, with each lesson's
family mapped to `openings/library.json`. **A lesson file is fetched only when opened.**

**The book** is the repertoire the app drills you on, and **`Add to my book` is the only
way anything crosses from a lesson into it**. That separation is deliberate: your book
is what you decided, not what you were shown. The editor also writes lines by playing or
typing them, and a PGN or Lichess study imports as leaf lines.

The book's derived trie deliberately **carries no tallies** — a decision has no
denominator, and a node with `n: 0` on it is a percentage waiting to be printed by
accident.

**Tactics** is the missed-tactics collection: the 200–300cp band, on the deck's own
schedule. **Drills** is choosing what to drill; *running* a drill happens in Listen, so
a user held on a guess does not have to change rooms to answer.

### Prep

A short list of the people you are about to play. A handle and a time control brings
their public games to this browser, filtered to the format you are actually playing, and
the row says what it read — "142 blitz games since March", or that they have none in
that format at all.

Opening a row gives the same report Insights gives about you, pointed at them and
written about them — their record, how they win and how they lose, what they open with —
and above it the one finding a report about yourself cannot produce: **your repertoire
walked against theirs**, as deep as you both have games in it, and where it goes worst
for you out of there.

Every card speaks, and one button reads the whole thing as a ninety-second briefing.
Refreshing the night before asks for what is new rather than for the archive again.

One tier costs the user's own CPU: press it and the engine goes through their games —
the games from your crossing first, stoppable at any point and resumed where it stopped
— and the report gains the lines their mistakes keep coming out of.

## 7. Analysis — local or wherever the user points it

This is the first of the two places the port diverges from the original, and the design
is a **provider interface** with two implementations.

```js
// src/engine/provider.js
// analyse(fen, opts) → Promise<{ cp?: number, mate?: number, pv: string[], depth: number }>
// opts: { depth, multipv, movetimeMs, signal }
```

**`local.js` — the default.** Stockfish 17.1 Lite compiled to WebAssembly, vendored in
`engine/`. The build *is* a worker and sets its own `onmessage`, so drive it from the
main thread rather than wrapping it in a worker of your own — nested workers are a
Safari hazard and the CPU is inside the engine's thread either way. **Lazy: the 7MB is
fetched only when the user first presses Analyse.**

**`remote.js` — configured in Settings.** A base URL, an optional bearer token, and a
health check. Two transports, both documented so anyone can implement the server side:

- **HTTP** — `POST {base}/analyse` with `{fen, depth, multipv, movetimeMs}`, answering
  the provider shape above. Batched: `POST {base}/analyse/batch` with an array.
- **WebSocket** — raw UCI. `{base}` upgraded, the client speaking `position fen …` /
  `go depth …` and parsing `info` and `bestmove` lines. This is what lets someone point
  at an off-the-shelf UCI bridge.

Ship a reference server in `server/` — a ~150-line Node process wrapping a native
Stockfish binary, with a Dockerfile and a README saying how to run it on a spare machine
or a small VPS. It is not required and nothing in the app assumes it exists.

**Selection is per-job-kind, not global.** A probe (the user asked a question about the
position on screen) should go wherever answers fastest; a sweep (hours of bookkeeping
nobody is watching) is exactly what a remote engine is for. Settings offers: local only,
remote only, or remote for the sweep and local for probes. Remote failure falls back to
local with one toast, never to an error.

### Jobs

| | Scan | Probe |
| --- | --- | --- |
| Asked by | pressing **Analyse** | pressing a depth, **Lines**, or `L` |
| Covers | every ply of the game | the one position on screen |
| Depth | 18, capped by 600ms | 18/22/26, capped by 6000ms |
| Lines | 1 | MultiPV 3 |
| Feeds | eval bar, arrows, scrubber marks, spoken verdicts, explanations | the analysis board's lines |

**A scan is cached, and the cache is why a returning user never sees one.** Debounce
committed plies into the game's `evals` row (2s, 40-ply ceiling so a scan closed early
has still written something). Stamp the row with the engine build and the depth, and
**discard a disagreeing row whole rather than reconciling it** — one stale number in the
middle of a fresh array is how a forced recapture becomes a blunder. A partial row is
honest and is kept; the scan queues only what is missing.

Store the evaluations *and* the principal variations. The lines are most of the row's
size (~7KB against a 2KB PGN) and they are kept because after this the engine never
re-runs — a line dropped from the cache is a line missing from every explanation the
user ever asks for.

**A probe jumps the queue**, because a scan is bookkeeping nobody asked for and a probe
is a question just asked. A scan caught mid-search is **abandoned and re-queued whole**
rather than allowed to commit a shallow evaluation between two deep ones.

**A variation is a position the game never reached**, so it cannot be a ply cursor. Keep
`varFrom`, `varMoves`, `varFens`, `varAt` beside `S.ply`, which stays where the game
was, and have one `viewFEN()` that the board, the move tree and the labels all read — a
variation then needs no special case anywhere downstream. Walking a line from inside a
variation *extends* it rather than starting another.

### The archive sweep

The pass that fills the deck. Without it, only games somebody happened to press Analyse
on could ever produce a card. It is a **press, not an idle-time job**, and the consent
outlives the tab: a sweep started yesterday picks up this morning, skipping everything
already cached. Newest-first, one game at a time, and honestly slow on local hardware —
which is the argument for §7's remote provider.

Make it **manageable rather than merely stoppable**:

- **Pause** keeps the consent and the place — cursor back to the half-done game and onto
  the disk, sweep jobs leave the queue, the in-flight search abandoned. A hidden tab
  presses pause automatically and lifts only its own press on return; a user's pause
  survives a reload, an auto-pause dies with the tab.
- **Pace** is a duty cycle (0 / 600 / 1800ms idle gap between searches), **never a
  depth** — the cache stamp forbids that. A probe never waits on it.
- **The estimate is measured, not guessed**: an EMA of what a search actually costs on
  this machine, silent until thirty searches have fed it, "about" for the life of the
  feature, the pace's gap priced in, times what is left — exact for the queue, counted
  for hydrated games, discounted by the observed skip ratio for games still on disk.
- **The queue is a list** behind "Show the games": per game, what the engine has done
  and the one action that makes sense there — skip, take back, or re-analyse.
- Repaint on a 1Hz per-position tick as well as at game boundaries, so a long game does
  not look like a stall. A sweep bar stands over Insights and Learn while it runs.

### Judging a move

Two vocabularies over the same figures, and **they are separate functions on purpose**.

`classifyMove()` answers with **three words** — inaccuracy (50cp), mistake (100cp),
blunder (300cp) — and is **guarded**: null for a move the engine would itself have
played, null from an already-lost position (expressed as a win probability floor, not a
centipawn one). Six callers read a non-null answer as *this move was an error*: the
spoken verdict, the explanation request, the move tree's marks, the amber arrow, the
scrubber and the pattern report. A *trainer* must not call a forced recapture a blunder.

`reviewClass()` is a **second function over the same figures with eleven words** —
Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder — for
the game review. The old one keeps its meaning. Pin this separation in a test.

**Accuracy is computed from win probability, not from move loss**, because they answer
different questions: loss is guarded, and an accuracy figure wants every move counted —
the probability curve flattens the dead ones on its own. Use Lichess's curve, constant
for constant:

```js
percent = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -1500, 1500))) - 1)
```

A second curve over the same numbers would make the percentage incomparable with the one
anyone can get free elsewhere, which is the opposite of the point of showing one.

**Two of the eleven words need a second pass.** *Great* and *Brilliant* are claims about
the moves that were **not** played, and the scan runs MultiPV 1, so the cache cannot
support either. Inferring "only move" from the evaluation delta is the worst form of the
failure the depth cap is about — a wrong *Blunder* is a bug a user argues with, a wrong
*Brilliant* is one they believe. So re-ask at MultiPV 2 when the scan drains, over a
shortlist rather than the game: only plies where the played move was already the
engine's, only in contested positions, capped at 24 jobs, preferring the sharpest. Land
the answers in a sparse `alts` column where `undefined` means *never asked* and `null`
means *asked, and the position was forced*. **Say neither word until the answer is in.**

### The game review

Everything in Analysis is about a move; everything in Insights is about the archive.
"How did I play *that* game" — the unit a player actually thinks in — is the middle, and
it adds **no engine work and no requests**: every figure is arithmetic over cached
evaluations and FENs banked at import. Cache it on the game keyed on the scan's done
state, so a review taken halfway through a scan is replaced rather than believed.

The card gives accuracy for both players, every move in the eleven words, accuracy split
across opening / middlegame / endgame, the three moments the game turned on, and the
opening **named from a position table rather than from whatever the PGN carried**.

The reviewed game's move tree wears the review's words — `!!`, `!`, `?!`, `?`, `??` —
with the three-word vocabulary standing in only while a scan is still running. The three
moments are chips in the notation's header, so the answer to *where did it go wrong* is
above the fold and beside the board.

`openings/eco.json` is a position-keyed ECO table, loaded by the review and by nothing
else. Fall back to the PGN headers when it is not there, so playback never waits on it.
It supplies the book-exit ply that the opening/middlegame boundary is cut on.

## 8. Speech and AI — point them at whatever you like

This is the second divergence. The original proxied OpenAI through a serverless function
to keep the key off the client. **There is no server here**, so the key is the user's,
stored on the user's machine, and the app talks to whatever endpoint they name.

### Settings → AI provider

One block serving both the voice and the explanations:

| Field | Notes |
| --- | --- |
| Base URL | Default `https://api.openai.com/v1`. Any OpenAI-compatible server: a local LM Studio / Ollama / llama.cpp, an OpenRouter, a self-hosted proxy |
| API key | Stored in `localStorage`. **Say so plainly next to the field** — it is a trust decision the user is making about their own browser |
| Speech model | Default `gpt-4o-mini-tts`. Free text, since compatible servers name their own |
| Voice | Free text with the ten OpenAI names as suggestions |
| Chat model | For "Why?" explanations |
| Test button | One round trip, reporting the actual error — a CORS failure and a bad key are different problems and must not print the same sentence |

**CORS is the thing that will bite.** A browser calling a third-party API directly needs
that API to allow it. Document this prominently: some providers do, some do not, and the
answer for the ones that do not is a four-line proxy the README should include verbatim.
The test button must distinguish "the endpoint refused your key" from "your browser was
not allowed to ask."

### The speech layer

`speak(text, onDone)` is the single door. Before dispatching it does two things: cancels
whatever is in flight, and **takes a ticket** (`const id = ++S.uttId`). Every callback
checks its ticket before firing, so a skip, seek or pause mid-utterance cannot resurrect
a stale completion and advance the ply. This is what keeps the transport responsive.

Two backends, and only one is a choice:

- **Browser** — `SpeechSynthesisUtterance`, system default voice. No picker, no pitch,
  no rate. It is a fallback, not a feature, so it has no settings of its own to get
  wrong. This is the default and it works with no configuration at all.
- **Configured API** — POST to `{base}/audio/speech`, play the returned blob. Build the
  request with trimmed text and a fixed parameter order, because that string is the
  in-memory cache key — two spellings of one utterance are two paid calls. **No speed
  parameter**: playback speed is not a control, so every utterance is generated once at
  1.0 and every listener shares the entry. Wait for `canplaythrough` before `play()`,
  with a 400ms backstop — starting an unbuffered half-second clip lets the browser
  swallow the opening consonant.

**The degradation latch.** Falling back per utterance is correct but expensive when the
endpoint is simply down. Count consecutive failures; reset on any success, so a single
503 between good responses is absorbed. Two in a row latch the session to the browser
voice and nothing calls the API again — which is why the latch has no reset: there is no
later success to observe. Say so once, in a corner toast that never interrupts the
transport, dismissible for good.

### The grammar

`moveToSpeech(move, verbosity)` at three levels:

- **full** — "White knight from g1 to f3." — colour and origin square
- **natural** — "Knight f3." / "Bishop takes f7, check." — how a commentator says it
- **short** — the notation as written (`Nf3`)

**Every level returns a sentence**: capitalised, tail clauses set off by commas, ending
in a full stop. Punctuation is the only prosody a voice has, and without it the words
mash — "knight to c6" comes out as "note c6". That slur is also why the preposition
appears only between two squares ("from g1 to f3") and never straight after a piece
name. Disambiguated notation (`Nbd7`, `R1e2`) names the **whole** origin square at every
level, because a bare "knight b d7" is not speech.

Handle castling, en passant, promotion, captures and disambiguation; append en passant,
promotion and check/checkmate as comma clauses. Announcements and results are the spoken
bookends, both gated on a toggle: the announcement adds the time control ("3 minute
blitz") and the result adds the reason ("White wins by resignation") off the
`Termination` header.

**The opening announcement lands mid-game.** Chess.com's `ECOUrl` holds the name *and*
the line that identifies it, so speak the name at the ply where the line ends, hung off
that move in one breath — "Pawn d5, the Scandinavian Defense." It returns a clause, and
the word "opening" is never appended since the names that want it already carry it. A
Lichess `Opening` header carries no line, so it falls to ply 0 and stands alone.

`positionSpeech()` says a position the way a player dictates one — **two sentences, a
side each, king first and pawns last** — rather than thirty per-piece utterances.

**What speaks and what waits to be asked is a rule, not taste.** Move phrases are a
closed vocabulary and are free. "You have been here fourteen times and scored thirty-two
percent" is unique text, so it is a **Speak button**. Same rule for explanations.

### "Why?"

One position as a FEN with the engine's numbers for it, sent to the configured chat
endpoint on an explicit press, rate-limited client-side. Validate the verdict against
the three words before asking, and drop anything else silently. If no AI provider is
configured, the button is not drawn — a card that is absent cannot say what it would
have held, but a button that errors is worse.

## 9. Optional self-hosted sync

Off by default; the app is complete without it. Settings takes a base URL and a token.
The contract is five blobs, one per store, and it is deliberately dumb — the server
stores bytes and counts versions; **the merge runs in the browser**, because that is the
only place holding both halves.

```
GET  {base}/{store}          → { version, blob }   (gzipped JSON)
PUT  {base}/{store}          ← { version, blob }   409 if version moved
DELETE {base}/{store}                              erase, always ungated
```

Stores: `deck`, `tactics`, `book`, `games`, `learn`. **Content-addressed keys make this
a union rather than a reconciliation** — two devices that author the same line or earn
the same card produce the same key, so there is no restore dialog anywhere in the
feature. Cards merge card by card: take the further-along schedule, never reset one.

Ship the reference server alongside the engine one in `server/` — the same process can
serve both. Document the contract well enough that a WebDAV or S3 shim is a weekend.

**The prep list deliberately syncs nowhere.** It is five handles you can retype and a
record of your weekend nobody else needs to hold.

Regardless of sync, Settings gets **Export everything** and **Import** — one JSON file,
merged by the same content-addressed keys. That is the backup story for everyone who
never configures a server, and it must exist before sync does.

## 10. Design

### Themes and tokens

Every colour is a custom property, in three groups whose separation is what makes a
theme cheap:

| Group | Tokens | Themed? |
| --- | --- | --- |
| structural | radius, shadow | no |
| identity | ground, surfaces, borders, primary, on-primary, text | **yes — this *is* the theme** |
| semantic | good, warn, danger, the board and its highlights | retuned per ground, never re-hued |

Four themes: **Analysis** (default), Midnight board, Wood & ink, Tournament green.
Analysis's ground is `#000` because that is an unlit pixel on an OLED panel, which is
also why it is the one theme with its washes set to `transparent` — a radial gradient
over black is what gives a pure ground away.

Two rules break silently if forgotten:

- **Every fill carries its own foreground.** `color: #fff` on a filled button is fine on
  blue, poor on brass and unreadable on bone, so `--on-primary` ships with the theme.
- **The board is themed.** Square colours, highlights and piece fills are part of the
  identity. A theme that stops at the chrome reads as a bug.

`THEMES` is the only list saying what a valid theme is; a stored value not in it is
ignored rather than applied. `applyTheme()` sets one attribute on `<html>` and nothing
else — no re-render, not even the board, because the squares and the piece colours are
tokens too.

**Apply the theme in the head, before first paint**, by a few lines reading
`localStorage` directly. Anything running at the foot of the script is too late — a user
on Wood would see a frame of Analysis first. Those lines duplicate the storage key on
purpose.

### Type

Two faces, and the line between them is about meaning rather than looks. The serif
carries everything the app **says**; the sans carries everything a user **operates** or
reads as **data**.

| Serif | Sans |
| --- | --- |
| the wordmark, card headings, table captions | buttons, tabs, fields, selects, `kbd` |
| the spoken text, explanations, training status | game and player labels, the move label |
| the sentences over the record and the tree | every count, percentage, table cell, stat tile |
| every empty state, the toast, the privacy prose | the transport and the analysis status |

**There is deliberately no `.serif` utility class.** One rule names every serif selector,
so the two faces cannot drift apart by accident. The corollary: **every control names
the sans explicitly** rather than inheriting, or a button inside a serif hint stops
reading as a button.

No webfont. `ui-serif` is a real book face on every platform, for no request, no flash
and no third party.

**SAN is a typographic object**, and one rule typesets it identically everywhere — the
move tree, variations, the explorer's moves and breadcrumbs, engine lines, the move
label. Tabular figures so a column lines up and a changing ply does not shuffle the row;
a little heavier and tighter so `Nxf7+` reads as one token rather than five characters.

### Keyboard

Full keyboard control: transport, ply stepping, game stepping, flip, the digit keys for
rooms, `L` for lines, `?` for the map. Generate the digit keys and the command palette
from the room list rather than from a second literal.

## 11. Licensing

**Read this before choosing a licence.** Stockfish is **GPL v3**. Vendoring its wasm
build and distributing it with the app makes the combined work's licensing a real
question rather than a formality. The clean answers are:

1. **License the whole repository GPL v3.** Simplest, honest, and costs an open-source
   project nothing. **This is the recommendation** — take it unless there is a reason
   not to.
2. Keep `engine/` out of the repo and fetch the build on first use, licensing your own
   code as you like. This is the arrangement that lets a permissive licence be
   defensible, at the cost of a first-run download and a weaker offline story.

The ported lesson content, ECO table and app code are the author's to relicense. Add a
`NOTICE` naming Stockfish, chess.js, the Cburnett piece set (CC BY-SA 3.0 — attribution
is required and must appear in the app, not only the repo) and the ECO source.

## 12. Testing

The original's testing idea is worth keeping and is now much cheaper: **the computations
are proved offline against fixture corpora, without a browser.** Because Insights, the
review, the deck and the crossing are all pure functions over parsed games and cached
evaluations, each gets a Vitest suite that loads a fixture PGN set plus a fixture eval
set and asserts the figures.

Suites to write, one per surface: parsing, insights, the review vocabulary (pin the
three-vs-eleven split), the deck's harvest and merge and schedule, the sweep's cursor and
estimate, the book's trie and the add-to-book crossing, the crossing report, the speech
grammar (every branch of `moveToSpeech`), the engine provider contract (both transports,
against a stub server), and the settings schema's guard-every-field behaviour.

`test/fixtures/` holds a few dozen real games — public Lichess games with clock tags,
covering bullet through classical, wins, losses, draws, flags and resignations, plus a
deliberately malformed set: a game with a clock series one reading short, a PGN with
nested variations and NAGs, a game with no result, a duplicate of another game.

One Playwright spec walks every room against a seeded IndexedDB and screenshots each, so
a layout regression is visible in a diff. Wire `npm run check` to run the lot.

## 13. Explicitly out of scope

Do not build, and do not leave hooks for: accounts, sign-in, magic links, sessions,
subscriptions, entitlement checks, payment webhooks, a maintenance wall, a demo mode, a
showcase or marketing pages, mobile layouts, server-side game storage, server-side
fetching from chess sites, telemetry of any kind.

## 14. Build order

Work in this order; each step should leave the app usable.

1. **Scaffold** — Vite, the shell, the rail, hash routing, the five empty rooms, the
   token system and all four themes, the pre-paint theme lines.
2. **Parse and show** — paste a PGN, `parseGame`, the board, the move tree, the
   transport, ply navigation. No storage yet.
3. **Memory** — IndexedDB, the nine stores, restore on boot, the cap and eviction, the
   memory switch and the erase, `memUsage`.
4. **Sources** — the import dialog: URL, Chess.com, Lichess, the source browser with its
   filters, merge-by-id.
5. **Speech** — the grammar, `speak()` and the ticket, the browser backend, the playback
   loop, announcements and results.
6. **The AI provider block** — Settings, the configured TTS backend, the cache, the
   degradation latch, the test button.
7. **The local engine** — the provider interface, the wasm worker, scans and probes, the
   eval cache and its stamp, the eval bar, arrows, scrubber marks, variations.
8. **The remote engine** — both transports, per-job-kind selection, the fallback, and the
   reference server in `server/`.
9. **The review** — `reviewClass`, accuracy, the phases, the three moments, the MultiPV 2
   second pass, the ECO table, the tree's marks.
10. **Insights** — `gameFacts`, the record, form, the clock, habits, compare, the
    explorer trie.
11. **The deck** — harvest, merge, Leitner (boxes 1/3/7/21/60; a miss returns in ten
    minutes, not tomorrow), the card renderer, grading, speaking a card.
12. **The sweep** — the pass, pause and pace, the measured estimate, the queue list, the
    sweep bar.
13. **The pattern report and recommendations** — the error-read tree, the sample floors,
    the dismissals.
14. **Learn** — the lesson walker, the 23 lessons, the library, the book store and its
    trie, add-to-book, the editor, the PGN/study import, tactics, drills.
15. **Prep** — opponents, their archives, the report pointed at them, the crossing, the
    briefing, the opponent engine pass.
16. **Export/import**, then **optional sync** if wanted.
17. **Docs** — port `architecture.md` as a description of what exists, and a README that
    leads with what the app is rather than how it is built.

## 15. How to write this code

Match the original's temperament, which is the actual reason it is good:

- **Comment the decisions, not the mechanics.** A comment saying what a line does is
  noise. A comment saying *why the obvious alternative is wrong* is the only record of
  a bug that will otherwise be reintroduced. Every rule in this document marked as
  breaking silently deserves one.
- **Name the constant and put the argument next to it.** `DECK_SWING = 300` with the
  reason beside it beats a magic number six callers deep.
- **One renderer per thing.** One deck card renderer, one board builder, one SAN rule.
  Two spellings of one object is how the two drift.
- **Prefer a guard that returns null over one that returns a plausible number.** Most of
  the hard-won rules above are that same instinct: drop the game with the bad clock
  series, discard the disagreeing eval row whole, say nothing rather than say *Brilliant*
  on a guess.
- **Every empty state is a sentence and a door.** Never a blank panel.

Start by writing `docs/architecture.md` as a stub describing the layers, then build step
1. Ask me before deviating from anything in §2.

## Appendix — files to copy from the original repo

Content, not code. Copy these across verbatim and adapt nothing but the licence header:

```
lessons/*.json          23 lessons + index.json — the whole Learn catalogue
openings/eco.json       Position-keyed ECO names (~433KB, 61KB gzipped)
openings/library.json   The shelves the lessons are grouped under
engine/                 Stockfish 17.1 Lite wasm + its Emscripten loader + LICENSE.txt
```

Read, but do not copy, as reference while building the corresponding step:

```
index.html                       The original app. Grep its section banners for the
                                 function named in each spec section above
docs/architecture.md             The layer-by-layer reference this spec compresses
docs/openings.md                 The full argument behind Learn and the book
scripts/*-check.js               The offline check pattern §12 replaces with Vitest
```

Do **not** copy: `api/`, `lib/`, `middleware.js`, `infra/`, `demo/`, `showcase/`,
`scripts/grant.js`, `scripts/license-check.js`, `.env*`, `vercel.json` — all of it
serves accounts, payment, the cloud pass or the demo, and §13 rules every one of them
out of scope.
