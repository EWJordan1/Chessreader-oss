/*
 * The engine module (§7, §12). Nothing here touches a browser: the provider is proved
 * against a stub server started in the test, and everything else is arithmetic over the
 * fixture corpus. The claims pinned are the ones a bug would falsify silently — a stale
 * evaluation surviving a stamp change, a probe waiting behind a scan, an `undefined`
 * and a `null` in `alts` collapsing into each other.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Chess } from 'chess.js';
import { S } from '../src/state.js';
import { splitPGN, parseGame } from '../src/pgn.js';
import { parseInfo, parseBestmove, newSearch, goCommand, PV_PLIES } from '../src/engine/uci.js';
import { transportOf, normaliseResult, describeHealth, _resetRemote } from '../src/engine/remote.js';
import { providerFor, batchable, analyse, analyseBatch, onFallback, _setBackends } from '../src/engine/provider.js';
import {
  ENGINE_BUILD, SCAN_DEPTH, SCAN_MOVETIME, PROBE_MOVETIME,
  analyseGame, probe, analysisReady, classifyable, applyEvalRow, evalRow, blankAnalysis,
  encodeEval, decodeEval, encodeEvalList, decodeEvalList, encodeLines, decodeLines,
  whitePositive, altsShortlist, cancelScans, jobState, _resetAnalyse,
} from '../src/engine/analyse.js';

const fixture = n => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const evals = JSON.parse(fixture('evals.json'));
const corpus = splitPGN(fixture('chesscom.pgn')).map(parseGame).filter(Boolean);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** A game from SAN, with no analysis unless one is attached. */
function toyGame(sans, id = 'toy') {
  const c = new Chess();
  const fens = [c.fen()];
  const moves = [];
  for (const s of sans) { moves.push(c.move(s)); fens.push(c.fen()); }
  return { id, headers: {}, moves, fens, pgn: '' };
}

beforeEach(() => {
  _resetAnalyse();
  _setBackends();
  _resetRemote();
  S.engineMode = 'local'; S.engineUrl = ''; S.engineToken = ''; S.remember = false;
  S.games = []; S.gi = 0; S.ply = 0; S.probeDepth = 22;
});

/* ===== UCI ===== */

describe('the UCI both engines speak', () => {
  it('reads a score, a depth, a multipv slot and the whole line', () => {
    const i = parseInfo('info depth 20 seldepth 30 multipv 2 score cp -34 nodes 9 pv e2e4 e7e5 g1f3');
    expect(i).toMatchObject({ depth: 20, multipv: 2, score: { cp: -34 } });
    expect(i.pv).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });
  it('has nothing to say about a line with no score', () => {
    expect(parseInfo('info depth 1 currmove e2e4 currmovenumber 1')).toBe(null);
    expect(parseInfo('bestmove e2e4')).toBe(null);
  });
  it('keeps the last arrival per slot and answers on bestmove', () => {
    const s = newSearch(2);
    expect(s.feed('info depth 8 multipv 1 score cp 10 pv e2e4')).toBe(false);
    s.feed('info depth 18 multipv 1 score cp 30 pv d2d4 d7d5');
    s.feed('info depth 18 multipv 2 score cp 12 pv c2c4');
    expect(s.feed('bestmove d2d4')).toBe(true);
    const r = s.result();
    expect(r).toMatchObject({ cp: 30, depth: 18 });
    expect(r.lines.map(l => l.cp)).toEqual([30, 12]);
  });
  it('ignores an aspiration bound: a bound is not an answer', () => {
    const s = newSearch(1);
    s.feed('info depth 18 multipv 1 score cp 900 lowerbound pv e2e4');
    s.feed('info depth 18 multipv 1 score cp 30 pv d2d4');
    s.feed('bestmove d2d4');
    expect(s.result().cp).toBe(30);
  });
  it('caps the stored line and spells the go command', () => {
    const s = newSearch(1);
    s.feed('info depth 30 multipv 1 score cp 0 pv ' + Array(20).fill('e2e4').join(' '));
    s.feed('bestmove e2e4');
    expect(s.result().pv.length).toBe(PV_PLIES);
    expect(goCommand({ depth: 18, movetimeMs: 600 })).toBe('go depth 18 movetime 600');
    expect(parseBestmove('bestmove (none)')).toBe(null);
  });
});

/* ===== The provider, over both transports, against a stub server ===== */

