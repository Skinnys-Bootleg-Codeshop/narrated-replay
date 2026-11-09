import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extensionFor } from '../audio.js';
import { segmentsFromWords, type Transcriber } from './types.js';

const run = promisify(execFile);

/** dist/server/... and src/server/transcribe/... both sit two levels or more below the package root. */
function scriptPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'python', 'transcribe_fw.py');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('narrated-replay: python/transcribe_fw.py not found');
}

export interface FasterWhisperOptions {
  python?: string;
  model?: string;
}

/** Local transcription. Needs Python with faster-whisper and numpy installed, and ffmpeg on PATH. */
export function fasterWhisper(opts: FasterWhisperOptions = {}): Transcriber {
  const python = opts.python ?? process.env.NARRATED_REPLAY_PYTHON ?? 'python3';
  const model = opts.model ?? 'small.en';
  return {
    async transcribe(audio, mime) {
      const dir = await mkdtemp(path.join(tmpdir(), 'nr-tx-'));
      try {
        const file = path.join(dir, `audio.${extensionFor(mime)}`);
        await writeFile(file, audio);
        const { stdout } = await run(python, [scriptPath(), file, model], { maxBuffer: 64 * 1024 * 1024 });
        const parsed = JSON.parse(stdout) as {
          segments: { start: number; end: number; text: string; words: { w: string; s: number; e: number }[] }[];
        };
        const words = parsed.segments.flatMap((g) =>
          g.words.map((w) => ({ text: w.w.trim(), startMs: Math.round(w.s * 1000), endMs: Math.round(w.e * 1000) })),
        );
        return { words, segments: segmentsFromWords(words) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
