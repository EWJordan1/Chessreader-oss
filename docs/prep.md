# Prep

A short list of the people you are about to play, and one report per person. A handle and
a time control brings their public games to this browser, filtered to the format you are
actually playing; the row says what it read. Opening a row gives the report Insights gives
about you, pointed at them — and above it **your repertoire walked against theirs**, which
is the one finding a report about yourself cannot produce.

Files: `src/prep.js`, `css/prep.css`, `test/prep.test.js`, this file.
Mount: `#prep-body`. Rooms: `prep`, registered in `boot()`.
Stores: `opponents`, `oppgames`, `oppevals` (memory owns the stores; the row shapes are here).

## What exists

| Area | Exports |
| --- | --- |
| The list | `opponents` `findOpponent` `addOpponent` `removeOpponent` `oppKeyOf` `rowSentence` |
| The format filter | `formatOf` `inFormat` `filterFormat` `FORMATS` `DEFAULT_FORMAT` |
| The fetch | `fetchOpponent` `monthsSince` `oppGameRow` `evictOldest` `oppGames` `OPP_GAME_CAP` `FETCH_MAX` |
| The crossing | `oppTrie` `crossing` `passOrder` `CROSS_*` |
| The report | `buildReport` `briefing` `briefingParts` `lineText` `lineSpeech` |
| The engine pass | `startPass` `stopPass` `passState` `passRow` `applyPassRow` `PASS_*` |

