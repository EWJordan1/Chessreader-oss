# Module contract

How the modules fit together. `docs/architecture.md` describes the app; this file is the
agreement each module is built against, so that modules written apart still meet. When a
module needs something not written here, it asks for it by adding to *its own* section
and its own files — never by editing another module's file.

## Ground rules (from the spec, §2 — violating one is a bug)

1. Desktop only, ≥1100px. No breakpoints, no touch affordances.
2. No accounts, no auth, no server you have to run. `npm run dev` is the whole environment.
3. Zero required third-party services. Remote engine and AI voice/explanations are opt-in;
   every failure path falls back to the local default with one toast, never an error.
4. `S` (src/state.js) is the single source of truth. Renderers read it; changes call an update function.
5. `speak()` (src/speech/provider.js) is the only way to make sound.
6. Every storage failure path is "carry on in memory" and says one sentence about why.
7. Nothing analyses, fetches or uploads without a press. No idle jobs, no polling.

Plus, for this codebase:

- **Vanilla JS, ES modules, no framework, no TypeScript.** JSDoc where a shape is non-obvious.
- **Comment the decisions, not the mechanics.** Every rule in the spec marked "breaks
  silently" gets a comment saying why the obvious alternative is wrong.
- **Prefer a guard that returns null over one that returns a plausible number.**
- **One renderer per thing.** Use `boardHTML`, `moveRunHTML`, `emptyHTML`; do not write a second.
- **Every empty state is a sentence and a door.** Never a blank panel.
- **Every colour is a token** from `css/tokens.css`. Never a raw hex in a module's CSS or markup.
- **Classes worth knowing**: `.hint` / `.lede` / `.empty` are serif prose; `.meta` is muted
  *data* in the sans; `.cards` is a card wall and `.cards-report` a two-column report grid
  whose panes may take a whole row with `.span-2`; `.panel-body.scroll-x` scrolls a wide
  table sideways inside its own panel.
- **Type**: the serif carries what the app *says* (headings, prose, verdicts, empty states);
  the sans carries what a user *operates* or reads as *data* (controls, counts, tables, SAN).
  There is no `.serif` class; the rule in `components.css` names the selectors. Use the
  existing classes (`.hint`, `.lede`, `.empty`, `.panel-head h2`, `.san`, `.num`, `.stat`).

## File ownership

Each module owns the files listed for it and **edits nothing else**. Shared files —
`index.html`, `src/main.js`, `src/state.js`, `src/render.js`, `src/route.js`,
`src/playback.js`, `src/dom.js`, `src/pgn.js`, `src/board.js`, `css/tokens.css`,
`css/layout.css`, `css/components.css`, `docs/architecture.md` — are the integrator's.
If you need a change in one, write it down in your `docs/<module>.md` under "Asks" and
work around it for now (a module may append its own panels into its mount by JS).

| Module | Owns | Mounts in `index.html` |
| --- | --- | --- |
| memory | `src/memory.js`, `src/sync/export.js`, `test/memory.test.js`, `docs/memory.md` | `#settings-memory` card: `#set-remember`, `#mem-usage`, `#btn-erase`, `#btn-export`, `#file-import`; `#rail-status` |
| sources | `src/sources.js` (extend), `css/sources.css`, `test/sources.test.js`, `docs/sources.md` | `#dlg-import`: `#pane-url`, `#pane-chesscom`, `#pane-lichess`, `#source-browser`; `#set-chesscom`, `#set-lichess` are settings fields already wired |
| engine | `src/engine/*.js`, `server/*`, `css/engine.css`, `test/engine.test.js`, `test/sweep.test.js`, `docs/engine.md` | `#btn-analyse`, `#analysis-tools`, `#analysis-status`, `#scrub-marks`, `#analysis-mount`, `#settings-engine` fields (`#set-engine-mode/url/token`, `#btn-engine-test`, `#engine-test-result`, `#set-sweep-pace`, `#sweep-settings`), `#sweep-bar` |
| review | `src/review.js`, `css/review.css`, `test/review.test.js`, `docs/review.md`; loads `openings/eco.json` | `#review-mount`, `#turn-strip`, tree marks via `setTreeMark` |
| insights | `src/insights.js`, `css/insights.css`, `test/insights.test.js`, `docs/insights.md` | `#insights-body` |
| deck | `src/deck.js`, `css/deck.css`, `test/deck.test.js`, `docs/deck.md` | none of its own: cards are drawn by Learn's drill runner through `deckCardHTML()` |
| learn | `src/learn/*.js`, `css/learn.css`, `test/learn.test.js`, `docs/learn.md` | `#learn-body`, `#learn-tabs`, `#drill-section`/`#drill-body` (in Listen) |
| prep | `src/prep.js`, `css/prep.css`, `test/prep.test.js`, `docs/prep.md` | `#prep-body` |
| home | `src/home.js`, `css/home.css`, `docs/home.md` | `#home-body`, `#badge-home` |
| ai | `src/ai/explain.js`, `docs/ai.md` | `#explain-mount` |
| sync | `src/sync/client.js`, `server/` (shares the process with the engine server), `test/sync.test.js`, `docs/sync.md` | `#settings-sync` fields, `#btn-sync-now`, `#sync-status` |

