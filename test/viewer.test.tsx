// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const players: any[] = [];
vi.mock('rrweb-player', () => ({
  default: class FakePlayer {
    listeners: Record<string, Array<(e: { payload: any }) => void>> = {};
    props: any;
    speed = 1;
    time = 0;
    gotos: Array<[number, boolean | undefined]> = [];
    constructor(o: { props: any }) { this.props = o.props; players.push(this); }
    addEventListener(ev: string, cb: (e: { payload: any }) => void) { (this.listeners[ev] ??= []).push(cb); }
    emit(ev: string, payload: any) { this.listeners[ev]?.forEach((cb) => cb({ payload })); }
    getReplayer() { const self = this; return { getCurrentTime: () => self.time, config: { get speed() { return self.speed; } } }; }
    goto(ms: number, play?: boolean) { this.gotos.push([ms, play]); this.time = ms; }
    $destroy() {}
  },
}));

import { SessionViewer } from '../src/viewer/index.js';

// jsdom does not implement media playback: model paused/currentTime/playbackRate.
const paused = new WeakMap<object, boolean>();
beforeEach(() => {
  players.length = 0;
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return paused.get(this) ?? true; } });
  HTMLMediaElement.prototype.play = function () { paused.set(this, false); return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () { paused.set(this, true); };
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let ready: any;
const meta = { sessionId: 's', rrwebStart: 1000, audioStart: 1100, audioMimeType: 'audio/webm', userAgent: 'u', url: 'http://x', endedAt: 9000 };
const events = [{ type: 4, timestamp: 1000, data: {} }];

async function mount(items: any[] = []) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(SessionViewer, { meta, events, audioUrl: '/a.webm', items, onReady: (a) => { ready = a; } }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return players[0];
}
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('viewer (review findings)', () => {
  it('turns skipInactive off so narration is not treated as inactivity', async () => {
    const p = await mount();
    expect(p.props.skipInactive).toBe(false);
  });

  it('starts audio when replay time crosses the audio offset (100 ms)', async () => {
    const p = await mount();
    p.emit('ui-update-player-state', 'playing');
    p.emit('ui-update-current-time', 50);
    expect(ready.audio.paused).toBe(true);
    p.emit('ui-update-current-time', 1000);
    expect(ready.audio.paused).toBe(false);
  });

  it('keeps audio.playbackRate equal to the replay speed', async () => {
    const p = await mount();
    p.emit('ui-update-player-state', 'playing');
    for (const s of [2, 4, 8, 1]) {
      p.speed = s;
      p.emit('ui-update-current-time', 2000);
      expect(ready.audio.playbackRate).toBe(s);
    }
  });

  it('has no native audio controls and pauses audio when the replay pauses', async () => {
    const p = await mount();
    expect(host.querySelector('audio')!.hasAttribute('controls')).toBe(false);
    p.emit('ui-update-player-state', 'playing');
    p.emit('ui-update-current-time', 1000);
    expect(ready.audio.paused).toBe(false);
    p.emit('ui-update-player-state', 'paused');
    expect(ready.audio.paused).toBe(true);
  });

  it('item seeks go through the replay player and keep its play state', async () => {
    const p = await mount();
    p.emit('ui-update-player-state', 'playing');
    ready.seekToAudioMs(3000);
    expect(p.gotos.at(-1)).toEqual([3100, true]);
    expect(ready.audio.currentTime).toBeCloseTo(3, 3);
  });
});
