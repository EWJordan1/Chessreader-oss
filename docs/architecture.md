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

*The sections for memory, analysis, the review, insights, the deck, the sweep, learn,
prep and sync are added as each module lands.*
