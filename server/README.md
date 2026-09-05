# ChessReader remote engine

A ~200-line Node process wrapping a native Stockfish, speaking both of the transports
the app knows. **It is optional.** ChessReader ships a WebAssembly Stockfish and works
with no network at all; this exists because an archive sweep is hours of arithmetic and
a spare machine does it in minutes.

You do not have to run *this*. The wire format below is the whole contract — the
WebSocket transport in particular is plain UCI, so any off-the-shelf UCI bridge works.

## Running it

```sh
# straight from a clone (Node 20+, a stockfish on PATH)
cd server && npm install && STOCKFISH=$(which stockfish) node index.js

# or in Docker — build from the repository root, not from server/
docker build -f server/Dockerfile -t chessreader-engine .
docker run -p 8020:8020 -e CR_TOKEN=a-long-random-string chessreader-engine
```

Then in ChessReader: **Settings → Engine**, mode *Remote only* or *Remote for the
archive sweep, local for questions*, URL `http://your-machine:8020` (or
`ws://your-machine:8020`), token if you set one, and press **Test**.

| Env | Default | |
| --- | --- | --- |
| `PORT` | `8020` | |
| `STOCKFISH` | `stockfish` | path to the binary |
| `CR_TOKEN` | *(empty)* | bearer token; empty means open — only sane on a LAN |
| `CR_THREADS` | `1` | `Threads` per engine process |
| `CR_HASH` | `128` | `Hash` MB per engine process |
| `CR_ENGINES` | `2` | size of the HTTP engine pool (a WebSocket gets its own) |
| `CR_ORIGIN` | `*` | `Access-Control-Allow-Origin` |

**Least privilege.** The process runs one child per engine and never touches the disk.
Put a token on anything reachable off your own network, and prefer a reverse proxy with
TLS over exposing it directly — the token travels in a header, and over plain `http://`
so does everything else. `CR_ORIGIN` should name your ChessReader origin rather than
`*` once you know it. There are no accounts and no sessions here by design (§13); the
token is the whole of the authorisation model.

## Wire format

### `GET /health`

Requires the token, so a wrong token is reported as a wrong token rather than as a
working server whose every search later fails.

```json
{ "ok": true, "engine": "Stockfish (/usr/games/stockfish)", "engines": 2, "busy": 0 }
```

### `POST /analyse`

```json
{ "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "depth": 18, "multipv": 1, "movetimeMs": 600 }
```

```json
{ "cp": 43,
  "depth": 18,
  "pv": ["e2e4", "e7e6", "d2d4", "d7d5"],
  "lines": [ { "cp": 43, "depth": 18, "pv": ["e2e4", "e7e6"] },
             { "cp": 36, "depth": 18, "pv": ["d2d4", "g8f6"] } ] }
```

- `cp` **or** `mate` (mate distance in moves; negative means the side to move is mated),
  never both. **Both are from the side to move's view** — the raw UCI convention. The
  app converts to White-positive when it commits, and a server that helpfully converts
  first will have every Black-to-move evaluation inverted.
- `pv` is UCI, longest first; the app keeps eight plies.
- `lines` is one entry per MultiPV slot, best first. With `multipv: 1` it may be omitted.
- Depth and movetime are both honoured — whichever ends first, exactly as `go depth N
  movetime M` behaves.

The server clamps: depth ≤ 40, movetime ≤ 60000ms, multipv ≤ 5, batch ≤ 64, body ≤ 256KB.

### `POST /analyse/batch`

An array of the request objects above, answered by an array of the answers **in the same
order**. The client matches by index and rejects an answer of a different length.

### `ws://…` — raw UCI

Connect, and if a token is set send `auth <token>` as the first line (a bad one, or five
seconds of silence, closes with code **4001**). After that the socket is a pipe to
Stockfish: send `uci`, `setoption name MultiPV value 3`, `position fen …`, `go depth 18
movetime 600`, and read `info …` and `bestmove …` back, one line per message.

The server allows only `uci`, `isready`, `ucinewgame`, `stop`, `quit`, `position
startpos`, `position fen <valid FEN>`, `go …` and `setoption` for `MultiPV`/`Hash`/
`Threads`. A FEN is matched against a strict pattern before it reaches stdin — a
newline inside one is a UCI injection, not a position.

## Sharing the process with sync

`routes` is a `Map` of `"METHOD /path" → handler(req, res)`, exported from `index.js`.
The optional sync server (§9) adds its entries to it, so both features run in one
process behind one port and one token:

```js
import { routes } from './index.js';
routes.set('POST /sync/push', async (req, res) => { /* … */ });
```

Handlers run after the bearer check and may throw; a throw becomes a 500 with the
message. `OPTIONS` preflight and CORS are handled for every route.
