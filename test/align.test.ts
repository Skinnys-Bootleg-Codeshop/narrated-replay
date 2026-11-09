import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMoments, type SessionMeta, type Transcript } from '../src/server/index.js';

const fx = (s: string, f: string) => readFileSync(new URL(`./fixtures/${s}/${f}`, import.meta.url), 'utf8');
const lab = JSON.parse(readFileSync(new URL('./fixtures/lab-moments.json', import.meta.url), 'utf8')) as Record<
  string,
  { id: string; start: number; end: number; quote: string; page: string | null; events: { t: number; kind: string; detail: string }[] }[]
>;

function load(s: string) {
  const m = JSON.parse(fx(s, 'meta.json'));
  const meta: SessionMeta = {
    sessionId: s, rrwebStart: m.rrwebStart, audioStart: m.audioStart, audioMimeType: m.mime, userAgent: 'lab', url: '', endedAt: m.end,
  };
  const events = fx(s, 'events.ndjson').trim().split('\n').map((l) => JSON.parse(l));
  const tx = JSON.parse(fx(s, 'transcript.fw.json'));
  const words = tx.segments.flatMap((g: any) => g.words.map((w: any) => ({ text: w.w.trim(), startMs: Math.round(w.s * 1000), endMs: Math.round(w.e * 1000) })));
  const transcript: Transcript = { words, segments: [] };
  return { meta, events, transcript };
}

describe.each(['s2', 's3'])('buildMoments matches the lab alignment (%s)', (s) => {
  const { meta, events, transcript } = load(s);
  // the lab used [start - 1 s, end + 2 s]
  const moments = buildMoments(events, transcript, meta, { windowBeforeMs: 1000, windowAfterMs: 2000 });
  const expected = lab[s]!;

  it('finds the same moments, pages and time windows', () => {
    expect(moments.length).toBe(expected.length);
    moments.forEach((m, i) => {
      const e = expected[i]!;
      expect(m.page).toBe(e.page);
      expect(Math.abs(m.startMs / 1000 - e.start)).toBeLessThanOrEqual(0.06);
      expect(Math.abs(m.endMs / 1000 - e.end)).toBeLessThanOrEqual(0.06);
    });
  });

  it('names the same clicked elements', () => {
    moments.forEach((m, i) => {
      const labClicks = expected[i]!.events.filter((x) => x.kind === 'click').map((x) => /<([^>]+)>/.exec(x.detail)![1]);
      const ours = m.events.filter((x) => x.kind === 'click').map((x) => x.detail.split(' ')[0]);
      expect(ours).toEqual(labClicks);
    });
  });

  it('reports the same newly appeared text', () => {
    moments.forEach((m, i) => {
      const labText = expected[i]!.events.filter((x) => x.kind === 'dom_text_appeared').map((x) => x.detail);
      expect(m.events.filter((x) => x.kind === 'dom_text_appeared').map((x) => x.detail)).toEqual(labText);
    });
  });
});

describe('buildMoments details', () => {
  it('labels the save button with its text, and sees the error text', () => {
    const { meta, events, transcript } = load('s2');
    const all = buildMoments(events, transcript, meta, { windowBeforeMs: 1000, windowAfterMs: 2000 }).flatMap((m) => m.events);
    expect(all.some((e) => e.kind === 'click' && e.detail.startsWith('button#btn-save') && e.detail.includes('Save invoice'))).toBe(true);
    expect(all.some((e) => e.kind === 'dom_text_appeared' && e.detail.includes('invalid date'))).toBe(true);
  });
  it('accepts both nr:route and the legacy route tag', () => {
    const meta: SessionMeta = { sessionId: 'x', rrwebStart: 0, audioStart: 0, audioMimeType: null, userAgent: '', url: '', endedAt: 0 };
    const ev = [
      { type: 5, timestamp: 0, data: { tag: 'nr:route', payload: { href: 'http://a/notes' } } },
      { type: 5, timestamp: 2000, data: { tag: 'route', payload: { href: 'http://a/#/new' } } },
    ];
    const words = [{ text: 'Hello.', startMs: 100, endMs: 500 }, { text: 'Again.', startMs: 2100, endMs: 2500 }];
    const m = buildMoments(ev, { words, segments: [] }, meta);
    expect(m.map((x) => x.page)).toEqual(['/notes', '/new']);
  });
});