describe('the provider contract', () => {
  let http, wss, port;
  const seen = { analyse: 0, batch: 0, health: 0, auth: [] };
  let failNext = false;

  beforeAll(async () => {
    http = createServer((req, res) => {
      seen.auth.push(req.headers.authorization || '');
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/health') { seen.health++; return send(200, { ok: true, engine: 'stub' }); }
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        if (failNext) { failNext = false; return send(500, { error: 'no' }); }
        const body = JSON.parse(raw || '{}');
        if (req.url === '/analyse/batch') {
          seen.batch++;
          return send(200, body.map((b, i) => ({ cp: 100 + i, depth: b.depth, pv: ['e2e4'], lines: [{ cp: 100 + i, depth: b.depth, pv: ['e2e4'] }] })));
        }
        seen.analyse++;
        send(200, { cp: 42, depth: body.depth, pv: ['e2e4', 'e7e5'], lines: [{ cp: 42, depth: body.depth, pv: ['e2e4'] }, { cp: 20, depth: body.depth, pv: ['d2d4'] }] });
      });
    });
    await new Promise(r => http.listen(0, r));
    port = http.address().port;

    // The other transport: a bridge that says UCI back, exactly as a real one does.
    wss = new WebSocketServer({ server: http });
    wss.on('connection', ws => {
      let mpv = 1;
      ws.on('message', d => {
        for (const line of String(d).split('\n')) {
          if (line === 'uci') ws.send('id name stub\nuciok');
          else if (/^setoption name MultiPV value (\d+)/.test(line)) mpv = +RegExp.$1;
          else if (line.startsWith('go')) {
            ws.send('info depth 18 multipv 1 score cp -15 pv e7e5 g1f3');
            if (mpv > 1) ws.send('info depth 18 multipv 2 score mate 3 pv d7d5');
            ws.send('bestmove e7e5');
          }
        }
      });
    });
  });
  afterAll(() => new Promise(r => { wss.close(); http.close(r); }));

  it('picks the engine per job kind, not globally', () => {
    expect(providerFor('probe', 'local', 'http://x')).toBe('local');
    expect(providerFor('sweep', 'remote', 'http://x')).toBe('remote');
    expect(providerFor('sweep', 'split', 'http://x')).toBe('remote');
    expect(providerFor('probe', 'split', 'http://x')).toBe('local');
    // No URL is no remote, whatever the mode says.
    expect(providerFor('sweep', 'remote', '')).toBe('local');
    expect(transportOf('wss://x')).toBe('ws');
    expect(transportOf('nonsense')).toBe(null);
  });

  it('answers the provider shape over HTTP, and batches in order', async () => {
    S.engineMode = 'remote'; S.engineUrl = 'http://127.0.0.1:' + port; S.engineToken = 'tok';
    const r = await analyse(START, { depth: 18, multipv: 2, movetimeMs: 600, kind: 'scan' });
    expect(r.cp).toBe(42);
    expect(r.depth).toBe(18);
    expect(r.pv[0]).toBe('e2e4');
    expect(r.lines.length).toBe(2);
    expect(seen.auth.at(-1)).toBe('Bearer tok');
    expect(batchable('scan')).toBe(true);
    const out = await analyseBatch([{ fen: START, depth: 18 }, { fen: START, depth: 18 }], { kind: 'sweep' });
    expect(out.map(x => x.cp)).toEqual([100, 101]);
    expect(seen.batch).toBe(1);
  });

  it('answers the same shape over the raw-UCI socket', async () => {
    S.engineMode = 'remote'; S.engineUrl = 'ws://127.0.0.1:' + port; S.engineToken = '';
    const r = await analyse(START, { depth: 18, multipv: 2, movetimeMs: 600, kind: 'probe' });
    // The socket answers from the side to move, as UCI does; nothing converts here.
    expect(r).toMatchObject({ cp: -15, depth: 18 });
    expect(r.lines[1]).toMatchObject({ mate: 3 });
  });

  it('falls back to local on a remote failure, with one toast and never an error', async () => {
    S.engineMode = 'remote'; S.engineUrl = 'http://127.0.0.1:' + port;
    const said = [];
    onFallback(e => said.push(e));
    _setBackends({ local: async () => ({ cp: 7, pv: ['a2a3'], depth: 18, lines: [] }) });
    onFallback(e => said.push(e));
    failNext = true;
    const r = await analyse(START, { kind: 'scan' });
    expect(r.cp).toBe(7);
    expect(said.length).toBe(1);
    failNext = true;
    await analyse(START, { kind: 'scan' });
    expect(said.length).toBe(1);            // said once a session, not once a search
  });

  it('reports the three health outcomes in three sentences', () => {
    expect(describeHealth('ok', 'stub').ok).toBe(true);
    expect(describeHealth('auth').ok).toBe(false);
    expect(describeHealth('url').text).toMatch(/http/);
    expect(describeHealth('network').text).toMatch(/CORS/);
  });

  it('refuses an answer that is not an evaluation rather than passing a plausible number on', () => {
    expect(normaliseResult({ pv: ['e2e4'] })).toBe(null);
    expect(normaliseResult('nope')).toBe(null);
    expect(normaliseResult({ cp: 5, pv: ['e2e4', 'garbage'] }).pv).toEqual(['e2e4']);
  });
});

