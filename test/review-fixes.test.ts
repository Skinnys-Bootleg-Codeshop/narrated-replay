import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline, claudeCli, createFileStore, forgetSession, type SessionMeta, type Store } from '../src/server/index.js';
import { main } from '../src/cli/main.js';
import { z } from 'zod';

let dir: string;
let store: Store;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'nr-fix-')); store = createFileStore(dir); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('store: malformed themes.json is an error, writes are atomic', () => {
  it('readJson returns null only when the file is missing', async () => {
    expect(await store.readJson('themes.json')).toBeNull();
    await writeFile(path.join(dir, 'themes.json'), '[{"id":"t1"');
    await expect(store.readJson('themes.json')).rejects.toThrow(/not valid JSON/);
  });
  it('writeJson leaves no temp file and replaces atomically', async () => {
    await store.writeJson('themes.json', [{ a: 1 }]);
    await store.writeJson('themes.json', [{ a: 2 }]);
    expect(await store.readJson('themes.json')).toEqual([{ a: 2 }]);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('analyze does not overwrite a malformed themes.json', () => {
  it('fails the session (exit 1) and leaves the file as it was', async () => {
    const id = randomUUID();
    await store.putMeta({ sessionId: id, rrwebStart: 1, audioStart: null, audioMimeType: null, userAgent: 'u', url: 'http://x/', endedAt: 2 });
    await store.putChunk(id, 'events', 0, new TextEncoder().encode('[]'));
    await writeFile(path.join(dir, 'themes.json'), '{broken');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // a transcriber that returns speech, so analysis reaches the catalogue read
    const bin = path.join(dir, 'fake-python');
    writeFileSync(bin, '#!/bin/sh\necho \'{"segments":[{"start":0,"end":1,"text":"It is broken.","words":[{"w":"It","s":0,"e":0.3},{"w":"is","s":0.3,"e":0.5},{"w":"broken.","s":0.5,"e":1}]}]}\'\n');
    chmodSync(bin, 0o755);
    const fakeClaude = path.join(dir, 'claude');
    writeFileSync(fakeClaude, '#!/bin/sh\ncat >/dev/null\necho \'{"result":"{\\"items\\":[]}"}\'\n');
    chmodSync(fakeClaude, 0o755);
    try {
      const code = await main(['analyze', '--store', dir, '--session', id, '--transcriber', 'faster-whisper', '--python', bin, '--llm', 'claude-cli']);
      expect(code).toBe(1);
      expect(err.mock.calls.flat().join(' ')).toMatch(/themes\.json is not valid JSON/);
    } finally { err.mockRestore(); log.mockRestore(); }
    expect(await readFile(path.join(dir, 'themes.json'), 'utf8')).toBe('{broken');
  });
});

describe('forgetSession / narrated-replay forget', () => {
  it('deletes the session and removes its quotes, items and counts from themes.json', async () => {
    const a = randomUUID(); const b = randomUUID();
    for (const id of [a, b]) {
      await store.putMeta({ sessionId: id, rrwebStart: 1, audioStart: null, audioMimeType: null, userAgent: 'u', url: 'http://x/', endedAt: 2 });
      await store.writeFile(id, 'items.json', JSON.stringify([{ id: `${id}:0`, quote: `quote from ${id.slice(0, 4)}`, category: id === a ? 'obvious_bug' : 'product_decision' }]));
    }
    await store.writeJson('themes.json', [
      { id: 't1', title: 'shared', description: '', exampleQuotes: [`quote from ${a.slice(0, 4)}`, `quote from ${b.slice(0, 4)}`], itemIds: [`${a}:0`, `${b}:0`], sessionIds: [a, b], category: 'obvious_bug' },
      { id: 't2', title: 'only a', description: '', exampleQuotes: [`quote from ${a.slice(0, 4)}`], itemIds: [`${a}:0`], sessionIds: [a], category: 'needs_design' },
    ]);
    const r = await forgetSession({ store, sessionId: a });
    expect(r).toEqual({ removedItems: 2, removedThemes: 1 });
    const themes = (await store.readJson<any[]>('themes.json'))!;
    expect(themes.map((t) => t.id)).toEqual(['t1']);
    expect(themes[0].itemIds).toEqual([`${b}:0`]);
    expect(themes[0].sessionIds).toEqual([b]);
    expect(themes[0].exampleQuotes).toEqual([`quote from ${b.slice(0, 4)}`]);
    expect(themes[0].category).toBe('product_decision'); // recomputed from surviving items
    expect(await store.listSessions()).toEqual([b]);
    expect(JSON.stringify(themes)).not.toContain(a);
    expect((await readdir(dir)).includes(a)).toBe(false);
  });
  it('rebuilds quotes from surviving items even when the session items.json is already gone', async () => {
    const a = randomUUID(); const b = randomUUID();
    for (const id of [a, b]) await store.putMeta({ sessionId: id, rrwebStart: 1, audioStart: null, audioMimeType: null, userAgent: 'u', url: 'http://x/', endedAt: 2 });
    await store.writeFile(b, 'items.json', JSON.stringify([{ id: `${b}:0`, quote: 'kept quote', category: 'easy_fix' }]));
    // session a's items.json was deleted by hand under the old retention advice
    await store.writeJson('themes.json', [
      { id: 't1', title: 'x', description: '', exampleQuotes: ['kept quote', 'secret words from a'], itemIds: [`${a}:0`, `${b}:0`], sessionIds: [a, b], category: 'obvious_bug' },
    ]);
    await forgetSession({ store, sessionId: a });
    const themes = (await store.readJson<any[]>('themes.json'))!;
    expect(themes[0].exampleQuotes).toEqual(['kept quote']);
    expect(JSON.stringify(themes)).not.toContain('secret words');
  });
  it('fails and changes nothing when a surviving item cannot be found', async () => {
    const a = randomUUID(); const b = randomUUID();
    for (const id of [a, b]) await store.putMeta({ sessionId: id, rrwebStart: 1, audioStart: null, audioMimeType: null, userAgent: 'u', url: 'http://x/', endedAt: 2 });
    const before = [{ id: 't1', title: 'x', description: '', exampleQuotes: ['q'], itemIds: [`${a}:0`, `${b}:0`], sessionIds: [a, b], category: 'obvious_bug' }];
    await store.writeJson('themes.json', before);
    await expect(forgetSession({ store, sessionId: a })).rejects.toThrow(/cannot forget/);
    expect(await store.readJson('themes.json')).toEqual(before);
    expect(await store.listSessions()).toContain(a);
  });
  it('CLI forget works and rejects missing arguments with exit 2', async () => {
    const id = randomUUID();
    await store.putMeta({ sessionId: id, rrwebStart: 1, audioStart: null, audioMimeType: null, userAgent: 'u', url: 'http://x/', endedAt: 2 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main(['forget', '--store', dir])).toBe(2);
      expect(await main(['forget', '--session', id])).toBe(2);
      expect(await main(['forget', '--store', dir, '--session', id])).toBe(0);
    } finally { log.mockRestore(); err.mockRestore(); }
    expect(await store.listSessions()).toEqual([]);
  });
});

describe('align: attribute and text mutations', () => {
  const meta: SessionMeta = { sessionId: 's', rrwebStart: 0, audioStart: 0, audioMimeType: null, userAgent: 'u', url: '', endedAt: 1 };
  const snap = {
    type: 2, timestamp: 0,
    data: { node: { id: 1, type: 0, childNodes: [
      { id: 2, type: 2, tagName: 'button', attributes: { 'aria-label': 'Save' }, childNodes: [] },
      { id: 3, type: 2, tagName: 'p', attributes: {}, childNodes: [{ id: 4, type: 3, textContent: 'Saving…' }] },
    ] } },
  };
  it('labels a click with the updated aria-label', () => {
    const tl = buildTimeline([
      snap,
      { type: 3, timestamp: 100, data: { source: 0, adds: [], removes: [], texts: [], attributes: [{ id: 2, attributes: { 'aria-label': 'Delete' } }] } },
      { type: 3, timestamp: 200, data: { source: 2, type: 2, id: 2, x: 0, y: 0 } },
    ], meta);
    const click = tl.find((t) => t.kind === 'click')!;
    expect(click.detail).toContain('aria-label="Delete"');
    expect(click.detail).not.toContain('Save');
  });
  it('removed attributes (null) disappear from the label', () => {
    const tl = buildTimeline([
      snap,
      { type: 3, timestamp: 100, data: { source: 0, adds: [], removes: [], texts: [], attributes: [{ id: 2, attributes: { 'aria-label': null } }] } },
      { type: 3, timestamp: 200, data: { source: 2, type: 2, id: 2 } },
    ], meta);
    expect(tl.find((t) => t.kind === 'click')!.detail).not.toContain('aria-label');
  });
  it('a text mutation on an existing node appears in the timeline as `text`', () => {
    const tl = buildTimeline([
      snap,
      { type: 3, timestamp: 300, data: { source: 0, adds: [], removes: [], attributes: [], texts: [{ id: 4, value: 'Error: invalid date' }] } },
    ], meta);
    expect(tl).toContainEqual({ tMs: 300, kind: 'text', detail: 'Error: invalid date' });
  });
});

describe('align: node state is independent of the events', () => {
  const meta: SessionMeta = { sessionId: 's', rrwebStart: 0, audioStart: 0, audioMimeType: null, userAgent: 'u', url: '', endedAt: 1 };
  it('buildTimeline does not mutate events, so a second pass gives the same result', () => {
    const events: any[] = [
      { type: 2, timestamp: 0, data: { node: { id: 1, type: 0, childNodes: [{ id: 2, type: 2, tagName: 'button', attributes: { 'aria-label': 'Save' }, childNodes: [] },
        { id: 3, type: 2, tagName: 'p', attributes: {}, childNodes: [{ id: 4, type: 3, textContent: 'Saving…' }] }] } } },
      { type: 3, timestamp: 50, data: { source: 2, type: 2, id: 2 } },
      { type: 3, timestamp: 100, data: { source: 0, adds: [], removes: [], texts: [{ id: 4, value: 'Error: bad' }], attributes: [{ id: 2, attributes: { 'aria-label': 'Delete' } }] } },
    ];
    const snapshotBefore = JSON.stringify(events);
    const first = buildTimeline(events, meta);
    expect(JSON.stringify(events)).toBe(snapshotBefore);
    const second = buildTimeline(events, meta);
    expect(second).toEqual(first);
    expect(first.find((t) => t.kind === 'click')!.detail).toContain('Save');
  });
});

describe('claude-cli: early exit (EPIPE) fails the call instead of crashing', () => {
  it('rejects with a clear error when the process exits before reading a large prompt', async () => {
    const bin = path.join(dir, 'exit-now');
    writeFileSync(bin, '#!/bin/sh\nexit 3\n');
    chmodSync(bin, 0o755);
    const llm = claudeCli({ command: bin });
    const big = 'x'.repeat(20_000_000);
    await expect(llm.json({ system: 's', user: big, schema: z.object({}) })).rejects.toThrow(/claude CLI/);
  });
});
