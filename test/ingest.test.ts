import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileStore, createIngestHandler } from '../src/server/index.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'nr-ingest-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const post = (h: (r: Request) => Promise<Response>, p: string, body: BodyInit = '[]', headers: Record<string, string> = {}) =>
  h(new Request(`http://x/api/narrated-replay${p}`, { method: 'POST', body, headers }));

const meta = (id: string) => ({
  sessionId: id, rrwebStart: 1, audioStart: 2, audioMimeType: 'audio/webm', userAgent: 'ua', url: 'http://x/', endedAt: 3,
});

describe('createIngestHandler', () => {
  it('throws at creation without authorize or allowUnauthenticated', () => {
    expect(() => createIngestHandler({ store: createFileStore(dir) })).toThrow(/authorize/);
  });

  it('accepts a valid chunk and stores it', async () => {
    const h = createIngestHandler({ store: createFileStore(dir), allowUnauthenticated: true });
    const id = randomUUID();
    expect((await post(h, `/sessions/${id}/events/0`, '[{"type":4}]')).status).toBe(200);
    expect((await post(h, `/sessions/${id}/audio/0`, new Uint8Array([1, 2, 3]))).status).toBe(200);
    expect((await post(h, `/sessions/${id}/meta/0`, JSON.stringify(meta(id)))).status).toBe(200);
    expect(await readFile(path.join(dir, id, 'events', '000000'), 'utf8')).toBe('[{"type":4}]');
    expect([...(await readFile(path.join(dir, id, 'audio', '000000')))]).toEqual([1, 2, 3]);
    const s = await createFileStore(dir).readSession(id);
    expect(s.events).toEqual([{ type: 4 }]);
    expect(s.meta.audioStart).toBe(2);
  });

  const h = () => createIngestHandler({ store: createFileStore(dir), allowUnauthenticated: true });

  it('rejects a session id that is not a UUID v4 with 400', async () => {
    expect((await post(h(), '/sessions/not-a-uuid/events/0')).status).toBe(400);
    // v1 UUID (version nibble 1)
    expect((await post(h(), '/sessions/123e4567-e89b-12d3-a456-426614174000/events/0')).status).toBe(400);
  });
  it('rejects unknown kinds with 400', async () => {
    expect((await post(h(), `/sessions/${randomUUID()}/video/0`)).status).toBe(400);
  });
  it.each(['-1', '100001', '1.5', 'abc', '1e3', '0x10', ''])('rejects seq %j with 400', async (seq) => {
    expect((await post(h(), `/sessions/${randomUUID()}/events/${seq}`)).status).toBe(400);
  });
  it('accepts seq bounds 0 and 100000', async () => {
    const id = randomUUID();
    expect((await post(h(), `/sessions/${id}/events/0`)).status).toBe(200);
    expect((await post(h(), `/sessions/${id}/events/100000`)).status).toBe(200);
  });
  it('rejects bodies over maxChunkBytes with 413 (declared and streamed)', async () => {
    const small = createIngestHandler({ store: createFileStore(dir), allowUnauthenticated: true, maxChunkBytes: 10 });
    const id = randomUUID();
    expect((await post(small, `/sessions/${id}/audio/0`, new Uint8Array(11))).status).toBe(413);
    expect((await post(small, `/sessions/${id}/audio/1`, new Uint8Array(10))).status).toBe(200);
  });
  it('defaults maxChunkBytes to 5 MB', async () => {
    const id = randomUUID();
    expect((await post(h(), `/sessions/${id}/audio/0`, new Uint8Array(5 * 1024 * 1024 + 1))).status).toBe(413);
  });
  it('returns 401 when authorize returns false, and never writes', async () => {
    const store = createFileStore(dir);
    const handler = createIngestHandler({ store, authorize: () => false });
    const id = randomUUID();
    expect((await post(handler, `/sessions/${id}/events/0`)).status).toBe(401);
    expect(await readdir(dir)).toEqual([]);
  });
  it('treats an authorize that throws as unauthorized', async () => {
    const handler = createIngestHandler({ store: createFileStore(dir), authorize: () => { throw new Error('boom'); } });
    expect((await post(handler, `/sessions/${randomUUID()}/events/0`)).status).toBe(401);
  });
  it('lets authorize see the request (headers)', async () => {
    const handler = createIngestHandler({ store: createFileStore(dir), authorize: (r) => r.headers.get('authorization') === 'Bearer k' });
    const id = randomUUID();
    expect((await post(handler, `/sessions/${id}/events/0`)).status).toBe(401);
    expect((await post(handler, `/sessions/${id}/events/0`, '[]', { authorization: 'Bearer k' })).status).toBe(200);
  });
  it('rejects events that are not a JSON array, and meta with a mismatched id', async () => {
    const id = randomUUID();
    expect((await post(h(), `/sessions/${id}/events/0`, '{"a":1}')).status).toBe(400);
    expect((await post(h(), `/sessions/${id}/events/0`, 'nope')).status).toBe(400);
    expect((await post(h(), `/sessions/${id}/meta/0`, JSON.stringify(meta(randomUUID())))).status).toBe(400);
    expect((await post(h(), `/sessions/${id}/meta/0`, '{}')).status).toBe(400);
  });
  it('only accepts POST and the /sessions/:id/:kind/:seq shape', async () => {
    const id = randomUUID();
    expect((await h()(new Request(`http://x/sessions/${id}/events/0`, { method: 'GET' }))).status).toBe(405);
    expect((await post(h(), `/sessions/${id}/events`)).status).toBe(400);
    expect((await post(h(), `/sessions/${id}/events/0/extra`)).status).toBe(400);
  });

  it('cannot write outside the store root with ../ in any path parameter', async () => {
    const root = path.join(dir, 'root');
    const handler = createIngestHandler({ store: createFileStore(root), allowUnauthenticated: true });
    const id = randomUUID();
    const attempts = [
      `/sessions/..%2F..%2Fevil/events/0`,
      `/sessions/${id}/..%2F..%2Fx/0`,
      `/sessions/${id}/events/..%2F..%2F0`,
      `/sessions/%2e%2e/events/0`,
      `/sessions/${id}/%2e%2e/0`,
      `/sessions/${id}/events/%2e%2e`,
      `/sessions/..%5C..%5Cevil/events/0`,
      `/sessions/${id}%00/events/0`,
    ];
    for (const p of attempts) {
      const r = await post(handler, p);
      expect(r.status, p).toBe(400);
    }
    // nothing was created anywhere in the temp dir
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('file store', () => {
  it('rejects bad names for derived files and traversal in readJson/writeJson', async () => {
    const s = createFileStore(path.join(dir, 'root'));
    await expect(s.writeJson('../x.json', {})).rejects.toThrow();
    await expect(s.writeJson('.hidden', {})).rejects.toThrow();
    await expect(s.writeFile(randomUUID(), '../../x', 'a')).rejects.toThrow();
    await expect(s.writeFile('../../etc', 'x', 'a')).rejects.toThrow();
    await s.writeJson('themes.json', [1]);
    expect(await s.readJson('themes.json')).toEqual([1]);
  });
});