The room has **two addresses**: `#/prep` is the list, `#/prep/<site>:<handle>` is that
person's report. The report is therefore a *place* — reachable by URL, surviving a reload,
closed by its own Back — which is the only reason it is a route segment rather than an
expanded row. The opponent id is one route segment (`route()` splits on the first `/`
only, and the id's separator is a colon), so nothing had to change in the shell.

The rail badge is the list's length, drawn by `renderNav()` off `S.opponents`; the module
only has to call `renderNav()` after an add or a remove.

## The crossing

The room's reason to exist, so it is written first in the file, drawn first in the report
and said first in the briefing.

`crossing(oppGames, trie, {color, oppKey, minGames, minPly, maxPly})` walks two tries in
lockstep: `trie` is `bookTrie(color)` — **your** book, in Learn's own memoised trie, never
a copy — and the other is `oppTrie(games, oppKey, theirColor)`, a tally of their games as
the opposite colour. Both are SAN from the start position, so they align move for move:
**no transposition logic and no engine — the whole finding is arithmetic over two trees.**

Whose ply it is decides what happens at a node:

- **Your ply.** The *book* chooses. Only the book's moves are followed, and only into
  nodes their games actually reached; a move of yours they have never faced is not a
  crossing.
- **Their ply.** *They* choose. A move of theirs your book answers goes deeper. A move of
  theirs your book has **no** answer to becomes a **gap row** — `gap: true`, a `walk` to
  Learn's editor, rendered as *Add one*.

Three findings come out of the walk:

| Field | What it is |
| --- | --- |
| `deepest` | the deepest node the two tries share — "you go as deep as 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6" |
| `shared` | the end of every branch, sorted **by their score at that node**, worst for you first |
| `gaps` | lines they play that your book has nothing for, sorted by how often they play them |

`rows` is `shared` then `gaps`; the table draws `CROSS_ROWS` of each and the report keeps
them all.

### Three rules that break silently if undone

1. **`shared` is ranked by their score, not by how often the line came up.** A line they
   win three of three out of is worse news than one they score even in over twenty.
   Ranking by `n` would reliably lead with whatever they play most, which is the thing you
   could already see in their opening pane.
2. **A gap is a row, never a silence.** A walk that reported only shared nodes would
   report the repertoire you already know you have. Where the walk *stops* is the finding.
3. **`CROSS_MIN_GAMES` is applied at the descent, not at the row.** Two games is the floor
   for writing anything; the floor is enforced *before* walking into a node, because a
   walk into a one-game branch comes back having written nothing **and** having marked its
   parent as descended — and the honest row above it, reached by enough games to mean
   something, vanishes with the branch that swallowed it. Enforcing it at the descent also
   means `deepest` can only ever name a node that clears the floor, so the briefing cannot
   open with a confident 100% over a single game.

`CROSS_MIN_PLY` (2) keeps one ply from being called a line: "after 1.e4 they score 54%" is
their whole archive with a move in front of it. `CROSS_MAX_PLY` (24) bounds the cost of
building their trie; in practice the walk is bounded by the book, which is shorter.

### What it feeds

`passOrder(games, {w, b})` reads the `gis` off the crossing's rows and puts those games at
the front of the engine pass — those are the positions you are actually going to be in.

## The other decisions

**The format filter drops, it does not sort.** A game outside the chosen time class is
dropped entirely, at the fetch *and* again at the read. A bullet game says nothing about
how somebody handles a rapid opening, and a row reading "142 blitz games" that quietly
contains forty bullet games is wrong in the one way nothing downstream could detect. The
class comes from `timeClassOf(TimeControl)` — Insights' own rule, not a second spelling of
it, and not the site's own label: that is what lets a Chess.com row (`ECOUrl` dialect), a
Lichess row (`Opening` dialect) and a hand-pasted PGN land in the same bucket. A header
that cannot say lands in no bucket at all.

**Refreshing asks for what is new.** `readAt` on the row is the watermark and
`fetchOpponent(id)` defaults `since` to it; `{since: 0}` is the explicit way to ask for the
archive again. Lichess takes the watermark itself as a query parameter, so the network
never carries the old archive. Chess.com has no `since` — its archive is a list of month
URLs — so the watermark is applied to the **months**, and a month that ended before it is
never fetched at all (`monthsSince`). Asking for every month and filtering afterwards is
the same answer at forty times the bandwidth, every night before a tournament. A month URL
this cannot parse is asked for rather than guessed at.

**The cap is theirs.** `OPP_GAME_CAP` (300) is per opponent, which is the reason their
games live in their own store rather than among the reader's. `evictOldest` returns
`{keep, drop}` rather than mutating, because the caller has to delete the dropped rows from
*two* stores and a function that had already thrown them away could not say which.
`oppevals` is keyed as `oppgames` is, so neither can be orphaned by the other.

**The briefing says the crossing before the record.** `briefingParts(rep)` returns
`{key, text}` in a fixed order: what was read, the crossing (deepest, worst, gap, per
colour), the record, the endings, what they open with, and what the engine pass found. The
record is what a report about them already says; the crossing is the thing it cannot. A
person with no games in the chosen format gets **one** sentence saying exactly that, rather
than a briefing read over an empty report. `briefing()` is those sentences, and the button
speaks them one at a time so that Stop lands between sentences and the reader hears where
they stopped.

`lineSpeech` walks a path back into verbose moves and hands them to the one grammar at
`natural` verbosity — "pawn e4, pawn e5, knight f3". `short` verbosity *is* the SAN with a
capital letter on it, which is the "N f 3" this function exists to avoid. An illegal path
falls back to the SAN rather than throwing.

**Insights' report is reused, not rebuilt.** `renderReport(el, games, oppKey, {about:
'them', name, room: 'prep'})` draws all eight panes in the third person. This module does
not rebuild a single pane, and `patternReport` is what the engine pass feeds.

**The list syncs nowhere (§9).** It is five handles you can retype and a record of
somebody's weekend that nobody else needs to hold. `opponents` is not in the five stores
the sync client carries, and is not in the export blob either. It is also not a cache:
it is never blanket-wiped, and removing a person is an explicit press that takes their
games and their evaluations with them.

**Nothing runs without a press (§2.7).** Adding a person stores an empty row. Arriving at
a report reads what is on the disk. The fetch, the refresh and the engine pass are three
separate buttons, and every failure path is one sentence in a toast rather than an error.

## Row shapes

```js
// opponents — key `id`
{ id: 'chesscom:hikaru', site, handle, format, addedAt,
  readAt,   // the watermark: when this row was last read, and what "what is new" means
  count,    // games held after the cap, in that format
  since }   // the finish of the oldest game held — the "since March" in the row sentence

// oppgames — key `oppId:pgnId`, index `by-opp` on [oppId, endTime]
{ key, oppId, pgnId, pgn, headers, endTime }

// oppevals — key `oppId:pgnId`, the `evals` row shape with Prep's own stamp
{ key, oppId, pgnId, build: PASS_BUILD, depth: PASS_DEPTH, plies, evals, lines, alts, bytes }
```

A crossing row, which is what the table and the briefing both read:

```js
{ path: [SAN], plies, san,          // the line, and its last move
  n, tally: {n, w, d, l}, score,    // THEIR tally and THEIR score at that node
  gis: [index],                     // which of their games are under it — the pass's queue
  gap, walk }                       // a gap ends in *Add one* and walks to Learn's editor
