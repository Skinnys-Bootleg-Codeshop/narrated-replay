import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createFileStore } from '../server/store.js';
import { createIngestHandler } from '../server/ingest.js';
import { forgetSession } from '../server/forget.js';
import { analyzeSession } from '../server/triage.js';
import { anthropic } from '../server/llm/anthropic.js';
import { bedrock } from '../server/llm/bedrock.js';
import { claudeCli } from '../server/llm/claude-cli.js';
import { fasterWhisper } from '../server/transcribe/faster-whisper.js';
import { openaiTranscribe } from '../server/transcribe/openai.js';
import { awsTranscribe } from '../server/transcribe/aws.js';
import type { Llm } from '../server/llm/types.js';
import type { Transcriber } from '../server/transcribe/types.js';

const USAGE = `narrated-replay (AI-generated, not reviewed by a human)

Usage:
  narrated-replay analyze --store DIR (--session ID | --all)
      --transcriber faster-whisper|openai|aws --llm claude-cli|anthropic|bedrock
      [--model M] [--extraction session|moment] [--product-context FILE]
      [--python PATH] [--aws-bucket B] [--aws-region R] [--force]
  narrated-replay serve --store DIR [--port 4319]
  narrated-replay forget --store DIR --session ID
      Delete a session and remove its quotes and counts from themes.json.

With --all, sessions already analysed are skipped unless --force is given.
Exit codes: 0 ok, 1 analysis failure, 2 bad arguments.`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === '--help' || cmd === '-h') {
      console.log(USAGE);
      return cmd ? 0 : 2;
    }
    if (cmd === 'analyze') return await analyze(rest);
    if (cmd === 'serve') return await serve(rest);
    if (cmd === 'forget') return await forget(rest);
    throw new UsageError(`unknown command: ${cmd}`);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function parse(args: string[], options: Record<string, { type: 'string' | 'boolean' }>) {
  try {
    return parseArgs({ args, options, allowPositionals: false }).values as Record<string, string | undefined> & {
      all?: boolean;
    };
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

async function analyze(args: string[]): Promise<number> {
  const v = parse(args, {
    store: { type: 'string' }, session: { type: 'string' }, all: { type: 'boolean' },
    transcriber: { type: 'string' }, llm: { type: 'string' }, model: { type: 'string' },
    extraction: { type: 'string' }, 'product-context': { type: 'string' }, python: { type: 'string' },
    'aws-bucket': { type: 'string' }, 'aws-region': { type: 'string' }, force: { type: 'boolean' },
  });
  if (!v.store) throw new UsageError('--store is required');
  if (!v.session && !v.all) throw new UsageError('give --session ID or --all');
  if (v.session && v.all) throw new UsageError('--session and --all are exclusive');
  const extraction = (v.extraction ?? 'session') as string;
  if (extraction !== 'session' && extraction !== 'moment') throw new UsageError('--extraction must be session or moment');

  let transcriber: Transcriber;
  switch (v.transcriber) {
    case 'faster-whisper': transcriber = fasterWhisper({ python: v.python }); break;
    case 'openai': transcriber = openaiTranscribe(); break;
    case 'aws':
      if (!v['aws-bucket']) throw new UsageError('--aws-bucket is required for --transcriber aws');
      transcriber = awsTranscribe({ bucket: v['aws-bucket'], region: v['aws-region'] });
      break;
    default: throw new UsageError('--transcriber must be faster-whisper, openai or aws');
  }
  let llm: Llm;
  switch (v.llm) {
    case 'claude-cli': llm = claudeCli({ model: v.model }); break;
    case 'anthropic': llm = anthropic({ model: v.model }); break;
    case 'bedrock': llm = bedrock({ model: v.model, region: v['aws-region'] ?? process.env.AWS_REGION ?? 'us-east-1' }); break;
    default: throw new UsageError('--llm must be claude-cli, anthropic or bedrock');
  }
  const productContext = v['product-context'] ? await readFile(v['product-context'], 'utf8') : undefined;

  const store = createFileStore(v.store);
  const ids = v.all ? await store.listSessions() : [v.session!];
  let failed = 0;
  for (const id of ids) {
    try {
      if (v.all && !v.force) {
        // A scheduled `--all` must not re-transcribe and re-send every old session to the LLM each time.
        const raw = await store.readFile(id, 'analysis.json');
        let done = false;
        try { done = !!raw && JSON.parse(Buffer.from(raw).toString('utf8')).status === 'ok'; } catch { /* unreadable: analyse again */ }
        if (done) {
          console.log(`${id}: already analysed, skipped (use --force to redo)`);
          continue;
        }
      }
      const r = await analyzeSession({ store, sessionId: id, transcriber, llm, extraction, productContext });
      console.log(`${id}: ${r.items.length} items, ${r.themes.length} themes total${r.seekable ? '' : ' (audio not seekable: ffmpeg missing or failed)'}`);
    } catch (e) {
      failed++;
      console.error(`${id}: analysis failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed ? 1 : 0;
}

async function forget(args: string[]): Promise<number> {
  const v = parse(args, { store: { type: 'string' }, session: { type: 'string' } });
  if (!v.store) throw new UsageError('--store is required');
  if (!v.session) throw new UsageError('--session is required');
  const r = await forgetSession({ store: createFileStore(v.store), sessionId: v.session });
  console.log(`${v.session}: deleted; removed ${r.removedItems} items from themes.json, dropped ${r.removedThemes} empty themes`);
  return 0;
}

async function serve(args: string[]): Promise<number> {
  const v = parse(args, { store: { type: 'string' }, port: { type: 'string' } });
  if (!v.store) throw new UsageError('--store is required');
  const port = Number(v.port ?? 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--port must be 1-65535');
  const store = createFileStore(v.store);
  // Unauthenticated on purpose: bound to loopback only, for local development.
  const handler = createIngestHandler({ store, allowUnauthenticated: true });
  const MAX_BODY = 5 * 1024 * 1024;
  const localOrigin = (o: string | undefined) => {
    try { return !!o && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(o).hostname); } catch { return false; }
  };
  const server = createServer(async (req, res) => {
    try {
      // Only pages served from this machine may talk to the local ingest.
      const origin = req.headers.origin;
      if (origin && !localOrigin(origin)) { res.writeHead(403).end(); return; }
      const cors: Record<string, string> = origin
        ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' }
        : {};
      if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/sessions') {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(await store.listSessions()));
        return;
      }
      if (req.method !== 'POST') { res.writeHead(404, cors).end(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) { res.writeHead(413, cors).end(); req.destroy(); return; }
        chunks.push(c as Buffer);
      }
      const r = await handler(new Request(url, { method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }));
      res.writeHead(r.status, { ...cors, 'content-type': 'application/json' }).end(await r.text());
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.on('clientError', (_e, socket) => socket.destroy());
  await new Promise<void>((res) => server.listen(port, '127.0.0.1', res));
  console.log(`narrated-replay serve: http://127.0.0.1:${port} (store ${v.store}, loopback only, no auth)`);
  return await new Promise<number>(() => undefined);
}
