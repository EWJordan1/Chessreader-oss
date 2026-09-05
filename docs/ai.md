# "Why?" — the AI explanations

`src/ai/explain.js`. One position, explained on an explicit press, by whatever
OpenAI-compatible chat endpoint the user named in Settings. The module is small on
purpose: the whole feature is one request, and everything else in the file is a rule
about when *not* to make it.

## The four rules

**The button is not drawn when no provider is configured.** A card that is absent cannot
say what it would have held, but a button that errors is worse — it offers the reader
something the app cannot do and then blames them for pressing it. `explainAvailable()`
is the one predicate, and every surface asks it before drawing anything.

**The verdict is validated before asking.** `jobForMove(game, n)` returns `null` unless
`classifyMove()` — the three-word vocabulary, with all its guards — calls the move an
error. Anything else is dropped silently. Without that guard the app pays a stranger to
explain a forced recapture, which is both a wrong answer and a charge for it.

**Rate-limited on this side of the wire.** The user's key, the user's bill:
`EXPLAIN_GAP_MS` (4s) between presses and `EXPLAIN_SESSION_MAX` (40) in a session. Four
seconds is faster than anyone reads an answer; forty is more explaining than a game
contains. Both numbers are about the invoice, not about the endpoint.

**A refusal latches.** A bad key, or a model the server does not have, is not a thing
that fixes itself between two presses, so after a 401 or 403 nothing more is asked this
session. A 429 does not latch — that one *does* fix itself.

## The two failure sentences

A cross-origin `fetch` that throws at the network level and an endpoint that answers 401
are different problems with different fixes, and the module never prints the same
sentence for both. The CORS case names the README's four-line proxy; the refusal names
the key. This is the same distinction the Settings test button makes.

## The cache

Keyed on `fen + '|' + played`, so re-asking about a position already explained costs
nothing and returns `{cached: true}`. It is a session cache: nothing is written to disk,
because an explanation is cheap to re-fetch and not worth a store of its own.

## Where it draws

| Surface | What |
| --- | --- |
| `#explain-mount` (Listen) | A "Why?" panel for the move just played, drawn only while Listen owns the board — an explanation shown against another position is a caption on the wrong picture |
| `.card-why[data-key]` (deck cards) | The deck renders an empty container on every card; this module puts a *Why?* button in it when a provider is configured, and fills it with the answer. The deck renderer stays ignorant of the AI module either way. The same container appears under `#drill-body` when the drill runner deals a card, and needs no special case: the click handler delegates from `document` and the filler runs on the board repaint that dealing a card causes |

A deck card can be explained from the card alone — `jobForCard(card)` needs no game,
because a card is self-contained by design (position, played move, engine's answer, both
evaluations).

## The prompt

Short, and deliberately not a chat: the position as FEN, the move played, the engine's
preference, both evaluations, and an instruction to answer in at most three sentences
naming the idea rather than reciting a variation or the numbers. A mate is written "mate
in 3" rather than as a centipawn figure, because ±10000 in a prompt reads as a bug.

## Tests

`test/explain.test.js`, 13 tests, `fetch` stubbed. They pin: the button's absence without
a provider; that a move the three words do not call an error is never asked about; the
prompt's contents; one POST to the configured base with the bearer key; the cache; the
gap and the session ceiling; CORS and refusal telling different stories; the latch; and
that `askExplain` never throws whatever the endpoint answers.

## Asks

None. The module reads only `classifyMove`/`analysisReady` from `review.js`, the settings
fields from `state.js`, and the deck's `.card-why` container, all of which exist.
