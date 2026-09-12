# Sync (optional, self-hosted)

`src/sync/client.js` (the browser half), `server/sync.js` (the reference server),
`test/sync.test.js` (39 tests). Off by default. **The app is complete without it**, and
Export / Import in Settings — `src/sync/export.js`, the memory module's — is the backup
story for everyone who never runs a server. Sync is that same merge, over HTTP, on a
press.

## What exists

```js
// src/sync/client.js
syncNow()                       // the #btn-sync-now press: every store, both directions
syncStore(name, {pull, push})   // one store
pushAll()                       // send this device's half; apply nothing
pullAll()                       // take the server's half; send nothing
mergeStore(name, mine, theirs) → {rows, incoming, outgoing}   // pure; the only merge
pickRow(store, mine, theirs), keyOf(store, row)
packEnvelope(rows, version) → {version, blob, enc}, unpackEnvelope(env) → rows
getStore(name), deleteStore(name), eraseRemote()
syncStatus() → {on, url, configured, busy, at, sent, received, error, stores}
statusSentence(), boot()
SYNC_STORES, PUT_ATTEMPTS (4), MAX_BLOB_BYTES (16 MB)

// server/sync.js
mountSync(routes, {dir, prefix, origin}) → number of routes mounted (0 with no dir)
syncCore(dir) → {get(token, store), put(token, store, env), del(token, store)}
createSyncServer({dir, tokens, origin}) → {server, routes, mounted}
shelfFor(token), SYNC_STORES, MAX_BLOB_BYTES
```

Settings already has the fields (`#set-sync-on`, `#set-sync-url`, `#set-sync-token` →
`S.syncOn` / `S.syncUrl` / `S.syncToken`) and the button. `boot()` wires
`#btn-sync-now`, repaints `#sync-status` on `cr:settings-painted` and `cr:setting`, and
**installs no timer**: a sync happens on the button, or the moment the switch goes on,
and those are the only two presses in the feature (§2.7).

## The contract

Five blobs, one per store: `deck`, `tactics`, `book`, `games`, `learn`. Three verbs.

```
GET    {base}/{store}   → 200 { version, blob, enc }
PUT    {base}/{store}   ← { version, blob, enc }   → 200 { version }   409 if version moved
DELETE {base}/{store}   → 200 { ok: true, version: 0 }                 always ungated
```

`{base}` is whatever the reader typed in Settings, trailing slashes trimmed; the token,
when set, travels as `Authorization: Bearer <token>` and nothing else does.

**The server stores bytes and counts versions. It never merges.** The merge runs in the
browser because that is the only place holding both halves — and because merging two
decks means knowing what a Leitner box is, which is the app's arithmetic, not a file
store's. This is the property that makes the server replaceable in an afternoon.

### GET

```http
GET /sync/deck HTTP/1.1
Authorization: Bearer a-long-random-string
```
```json
{ "version": 7, "enc": "gzip", "blob": "H4sIAAAAAAAAA6tWKkpNy0lNLlFSsFJQ8s9T0lFQ…" }
```

A store that was never written answers `{ "version": 0, "blob": null, "enc":
"identity" }`. A `404` means the same thing to the client, so a shim over an object
store that 404s a missing key needs no special case.

### PUT

`version` is **the version the client read**, not the one it is writing. The server
accepts when it still matches and stores the blob at `version + 1`:

```http
PUT /sync/deck
Content-Type: application/json

{ "version": 7, "enc": "gzip", "blob": "H4sIAAAA…" }
```
```json
{ "version": 8 }
```

If it does not match, that is the whole of the concurrency story:

```json
409 { "error": "the version moved", "version": 9 }
```

On a 409 the client **GETs the current blob, merges locally, and PUTs again**, bounded
at `PUT_ATTEMPTS` (4) tries. A server that keeps moving is one we stop arguing with: a
sync that never finishes is worse than one that says it did not. Rows that arrived
during the race are applied here as well as sent back up.

### DELETE

No version travels with it and none is checked. Erasing is the one thing a reader should
never be argued with about. It erases the **server's** copy only — it is not a delete
that propagates, and a device that still holds those cards will simply put them back on
its next sync. That is honest: the merge is a union, and a union has no way to express
"gone".

### The envelope, and gzip

`blob` is a JSON array of rows, as a string. `enc` says how it is encoded:

| `enc` | `blob` is |
| --- | --- |
| `"gzip"` | base64 of gzip(UTF-8 JSON) — written with `CompressionStream('gzip')` |
| `"identity"` | the JSON text itself |

The client writes `gzip` when `CompressionStream` exists and `identity` when it does
not, so **a browser without the Compression Streams API still syncs**, and every client
reads both. If a blob arrives gzipped and this browser has no `DecompressionStream`,
that store is skipped entirely — reported, not merged, and above all **not PUT**.
Writing our own half over a version we could not read is the one way this feature could
lose somebody's cards, so it is the one guard that refuses to carry on.

