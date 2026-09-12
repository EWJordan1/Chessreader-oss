# Architecture

This file describes what exists. It is written as a description, not a plan: when the
code and this file disagree, the code is wrong or this file is stale, and either is a bug.

ChessReader is a static web app: Vite bundles vanilla ES modules, and everything runs in
the browser. There is no server to run. Two optional servers exist in `server/` for
people who want the engine or a sync store on another machine; the app assumes neither.

## The layers

```
PGN text ──► parse ──► games[] ──► playback loop ──► speech
(paste,      moves +   cursor      timer + ply       browser or
 URL,        FENs      (gi, ply)   cursor            configured API
 archives)                            │
                                      ├──► board render (FEN → grid)
                                      └──► UI updates
```

| Layer | Module | What it owns |
| --- | --- | --- |
| Input | `src/sources.js` | Paste / file / URL / Chess.com / Lichess → `loadPGNText()`, the single entry into parsing |
| Parsing | `src/pgn.js` | `splitPGN`, `cleanPGN`, `parseGame`, the 53-bit id, `mergeGames` |
| State | `src/state.js` | `S`, the settings schema with its per-field guards, `applyTheme`, `viewFEN` |
| Storage | `src/memory.js` | IndexedDB `chessreader`, nine stores, restore, cap and eviction |
| Board | `src/board.js` | `boardHTML` (one builder for every board), the Cburnett SVG, arrows |
| Rendering | `src/render.js` | the stage and its claims, the score, the transport, the queue, `updateAll` |
| Routing | `src/route.js` | `route()`, the room list, `registerRoom`, `renderNav` |
| Playback | `src/playback.js` | `playStep()`, ply and game navigation, variations |
| Speech | `src/speech/` | `speak()` and the ticket (`provider.js`), the two backends, the grammar |
| Analysis | `src/engine/` | the provider interface, local wasm, remote HTTP/WS, scans, probes, the sweep |
| Codec | `src/engine/codec.js` | the compact stored-analysis spellings — a leaf imported by both the scan queue and Prep, so one format has one spelling |
| Review | `src/review.js` | `classifyMove` (three words) and `reviewClass` (eleven), accuracy, the moments |
| Insights | `src/insights.js` | `gameFacts`, the record, habits, the explorer trie, patterns, recommendations |
| Deck | `src/deck.js` | harvest, merge, Leitner scheduling, tactics |
| Learn | `src/learn/` | lessons, the book and its trie, drills |
| Prep | `src/prep.js` | opponents, their archives, the crossing, the briefing |
| AI | `src/ai/explain.js` | "Why?" against a chat endpoint |
| Sync | `src/sync/client.js` | optional five-blob sync; export/import |

## Boundaries worth keeping

- **`S` is the single source of truth.** Render functions read it and never hold copies.
- **`speak()` is the only way to make sound**, and `S.uttId` the only way to cancel one.
- **Every storage failure path is "carry on in memory."**
- **Nothing analyses, fetches or uploads without a press.**
- **`route()` never touches playback.**
- **Desktop only.** Below 1100px the app says so in one sentence and does not reflow.

## The stage

One board serves every room. A room with a position to show *claims* the stage
(`stageClaim(room, pos)`), and claims are held per room, so walking out and back finds
the position still there. `pos.line` is the score beside the board: `{moves, at, from,
act, mark, nest}`. `act` is what a press on a move does — Listen's is the ply cursor;
a lesson or a drill installs a function — and a run with no `act` is a record rather
than a place. `moveRunHTML()` is the one renderer of numbered SAN.

## The settings schema

`SETTINGS` in `state.js` is a table of `{def, ok}` per persisted field. `loadSettings()`
walks it: a value the guard refuses keeps its default, a key not in the table is
ignored, so an older or hand-edited blob loads without migration.

## Memory

IndexedDB `chessreader`, nine stores, `onupgradeneeded` creating only what is missing —
every migration is additive. `GAME_CAP` is 2,000 games, evicted oldest `seq` first,
sparing whatever is on screen.

**Four stores are not caches and are never blanket-wiped.** `deck` and `tactics` are
*earned*: each row is self-contained — position, played move, engine line, both
evaluations, player, opponent, date — so it survives its game's eviction and can draw,
speak, reveal and explain itself alone. `book` is *authored*, which is stronger: a line
was typed or played in by the user and exists nowhere upstream. `opponents` is a record
of somebody's weekend.

Rules that break silently if forgotten:

- **Only the PGN is stored, so every boot re-parses.** A FEN per ply is ~3× the size of
  the game that produces it.
