import { mkdir, readFile, readdir, writeFile, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { CHUNK_KINDS, SessionMetaSchema, UUID_V4, type ChunkKind, type SessionMeta } from '../shared/types.js';

export class ValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface SessionData {
  meta: SessionMeta;
  events: unknown[];
  audio: Uint8Array;
}

export interface Store {
  putChunk(sessionId: string, kind: Exclude<ChunkKind, 'meta'>, seq: number, data: Uint8Array): Promise<void>;
  putMeta(meta: SessionMeta): Promise<void>;
  readSession(sessionId: string): Promise<SessionData>;
  listSessions(): Promise<string[]>;
  readJson<T = unknown>(name: string): Promise<T | null>;
  writeJson(name: string, value: unknown): Promise<void>;
  writeFile(sessionId: string, name: string, data: Uint8Array | string): Promise<void>;
  readFile(sessionId: string, name: string): Promise<Uint8Array | null>;
  /** Delete everything stored for one session (chunks, meta, analysis files). Does not touch themes.json: see forgetSession. */
  deleteSession(sessionId: string): Promise<void>;
}

export function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID_V4.test(id)) throw new ValidationError('session id must be a UUID v4');
}
export function assertKind(kind: unknown): asserts kind is ChunkKind {
  if (typeof kind !== 'string' || !(CHUNK_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError('kind must be events, audio or meta');
  }
}
export function parseSeq(seq: unknown): number {
  if (typeof seq !== 'string' && typeof seq !== 'number') throw new ValidationError('seq must be an integer 0-100000');
  const s = String(seq);
  if (!/^\d{1,6}$/.test(s)) throw new ValidationError('seq must be an integer 0-100000');
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new ValidationError('seq must be an integer 0-100000');
  return n;
}
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
export function assertName(name: string): void {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new ValidationError('invalid file name');
  }
}

const pad = (n: number) => String(n).padStart(6, '0');

/** Files on disk: <root>/<sessionId>/{events,audio}/<seq>, meta.json, plus derived files. */
export function createFileStore(rootDir: string): Store {
  const root = path.resolve(rootDir);
  const under = (...parts: string[]) => {
    const p = path.resolve(root, ...parts);
    if (p !== root && !p.startsWith(root + path.sep)) throw new ValidationError('path escapes store root');
    return p;
  };

  return {
    async putChunk(id, kind, seq, data) {
      assertSessionId(id);
      assertKind(kind);
      if ((kind as string) === 'meta') throw new ValidationError('use putMeta');
      const n = parseSeq(seq);
      const dir = under(id, kind);
      await mkdir(dir, { recursive: true });
      await writeFile(under(id, kind, pad(n)), data);
    },
    async putMeta(meta) {
      assertSessionId(meta.sessionId);
      const parsed = SessionMetaSchema.parse(meta);
      await mkdir(under(meta.sessionId), { recursive: true });
      await writeFile(under(meta.sessionId, 'meta.json'), JSON.stringify(parsed, null, 2));
    },
    async readSession(id) {
      assertSessionId(id);
      const meta = SessionMetaSchema.parse(JSON.parse(await readFile(under(id, 'meta.json'), 'utf8')));
      const read = async (kind: 'events' | 'audio') => {
        const dir = under(id, kind);
        let names: string[] = [];
        try { names = (await readdir(dir)).filter((f) => /^\d{6}$/.test(f)).sort(); } catch { /* none */ }
        return Promise.all(names.map((f) => readFile(under(id, kind, f))));
      };
      const eventChunks = await read('events');
      const events = eventChunks.flatMap((b) => JSON.parse(b.toString('utf8')) as unknown[]);
      const audio = Buffer.concat(await read('audio'));
      return { meta, events, audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength) };
    },
    async listSessions() {
      let names: string[] = [];
      try { names = await readdir(root); } catch { return []; }
      const out: { id: string; t: number }[] = [];
      for (const n of names) {
        if (!UUID_V4.test(n)) continue;
        try {
          const s = await stat(under(n, 'meta.json'));
          out.push({ id: n, t: s.mtimeMs });
        } catch { /* incomplete session */ }
      }
      return out.sort((a, b) => b.t - a.t).map((x) => x.id);
    },
    async readJson(name) {
      assertName(name);
      let text: string;
      try { text = await readFile(under(name), 'utf8'); }
      catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
      }
      // A malformed file throws: callers must not treat it as an empty catalogue and overwrite it.
      try { return JSON.parse(text); }
      catch (e) { throw new Error(`narrated-replay: ${name} is not valid JSON (${(e as Error).message}); fix or remove it`); }
    },
    async writeJson(name, value) {
      assertName(name);
      await mkdir(root, { recursive: true });
      // Write to a temp file in the same directory, then rename: readers never see a half-written file.
      const dest = under(name);
      const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(value, null, 2));
        await rename(tmp, dest);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async writeFile(id, name, data) {
      assertSessionId(id);
      assertName(name);
      await mkdir(under(id), { recursive: true });
      await writeFile(under(id, name), data);
    },
    async readFile(id, name) {
      assertSessionId(id);
      assertName(name);
      try { return new Uint8Array(await readFile(under(id, name))); } catch { return null; }
    },
    async deleteSession(id) {
      assertSessionId(id);
      await rm(under(id), { recursive: true, force: true });
    },
  };
}