The encoding is named inside the envelope rather than left to HTTP `Content-Encoding`,
because a body marked `Content-Encoding: gzip` is decoded again by whatever proxy,
runtime or `fetch` implementation is in the way — a double-decode that appears only in
production — and because a self-describing envelope is a thing an S3 object or a WebDAV
file can hold byte for byte, which is exactly the shim this contract is meant to permit.
Requests carry `Content-Type: application/json` and no `Content-Encoding` at all.

## The merge rules

Keyed by the store's own content-addressed key: `key` for `deck` / `tactics` / `book`,
`id` (the PGN hash) for `games`, `k` for `learn`.

**Content-addressed keys make this a union rather than a reconciliation.** Two devices
that author the same line or earn the same card produce the same key, so there is no
losing side and no restore dialog anywhere in this feature — there is deliberately no
function here that asks the reader to choose, and a test pins that absence. The worst a
merge can do is keep a row somebody already had.

| Store | Rows | On the same key |
| --- | --- | --- |
| `deck`, `tactics` | deck cards | **the further-along schedule**: higher `box`, else later `due`, else the local row |
| `book` | repertoire lines | the same rule (a line is authored; it is never dropped) |
| `games` | `memRow()` rows — the PGN only | the later `lastPlayedAt` wins its cursor; the game itself is never dropped |
| `learn` | the `meta` rows | the local value wins; the remote fills only keys this device lacks |

The schedule rule is `furtherAlong()` from `src/sync/export.js` — imported, not
rewritten. Two spellings of "which schedule is ahead" is how Import and sync drift, and
the rule is symmetric: a card in box 4 wins from either direction, so it does not matter
which device is called "mine". **A card is never reset by a merge.** Tests pin both
directions and the reset.

Rows that arrive are written through `importEverything()`, so a blob arriving over the
wire and a file arriving through the Import button are one code path, one set of
`cr:deck-changed` / `cr:book-changed` / `cr:games-added` events, and one bug to fix when
there is one.

Two guards worth knowing:

- **Nothing syncs while `S._restoring` is true.** Before the restore finishes, `S` holds
  fewer games and no cards, so the union we would PUT is *smaller* than what this device
  actually has — the server would take it and the next device would read a library with
  holes in it.
- **Rows identical on both sides are not a difference.** The merge compares content, not
  object identity; otherwise two devices that already agree would write a new version
  every time either of them pressed the button.

### What does not sync, and why

- **The prep list.** No `opponents` store, here or on the server, and there never will
  be: it is five handles you can retype and a record of your weekend nobody else needs to
  hold (§9). It is also the one store whose rows name a third party. A test asserts the
  string `opponents` never appears in a request.
- **`evals`.** An analysis is a cache stamped with an engine build and a depth. It is the
  largest thing on the disk, it is reconstructible from the game in the same blob, and a
  row from another machine's build is discarded on arrival anyway (see `pickEvals`).
- **`meta 'cursor'` and `meta 'schema'`.** Where *this* screen was left, and this
  device's database version. `exportEverything()` already drops both.
- **Settings.** They live in `localStorage`, they include the sync token, and a token
  that syncs itself is a token that can never be changed on one device only.

> `learn` is the spec's fifth store. This port keeps lesson and room progress in `meta`
> rather than in a store of its own, so the `learn` blob carries the `meta` rows. If a
> lessons store is ever added, it joins that blob and the wire does not change.

## Running the reference server

It is a directory of files. One directory per token (the token hashed, so it never
appears in a path or a listing), one file per store inside it, written beside and
renamed over so a half-written blob is never read.

**With the engine server**, sharing one process, one port and one token:

```sh
cd server && npm install
CR_SYNC_DIR=/var/lib/chessreader CR_TOKEN=a-long-random-string STOCKFISH=$(which stockfish) node index.js
```

`server/index.js` calls `mountSync(routes)` at its `routes` hook, which **mounts nothing
unless `CR_SYNC_DIR` is set** — a server somebody started for the engine never quietly
becomes a place to store other people's decks. Settings → Sync URL is then
`http://your-machine:8020/sync`.

**On its own**, if you want sync without an engine:

```sh
CR_SYNC_DIR=/var/lib/chessreader CR_SYNC_TOKENS=a-long-random-string node server/sync.js
# → chessreader sync on :8021 → /var/lib/chessreader (token required)
```

| Env | Default | |
| --- | --- | --- |
| `CR_SYNC_DIR` | *(unset)* | where the blobs live. Unset = sync is not mounted |
| `CR_SYNC_PREFIX` | `/sync` | the path the five stores hang off |
| `CR_SYNC_TOKENS` | `CR_TOKEN` | standalone only: comma-separated accepted tokens; empty = open |
| `CR_ORIGIN` | `*` | `Access-Control-Allow-Origin` |
| `PORT` | `8021` | standalone only |

