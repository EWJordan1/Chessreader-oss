# Memory

What this device remembers between visits: `src/memory.js` (IndexedDB, the nine stores,
restore, the cap, the switch, the erase, usage) and `src/sync/export.js` (Export / Import
as one JSON file). Tests in `test/memory.test.js`.

## What exists

**Database** `chessreader`, version 1, nine stores exactly as the contract table:
`games(id)`, `evals(gameId)`, `deck(key)`, `tactics(key)`, `book(key)`, `meta(k)`,
`opponents(id)`, `oppgames(key, index by-opp on [oppId, endTime])`, `oppevals(key)`.
`onupgradeneeded` creates only what is missing; a migration that must change a store does
it row by row, never by deleting and recreating. `MEM_STORES` is the one list of them —
the erase walks it, so a store added there is a store the erase covers.

**API** (as in the contract, plus a few named internals exported for tests and modules):

```js
bootMemory()                         // open, load the Maps, restore the games, wire the card, fire cr:restored
memAvailable()                       // true only once a database has actually opened
dbGet, dbPut, dbPutAll, dbDelete, dbAll, dbClear, dbCount, dbIndexRange
memUsage() → {games, evals, deck, tactics, book, bytes}
eraseAll()                           // the disk: every store cleared. What the switch going off does.
forgetEverything()                   // the button: eraseAll() + S emptied + repaint + route()
exportEverything(), importEverything(obj)   // re-exported from src/sync/export.js
// also exported: memRow, rememberGames, evictOverCap(cap), rememberCursor, writeCursor,
// restoreLibrary, persistLibrary, usageSentence, fmtBytes,
// DB_NAME, DB_VERSION, GAME_CAP, CURSOR_DEBOUNCE_MS, ERASE_ARM_MS, MEM_STORES
```

One deviation to note: the contract lists `eraseAll()` as both "the one-press-twice erase"
and "what turning memory off does". Those two differ in the spec — the switch keeps what is
on screen, the button does not — so they are two functions here. `eraseAll()` is the disk;
`forgetEverything()` is the disk and the screen. The button calls the second.

**Boot order.** `restoreLibrary()` loads `S.deck`, `S.tactics`, `S.book` (Maps keyed by
row key) and `S.opponents` (array) *before* the games, so the modules booting after memory
find them. Games are re-parsed from the stored PGN through `parseGame`, sliced on
`PARSE_SLICE_MS` and yielding between slices, behind the loading overlay past 20 rows.
`S._seq` becomes the max stored seq. The cursor (`meta 'cursor'` → `{id, ply}`) is applied
only when that game is present, via `setGame`, while `S._restoring` is still true so the
restore's own cursor change never writes. Then `S._restoring = false`, `updateAll()`,
`cr:restored`. The hooks (`onGamesAdded` → `rememberGames`, `onCursor` → `rememberCursor`)
are installed after the restore for the same reason. All DOM work is guarded on
`typeof document`, so the whole boot runs in node.

## Decisions and why

- **Only the PGN is stored.** A FEN per ply is ~3× the game; `memRow()` is the one row
  shape and it has no `fens`/`moves`. The test pins the key list.
- **The stored id wins over the recomputed one** on restore and on import. It is what the
  evals, the cards and the cursor reference; a hash that drifts between builds must not
  silently orphan them.
- **One transaction, one request, nothing after an await.** `read()`/`write()` are the
  only two places a transaction is made; every helper is a one-liner over them. A caller
  needing two stores makes two calls. `writeCursor()`'s existence check is therefore its
  own read *before* the write, not inside it.
- **The transaction, not the request, is awaited for writes.** A request's success says
  the put was accepted; the transaction's completion says it was written.
- **A bounded open** (4 s). `indexedDB.open()` may never answer in a locked-down profile,
  and boot awaits it; a timeout puts us on the refusal path instead of wedging the app on
  a greeting. Latched so boot pays it once. The timer is cleared on settle.
- **Failure = carry on in memory, said once.** `tellOff()` sets `memAvailable()` false,
  guards on `S._memToldOff`, is silent when memory is switched off, and says one sentence
  (quota vs. refusal) via `toast` plus a short line in `#rail-status`. Helpers resolve
  normally afterwards: get → undefined, all → [], count → 0, writes → false.
- **The cap is 2000, oldest seq first, sparing the game on screen.** Evicting a game deletes
  its `evals` row (an eval outliving its game is a record of a game we said we no longer
  have) and leaves its cards (earned history, self-contained). The evicted games also leave
  `S.games`, with `S.gi` re-pointed at the spared game; `cr:games-removed {ids}` fires.
  `evictOverCap(cap = GAME_CAP)` takes the cap as a parameter so the test can exercise
  the order without 2001 rows.