/* ===== The cache and its stamp ===== */

describe('the evals row', () => {
  const g = () => {
    const game = toyGame(['e4', 'e5', 'Nf3']);
    game.analysis = blankAnalysis();
    return game;
  };

  it('round-trips evaluations, lines and alts, keeping undefined and null apart', () => {
    const game = g();
    const a = game.analysis;
    a.evals[0] = { cp: 30 }; a.evals[1] = { cp: -25 }; a.evals[2] = { mate: 2 }; a.evals[3] = { cp: 0 };
    a.pv[0] = ['e2e4', 'e7e5']; a.pv[1] = ['g1f3'];
    a.best[0] = 'e2e4'; a.best[1] = 'g1f3';
    a.alts[1] = null; a.alts[3] = { cp: 0 };
    a.done = 4;
    const row = evalRow(game);
    expect(row).toMatchObject({ gameId: 'toy', build: ENGINE_BUILD, depth: SCAN_DEPTH, plies: 4 });
    expect(row.evals).toBe('30,-25,m2,0');
    expect(row.lines).toBe('e2e4 e7e5|g1f3');
    expect(row.alts).toBe(',n,,0');
    expect(row.bytes).toBeGreaterThan(0);

    const fresh = g();
    expect(applyEvalRow(fresh, row)).toBe(true);
    expect(fresh.analysis.evals).toEqual([{ cp: 30 }, { cp: -25 }, { mate: 2 }, { cp: 0 }]);
    expect(fresh.analysis.best[0]).toBe('e2e4');
    expect(fresh.analysis.pv[0]).toEqual(['e2e4', 'e7e5']);
    // The three states of alts, which are three different words in the review.
    expect(0 in fresh.analysis.alts).toBe(false);
    expect(fresh.analysis.alts[1]).toBe(null);
    expect(fresh.analysis.alts[3]).toEqual({ cp: 0 });
    expect(fresh.analysis.done).toBe(4);
    expect(analysisReady(fresh)).toBe(true);
    expect(fresh.analysis.altsDone).toBe(true);   // a complete scan carrying an alt has had its pass
  });

  it('discards a row of another build or another depth WHOLE, not per ply', () => {
    const row = { gameId: 'toy', build: ENGINE_BUILD, depth: SCAN_DEPTH, plies: 4, evals: '30,25,20,15', lines: '', alts: '' };
    const other = { ...row, build: 'sf16' };
    const shallow = { ...row, depth: 12 };
    for (const bad of [other, shallow]) {
      const game = g();
      expect(applyEvalRow(game, bad)).toBe(false);
      expect(game.analysis.done).toBe(0);
      expect(game.analysis.evals.length).toBe(0);   // nothing at all, not the agreeing half
    }
    // The fixture set is depth 12 by construction: it must not be readable as a cache row.
    expect(applyEvalRow(g(), { ...row, depth: 12, build: 'sf17-native-fixture' })).toBe(false);
  });

  it('refuses a row whose ply count belongs to another game', () => {
    const game = g();
    expect(applyEvalRow(game, { gameId: 'toy', build: ENGINE_BUILD, depth: SCAN_DEPTH, plies: 99, evals: '30' })).toBe(false);
  });

  it('keeps a partial row, and a merge only fills holes', () => {
    const game = g();
    expect(applyEvalRow(game, { build: ENGINE_BUILD, depth: SCAN_DEPTH, plies: 4, evals: '30,,20', lines: 'e2e4||d2d4', alts: '' })).toBe(true);
    expect(game.analysis.done).toBe(2);
    expect(analysisReady(game)).toBe(false);
    expect(1 in game.analysis.evals).toBe(false);
    expect(classifyable(game, 0)).toBe(false);     // the ply after it is missing
    // A fresh evaluation is never overwritten by a stored one; the hole is filled.
    game.analysis.evals[1] = { cp: 999 };
    expect(applyEvalRow(game, { build: ENGINE_BUILD, depth: SCAN_DEPTH, plies: 4, evals: '1,2,3,4', lines: '', alts: '' })).toBe(true);
    expect(game.analysis.evals[1]).toEqual({ cp: 999 });
    expect(game.analysis.evals[3]).toEqual({ cp: 4 });
    expect(game.analysis.done).toBe(4);
  });

  it('spells one evaluation three ways and reads all three back', () => {
    expect(encodeEval(undefined)).toBe('');
    expect(encodeEval(null)).toBe('n');
    expect(encodeEval({ mate: -3 })).toBe('m-3');
    expect(decodeEval('')).toBe(undefined);
    expect(decodeEval('n')).toBe(null);
    expect(decodeEval('m-3')).toEqual({ mate: -3 });
    expect(decodeEval('rubbish')).toBe(undefined);
    // Trailing holes cost nothing on the disk and come back as holes.
    expect(encodeEvalList([{ cp: 1 }], 5)).toBe('1');
    const back = decodeEvalList('1', 5);
    expect(back.length).toBe(5);
    expect(4 in back).toBe(false);
    expect(encodeLines([['e2e4']], 3)).toBe('e2e4');
    expect(decodeLines('e2e4 e7e5||g1f3', 3).best).toEqual(['e2e4', undefined, 'g1f3']);
  });

  it('turns the side-to-move score White-positive at the one moment it is committed', () => {
    const black = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(whitePositive({ cp: 30 }, START)).toEqual({ cp: 30 });
    expect(whitePositive({ cp: 30 }, black)).toEqual({ cp: -30 });
    expect(whitePositive({ mate: 3 }, black)).toEqual({ mate: -3 });
    // A mated side to move answers `mate 0`: it has no sign to flip.
    expect(whitePositive({ mate: 0 }, black)).toEqual({ mate: 0 });
    expect(whitePositive({ cp: NaN }, START)).toBe(undefined);
    expect(whitePositive(null, START)).toBe(undefined);
  });
});