Every module exports `boot()` (memory exports `bootMemory()`), called once from
`src/main.js` after settings are loaded and before the first `route()`. `boot()` wires
its DOM, registers its room, and installs its hooks. It must not throw if its mount is
missing. Tests import the pure functions; nothing touches `document` at import time.

## What the shell already provides

```js
// state.js
S                       // the state object; settings fields are S[key] — see SETTINGS there
saveSettings()          // after changing any SETTINGS field
currentGame()           // S.games[S.gi] || null
viewFEN()               // the position on the board (variation-aware)
inVariation()
aiConfigured()          // base URL and key both set
THEMES, PROBE_DEPTHS, SWEEP_PACES, ENGINE_MODES

// dom.js
$(id), escHtml(s), toast(text, {action, onAction, sticky}), showLoading(text, frac), hideLoading()
emptyHTML(sentence, doorLabel, doorAction)   // doorAction 'import' opens the import dialog
plural(n, one, many), fmtDate(ms)

// route.js
registerRoom(room, enter(arg, {first}))  // paint on arrival; `first` only on the first arrival this session
//   rooms: home learn insights prep play settings
onRoute(fn(room, arg)), currentRoom(), routeArg(), navigate(room, arg), hashFor()
setDueCounter(fn)                // Learn's badge: fn() → number, counting deck+book+tactics once each
renderNav()

// render.js
stageClaim(room, pos), stageRelease(room), stageOwner(), stagePos()
//   pos = {fen, from, to, flipped, veiled, label, arrows:[{from,to,kind}], eval:{cp}|{mate}, line,
//          legend:{best, missed}}   // optional sentences for the arrow key; a card's amber is the move played
//   line = {moves, at, from, act, mark, nest}; act: 'play' (Listen's cursor) or fn(ply1based)
moveRunHTML(moves, {style:'tree'|'var'|'line'|'plain', from, at, attr, tail, mark, nest})
renderBoard()            // Listen's claim; call after anything that changes what its board shows
renderStage(), renderNotation(), updateAll(), updateNowPlaying(), sayNow(text), showBoard()
onRender('board'|'notation'|'all', fn)   // painters run after each repaint of that kind
setTreeMark(fn(game, ply) → tier|null)   // review installs; tiers are TREE_MARKS keys
setArrowsFor(fn(game) → arrows), setEvalFor(fn(game, ply) → {cp}|{mate}|null)   // engine installs
TREE_MARKS, STAGE_ROOM_LABEL

// playback.js
play(), pause(), togglePlay(), nextMove(), prevMove(), goToPly(n), setGame(i, ply), nextGame(), prevGame()
enterVariation(uciOrSan), exitVariation(), varStep(d), varGoTo(n), varUndo(), flipBoard()
setGuessGuard(fn(game, ply) → bool)   // drills: hold before speaking this ply
onGuessHold(fn(game, ply))            // fires the moment the loop stops for an answer
setVerdictSpeech(fn(game, n) → string) // review installs: a sentence appended to move n's speech, or ''
onCursor(fn)                          // fires on every cursor change (memory debounces it)

// sources.js
loadPGNText(text, source) → {added, dupes, skipped, games}   // the single entry into parsing
onGamesAdded(fn(games))               // fires with the newly added games after each import
openImport(tab), closeImport(), showImportTab(tab)

// speech
speak(text, onDone, onStart), cancelSpeech()         // provider.js
moveToSpeech(move, verbosity), positionSpeech(fen), resultSpeech(h), announcementSpeech(h)   // grammar.js

// pgn.js
splitPGN, cleanPGN, parseGame, pgnId, headersOf(pgn), mergeGames, loadGames, moveNumberLabel, fenPly, START_FEN
// board.js
boardHTML(fen, {flipped, from, to, coords, interactive, legal, selected, moves}), arrowsSVG, PIECES, COLORS
```

