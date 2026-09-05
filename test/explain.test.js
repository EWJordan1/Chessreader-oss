import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { S } from '../src/state.js';
import { loadGames } from '../src/pgn.js';
import { askExplain, buildPrompt, jobForMove, jobForCard, explainAvailable, EXPLAIN_GAP_MS, EXPLAIN_SESSION_MAX, _reset } from '../src/ai/explain.js';

const evals = JSON.parse(readFileSync(new URL('./fixtures/evals.json', import.meta.url), 'utf8'));
let games;

beforeEach(async () => {
  _reset();
  S.aiBase = 'https://api.example.test/v1';
  S.aiKey = 'sk-test';
  S.aiChatModel = 'gpt-4o-mini';
  if (!games) {
    const r = await loadGames(readFileSync(new URL('./fixtures/chesscom.pgn', import.meta.url), 'utf8'));
    games = r.games;
    for (const g of games) if (evals[g.id]) g.analysis = evals[g.id];
  }
});

const okFetch = (text = 'The knight was hanging.') => vi.fn(async () => ({
  ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }),
}));

describe('the button is not offered without a provider', () => {
  it('is unavailable when the base URL or the key is missing', () => {
    expect(explainAvailable()).toBe(true);
    S.aiKey = '';
    expect(explainAvailable()).toBe(false);
    S.aiKey = 'sk-test'; S.aiBase = '';
    expect(explainAvailable()).toBe(false);
  });
});

describe('the verdict guard', () => {
  it('asks nothing about a move the three words do not call an error', () => {
    const g = games.find(x => x.analysis);
    let errors = 0, quiet = 0;
    for (let n = 0; n < g.moves.length; n++) {
      const job = jobForMove(g, n);
      if (job) { errors++; expect(['inaccuracy', 'mistake', 'blunder']).toContain(job.verdict); }
      else quiet++;
    }
    // A game is mostly moves nobody should be paying to have explained.
    expect(quiet).toBeGreaterThan(errors);
  });
  it('returns null for a game with no analysis at all', () => {
    expect(jobForMove({ moves: [], fens: [] }, 0)).toBeNull();
    expect(jobForMove(null, 0)).toBeNull();
  });
});

describe('the prompt', () => {
  it('carries the position, the move and both evaluations, and asks for no variations', () => {
    const p = buildPrompt({ fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1', played: 'Nxe4', best: 'g8f6', verdict: 'blunder', evalBefore: { cp: 30 }, evalAfter: { cp: 320 } });
    expect(p).toMatch(/blunder/);
    expect(p).toMatch(/Nxe4/);
    expect(p).toMatch(/0\.30/);
    expect(p).toMatch(/3\.20/);
    expect(p).toMatch(/do not give a long variation/);
  });
  it('says "mate in n" rather than a centipawn figure', () => {
    expect(buildPrompt({ fen: 'x', played: 'a', verdict: 'blunder', evalBefore: { mate: -3 }, evalAfter: { cp: 0 } })).toMatch(/mate in 3/);
  });
});

describe('asking', () => {
  it('sends one POST to the configured base with the bearer key', async () => {
    const f = okFetch();
    const r = await askExplain({ fen: 'a', played: 'b', verdict: 'mistake' }, f);
    expect(r.text).toBe('The knight was hanging.');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body).model).toBe('gpt-4o-mini');
  });
  it('answers a repeated question from the cache without paying twice', async () => {
    const f = okFetch();
    const job = { fen: 'a', played: 'b', verdict: 'mistake' };
    await askExplain(job, f);
    const again = await askExplain(job, f);
    expect(again.cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('rate-limits a second question on a different position', async () => {
    const f = okFetch();
    await askExplain({ fen: 'a', played: 'b', verdict: 'mistake' }, f);
    const r = await askExplain({ fen: 'c', played: 'd', verdict: 'mistake' }, f);
    expect(r.error).toMatch(/one question at a time/i);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('stops for the session after the ceiling', async () => {
    vi.useFakeTimers();
    const f = okFetch();
    for (let i = 0; i < EXPLAIN_SESSION_MAX; i++) {
      vi.advanceTimersByTime(EXPLAIN_GAP_MS + 1);
      await askExplain({ fen: 'f' + i, played: 'b', verdict: 'mistake' }, f);
    }
    vi.advanceTimersByTime(EXPLAIN_GAP_MS + 1);
    const r = await askExplain({ fen: 'last', played: 'b', verdict: 'mistake' }, f);
    expect(r.error).toMatch(/as many explanations/);
    expect(explainAvailable()).toBe(false);
    vi.useRealTimers();
  });
  it('tells a refused key apart from a browser that was not allowed to ask', async () => {
    const refused = vi.fn(async () => ({ ok: false, status: 401 }));
    const r1 = await askExplain({ fen: 'a', played: 'b', verdict: 'mistake' }, refused);
    expect(r1.error).toMatch(/refused your key/);
    _reset();
    const cors = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const r2 = await askExplain({ fen: 'a', played: 'b', verdict: 'mistake' }, cors);
    expect(r2.error).toMatch(/CORS/);
    expect(r2.error).not.toMatch(/refused your key/);
  });
  it('latches after a refusal and asks nothing more this session', async () => {
    const refused = vi.fn(async () => ({ ok: false, status: 403 }));
    await askExplain({ fen: 'a', played: 'b', verdict: 'mistake' }, refused);
    expect(explainAvailable()).toBe(false);
    const r = await askExplain({ fen: 'z', played: 'y', verdict: 'mistake' }, refused);
    expect(r.error).toMatch(/refused an earlier question/);
    expect(refused).toHaveBeenCalledTimes(1);
  });
  it('never throws, whatever the endpoint answers', async () => {
    const junk = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
    await expect(askExplain({ fen: 'a', played: 'b', verdict: 'mistake' }, junk)).resolves.toHaveProperty('error');
  });
});

describe('a deck card asks the same question', () => {
  it('builds a job from the card alone, since a card is self-contained', () => {
    const card = { fen: 'r1bqkbnr/8/8/8/8/8/8/RNBQKBNR w KQkq - 0 1', played: 'e2e4', answer: 'd2d4', before: { cp: 20 }, after: { cp: -300 } };
    const job = jobForCard(card);
    expect(job.fen).toBe(card.fen);
    expect(job.best).toBe('d2d4');
    expect(buildPrompt(job)).toMatch(/-3\.00/);
    expect(jobForCard(null)).toBeNull();
  });
});