/* ===== The queue ===== */

describe('the queue', () => {
  const searched = [];
  function backend(delay = 5) {
    return (fen, opts = {}) => {
      searched.push({ fen, kind: opts.kind, multipv: opts.multipv || 1 });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ cp: 20, depth: 18, pv: ['e2e4', 'e7e5'], lines: [{ cp: 20, depth: 18, pv: ['e2e4'] }] }), delay);
        if (opts.signal) opts.signal.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
    };
  }
  beforeEach(() => { searched.length = 0; _setBackends({ local: backend() }); });

  it('scans every ply of a game and reports it done', async () => {
    const game = toyGame(['e4', 'e5', 'Nf3', 'Nc6']);
    S.games = [game];
    await analyseGame(game, { noAlts: true });
    expect(game.analysis.done).toBe(game.fens.length);
    expect(analysisReady(game)).toBe(true);
    expect(searched.length).toBe(game.fens.length);
    expect(searched.every(s => s.kind === 'scan')).toBe(true);
  });

  it('lets a probe jump the queue, and re-queues the abandoned scan WHOLE', async () => {
    const game = toyGame(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    S.games = [game];
    const scan = analyseGame(game, { noAlts: true });
    await tick(1);                                   // the first search is in flight
    const answer = await probe(START, 18);
    expect(answer).toBeTruthy();
    const probeAt = searched.findIndex(s => s.kind === 'probe');
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(game.fens.length);  // it did not wait for the scan
    expect(searched[probeAt].multipv).toBe(3);
    await scan;
    // The abandoned position was searched again rather than committed short: one ply
    // appears twice in the log, and every ply is present exactly once in the answer.
    expect(searched.filter(s => s.kind === 'scan').length).toBe(game.fens.length + 1);
    expect(game.analysis.done).toBe(game.fens.length);
    expect(game.analysis.evals.filter(e => e !== undefined).length).toBe(game.fens.length);
  });

  it('resumes a half-scanned game by queueing only what is missing', async () => {
    const game = toyGame(['e4', 'e5', 'Nf3']);
    game.analysis = blankAnalysis();
    game.analysis.evals[0] = { cp: 10 };
    game.analysis.evals[1] = { cp: -10 };
    game.analysis.done = 2;
    S.games = [game];
    await analyseGame(game, { noAlts: true });
    expect(searched.length).toBe(game.fens.length - 2);
    expect(game.analysis.evals[0]).toEqual({ cp: 10 });   // untouched
  });

  it('does nothing at all for a game the cache already covers', async () => {
    const game = toyGame(['e4', 'e5']);
    game.analysis = blankAnalysis();
    for (let i = 0; i < game.fens.length; i++) game.analysis.evals[i] = { cp: 0 };
    game.analysis.done = game.fens.length;
    game.analysis.altsDone = true;
    S.games = [game];
    await analyseGame(game);
    expect(searched.length).toBe(0);
  });

  it('drops a cancelled scan and leaves what was committed', async () => {
    const game = toyGame(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    S.games = [game];
    const p = analyseGame(game, { noAlts: true });
    await tick(1);
    cancelScans();
    await p;
    expect(analysisReady(game)).toBe(false);
    expect(jobState().queued).toBe(0);
  });
});