Custom events on `document` (dispatch with `new CustomEvent(name, {detail})`):

| Event | From | Meaning |
| --- | --- | --- |
| `cr:restored` | memory | the library is back off the disk; `S._restoring` is now false |
| `cr:games-added` | sources (also via `onGamesAdded`) | `detail.games` were added |
| `cr:games-removed` | memory | `detail.ids` were evicted or erased |
| `cr:analysis` | engine | `detail.game`'s analysis progressed (a ply committed) |
| `cr:analysis-done` | engine | `detail.game`'s scan is complete (every ply evaluated) |
| `cr:alts-done` | engine | the MultiPV 2 second pass landed for `detail.game` |
| `cr:deck-changed` | deck (also memory, after import/erase) | cards were added, graded or removed |
| `cr:book-changed` | learn (also memory, after import/erase) | the book changed |
| `cr:setting` | settings | `detail.key` changed in Settings |
| `cr:settings-painted` | settings | the Settings room repainted; add your own field paint here |
| `cr:analyse`, `cr:lines`, `cr:import` | keys | the `a`, `L`, `i` keys |
| `cr:sweep` | engine | sweep state changed (running/paused/progress) |

## Shapes

### A game (`S.games[i]`)

```js
{ id, pgn, headers, moves, fens,            // from parseGame
  source, addedAt, seq, bytes,              // from sources / memory
  lastPly, lastPlayedAt,                    // memory's cursor row
  analysis,                                 // engine — see below; undefined until asked
  _review, _facts, ... }                    // per-module caches, underscore-prefixed, never stored
```

### `game.analysis` (engine owns; review, insights, deck, home read)

```js
{ build: 'sf17.1-lite' | string,     // engine build stamp; a row with another build is discarded whole
  depth: 18,                          // the scan depth; likewise
  evals: [],   // evals[i] evaluates fens[i], White-positive: {cp} or {mate: n} (n>0 White mates); undefined = not yet
  best:  [],   // best[i] = UCI the engine would play from fens[i]
  pv:    [],   // pv[i] = UCI[] principal variation from fens[i]
  alts:  [],   // alts[i]: undefined never asked · null asked, position forced · {cp} second-best eval (White-positive)
  done: 0,     // count of evaluated plies; analysisReady(game) ⇔ done === fens.length
  altsDone: false }
```

`test/fixtures/evals.json` is `{ [gameId]: analysis }` computed by a native Stockfish at
depth 12 over every game in `test/fixtures/chesscom.pgn` (with `pv` capped at six
moves). Tests attach it: `game.analysis = evals[game.id]`.

### The stored rows (memory owns the stores; each module owns its row shape)

| Store | Key | Row (owner) |
| --- | --- | --- |
| `games` | `id` | `{id, pgn, headers, source, addedAt, seq, bytes, lastPly, lastPlayedAt}` (memory) |
| `evals` | `gameId` | `{gameId, build, depth, plies, evals, lines, alts, bytes}` — `evals` is a compact string `"30,25,m2,,-40"` (empty = undefined), `lines` is `"e2e4 e7e5|g1f3|"` (per ply, `|`-separated), `alts` likewise with `n` for null (engine) |
| `deck` | `gameId:ply` | see deck below (deck) |
| `tactics` | `gameId:ply` | same shape as deck (deck) |
| `book` | `w|b` + `:` + hash of SAN moves | `{key, color, moves:[SAN], name, box, due, seen, passes, fails, lastAt, addedAt}` (learn) |
| `meta` | `k` | `{k, v}`: `cursor` `{id, ply}`, `hero`, `schema`, `sweepCursor`, `recsHidden` |
| `opponents` | `site:handle` | `{id, site, handle, format, addedAt, readAt, count, since}` (prep) |
| `oppgames` | `oppId:pgnId`, index `by-opp` on `[oppId, endTime]` | `{key, oppId, pgnId, pgn, headers, endTime}` (prep) |
| `oppevals` | `oppId:pgnId` | as `evals` (prep) |