- **The cursor is debounced 1.5 s and refuses a blind put.** A game evicted under the cap
  is not stored; a blind `put` would resurrect it — one game over the ceiling forever,
  churning in and out. Never written while `S._restoring`.
- **The switch off erases immediately** (`eraseAll`), leaving `S` alone: this session's
  work is not what is being withdrawn. The switch on calls `persistLibrary()`: games,
  the three Maps, the opponents, the cursor. Neither touches `localStorage`.
- **The erase is two presses** (6 s window, label changes to "Press again to erase"), not a
  modal. Settings are untouched and are the only thing left in the browser afterwards.
- **Usage is a sentence** — "34 games, 12 analysed, 40 cards, 3 book lines, 2.1 MB on this
  device." — painted on boot, `cr:settings-painted`, and after games/deck/book/analysis
  events. Bytes are the games' and evals' own `bytes` fields plus a JSON-length estimate
  of every other store, so a figure that quietly leaves a store out cannot happen.

### Export / Import (`src/sync/export.js`)

`exportEverything()` → `{v:1, exportedAt, games, evals, deck, tactics, book, meta}`. Games
and cards come from `S` (the source of truth, and what a reader with memory off actually
has); `evals` and `meta` are other modules' rows and live only on disk, so they come from
there — with memory off an export carries no analysis. `meta 'schema'` is dropped. The
prep list deliberately travels nowhere. The button downloads `chessreader-YYYY-MM-DD.json`.

`importEverything(obj)` merges by content-addressed keys and returns `{games, evals, deck,
tactics, book, meta}` added counts:

- **games** by `id`: skip present, parse the rest, new `seq` (it arrived *now*; the cap is
  about arrival here), then `rememberGames` (which applies the cap).
- **evals** by `gameId`, only for games present after the merge: same build and depth →
  the row with more filled cells wins; different build/depth → keep the local row (it is
  what every card and review here was read from).
- **deck / tactics** card by card via `furtherAlong()`: higher `box`, or later `due` when
  boxes agree; the local card wins ties. Never resets a schedule. Only changed rows are
  written.
- **book** by key: union, with the same schedule rule on a collision.
- **meta**: fills only keys this device lacks, never `cursor` or `schema`.

Then `updateAll()`, a toast, and `cr:games-added` / `cr:deck-changed` / `cr:book-changed`
when the respective counts moved — those events are owned by other modules per the
contract table, but the data changed and their painters need to know (see Asks).

## Row shapes

`games`: `{id, pgn, headers, source, addedAt, seq, bytes, lastPly, lastPlayedAt}` — built
only by `memRow(g)`. `meta`: `{k, v}`; memory writes `cursor` `{id, ply}` and `schema`
(the DB version). Every other store's row shape belongs to its owner; memory stores and
returns them untouched and keys the Maps by `row.key` (`row.id` for opponents).

## Tests

21 tests, node, `fake-indexeddb/auto`. They pin: nine stores + the index, a same-version
reopen fires no upgrade and keeps an authored row; one transaction / one request per helper
(spies on `IDBDatabase.prototype.transaction` and the store methods); `dbIndexRange` order;
PGN-only rows and re-parse with the stored id winning; Maps and cursor restore (cursor for
an absent game ignored); nothing restored with memory off; cap order, sparing, evals
removal, cards kept, `S` agreeing; cursor blind-put refusal and the `_restoring`/off gates;
switch-off keeps the screen, the button empties it and leaves settings; `persistLibrary`;
`memUsage` and the sentence; export→import round trip; dedupe, schedule and evals merge
rules; a non-export rejected; and a separate module graph with `indexedDB` undefined where
boot finishes, tells off once, and every helper resolves.

## Asks

1. **Evals on the switch going on.** `persistLibrary()` writes games, cards, book,
   opponents and the cursor, but not `evals` — the row serialiser is the engine's. Ask:
   the engine listens for `cr:setting {key:'remember'}` and, when `S.remember` is true,
   puts its rows for every game with `analysis.done`. Until then a game analysed while the
   switch was off is re-analysed after it goes on.
2. **Event ownership.** Import and the erase dispatch `cr:deck-changed` and
   `cr:book-changed` (owned by deck / learn in the contract table) because the Maps
   changed under them. Either bless memory as a second dispatcher of those two, or have
   deck and learn also listen for `cr:restored` and a new `cr:imported` — say which and
   the dispatches move.
3. **`#rail-status` copy.** Memory writes "Nothing is kept on this device." there when
   storage is refused. If another module also uses that line, the integrator should decide
   who owns it; memory writes it once and never clears it.
4. **Paint order on the switch.** `settings.js` dispatches `cr:setting` and then
   `renderSettings()` → `cr:settings-painted` synchronously, while the erase/persist behind
   the switch is async. So the usage line is painted once before the disk has changed and
   once after (memory repaints on both). Harmless; noted so nobody reads the first paint
   as the result. No change asked for.
