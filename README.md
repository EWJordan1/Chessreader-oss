# ChessReader

Free, open-source, desktop chess analysis and training. Paste a PGN, fetch one from a
URL, or pull your public Chess.com or Lichess archive, and the app reads your games back
to you the way a coach would: what you got wrong, what you keep getting wrong, and what to
do about it. Games can also be read aloud, move by move.

Everything is computed in your browser. Games live in IndexedDB on your device. Nothing is
uploaded unless you configure an endpoint to upload it to.

## What it does

- **Listen** — a player: a queue of games, transport controls, per-move scrubbing, repeat
  modes, moves spoken at three verbosity levels in the browser's own voice or one you
  configure.
- **Analyse** — Stockfish runs in the page (the 7 MB is fetched the first time you press
  Analyse). Every move is judged in three words while the scan runs and eleven when it is
  done — Brilliant down to Blunder — with accuracy for both players, the three moments the
  game turned on, and the opening named from a position table.
- **Insights** — your record, your form, your clock, your habits, two periods compared,
  the tree of what you actually play, which of your lines keeps handing you positions you
  play badly, and what to work on — all arithmetic over your own games, each finding
  behind a sample floor.
- **Learn** — 23 opening lessons, a repertoire book you author (nothing crosses into it
  except by your own *Add to my book*), the missed-tactics collection, and drills over
  the deck, the book and the tactics on one spaced-repetition schedule.
- **The deck** — every position where a move cost you three pawns or more becomes a
  self-contained flashcard, filled by an archive sweep you start and can pause.
- **Prep** — the people you are about to play: their public games, the same report
  Insights gives about you pointed at them, and your repertoire walked against theirs.
- **Four themes**, full keyboard control, everything speakable.

Desktop only: the window has to be at least 1100 pixels wide.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173/app.html — the landing page is at /
```

That is the whole environment. There are no accounts, no server, no keys required.

```sh
npm test           # the Vitest suites: every computation proved against fixture corpora
npm run walk       # Playwright: a headless walk of every room, one screenshot each
npm run check      # both
npm run build      # a static bundle in dist/, deployable to any file host
```

## Pointing it at your own infrastructure

Everything optional is a setting, and every failure falls back to the local default with
one sentence, never an error.

**A remote engine.** Settings → Engine takes a base URL and an optional bearer token.
Two transports are supported — HTTP (`POST {base}/analyse`) and WebSocket raw UCI — so
you can point it at the reference server in [`server/`](server/) on a spare machine, or
at any off-the-shelf UCI bridge. Choose *remote for the archive sweep, local for
questions* to keep the long jobs off your laptop. See [docs/engine.md](docs/engine.md).

**A voice and explanations.** Settings → AI provider takes any OpenAI-compatible base
URL and key: OpenAI, a local LM Studio or Ollama, OpenRouter, your own proxy. One block
serves both the spoken voice and the "Why?" explanations. The key is stored in your
browser's `localStorage`, in plain text, and is sent only to the base URL you name.

**CORS will bite.** Your browser calls the API directly, so the API has to allow it. Some
providers do (OpenAI does not, for browser origins). The Test button in Settings tells
you which problem you have — *the endpoint refused your key* and *your browser was not
allowed to ask* are different sentences. For a provider that does not allow it, run this
four-line proxy somewhere you control and point the base URL at it:

```js
// proxy.mjs — node proxy.mjs  (forwards /v1/* to the provider, adds CORS)
import http from 'node:http';
http.createServer((req, res) => { if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' }); return res.end(); }
  fetch('https://api.openai.com' + req.url, { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json', Authorization: req.headers.authorization || '' }, body: req.method === 'POST' ? req : undefined, duplex: 'half' })
    .then(r => { res.writeHead(r.status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' }); r.body.pipeTo(new WritableStream({ write: c => res.write(c), close: () => res.end() })); }).catch(e => { res.writeHead(502); res.end(String(e)); }); }).listen(8787);
```

Then set the base URL to `http://localhost:8787/v1`. Change the upstream host for another
provider.

**Sync.** Off by default. Settings → Sync takes a URL and a token for a server that
stores five blobs; the merge runs in the browser and is a union, so there is never a
"which copy do you want" dialog. The reference server shares the process with the engine
server. See [docs/sync.md](docs/sync.md). Whether or not you sync, *Export everything*
and *Import* in Settings are the backup story: one JSON file, merged by the same keys.

## How it is built

Vanilla JavaScript, ES modules, Vite. No framework, no TypeScript. One state object,
one board builder, one speech door. [docs/architecture.md](docs/architecture.md)
describes the layers; [docs/contract.md](docs/contract.md) is the agreement the modules
are built against.

## Licence

GPL v3 — see [LICENSE](LICENSE). The repository is licensed as a whole under the GPL
because it vendors and distributes a GPL v3 build of Stockfish. Third-party work and
its attribution is listed in [NOTICE](NOTICE): Stockfish, chess.js, the Cburnett piece
set (CC BY-SA 3.0 — the attribution is also shown in the app under Settings → About), and
the Lichess opening database.
