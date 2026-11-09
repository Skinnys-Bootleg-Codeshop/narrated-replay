import type { SessionMeta } from '../shared/types.js';
import { defaultMaskInput } from './mask.js';
import { trackRoutes } from './routes.js';
import type { Uploader } from './uploader.js';

export { shapeMask, defaultMaskInput } from './mask.js';
export { httpUploader } from './uploader.js';
export type { Uploader, HttpUploaderOptions } from './uploader.js';
export { trackRoutes } from './routes.js';
export type { SessionMeta } from '../shared/types.js';

export type RecorderState = 'idle' | 'recording' | 'stopping' | 'error';

export interface RecorderOptions {
  uploader: Uploader;
  chunkMs?: number;
  audio?: { bitsPerSecond?: number; mimeTypes?: string[] } | false;
  /** Extra options merged into rrweb's record(). `emit` and `maskInputFn` are set by the recorder. */
  rrweb?: Record<string, unknown>;
  maskInput?: (text: string, el?: HTMLElement) => string;
  captureConsoleErrors?: boolean;
  appMetadata?: Record<string, string>;
  continueWithoutAudio?: boolean;
}

type Listener = (arg?: unknown) => void;

export interface Recorder {
  start(): Promise<void>;
  stop(): Promise<SessionMeta>;
  readonly state: RecorderState;
  readonly sessionId: string | null;
  on(event: 'state' | 'error' | 'mic-denied', cb: Listener): () => void;
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const chunkMs = opts.chunkMs ?? 5000;
  let state: RecorderState = 'idle';
  let sessionId: string | null = null;
  const listeners: Record<string, Set<Listener>> = { state: new Set(), error: new Set(), 'mic-denied': new Set() };
  const emit = (ev: string, arg?: unknown) => listeners[ev]?.forEach((cb) => cb(arg));
  const setState = (s: RecorderState) => {
    state = s;
    emit('state', s);
  };

  let events: unknown[] = [];
  let eventSeq = 0;
  let audioSeq = 0;
  const pending: Promise<unknown>[] = [];
  let stopRrweb: (() => void) | undefined;
  let restoreRoutes: (() => void) | undefined;
  let restoreConsole: (() => void) | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let mr: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let rrwebStart = 0;
  let audioStart: number | null = null;
  let audioMime: string | null = null;
  let onPageHide: (() => void) | undefined;
  let uploadError: unknown;

  const track = (p: Promise<void>) => {
    const q = p.catch((e) => {
      uploadError = e;
      emit('error', e);
    });
    pending.push(q);
  };

  const MAX_EVENT_CHUNK_CHARS = 3_000_000; // well under the ingest default of 5 MB
  const flushEvents = () => {
    if (!events.length || !sessionId) return;
    const all = events;
    events = [];
    // Greedy split so one big flush (e.g. after a long pause) does not exceed the server's chunk limit.
    // A single event bigger than the limit still goes alone and may be rejected.
    let batch: string[] = [];
    let size = 2;
    const send = () => {
      if (!batch.length) return;
      track(opts.uploader.put(sessionId!, 'events', eventSeq++, `[${batch.join(',')}]`));
      batch = [];
      size = 2;
    };
    for (const e of all) {
      const j = JSON.stringify(e);
      if (batch.length && size + j.length + 1 > MAX_EVENT_CHUNK_CHARS) send();
      batch.push(j);
      size += j.length + 1;
    }
    send();
  };

