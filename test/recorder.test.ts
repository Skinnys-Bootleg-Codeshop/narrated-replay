// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshot } from 'rrweb-snapshot';
import { MASK_ALL_INPUT_TYPES, defaultMaskInput } from '../src/recorder/mask.js';

const custom: Array<[string, unknown]> = [];
let emitFn: (e: unknown) => void = () => {};
vi.mock('rrweb', () => {
  const record: any = (o: { emit: (e: unknown) => void }) => {
    emitFn = o.emit;
    return () => {};
  };
  record.addCustomEvent = (tag: string, payload: unknown) => {
    custom.push([tag, payload]);
    emitFn({ type: 5, timestamp: Date.now(), data: { tag, payload } });
  };
  return { record };
});

afterEach(() => { custom.length = 0; });

describe('hidden input masking (finding: maskAllInputs leaves hidden inputs)', () => {
  it('masks a CSRF-style hidden input in a real snapshot', () => {
    document.body.innerHTML =
      '<form><input type="hidden" name="csrf" value="tok-ABC123-secret"><input type="text" value="2026-11-09"></form>';
    const node: any = snapshot(document, {
      maskAllInputs: { ...MASK_ALL_INPUT_TYPES } as never,
      maskInputFn: (t: string, el: any) => defaultMaskInput(t, el),
    });
    const json = JSON.stringify(node);
    expect(json).not.toContain('tok-ABC123-secret');
    expect(json).toContain('*'.repeat('tok-ABC123-secret'.length));
    expect(json).toContain('9999-99-99');
  });
  it('defaultMaskInput fully masks hidden inputs', () => {
    expect(defaultMaskInput('abc123', { type: 'hidden' })).toBe('******');
  });
});

describe('recorder stop marker (finding: no completion event)', () => {
  it('appends nr:stop before the final flush', async () => {
    const { createRecorder } = await import('../src/recorder/index.js');
    const sent: Array<{ kind: string; body: string }> = [];
    const rec = createRecorder({
      audio: false,
      captureConsoleErrors: false,
      uploader: {
        put: async (_id, kind, _seq, body) => { sent.push({ kind, body: String(body) }); },
        finish: async () => {},
      },
    });
    await rec.start();
    await rec.stop();
    const all = sent.filter((s) => s.kind === 'events').flatMap((s) => JSON.parse(s.body) as any[]);
    const last = all[all.length - 1];
    expect(last.data.tag).toBe('nr:stop');
    expect(typeof last.data.payload.at).toBe('number');
  });
});
