# Sources

Build order step 4. Everything a game can arrive through — paste, file, URL, Chess.com,
Lichess — resolves to PGN text and converges on `loadPGNText(text, source)`, the single
entry into parsing. An import merges by the content id (§4): the ones already present
are dropped, counted and said.

Files: `src/sources.js`, `css/sources.css`, `test/sources.test.js`.

## What exists

`src/sources.js` is in two halves, and the line between them is the rule the tests
rely on: **nothing above `openImport()` names `document`.** The top half is arithmetic
and fetching; the bottom half is the dialog.

### The pipeline entry

`loadPGNText(text, source)` — unchanged from the shell, plus: it now dispatches
`cr:games-added` on `document` (the contract lists it as sources' event; memory was
listening and nobody was sending). `onGamesAdded(fn)` still fires first.

### The importers

| Tab | Function | Sentence on failure |
| --- | --- | --- |
| URL | `fetchPGNFromURL(url) → {ok, text} \| {ok:false, error}` | names the host, says the host's CORS headers decide whether a browser may fetch it, and points at the Paste tab's file picker |
| Chess.com | `chesscomArchives(user)`, `lookupChesscom(user, {max, onProgress}) → rows` | 404 → "No Chess.com player called …"; 429 → rate limit; a player with an empty archive is "No games … yet" (a different sentence from no player) |
| Lichess | `fetchLichess(user, {max, since, onProgress}) → rows` | 404 and 429 as two sentences; the NDJSON is streamed and a malformed line is skipped |

`lookupChesscom` walks the archive index newest month first until `LOOKUP_MAX` (300)
games or the archive runs out; a month that 500s is skipped, not fatal. Only
`rules === 'chess'` is kept — Chess960 and bughouse share the same months and would
only fail at parse. `fetchLichess` restricts `perfType` to the orthodox pools for the
same reason, sends `Accept: application/x-ndjson` with `pgnInJson`, `clocks` and
`opening`, and reads the body as a stream because a public Lichess archive can be
hundreds of thousands of games.

### The row (`SourceRow`)

Both sites reduce to one shape, which the browser and the tracker share:

```js
{ site: 'chesscom'|'lichess', pgn, white, black, whiteRating, blackRating,
  timeClass,          // bullet | blitz | rapid | classical | daily
  result: 'w'|'l'|'d',// from the looked-up user's view
  reason,             // checkmate, resignation, time, … ('' when unknown)
  endTime,            // ms since the epoch — ms, not Chess.com's seconds
  opponent, url }
```