/* ===== The second pass ===== */

describe('the MultiPV 2 shortlist', () => {
  const games = corpus.map(g => ({ ...g, analysis: evals[g.id] ? { ...evals[g.id], alts: [], altsDone: false } : undefined }))
    .filter(g => g.analysis);

  it('asks about a shortlist rather than a game, capped at 24', () => {
    expect(games.length).toBeGreaterThan(10);
    for (const g of games) {
      const list = altsShortlist(g);
      expect(list.length).toBeLessThanOrEqual(24);
      expect([...list].sort((a, b) => a - b)).toEqual(list);   // in playing order
    }
    // Somewhere in a corpus of real games there is something worth asking about.
    expect(games.reduce((n, g) => n + altsShortlist(g).length, 0)).toBeGreaterThan(0);
  });

  it('asks only where the played move was already the engine\'s, and only in a contested position', () => {
    const uci = m => m.from + m.to + (m.promotion || '');
    const win = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1500, Math.min(1500, cp)))) - 1);
    for (const g of games) {
      for (const n of altsShortlist(g)) {
        expect(g.analysis.best[n]).toBe(uci(g.moves[n]));
        const ev = g.analysis.evals[n];
        const cp = ev.mate !== undefined ? (ev.mate > 0 ? 10000 : -10000) : ev.cp;
        const mine = g.moves[n].color === 'w' ? win(cp) : 100 - win(cp);
        expect(mine).toBeGreaterThanOrEqual(10);
        expect(mine).toBeLessThanOrEqual(90);
      }
    }
  });

  it('never asks twice: a ply already answered, either way, is off the list', () => {
    const g = games.find(x => altsShortlist(x).length > 1);
    const list = altsShortlist(g);
    g.analysis.alts[list[0]] = null;            // asked, and forced
    g.analysis.alts[list[1]] = { cp: 12 };      // asked, and answered
    const again = altsShortlist(g);
    expect(again).not.toContain(list[0]);
    expect(again).not.toContain(list[1]);
    g.analysis.alts = [];
  });

  it('prefers the sharpest when the cap bites', () => {
    const g = games.find(x => altsShortlist(x, 100).length > 4);
    const all = altsShortlist(g, 100);
    const few = altsShortlist(g, 3);
    expect(few.length).toBe(3);
    for (const n of few) expect(all).toContain(n);
    const swing = n => {
      const cp = i => { const e = g.analysis.evals[i]; return e.mate !== undefined ? (e.mate > 0 ? 10000 : -10000) : e.cp; };
      return Math.abs(cp(n + 1) - cp(n));
    };
    const kept = Math.min(...few.map(swing));
    const dropped = all.filter(n => !few.includes(n)).map(swing);
    for (const d of dropped) expect(d).toBeLessThanOrEqual(kept);
  });
});

/* ===== The constants the contract names ===== */

describe('the numbers the rest of the app reads', () => {
  it('are the ones the contract names', () => {
    expect(SCAN_DEPTH).toBe(18);
    expect(SCAN_MOVETIME).toBe(600);
    expect(PROBE_MOVETIME).toBe(6000);
    expect(ENGINE_BUILD).toBe('sf17.1-lite');
  });
});