**A deck card** (self-contained: it draws, speaks, reveals and explains itself alone):

```js
{ key: gameId + ':' + ply, gameId, ply,
  fen,                 // the position before the mistake (fens[ply])
  played, previous, answer,   // UCI: the move played, the move before it (for the highlight), the engine's move
  before, after,       // {cp}|{mate} evaluations before and after the played move, White-positive
  color,               // whose mistake: 'w' | 'b'
  player, opponent, date, site,   // strings, for the label
  box, due, seen, passes, fails, lastAt, addedAt }   // the Leitner schedule
```

### Memory API (`src/memory.js`)

```js
bootMemory()                 // open, migrate, load the Maps (S.deck, S.tactics, S.book, S.opponents), restore games, fire cr:restored
memAvailable() → bool        // false = carry on in memory
dbGet(store, key), dbPut(store, row), dbPutAll(store, rows), dbDelete(store, key), dbAll(store), dbClear(store), dbCount(store)
dbIndexRange(store, index, lower, upper)   // for oppgames
memUsage() → {games, evals, deck, tactics, book, bytes}
eraseAll()                   // the one-press-twice erase; also what turning memory off does
exportEverything() → object, importEverything(obj) → {added per store}   // src/sync/export.js
```

Each helper is one transaction with one request; **never read across an `await` inside a
transaction**. All helpers resolve normally when storage is unavailable (get → undefined,
all → [], puts → false) so callers need no branches.

### Engine API (`src/engine/*.js`)

```js
// provider.js
analyse(fen, {depth, multipv, movetimeMs, signal, kind:'scan'|'probe'|'sweep'}) → Promise<{cp?, mate?, pv: string[], depth, lines?: [{cp?, mate?, pv}]}>
//   cp/mate are from the SIDE TO MOVE's view here (raw UCI); analyse.js converts to White-positive when it commits
engineStatus() → {local: 'idle'|'loading'|'ready'|'failed', remote: 'off'|'ok'|'down'}
// analyse.js
analyseGame(game)            // a scan: cache first, queue what is missing; the press behind #btn-analyse
probe(fen, depth)            // MultiPV 3 for the position on screen; jumps the queue
analysisReady(game) → bool
classifyable(game, ply) → bool
ENGINE_BUILD, SCAN_DEPTH (18), SCAN_MOVETIME (600), PROBE_MOVETIME (6000)
// sweep.js
startSweep(), pauseSweep(byUser), resumeSweep(), stopSweep(), sweepState() → {on, paused, auto, done, total, etaMs|null}
```

### Review API (`src/review.js`)

```js
classifyMove(game, n) → 'inaccuracy'|'mistake'|'blunder'|null   // three words, guarded (null for best move / already lost)
reviewClass(game, n) → one of the eleven words, or null when unanalysed
winProb(cp) → 0..100 (Lichess curve), moveLoss(game, n) → cp ≥ 0 or null
gameReview(game) → {accuracy:{w,b}, plies:[tier…], phases:{opening:{w,b}, middlegame, endgame}, moments:[{ply, tier, swing}], opening:{eco, name, exitPly}, counts:{w:{blunder:n…}, b:{…}}}
ecoLookup(fen) → {eco, name} | null      // openings/eco.json, loaded lazily
```

### Insights API (`src/insights.js`)

```js
gameFacts(game, heroKey) → {color, result:'w'|'l'|'d', ending, timeClass, length, rating, oppRating, opponent, date} | null
resolveHero(games) → {name, key} | null        // most frequent name; S.heroOverride wins; remembered handle breaks a tie
computeStats(games, heroKey) → the record
buildExplorer(games, heroKey, color, maxPly=12) → trie root {n, w, d, l, games:[i], fen, children: Map<san, node>}
patternReport(games, heroKey, color, minGames=3) → rows
recommendations(games, heroKey) → [{id, weight, text, numbers, walk:{room, arg}}]   // sample floors inside
clockSeries(game) → number[] | null            // raw PGN [%clk]; null when count ≠ move count
timeTrouble(game, ply) → bool | null
renderReport(container, games, heroKey, {about: 'you'|'them', name, room})   // the eight panes, reused by Prep
//   `room` names which room's stage claim the explorer should make ('insights' | 'prep')
```