```

`buildReport(opp, games)` is the whole room as one plain object — `{stats, cross: {w, b},
pass, since, readAt, name, oppKey, games}` — and it is pure, so the ninety seconds of
speech are tested without a document and without a network.

## The engine pass

One press, the reader's own CPU, and the only thing in the app that evaluates somebody
else's games.

- `PASS_DEPTH` 14 and `PASS_MOVETIME` 300 — shallower than the reader's own scan (18/600),
  because it is up to 300 of somebody else's games and the finding wanted from it is which
  line their mistakes come out of, not a centipawn.
- `PASS_BUILD` is its own stamp. `applyPassRow` discards a row of another build, another
  depth, or another ply count **whole** rather than reconciling it, exactly as the
  engine's own eval cache does; a ply count that disagrees is the only way to notice a
  different game under the same key.
- The queue is `passOrder`: the games from the crossing first, then the rest, each once.
- **Stoppable, and it resumes where it stopped.** `stopPass()` clears the flag and aborts
  the in-flight job; what has been committed is written per game, so pressing again skips
  every ply that already has an evaluation. There is one pass at a time and it belongs to
  the room, not to the engine's queue.
- The provider answers from the side to move; the store is White-positive, and the
  conversion happens where the eval is committed.

`passSummary` then reads `patternReport` over both colours, so the report gains the lines
their mistakes keep coming out of.

## Tests

`test/prep.test.js`, 44 tests, node environment, no DOM. `src/memory.js` is mocked with an
in-memory map per store (including a `by-opp` range), `fetch` is stubbed per route, and
`src/engine/provider.js` is stubbed so the pass can be stopped mid-position. Corpora are
built from `test/fixtures/chesscom.pgn` (34 games, `ECOUrl`) and `test/fixtures/lichess.pgn`
(17 games, `Opening`) — two header dialects on purpose — plus small synthetic archives
where the claim needs an exact shape.

What is pinned: the crossing's deepest node; worst-by-score rather than by count; the gap
row surviving to the table with its door; `CROSS_MIN_GAMES` as a floor in both directions
and not swallowing the row above it; the format filter dropping rather than sorting, and
the sentence a person with no games in that format gets; the Chess.com months and the
Lichess `since` both being "what is new"; oldest-first eviction from both stores; the
briefing's fixed order with the crossing before the record; `passOrder` putting the
crossing first; the pass stopping and resuming; and `applyPassRow` refusing a disagreeing
build, depth or ply count.

Two bugs were found while writing them, and both are fixed in `src/prep.js`: the crossing
applied `CROSS_MIN_GAMES` at the row instead of at the descent (losing real rows and
letting `deepest` name a one-game line), and `lineSpeech` asked the grammar for `short`
verbosity, which returns the SAN itself.

## Asks

Nothing blocking. Four things a shared file could do better, all worked around locally:

1. **The `evals` row codec is written twice.** `oppevals` uses the engine's compact
   spellings (`"30,25,m2,,-40"`, `"e2e4 e7e5|g1f3|"`), and `src/prep.js` spells them out
   again rather than reaching into the scan queue for them. Two spellings of one format is
   how the two drift. A leaf module exporting `encodeEvals`/`decodeEvals` — owned by
   neither module, imported by both — would end it.
2. **`plural(n, one, many)` pluralises the whole phrase.** `plural(3, 'of their games')`
   is `"3 of their gamess"`, and the third argument does not help when the right English
   is "1 of their games" as well as "3 of their games". A `count(n, phrase)` in `dom.js`
   that only ever prefixes the number would cover this; Prep has a three-line local helper
   for now. (This was a live bug in the briefing, not a hypothetical.)
3. **`components.css` puts `.hint` and `.lede` in the serif**, so every figure inside one
   has to be put back into the sans by name (`.prep-cross .lede .num`). Insights asks for
   the same thing: a muted-but-sans class — the colour of `.hint` without its face.
4. **A progress element.** The engine pass draws its own bar out of a class and a
   `--frac` custom property on `.prep-pass-status`, because the shell's only progress
   affordance is `showLoading()`, which is modal, and `#sweep-bar` belongs to the engine.
   A small non-modal `.progress` in `components.css` would be used by at least Prep and
   the sweep.

One note rather than an ask: `emptyHTML(sentence, label, action)` documents `'import'` as
the door action, but it emits `data-act` and any room with a click delegate can answer its
own doors. Prep answers `back`, `refresh` and `book` that way.