`normaliseChesscom(json, user)` and `normaliseLichessLine(obj, user)` are the two pure
normalisers. **Deviation from the brief**: both take the username as a second argument.
"Result from the user's view" cannot be computed without knowing who the user is, and
reading it off module state would score a background tracker check from the point of
view of whoever the browser last showed. A user matching neither player is read as
White (the PGN's own default).

`withLichessHeaders(pgn, lastMoveAt, openingName)` puts `[EndDate]`/`[EndTime]` (UTC,
from `lastMoveAt`) and `[Opening]` into the header block when absent. Insights reads the
finish off `EndDate`/`EndTime` — Chess.com writes them, Lichess does not — so without
this a Lichess game is not "a game with no clock", it is silently dropped from the
time-of-day and tilt findings. A game that crosses midnight UTC gets the finish date,
not the start date; the test pins that.

### The source browser (`#source-browser`)

After a lookup: a title (`user on Site`), `n of m games shown`, three filters (time class
select built from the classes present, result select, opponent text with a 150ms
debounce), "Select all shown" / "Select none", a selected count, "Import selected", and a
sticky-headed table of rows with a checkbox each. The data is sans (contract: it is
data), the empty filter state is `emptyHTML('No games match those filters.', 'Clear the
filters')`, and "Import selected" closes the dialog and calls `loadPGNText(text, site)`.

The browser belongs to the tab that filled it: `showImportTab` hides it under any other
tab and shows it again on the way back.

The three panes are `<form>`s, so Enter submits and the dialog works by keyboard end to
end; `openImport(tab)` focuses the pane's first field. The username fields are prefilled
from `S.chesscomUser` / `S.lichessUser` and follow `cr:setting`. **A typed handle
becomes the default only after a lookup finds games** — `remember()` runs after the
rows arrive, never on keystroke, so a typo never becomes the setting.

### The tracker — "7 new games since Tuesday"

```js
checkNewGames(site) → Promise<{count, since} | null>   // since in ms: the watermark
importNewGames(site) → Promise<loadPGNText result | null>
newestImported(site, games = S.games) → ms | 0
gameEndMs(game) → ms | null
savedUser(site), lastChecked(site), resetTracker()
TRACKER_SITES, TRACKER_GAP_MS (30 min), TRACKER_MAX (100), LOOKUP_MAX (300), SITE_NAMES
```

**The watermark is derived, not stored.** It is the newest finish among the games in
`S.games` with `source === site`, read off `EndDate`+`EndTime` and falling back to
`UTCDate`+`UTCTime`; a game with only a `Date` header contributes nothing (a day with
no time is midnight, and a midnight watermark would report the whole day's games as new
forever). A stored number would need moving on import, resetting on erase and
reconciling on sync; the derived one is right by construction — a reader who took four
of forty games has seen four.

`checkNewGames` returns null when there is nothing to ask about: no saved username, no
games imported from that site yet (that reader is who the import button is for), or the
site would not answer. Chess.com is asked for the current month's archive — plus the
watermark's month when that is the month before, because a game played on the 31st and
imported on the 1st is exactly the news this exists to notice (one extra request at
most; **a small deviation from "current month only"**). Lichess takes `since=` the
watermark + 1 ms and `max=TRACKER_MAX`.

**Once per 30 minutes per site.** The stamp lives in a module-level `Map`, not in `S` —
a floor between network requests is a fact about this tab's session, not about the
library. It is stamped *before* the request, so a second press mid-flight, or a site that
refuses, both wait the full gap: a rate-limiting site is the last one worth asking again
in thirty seconds. Within the gap the last answer is returned again, re-counted against
the current watermark (an import by another door moves it), without a request.

The tracker never runs on its own (§2.7). Home calls `checkNewGames` on a press or on
arrival and decides what to say; `importNewGames` imports exactly the rows the last
check counted (asking first, ignoring the floor, if there is no check behind it — that
is a press). `cr:games-removed` resets the cache: an erased library has no watermark.

## Tests

`test/sources.test.js`, 23 tests, `fetch` stubbed, no `document`: Chess.com
normalisation from both colours, draws and reasons, the rules filter; the month walk
stopping at `max`; Lichess EndDate/EndTime/Opening injection across midnight UTC,
existing headers left alone, NDJSON request shape and line reading, 404 vs 429; the URL
importer's CORS sentence; the watermark derivation; the tracker's null cases, current
month request, `since=`, the 30-minute floor (fake timers) including after a refusal,
and the re-count against a moved watermark.

## Asks

- **`#loading` is a `<div>`, `#dlg-import` is a modal `<dialog>`.** A modal sits in the
  top layer, so `showLoading()` during a lookup is invisible behind the dialog. This
  module puts progress in the pane's own status line instead, which is fine — but
  `loadPGNText`'s own overlay for a >20-game import only shows because the dialog has
  closed by then. If the overlay should ever show over a dialog, make `#loading` a
  `<dialog>` too (as the original did) or `popover`.
- `.sr-only` is defined locally in `css/sources.css` under `.src-table`; a global one in
  `components.css` would serve every module.
- Home (`docs/home.md`) will want a "since Tuesday" word for `since` (ms); the original's
  `sinceWord()` counted midnights, not hours. That belongs to Home, not here.