- **Never read across an `await` inside a transaction.** A transaction idle for a
  microtask is one the browser may close, and the bug is intermittent by construction.
  Each helper is one transaction with one request.
- **The cursor is debounced and written only if the game's row is already there** — a
  blind put resurrects an evicted game.
- **Turning memory off erases immediately**; it does not merely stop writing. What stays
  is what is on screen, because this session's work is not what is being withdrawn.

## Analysis

`analyse(fen, opts)` is the whole provider interface, and there are two implementations:
`local.js` (Stockfish 17.1 Lite as wasm — the build *is* a worker, so it is driven from
the main thread rather than wrapped in one of ours; the 7 MB is fetched only on the first
press of Analyse) and `remote.js` (HTTP `POST /analyse` and `/analyse/batch`, or a raw
UCI WebSocket, so an off-the-shelf bridge works). **Selection is per job kind**: a probe
goes wherever answers fastest, a sweep is what a remote engine is for. A remote failure
falls back to local with one toast, never to an error.

| | Scan | Probe |
| --- | --- | --- |
| Asked by | pressing **Analyse** | pressing a depth, **Lines**, or `L` |
| Covers | every ply | the position on screen |
| Depth | `SCAN_DEPTH` 18, capped by `SCAN_MOVETIME` 600 ms | 18/22/26, capped by `PROBE_MOVETIME` 6000 ms |
| Lines | 1 | MultiPV 3 |

**A scan is cached, and the cache is why a returning reader never sees one.** The `evals`
row is stamped with the engine build and the depth, and **a disagreeing row is discarded
whole rather than reconciled** — one stale number between two fresh ones is how a forced
recapture becomes a blunder. A partial row is honest and is kept; the scan queues only
what is missing. The principal variations are stored too, because after this the engine
never re-runs, and a line dropped from the cache is a line missing from every explanation
the reader ever asks for.

**A probe jumps the queue** — a scan is bookkeeping nobody asked for, a probe is a
question just asked. A scan caught mid-search is abandoned and re-queued whole rather
than allowed to commit a shallow evaluation between two deep ones.

**A variation is a position the game never reached**, so it cannot be a ply cursor:
`varFrom`/`varMoves`/`varFens`/`varAt` live beside `S.ply`, and one `viewFEN()` is what
the board, the score and the labels all read — so a variation needs no special case
anywhere downstream.

### The sweep

The pass that fills the deck, and **a press rather than an idle-time job**; the consent
outlives the tab. Newest first, one game at a time, skipping what is cached.

- **Pause keeps the consent and the place.** A hidden tab pauses automatically and lifts
  only its own press on return; a reader's pause survives a reload, an auto-pause dies
  with the tab.
- **Pace is a duty cycle (0 / 600 / 1800 ms idle gap), never a depth** — the cache stamp
  forbids changing depth. A probe never waits on it.
- **The estimate is measured, not guessed**: an EMA of what a search actually costs on
  this machine, silent until `EMA_MIN_SEARCHES` (30) have fed it, "about" for the life of
  the feature, the pace priced in, discounted by the observed skip ratio.

## The review

Two vocabularies over the same figures, and **they are separate functions on purpose**.

`classifyMove()` answers with **three words** — inaccuracy 50, mistake 100, blunder 300
(`SWING`) — and is *guarded*: null for a move the engine would itself have played, and
null from an already-lost position, expressed as a win-probability floor
(`DECIDED_WIN_PCT` 5%) rather than a centipawn one. Six callers read a non-null answer as
*this move was an error*. A trainer must not call a forced recapture a blunder.

`reviewClass()` is a second function over the same figures with **eleven words** —
Brilliant, Great, Best, Excellent, Good, Book, Forced, Inaccuracy, Mistake, Miss,
Blunder. (The spec enumerates ten and calls them eleven; `forced` is the one its list
dropped, and the second pass already collects exactly that fact.) The split is pinned by
a test.

**Accuracy is computed from win probability, not from move loss**, because they answer
different questions: loss is guarded, and an accuracy figure wants every move counted.
Lichess's curve, constant for constant, so the number is comparable with the one anyone
can get free elsewhere. Per-move loss is **floored at zero as well as capped**
(`LOSS_CAP` 1000): a mate escaped is a difference of ~99,000, and one of those in a
bucket is the whole of that bucket's mean.