export interface S3LikeClient { send(command: unknown): Promise<any> }

/** S3 store. Needs the optional peer dependency @aws-sdk/client-s3 unless you pass your own `client`. */
export function createS3Store(opts: { bucket: string; prefix?: string; client?: S3LikeClient }): Store {
  const prefix = (opts.prefix ?? 'narrated-replay/').replace(/^\/+/, '').replace(/([^/])$/, '$1/');
  let sdk: any;
  const getSdk = async () => {
    if (!sdk) {
      try { sdk = await import('@aws-sdk/client-s3' as string); }
      catch { throw new Error('narrated-replay: install @aws-sdk/client-s3 to use createS3Store'); }
    }
    return sdk;
  };
  let client = opts.client;
  const send = async (cmd: (s: any) => unknown) => {
    const s = await getSdk().catch((e) => { if (opts.client) return null; throw e; });
    client ??= new s.S3Client({});
    return client!.send(cmd(s ?? {}));
  };
  const key = (...p: string[]) => prefix + p.join('/');
  const put = (k: string, body: Uint8Array | string, type?: string) =>
    send((s) => new (s.PutObjectCommand ?? Cmd)({ Bucket: opts.bucket, Key: k, Body: body, ContentType: type }));
  const get = async (k: string): Promise<Uint8Array | null> => {
    try {
      const r = await send((s) => new (s.GetObjectCommand ?? Cmd)({ Bucket: opts.bucket, Key: k }));
      return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : null;
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  };
  const list = async (p: string): Promise<string[]> => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await send((s) => new (s.ListObjectsV2Command ?? Cmd)({ Bucket: opts.bucket, Prefix: p, ContinuationToken: token }));
      for (const o of r.Contents ?? []) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys;
  };

  return {
    async putChunk(id, kind, seq, data) {
      assertSessionId(id); assertKind(kind);
      if ((kind as string) === 'meta') throw new ValidationError('use putMeta');
      await put(key(id, kind, pad(parseSeq(seq))), data);
    },
    async putMeta(meta) {
      assertSessionId(meta.sessionId);
      await put(key(meta.sessionId, 'meta.json'), JSON.stringify(SessionMetaSchema.parse(meta)), 'application/json');
    },
    async readSession(id) {
      assertSessionId(id);
      const m = await get(key(id, 'meta.json'));
      if (!m) throw new Error(`session ${id} has no meta.json`);
      const meta = SessionMetaSchema.parse(JSON.parse(Buffer.from(m).toString('utf8')));
      const read = async (kind: string) => {
        const keys = (await list(key(id, kind) + '/')).sort();
        return Promise.all(keys.map(async (k) => Buffer.from((await get(k)) ?? new Uint8Array())));
      };
      const events = (await read('events')).flatMap((b) => JSON.parse(b.toString('utf8')) as unknown[]);
      const audio = Buffer.concat(await read('audio'));
      return { meta, events, audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength) };
    },
    async listSessions() {
      const keys = await list(prefix);
      const ids = new Set<string>();
      for (const k of keys) {
        const id = k.slice(prefix.length).split('/')[0]!;
        if (UUID_V4.test(id) && k.endsWith('/meta.json')) ids.add(id);
      }
      return [...ids];
    },
    async readJson(name) {
      assertName(name);
      const b = await get(key(name));
      return b ? JSON.parse(Buffer.from(b).toString('utf8')) : null;
    },
    async writeJson(name, value) {
      assertName(name);
      await put(key(name), JSON.stringify(value, null, 2), 'application/json');
    },
    async writeFile(id, name, data) {
      assertSessionId(id); assertName(name);
      await put(key(id, name), data);
    },
    async readFile(id, name) {
      assertSessionId(id); assertName(name);
      return get(key(id, name));
    },
    async deleteSession(id) {
      assertSessionId(id);
      for (const k of await list(key(id) + '/')) {
        await send((s) => new (s.DeleteObjectCommand ?? Cmd)({ Bucket: opts.bucket, Key: k }));
      }
    },
  };
}

/** Fallback command class so a mock client can see plain command objects in tests. */
class Cmd {
  constructor(readonly input: Record<string, unknown>) {}
}