**Least privilege.** The token is the whole of the authorisation model (§13: no
accounts); it names the shelf, so two people can share one process only if the process
accepts both tokens — the engine server's gate accepts one. Put a token on anything
reachable off your own network and prefer a reverse proxy with TLS: the token travels in
a header and over plain `http://` so does every one of your games. Blobs are refused
above 16 MB, the store name is matched against the list of five before it is ever part of
a path, and nothing else in the directory is served.

### A WebDAV or S3 shim

The server is four functions over a shelf — `readShelf`, `writeShelf`, `rm`, and the
version check between them. Anything that stores a value and hands it back can stand in;
the version does not need a compare-and-swap primitive if you keep it *inside* the
stored object, which is why it is stored there.

```js
// S3 (or any object store): one key per store per shelf, the envelope stored verbatim.
const key = (token, store) => `chessreader/${shelfFor(token)}/${store}.json`;

async function readShelf(s3, token, store) {
  try {
    const { text, etag } = await s3.getObject(key(token, store));
    return { ...JSON.parse(text), etag };
  } catch (e) { return { version: 0, blob: null, enc: 'identity' }; }   // 404 = version 0
}
async function put(s3, token, store, env) {
  const cur = await readShelf(s3, token, store);
  if ((Number(env.version) || 0) !== cur.version) return { code: 409, body: { version: cur.version } };
  const next = { version: cur.version + 1, blob: env.blob, enc: env.enc };
  // Conditional write where the store has one (S3 If-Match on the ETag read above,
  // WebDAV If:) — without it, two devices PUTting in the same instant can interleave
  // and one union is written over the other. The client's next sync re-unions and
  // repairs it, which is why this is a wart rather than a data loss.
  await s3.putObjectText(key(token, store), JSON.stringify(next), { ifMatch: cur.etag });
  return { code: 200, body: { version: next.version } };
}
```

WebDAV is the same three lines against `GET` / `PUT` / `DELETE` on
`{collection}/{shelf}/{store}.json`, with `If:` for the conditional write. Neither shim
needs to understand a single field inside `blob` — that is the point of the contract.

## Tests

39, node environment, `fetch` stubbed, `src/memory.js` mocked. The round-trip tests are
driven through `server/sync.js`'s **real handlers in process** (a fake `req`/`res` over
the mounted `routes` map on a scratch directory), so the client and the reference server
are tested against each other rather than against two ideas of the contract.

They pin: the five stores on both sides and the absence of `opponents` (including that no
request ever names it, and that the module exports no chooser/prompt/restore); a merge is
a union that loses neither half; the further-along schedule **in both directions** for
`deck`, `tactics` and `book`, and on the `due` tie-break; a card is never reset, through
the pure function and through a whole sync; a game is never dropped and travels as PGN
only; `learn` keeps the local answer; the gzip round trip; a browser with no
`CompressionStream` syncing in `identity`; a gzipped shelf an old browser cannot read
being left untouched rather than overwritten; a 409 causing a re-GET, re-merge and re-PUT
whose blob carries both halves, and the retry bounded at `PUT_ATTEMPTS`; a DELETE
carrying no version, erasing whatever version was there, and the counter starting again;
nothing sent with the switch off, with no URL, or while restoring; `boot()` installing no
timer and asking for nothing; `pushAll` applying nothing locally and `pullAll` sending
nothing; the server's version counter, 409, per-token shelves, 404 for an unknown store,
and `mountSync` mounting nothing without a directory.

## Asks

1. **CORS preflight in `server/index.js`.** Its shared `OPTIONS` answer is
   `'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'`, which a browser reads as
   permission to do neither `PUT` nor `DELETE` — so cross-origin sync against the shared
   engine process fails at the preflight, before any handler runs. Ask: make that string
   `'GET, POST, PUT, DELETE, OPTIONS'`. It is one word in a file this module does not
   own. Until then, sync against the shared process works same-origin or behind a reverse
   proxy, and `node server/sync.js` standalone answers the preflight correctly.
2. **A door for `eraseRemote()`.** "Erase what the server holds" is the DELETE verb's
   reason to exist and there is no button for it: `#settings-sync` has the switch, the two
   fields and Sync now. Ask: a `#btn-sync-erase` beside Sync now (two presses, like the
   memory erase), and the copy "This erases the server's copy. The cards on this device
   stay, and syncing again puts them back."
3. **`server/README.md`** (the engine module's) documents the `routes` hook but not
   `CR_SYNC_DIR`. Ask: one row in its env table pointing at this file.
4. **Confirm the `learn` blob.** The spec names a `learn` store; this port has no such
   IndexedDB store, so the blob carries the `meta` rows (minus `schema` and `cursor`).
   Say if it should instead be reserved for a future lessons-progress store — the change
   is one line in `localAll()` and the wire does not move.
5. **Event ownership** — the same Ask the memory module makes: rows arriving over the wire
   dispatch `cr:deck-changed`, `cr:book-changed` and `cr:games-added` from
   `importEverything()`, which the contract table gives to deck, learn and sources. Either
   bless that, or give both features one `cr:imported` to fire instead.