**Two of the eleven need a second pass.** *Great* and *Brilliant* are claims about the
moves that were **not** played, and the scan runs MultiPV 1, so the cache cannot support
either. Inferring "only move" from the evaluation delta is the worst form of guess — a
wrong *Blunder* is a bug a reader argues with, a wrong *Brilliant* is one they believe.
So the engine re-asks at MultiPV 2 over a shortlist when the scan drains, landing answers
in a sparse `alts` column where `undefined` means *never asked* and `null` means *asked,
and the position was forced*. Neither word is said until the answer is in.

## Insights

Eight panes, all arithmetic over the loaded games — nothing fetched, nothing uploaded,
nothing stored. `gameFacts(game, heroKey)` reduces one game to the six things a record is
made of and returns `null` for a game the subject did not play; every card is built from
it. **The subject is inferred, not configured**: the name in the most games, the
remembered handle breaking a tie, with a picker to override.

Rules with teeth:

- **Time trouble is the last tenth of that game's own base clock**, never a fixed number
  of seconds — a minute is the whole game in bullet and nothing in classical. The
  predicate returns `null` rather than `false` when there is no clock to ask.
- **Clock readings come from the raw PGN**, since `cleanPGN` strips `{[%clk …]}`. A file
  whose reading count does not equal its move count is **dropped whole**: a clock series
  one move out of step yields figures that are wrong and plausible at once.
- **Accuracy is aggregated per game and then averaged across games**, never by
  concatenating the archive's moves — across a join, a move's neighbours are somebody
  else's game.
- **Every recommendation generator sits behind a sample floor.** Advice is the strongest
  register the app speaks in, and advice drawn from six games is a horoscope. A generator
  that cannot clear its floor writes nothing.

The explorer is a trie over the first twelve plies: each node *is* a tally, holds the
game indices that reached it, and takes its position from `fens[depth]` of the first game
through it. The path is a list of SAN rather than node references, so it survives a
rebuild. The pattern report reads the same tree for errors instead of results.

## The deck

`DECK_SWING` is 300 centipawns: a move that cost three pawns becomes a card.
`TACTIC_BAND` is [200, 300] — the near-misses, on the same schedule in their own store.
Leitner boxes are `DECK_BOXES` [1, 3, 7, 21, 60] days, and **a miss returns in ten
minutes** (`DECK_RETRY_MS`), not tomorrow.

Each row is self-contained by design (see Memory), which is what lets a card outlive its
game and explain itself to the AI module with no game in hand.

## Learn

Three sections split by *act* — acquiring material against practising it. 23 lessons
ship; a lesson file is fetched only when opened. **`Add to my book` is the only way
anything crosses from a lesson into the book**: your book is what you decided, not what
you were shown.

The book's derived trie deliberately **carries no tallies** — a decision has no
denominator, and a node with `n: 0` is a percentage waiting to be printed by accident.

Drills *run* in Listen rather than in Learn, so a reader held on a guess does not have to
change rooms to answer.

## Prep

A short list of the people you are about to play, their public games filtered to the
format you are actually playing, and the report Insights gives about you pointed at them.
Above it sits the one finding a report about yourself cannot produce: **your repertoire
walked against theirs**, as deep as you both have games in it, and where it goes worst
for you out of there. One tier costs the reader's own CPU — a stoppable, resumable engine
pass over their games, the crossing's games first.

**The prep list syncs nowhere.** It is five handles you can retype and a record of
somebody's weekend nobody else needs to hold.

## Sync

Off by default; the app is complete without it, and Export / Import is the backup story
for everyone who never runs a server. Five blobs, one per store, and the contract is
deliberately dumb: the server stores bytes and counts versions, and **the merge runs in
the browser**, because that is the only place holding both halves.

**Content-addressed keys make this a union rather than a reconciliation** — two devices
that author the same line or earn the same card produce the same key, so there is no
restore dialog anywhere in the feature. Cards merge card by card and take the
further-along schedule, never a reset. A 409 means re-GET, re-merge, re-PUT, bounded.

Only the `meta` rows that are facts about the *reader* travel; `cursor`, `sweepCursor`
and `schema` are facts about a device and stay on it.

## Where the spec was corrected

Two places where this port knowingly differs from `oss-port-prompt.md`, both recorded
here so the difference is a decision rather than a drift:

1. **The eleven words.** §7 says "eleven words" and then lists ten. The original app's
   list is the eleven; `forced` is the one the enumeration dropped, and the MultiPV 2
   pass already answers exactly that question, so it costs nothing to say.
2. **Nine stores, one version.** §5 describes the nine stores as the result of additive
   migrations from an older schema. This repository starts at `DB_VERSION` 1 with all
   nine present, because there is no older database in the world to migrate from.