### Deck API (`src/deck.js`)

```js
DECK_SWING = 300, TACTIC_BAND = [200, 300], DECK_BOXES = [1,3,7,21,60] (days), DECK_RETRY_MS = 10*60*1000
harvestDeck(game) → {deck: card[], tactics: card[]}    // from game.analysis; nothing when not analysisReady
mergeDeck(cards, store='deck'|'tactics') → added      // into S.deck / S.tactics + dbPutAll; never resets a schedule
deckDue(now) → card[], tacticsDue(now) → card[]
gradeCard(card, pass, now, store?) → card             // Leitner; a miss returns in DECK_RETRY_MS
deckCardHTML(card, {revealed}) → html                 // the one card renderer
cardClaim(card, {revealed}) → a stage pos             // for stageClaim
speakCard(card, {revealed}), cardAnswerSpeech(card)
weekStats(now) → {drilled, due, grew, worst: card|null}   // for Home
```

### Learn API (`src/learn/*.js`)

```js
// book.js
bookLines(color?) → line[], bookTrie(color) → root (no tallies), addToBook(color, sanMoves, name) → line|null (dupe → null)
removeLine(key), bookDue(now), gradeLine(line, pass, now)
// lessons.js
loadIndex() → catalogue, loadLesson(id) → lesson (fetched only when opened)
// drills.js
startDrill(kind:'deck'|'tactics'|'book'|'guess', opts), stopDrill({quiet}), drillState()
//   'guess' takes {side: 'w'|'b'|'both'} and holds the playback loop before that side's moves
answerDrill(text), revealDrill(), judgeAnswer(fen, text, expected), moveOn(fen, text), guessGuard(game, ply)
```

### Prep API (`src/prep.js`)

```js
opponents() → S.opponents, addOpponent(site, handle, format), removeOpponent(id)
fetchOpponent(id, {since}) → count, crossing(oppGames, bookTrie) → report, briefing(report) → sentences[]
```

## Speak buttons

Move phrases are free. Unique text is a **Speak** button (`.btn` calling `speak(text)`).
Outside Listen, give it the class `speak-elsewhere`: the stylesheet hides those unless the
reader turned on *Speak buttons in every room* (Settings → Reading, `S.speakEverywhere`,
written onto `<html data-speak-all>`). No renderer needs to check the setting.

## Rooms

`#drill-section` in Listen stays on screen with its idle sentence when no drill is
running, rather than being hidden: an empty state is a sentence and a door, and a panel
that vanishes cannot say what would fill it.

A room module calls `registerRoom(room, enter)` in `boot()`. `enter(arg)` paints the
room's body from `S` and claims the stage if it has a position (`stageClaim(room, pos)`);
it must be idempotent and cheap enough to call on every arrival. Claim only when there is
something to show; release when there is not.

## Tests

Vitest, `test/<module>.test.js`, node environment. Load fixtures from
`test/fixtures/`:

| File | What |
| --- | --- |
| `chesscom.pgn` | 34 real Chess.com games, bullet through daily, with clocks and `ECOUrl` headers |
| `lichess.pgn` | 17 real Lichess games, with clocks and `Opening` headers, `Termination` Normal / Time forfeit — the other header dialect |
| `malformed.pgn` | nested variations and NAGs, a game with no result, a clock series one reading short, unparseable movetext |
| `evals.json` | `{[gameId]: analysis}` from a native Stockfish at depth 12 over every game in `chesscom.pgn` |
 Memory tests use `fake-indexeddb/auto`. Network is stubbed (`globalThis.fetch = …`).
Pin the claims a bug would falsify silently, not the mechanics.

## Docs

Write `docs/<module>.md`: what exists, the decisions and why, the row shapes, and an
"Asks" list of anything you needed from a shared file. The integrator folds it into
`architecture.md`.
