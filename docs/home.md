# Home

`src/home.js`, `css/home.css`, `test/home.test.js`. The front page: the greeting, the
news, and the last seven days.

Home is the room that **computes almost nothing**. `weekStats()` is the deck's
arithmetic, `bookDue()` is the book's, `checkNewGames()` is the tracker's, `gameFacts()`
is Insights'. What this module owns is the *wording* and the *doors* — every figure with
evidence behind it is a button that walks to the evidence rather than a number printed at
the reader.

## The two rules

**`S._restoring` holds the page.** From load until the library is off the disk,
`weekReport()` returns `null` and the week refuses to paint at all. A week counted over
half a queue is a *wrong* week, not a smaller one — and it is wrong in the direction that
reads as work lost, which is the one direction a dashboard must never be wrong in. The
`cr:restored` event brings the page back. This is the same flag Insights and the cursor
writer read, for the same reason.

**Nothing polls.** The tracker is asked on *arrival at Home* — the reader walking into
the room is the press — and never on a timer. `sources.js` holds the
once-per-thirty-minutes floor; this module only decides whether to ask at all. That is
the whole of spec §2.7 as it applies here: consent is a button, and a room you walked
into is a button.

## What is on the page

| Block | What it says | Where its doors go |
| --- | --- | --- |
| The greeting | "Good morning, *name*." — the hour of the day and the resolved hero | — |
| Since you were last here | "7 new games on Chess.com since Tuesday." One button imports exactly those | `importNewGames(site)` |
| The last seven days | drilled, due, how the deck grew, book lines due, and the week's single most expensive move | due → Learn's drills; the worst move → that game in Listen at that ply |
| Newest in the queue | the subject's last six games, newest first | a row → that game in Listen |

With no username saved, the news block is a sentence and a door to Settings rather than
an absence. With an empty deck, the week is a sentence and a door to Learn. Every empty
state is a sentence and a door.

## The wording

`sinceWording(ms, now)` is the module's one piece of real prose logic: "today",
"yesterday", a day name inside the last week, a date beyond that. **The comparison is in
whole local days, not elapsed milliseconds** — 23 hours ago can be yesterday and 25 hours
ago can still be today, and the reader means the calendar. Seven days back is where the
day names stop, because the seventh day carries the *same name* as today and "since
Tuesday" would then mean a week ago.

`newsParts()` returns `null` for zero, so a site with nothing new writes no line at all.
A "0 new games" row is a dashboard reporting its own emptiness, and the test pins it.

## The strip

`recentGames(games, heroKey, max)` is the subject's last six, newest first.

With a subject, a game they did not play is **dropped**, not drawn with a blank verdict:
the row's whole content is *won / lost / drew, as which colour, against whom*, and a game
they were not in has no answer to any of that. With no subject resolved yet there is
nobody to have won, and every game belongs — the row says the two players instead, which
is the honest reading of the same fact.

Ordering is by when the game *ended* (`gameEndMs`), falling back to when it was imported
for a dateless game. It must not come from the hero's facts: that was a bug during the
build — any game the hero had not played sorted with a date of zero and floated to the
top of the strip.

## Tests

`test/home.test.js`, 19 tests: the greeting's three windows; `sinceWording` across today,
yesterday, inside the week, and beyond it; the week's seven-day boundary; that
`weekReport()` returns `null` while `_restoring` and a report once it is false with the
same data; the news line's phrasing for 0, 1 and many; the strip's ordering, its cap, its
subject filter, and its dateless fallback.

## Asks

- The greeting reads the hero through `resolveHero()`, which is Insights' — if a hero
  picker ever moves out of Insights, this module should read it from wherever it lands
  rather than growing its own.
- `#badge-home` carries a dot rather than a count, set by `renderNav()` in `route.js`
  from the same tracker state this room paints. Two readers of one fact; if a third
  appears, the count belongs in one function both call.