  async function start() {
    if (state === 'recording' || state === 'stopping') throw new Error(`narrated-replay: cannot start while ${state}`);
    sessionId = crypto.randomUUID();
    events = [];
    eventSeq = 0;
    audioSeq = 0;
    audioStart = null;
    audioMime = null;
    uploadError = undefined;
    try {
      // 1. Microphone first, so a denial costs nothing.
      if (opts.audio !== false) {
        try {
          if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
            throw new Error('MediaRecorder is not supported in this browser');
          }
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
          emit('mic-denied', e);
          if (!opts.continueWithoutAudio) {
            setState('error');
            throw e;
          }
          stream = null;
        }
      }

      // 2. rrweb, on the shared Date.now() clock.
      const { record } = await import('rrweb');
      const maskInput = opts.maskInput ?? defaultMaskInput;
      rrwebStart = Date.now();
      const stop = record({
        ...(opts.rrweb ?? {}),
        emit: (e: unknown) => {
          events.push(e);
        },
        // maskAllInputs routes every input through maskInputFn (shape only; passwords fully masked).
        maskAllInputs: true,
        maskInputFn: (text: string, el: HTMLElement) =>
          maskInput(text, el),
      } as never);
      stopRrweb = stop ?? undefined;
      restoreRoutes = trackRoutes((tag, payload) => record.addCustomEvent(tag, payload));
      if (opts.captureConsoleErrors !== false) restoreConsole = captureConsole((p) => record.addCustomEvent('nr:error', p));

      // 3. Audio. audioStart is read in the MediaRecorder 'start' event, not before.
      if (stream) {
        const types = opts.audio && opts.audio.mimeTypes ? opts.audio.mimeTypes : ['audio/webm;codecs=opus', 'audio/mp4'];
        const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
        mr = new MediaRecorder(stream, {
          ...(mime ? { mimeType: mime } : {}),
          audioBitsPerSecond: (opts.audio && opts.audio.bitsPerSecond) || 32000,
        });
        audioMime = mr.mimeType || mime || null;
        mr.addEventListener('dataavailable', (e: BlobEvent) => {
          if (e.data.size && sessionId) track(opts.uploader.put(sessionId, 'audio', audioSeq++, e.data));
        });
        const started = new Promise<void>((res) => {
          mr!.addEventListener('start', () => {
            audioStart = Date.now();
            res();
          });
        });
        mr.start(chunkMs);
        await started;
      }

      flushTimer = setInterval(flushEvents, chunkMs);
      onPageHide = () => {
        if (!events.length || !sessionId || !opts.uploader.beacon) return;
        if (opts.uploader.beacon(sessionId, 'events', eventSeq, JSON.stringify(events))) {
          eventSeq++;
          events = [];
        }
      };
      addEventListener('pagehide', onPageHide);
      setState('recording');
    } catch (e) {
      cleanup();
      if (state !== 'error') setState('error');
      emit('error', e);
      throw e;
    }
  }

  function cleanup() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = undefined;
    try { stopRrweb?.(); } catch { /* ignore */ }
    stopRrweb = undefined;
    restoreRoutes?.();
    restoreRoutes = undefined;
    restoreConsole?.();
    restoreConsole = undefined;
    if (onPageHide) removeEventListener('pagehide', onPageHide);
    onPageHide = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function stop(): Promise<SessionMeta> {
    if (state !== 'recording' || !sessionId) throw new Error(`narrated-replay: cannot stop while ${state}`);
    setState('stopping');
    try {
      if (mr && mr.state !== 'inactive') {
        const stopped = new Promise<void>((res) => mr!.addEventListener('stop', () => res(), { once: true }));
        mr.stop();
        await stopped; // final dataavailable fires before stop
      }
      mr = null;
      cleanup();
      flushEvents();
      await Promise.all(pending);
      if (uploadError) throw uploadError;
      const meta: SessionMeta = {
        sessionId,
        rrwebStart,
        audioStart,
        audioMimeType: audioStart === null ? null : audioMime,
        userAgent: navigator.userAgent,
        url: location.href,
        ...(opts.appMetadata ? { appMetadata: opts.appMetadata } : {}),
        endedAt: Date.now(),
      };
      await opts.uploader.finish(meta);
      setState('idle');
      return meta;
    } catch (e) {
      setState('error');
      emit('error', e);
      throw e;
    }
  }

  return {
    start,
    stop,
    get state() { return state; },
    get sessionId() { return sessionId; },
    on(event, cb) {
      listeners[event]!.add(cb);
      return () => listeners[event]!.delete(cb);
    },
  };
}

function captureConsole(report: (p: { level: string; message: string }) => void): () => void {
  const orig = { error: console.error, warn: console.warn };
  const wrap = (level: 'error' | 'warn') => (...args: unknown[]) => {
    try { report({ level, message: args.map(String).join(' ').slice(0, 500) }); } catch { /* ignore */ }
    orig[level].apply(console, args as never);
  };
  console.error = wrap('error');
  console.warn = wrap('warn');
  const onErr = (e: ErrorEvent) => report({ level: 'error', message: String(e.message).slice(0, 500) });
  addEventListener('error', onErr);
  return () => {
    console.error = orig.error;
    console.warn = orig.warn;
    removeEventListener('error', onErr);
  };
}
