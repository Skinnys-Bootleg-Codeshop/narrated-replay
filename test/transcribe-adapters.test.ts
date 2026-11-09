import { describe, expect, it } from 'vitest';
import {
  awsTranscribe, anthropic, bedrock, createS3Store, openaiTranscribe, parseAwsTranscript, DEFAULT_MODEL,
} from '../src/server/index.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

describe('openaiTranscribe', () => {
  it('maps word timestamps to ms', async () => {
    const calls: any[] = [];
    const client = { audio: { transcriptions: { create: async (a: any) => { calls.push(a); return { words: [{ word: ' Hello', start: 0.5, end: 0.9 }, { word: 'there.', start: 1.0, end: 1.4 }] }; } } } };
    const t = await openaiTranscribe({ client, model: 'm' }).transcribe(new Uint8Array([1]), 'audio/webm');
    expect(t.words).toEqual([{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'there.', startMs: 1000, endMs: 1400 }]);
    expect(t.segments).toEqual([{ text: 'Hello there.', startMs: 500, endMs: 1400 }]);
    expect(calls[0].timestamp_granularities).toEqual(['word']);
    expect(calls[0].model).toBe('m');
  });
});

describe('awsTranscribe', () => {
  const json = { results: { items: [
    { type: 'pronunciation', start_time: '0.5', end_time: '0.9', alternatives: [{ content: 'Hello' }] },
    { type: 'pronunciation', start_time: '1.0', end_time: '1.4', alternatives: [{ content: 'world' }] },
    { type: 'punctuation', alternatives: [{ content: '.' }] },
  ] } };
  it('parses items into words with punctuation attached', () => {
    expect(parseAwsTranscript(json).words).toEqual([{ text: 'Hello', startMs: 500, endMs: 900 }, { text: 'world.', startMs: 1000, endMs: 1400 }]);
  });
  it('runs upload, start, poll and parse with mocked clients', async () => {
    const sent: string[] = [];
    class Cmd { constructor(public input: any) {} }
    const mk = (name: string) => class extends Cmd { n = name; };
    const polls = ['IN_PROGRESS', 'COMPLETED'];
    const t = await awsTranscribe({
      bucket: 'b', pollMs: 1,
      commands: { s3: { PutObjectCommand: mk('put') }, transcribe: { StartTranscriptionJobCommand: mk('start'), GetTranscriptionJobCommand: mk('get') } },
      s3: { send: async (c: any) => { sent.push(c.n); } },
      transcribe: { send: async (c: any) => { sent.push(c.n); return c.n === 'get' ? { TranscriptionJob: { TranscriptionJobStatus: polls.shift(), Transcript: { TranscriptFileUri: 'u' } } } : {}; } },
      fetchJson: async () => json,
    }).transcribe(new Uint8Array([1]), 'audio/webm');
    expect(sent).toEqual(['put', 'start', 'get', 'get']);
    expect(t.words).toHaveLength(2);
  });
});

describe('LLM adapters (mocked clients)', () => {
  const schema = z.object({ ok: z.boolean() });
  it('anthropic sends the default model and parses a text reply', async () => {
    const calls: any[] = [];
    const client = { messages: { create: async (a: any) => { calls.push(a); return { content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] }; } } };
    expect(await anthropic({ client }).json({ system: 's', user: 'u', schema })).toEqual({ ok: true });
    expect(calls[0].model).toBe(DEFAULT_MODEL);
    expect(calls[0].system).toBe('s');
    expect(calls[0].tool_choice).toBeUndefined();
  });
  it('bedrock uses the anthropic.-prefixed model id', async () => {
    const calls: any[] = [];
    const client = { messages: { create: async (a: any) => { calls.push(a); return { content: [{ type: 'text', text: '{"ok":true}' }] }; } } };
    await bedrock({ region: 'eu-west-2', client }).json({ system: 's', user: 'u', schema });
    expect(calls[0].model).toBe(`anthropic.${DEFAULT_MODEL}`);
  });
  it('anthropic without the SDK installed gives a clear error', async () => {
    await expect(anthropic().json({ system: 's', user: 'u', schema })).rejects.toThrow(/install @anthropic-ai\/sdk/);
  });
});

describe('createS3Store with a mock client', () => {
  it('round-trips chunks and meta under the prefix', async () => {
    const objects = new Map<string, Uint8Array | string>();
    const client = {
      send: async (c: any) => {
        const i = c.input;
        if ('Body' in i) { objects.set(i.Key, i.Body); return {}; }
        if ('Prefix' in i) return { Contents: [...objects.keys()].filter((k) => k.startsWith(i.Prefix)).map((Key) => ({ Key })) };
        const b = objects.get(i.Key);
        if (b === undefined) { const e: any = new Error('nope'); e.name = 'NoSuchKey'; throw e; }
        return { Body: { transformToByteArray: async () => (typeof b === 'string' ? new TextEncoder().encode(b) : b) } };
      },
    };
    const s = createS3Store({ bucket: 'b', prefix: 'p', client });
    const id = randomUUID();
    await s.putChunk(id, 'events', 1, new TextEncoder().encode('[2]'));
    await s.putChunk(id, 'events', 0, new TextEncoder().encode('[1]'));
    await s.putChunk(id, 'audio', 0, new Uint8Array([9]));
    await s.putMeta({ sessionId: id, rrwebStart: 1, audioStart: 2, audioMimeType: null, userAgent: '', url: '', endedAt: 3 });
    expect([...objects.keys()].every((k) => k.startsWith('p/'))).toBe(true);
    const r = await s.readSession(id);
    expect(r.events).toEqual([1, 2]);
    expect([...r.audio]).toEqual([9]);
    expect(await s.listSessions()).toEqual([id]);
    await expect(s.putChunk('../x', 'events', 0, new Uint8Array())).rejects.toThrow();
  });
});
