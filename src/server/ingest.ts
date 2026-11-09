import { SessionMetaSchema } from '../shared/types.js';
import { ValidationError, assertKind, assertSessionId, parseSeq, type Store } from './store.js';

export interface IngestOptions {
  store: Store;
  /** Return true to allow the request. Required unless allowUnauthenticated is true. */
  authorize?: (req: Request) => boolean | Promise<boolean>;
  allowUnauthenticated?: boolean;
  maxChunkBytes?: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createIngestHandler(opts: IngestOptions): (req: Request) => Promise<Response> {
  if (!opts.authorize && opts.allowUnauthenticated !== true) {
    throw new Error(
      'narrated-replay: createIngestHandler needs an authorize(req) function, or allowUnauthenticated: true (local development only).',
    );
  }
  const max = opts.maxChunkBytes ?? 5 * 1024 * 1024;

  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    if (opts.authorize) {
      let ok = false;
      try { ok = (await opts.authorize(req)) === true; } catch { ok = false; }
      if (!ok) return json(401, { error: 'unauthorized' });
    }
    try {
      // Path suffix: /sessions/:id/:kind/:seq  (segments are untrusted; validated before any use)
      const parts = new URL(req.url).pathname.split('/').filter((p) => p !== '');
      const i = parts.lastIndexOf('sessions');
      if (i < 0 || parts.length - i !== 4) throw new ValidationError('expected /sessions/:id/:kind/:seq');
      const [rawId, rawKind, rawSeq] = parts.slice(i + 1).map((p) => {
        try { return decodeURIComponent(p); } catch { throw new ValidationError('bad path encoding'); }
      }) as [string, string, string];
      assertSessionId(rawId);
      assertKind(rawKind);
      const seq = parseSeq(rawSeq);

      const declared = Number(req.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > max) return json(413, { error: 'chunk too large' });
      const body = await readLimited(req, max);
      if (body === null) return json(413, { error: 'chunk too large' });

      if (rawKind === 'meta') {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(body).toString('utf8')); } catch { throw new ValidationError('meta must be JSON'); }
        const r = SessionMetaSchema.safeParse(parsed);
        if (!r.success) throw new ValidationError('invalid meta');
        if (r.data.sessionId !== rawId) throw new ValidationError('meta sessionId does not match path');
        await opts.store.putMeta(r.data);
      } else if (rawKind === 'events') {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(body).toString('utf8')); } catch { throw new ValidationError('events chunk must be a JSON array'); }
        if (!Array.isArray(parsed)) throw new ValidationError('events chunk must be a JSON array');
        await opts.store.putChunk(rawId, 'events', seq, body);
      } else {
        await opts.store.putChunk(rawId, 'audio', seq, body);
      }
      return json(200, { ok: true });
    } catch (e) {
      if (e instanceof ValidationError) return json(e.status, { error: e.message });
      return json(500, { error: 'internal error' });
    }
  };
}

async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** For Next.js App Router: `export const { POST } = toNextRouteHandlers(handler)`. */
export function toNextRouteHandlers(handler: (req: Request) => Promise<Response>) {
  return { POST: (req: Request) => handler(req) };
}
