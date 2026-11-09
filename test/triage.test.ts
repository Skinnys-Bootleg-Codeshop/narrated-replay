import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeSession, createFileStore, mockLlm, needsHumanReview, type Store, type Transcriber, type Transcript,
} from '../src/server/index.js';

let dir: string;
let store: Store;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'nr-triage-')); store = createFileStore(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const transcript: Transcript = {
  words: [
    { text: 'The', startMs: 1000, endMs: 1200 }, { text: 'date', startMs: 1200, endMs: 1500 },
    { text: 'box', startMs: 1500, endMs: 1800 }, { text: 'is', startMs: 1800, endMs: 1900 }, { text: 'broken.', startMs: 1900, endMs: 2400 },
    { text: 'I', startMs: 4000, endMs: 4100 }, { text: 'want', startMs: 4100, endMs: 4300 }, { text: 'dark', startMs: 4300, endMs: 4500 },
    { text: 'mode.', startMs: 4500, endMs: 5000 },
  ],
  segments: [],
};
const transcriber: Transcriber = { transcribe: async () => transcript };

async function seed(withAudio = true) {
  const id = randomUUID();
  const t0 = 1_000_000;
  await store.putMeta({ sessionId: id, rrwebStart: t0, audioStart: withAudio ? t0 + 50 : null, audioMimeType: withAudio ? 'audio/webm' : null, userAgent: 'ua', url: 'http://x/', endedAt: t0 + 9000 });
  await store.putChunk(id, 'events', 0, new TextEncoder().encode(JSON.stringify([
    { type: 5, timestamp: t0 + 10, data: { tag: 'nr:route', payload: { href: 'http://x/notes' } } },
  ])));
  if (withAudio) await store.putChunk(id, 'audio', 0, new Uint8Array([1, 2, 3, 4]));
  return id;
}

const item = (momentIds: string[], over: Record<string, unknown> = {}) => ({
  quote: 'The date box is broken.', momentIds, element: null, summary: 'Date box rejects valid dates',
  category: 'obvious_bug', confidence: 0.9, rationale: 'user says broken', ...over,
});

describe('analyzeSession', () => {
  it('writes items, themes and report; enforces review rule in code', async () => {
    const id = await seed();
    const llm = mockLlm([
      { items: [
        item([`${id}-m0`]),
        item([`${id}-m1`], { quote: 'I want dark mode.', summary: 'Wants dark mode', category: 'product_decision', confidence: 0.95 }),
        item([`${id}-m1`], { quote: 'I want dark mode.', summary: 'Copy tweak', category: 'easy_fix', confidence: 0.4 }),
      ] },
      { newThemes: [{ key: 'date', title: 'Date box', description: 'dates rejected' }, { key: 'dark', title: 'Dark mode', description: 'wants dark mode' }],
        assignments: [{ ref: 'i0', themeId: 'new:date' }, { ref: 'i1', themeId: 'new:dark' }, { ref: 'i2', themeId: 'new:dark' }] },
    ]);
    const r = await analyzeSession({ store, sessionId: id, transcriber, llm });
    expect(r.items.map((i) => [i.category, i.needsHumanReview])).toEqual([
      ['obvious_bug', false], ['product_decision', true], ['easy_fix', true],
    ]);
    expect(r.items[0]).toMatchObject({ sessionId: id, page: '/notes', themeId: 't1', momentIds: [`${id}-m0`] });
    expect(r.items[0]!.startMs).toBe(1000);
    expect(r.themes).toHaveLength(2);
    const onDisk = JSON.parse(await readFile(path.join(dir, id, 'items.json'), 'utf8'));
    expect(Object.keys(onDisk[0]).sort()).toEqual(
      ['category', 'confidence', 'element', 'endMs', 'id', 'momentIds', 'needsHumanReview', 'page', 'quote', 'rationale', 'sessionId', 'startMs', 'summary', 'themeId'],
    );
    expect(JSON.parse(await readFile(path.join(dir, 'themes.json'), 'utf8'))).toHaveLength(2);
    const report = await readFile(path.join(dir, id, 'report.md'), 'utf8');
    expect(report).toContain('needs human review');
    expect(JSON.parse(await readFile(path.join(dir, id, 'analysis.json'), 'utf8')).status).toBe('ok');
  });

  it('notes in the report that seeking may not work without a working ffmpeg remux', async () => {
    const id = await seed();
    const llm = mockLlm([{ items: [] }]);
    const r = await analyzeSession({ store, sessionId: id, transcriber, llm });
    // dummy bytes are not valid audio, so remux fails -> not seekable
    expect(r.seekable).toBe(false);
    expect(await readFile(path.join(dir, id, 'report.md'), 'utf8')).toMatch(/seeking in the replay may not work/);
  });

  it('assigns an overlapping complaint in a second session to the existing theme', async () => {
    const a = await seed();
    const b = await seed();
    const first = mockLlm([
      { items: [item([`${a}-m0`])] },
      { newThemes: [{ key: 'date', title: 'Date box', description: 'dates rejected' }], assignments: [{ ref: 'i0', themeId: 'new:date' }] },
    ]);
    await analyzeSession({ store, sessionId: a, transcriber, llm: first });
    const second = mockLlm([
      { items: [item([`${b}-m0`], { summary: 'Valid date refused' })] },
      { newThemes: [], assignments: [{ ref: 'i0', themeId: 't1' }] },
    ]);
    const r = await analyzeSession({ store, sessionId: b, transcriber, llm: second });
    expect(r.themes).toHaveLength(1);
    expect(r.themes[0]).toMatchObject({ id: 't1', sessionIds: [a, b] });
    expect(r.themes[0]!.itemIds).toHaveLength(2);
    // the clustering prompt carried the existing catalogue
    expect(second.calls[1]!.user).toContain('"id": "t1"');
    expect(second.calls[1]!.user).toContain('Date box');
  });

  it('re-analysing a session replaces its items instead of duplicating', async () => {
    const id = await seed();
    const replies = () => [
      { items: [item([`${id}-m0`])] },
      { newThemes: [{ key: 'd', title: 'Date', description: 'd' }], assignments: [{ ref: 'i0', themeId: 'new:d' }] },
    ];
    await analyzeSession({ store, sessionId: id, transcriber, llm: mockLlm(replies()) });
    const r = await analyzeSession({ store, sessionId: id, transcriber, llm: mockLlm(replies()) });
    expect(r.themes).toHaveLength(1);
    expect(r.themes[0]!.itemIds).toHaveLength(1);
  });

  it('re-analysis drops the session\'s old example quotes from themes', async () => {
    const id = await seed();
    const mk = (quote: string) => [
      { items: [item([`${id}-m0`], { quote })] },
      { newThemes: [{ key: 'd', title: 'Date', description: 'd' }], assignments: [{ ref: 'i0', themeId: 'new:d' }] },
    ];
    await analyzeSession({ store, sessionId: id, transcriber, llm: mockLlm(mk('first wording')) });
    const r = await analyzeSession({ store, sessionId: id, transcriber, llm: mockLlm(mk('second wording')) });
    expect(r.themes[0]!.exampleQuotes).toEqual(['second wording']);
  });

  it('theme category counts items from earlier sessions too', async () => {
    const a = await seed();
    const b = await seed();
    const c = await seed();
    const first = (sid: string, cat: string) => [
      { items: [item([`${sid}-m0`], { category: cat })] },
      { newThemes: [{ key: 'd', title: 'Date', description: 'd' }], assignments: [{ ref: 'i0', themeId: 'new:d' }] },
    ];
    const again = (sid: string, cat: string) => [
      { items: [item([`${sid}-m0`], { category: cat })] },
      { newThemes: [], assignments: [{ ref: 'i0', themeId: 't1' }] },
    ];
    await analyzeSession({ store, sessionId: a, transcriber, llm: mockLlm(first(a, 'obvious_bug')) });
    await analyzeSession({ store, sessionId: b, transcriber, llm: mockLlm(again(b, 'obvious_bug')) });
    const r = await analyzeSession({ store, sessionId: c, transcriber, llm: mockLlm(again(c, 'easy_fix')) });
    expect(r.themes[0]!.category).toBe('obvious_bug'); // 2 vs 1, not flipped by the newest session
  });

  it('retries once on invalid output, then fails the session without writing items', async () => {
    const id = await seed();
    const llm = mockLlm(['not json', 'still not json']);
    await expect(analyzeSession({ store, sessionId: id, transcriber, llm })).rejects.toThrow(/after one retry/);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.user).toContain('rejected');
    expect(await readFile(path.join(dir, id, 'items.json'), 'utf8').catch(() => null)).toBeNull();
    expect(JSON.parse(await readFile(path.join(dir, id, 'analysis.json'), 'utf8')).status).toBe('failed');
  });

  it('recovers when the retry is valid', async () => {
    const id = await seed();
    const llm = mockLlm([
      { items: [item(['bogus-id'])] }, // unknown momentId -> rejected
      { items: [item([`${id}-m0`])] },
      { newThemes: [{ key: 'd', title: 'Date', description: 'd' }], assignments: [{ ref: 'i0', themeId: 'new:d' }] },
    ]);
    const r = await analyzeSession({ store, sessionId: id, transcriber, llm });
    expect(r.items).toHaveLength(1);
  });

  it('rejects a category outside the four allowed', async () => {
    const id = await seed();
    const llm = mockLlm([{ items: [item([`${id}-m0`], { category: 'hard' })] }, { items: [item([`${id}-m0`], { category: 'hard' })] }]);
    await expect(analyzeSession({ store, sessionId: id, transcriber, llm })).rejects.toThrow(/category/);
  });

  it('rejects a clustering reply that skips an item or invents a theme', async () => {
    const id = await seed();
    const llm = mockLlm([
      { items: [item([`${id}-m0`])] },
      { newThemes: [], assignments: [{ ref: 'i0', themeId: 't99' }] },
      { newThemes: [], assignments: [{ ref: 'i0', themeId: 't99' }] },
    ]);
    await expect(analyzeSession({ store, sessionId: id, transcriber, llm })).rejects.toThrow(/themeId/);
  });

  it('moment extraction makes one call per moment', async () => {
    const id = await seed();
    const llm = mockLlm(({ system, user }) => {
      if (system.startsWith('You merge')) {
        return { newThemes: [{ key: 'a', title: 'A', description: 'a' }], assignments: JSON.parse(user).newItems.map((i: any) => ({ ref: i.ref, themeId: 'new:a' })) };
      }
      const moment = JSON.parse(user)[0].id as string;
      return { items: [item([moment])] };
    });
    const r = await analyzeSession({ store, sessionId: id, transcriber, llm, extraction: 'moment' });
    expect(r.items).toHaveLength(2);
    expect(llm.calls).toHaveLength(3);
  });

  it('no speech: zero items, report says so, exit state ok', async () => {
    const id = await seed();
    const llm = mockLlm([]);
    const r = await analyzeSession({ store, sessionId: id, transcriber: { transcribe: async () => ({ words: [], segments: [] }) }, llm });
    expect(r.items).toEqual([]);
    expect(llm.calls).toHaveLength(0);
    expect(await readFile(path.join(dir, id, 'report.md'), 'utf8')).toContain('No speech detected');
    expect(JSON.parse(await readFile(path.join(dir, id, 'analysis.json'), 'utf8')).status).toBe('ok');
  });
});

describe('needsHumanReview', () => {
  it('is true for product_decision and for confidence below 0.7', () => {
    expect(needsHumanReview('product_decision', 1)).toBe(true);
    expect(needsHumanReview('easy_fix', 0.69)).toBe(true);
    expect(needsHumanReview('easy_fix', 0.7)).toBe(false);
    expect(needsHumanReview('needs_design', 0.95)).toBe(false);
  });
});
