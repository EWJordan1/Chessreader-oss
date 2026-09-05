import { describe, it, expect, beforeEach } from 'vitest';
import { S, SETTINGS, THEMES, applySettings, loadSettings, saveSettings, SKEY } from '../src/state.js';

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

beforeEach(() => { for (const [k, row] of Object.entries(SETTINGS)) S[k] = row.def; });

describe('the settings schema', () => {
  it('guards every field individually — a refused value keeps its default', () => {
    applySettings({ theme: 'neon', probeDepth: 400, interval: 'fast', verbosity: 'natural' });
    expect(S.theme).toBe(THEMES[0]);
    expect(S.probeDepth).toBe(22);
    expect(S.interval).toBe(3000);
    expect(S.verbosity).toBe('natural');
  });
  it('ignores unknown keys, so an older or newer blob loads without migration', () => {
    applySettings({ density: 'compact', signedIn: true, plan: 'pro', remember: false });
    expect(S.density).toBeUndefined();
    expect(S.signedIn).toBeUndefined();
    expect(S.remember).toBe(false);
  });
  it('treats absent as the default, not as a "no"', () => {
    applySettings({});
    expect(S.remember).toBe(true);
    expect(S.announce).toBe(true);
  });
  it('round-trips through storage and survives a corrupt blob', () => {
    const st = memStorage();
    S.theme = 'wood'; S.interval = 5000;
    saveSettings(st);
    const saved = JSON.parse(st.getItem(SKEY));
    expect(Object.keys(saved).sort()).toEqual(Object.keys(SETTINGS).sort());
    S.theme = 'analysis'; S.interval = 3000;
    loadSettings(st);
    expect(S.theme).toBe('wood');
    expect(S.interval).toBe(5000);
    st.setItem(SKEY, '{not json');
    expect(() => loadSettings(st)).not.toThrow();
  });
  it('never persists session state', () => {
    const st = memStorage();
    saveSettings(st);
    const saved = JSON.parse(st.getItem(SKEY));
    for (const k of ['games', 'gi', 'ply', 'playing', 'uttId', '_degraded', 'deck']) expect(saved).not.toHaveProperty(k);
  });
  it('validates the theme against THEMES and nothing else', () => {
    for (const t of THEMES) { applySettings({ theme: t }); expect(S.theme).toBe(t); }
  });
});
