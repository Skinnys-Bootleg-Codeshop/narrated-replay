import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function extensionFor(mime: string | null): string {
  if (mime?.includes('mp4')) return 'm4a';
  if (mime?.includes('ogg')) return 'ogg';
  return 'webm';
}

/** Concatenate audio chunks, then remux with ffmpeg (`-c copy`) so the file has a duration and is seekable. */
export async function concatAndRemux(
  chunks: Uint8Array | Uint8Array[],
  mime: string | null,
): Promise<{ data: Uint8Array; seekable: boolean }> {
  const data = Array.isArray(chunks) ? new Uint8Array(Buffer.concat(chunks)) : chunks;
  if (data.byteLength === 0) return { data, seekable: false };
  const dir = await mkdtemp(path.join(tmpdir(), 'nr-audio-'));
  try {
    const ext = extensionFor(mime);
    const inPath = path.join(dir, `in.${ext}`);
    const outPath = path.join(dir, `out.${ext}`);
    await writeFile(inPath, data);
    try {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inPath, '-c', 'copy', outPath]);
    } catch {
      return { data, seekable: false }; // ffmpeg missing or failed
    }
    return { data: new Uint8Array(await readFile(outPath)), seekable: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
