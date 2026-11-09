import type { ChunkKind, SessionMeta } from '../shared/types.js';

export interface Uploader {
  put(sessionId: string, kind: Exclude<ChunkKind, 'meta'>, seq: number, body: Blob | string): Promise<void>;
  finish(meta: SessionMeta): Promise<void>;
  /** Best effort synchronous-ish send used on pagehide. */
  beacon?(sessionId: string, kind: Exclude<ChunkKind, 'meta'>, seq: number, body: string): boolean;
}

export interface HttpUploaderOptions {
  endpoint: string;
  headers?: Record<string, string> | (() => Record<string, string>);
  retries?: number;
  fetch?: typeof fetch;
}

export function httpUploader(opts: HttpUploaderOptions): Uploader {
  const base = opts.endpoint.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const retries = opts.retries ?? 3;
  const headers = () => (typeof opts.headers === 'function' ? opts.headers() : opts.headers ?? {});

  async function post(path: string, body: Blob | string, contentType: string) {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(`${base}${path}`, {
          method: 'POST',
          body,
          headers: { 'content-type': contentType, ...headers() },
          keepalive: false,
        });
        if (res.ok) return;
        // 4xx will not get better by retrying (except 408/429)
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw new Error(`narrated-replay upload rejected: ${res.status}`);
        }
        lastErr = new Error(`narrated-replay upload failed: ${res.status}`);
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && e.message.includes('rejected')) throw e;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
    }
    throw lastErr;
  }

  return {
    put: (id, kind, seq, body) =>
      post(`/sessions/${id}/${kind}/${seq}`, body, kind === 'events' ? 'application/json' : 'application/octet-stream'),
    finish: (meta) => post(`/sessions/${meta.sessionId}/meta/0`, JSON.stringify(meta), 'application/json'),
    beacon: (id, kind, seq, body) => {
      if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
      return navigator.sendBeacon(`${base}/sessions/${id}/${kind}/${seq}`, new Blob([body], { type: 'application/json' }));
    },
  };
}
