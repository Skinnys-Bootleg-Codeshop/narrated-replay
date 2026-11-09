// @vitest-environment jsdom
import { createElement, act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeRec { state: string; started: boolean; stopped: number; resolveStart: () => void; listeners: Record<string, Array<(a?: unknown) => void>> }
const recs: FakeRec[] = [];
vi.mock('../src/recorder/index.js', () => ({
  createRecorder: () => {
    const r: FakeRec = { state: 'idle', started: false, stopped: 0, resolveStart: () => {}, listeners: {} };
    recs.push(r);
    return {
      get state() { return r.state; },
      sessionId: null,
      start: () => new Promise<void>((res) => {
        r.started = true;
        r.resolveStart = () => { r.state = 'recording'; r.listeners.state?.forEach((cb) => cb('recording')); res(); };
      }),
      stop: async () => { r.stopped++; r.state = 'idle'; r.listeners.state?.forEach((cb) => cb('idle')); return {} as never; },
      on(ev: string, cb: (a?: unknown) => void) { (r.listeners[ev] ??= []).push(cb); return () => {}; },
    };
  },
}));
vi.mock('../src/recorder/uploader.js', () => ({ httpUploader: () => ({}) }));

import { TalkButton } from '../src/react/index.js';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  recs.length = 0;
  localStorage.setItem('narrated-replay:consent', 'accepted');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = (n: ReactNode) => act(() => root.render(n));
const talk = () => host.querySelector('[data-testid="nr-talk"]') as HTMLButtonElement;

describe('TalkButton start guard (finding: two quick clicks start two recorders)', () => {
  it('ignores a second click while a start is pending and disables the button', async () => {
    render(createElement(TalkButton, { options: { endpoint: '/x' } }));
    await act(async () => { talk().click(); });
    expect(talk().disabled).toBe(true);
    await act(async () => { talk().click(); });
    expect(recs.length).toBe(1);
    await act(async () => { recs[0]!.resolveStart(); });
    expect(host.querySelector('[data-testid="nr-stop"]')).not.toBeNull();
  });
});

describe('TalkButton unmount during pending start (finding: recording starts after unmount)', () => {
  it('stops a recorder that becomes active after unmount', async () => {
    render(createElement(TalkButton, { options: { endpoint: '/x' } }));
    await act(async () => { talk().click(); });
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => { recs[0]!.resolveStart(); });
    expect(recs[0]!.stopped).toBe(1);
  });
});
