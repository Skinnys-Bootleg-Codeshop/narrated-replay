import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { concatAndRemux } from '../src/server/index.js';

const probe = spawnSync('ffmpeg', ['-hide_banner', '-encoders']);
const hasFfmpeg = probe.status === 0 && String(probe.stdout).includes('libopus');
const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });

describe('concatAndRemux', () => {
  it('without ffmpeg on PATH returns the data unchanged and seekable=false', async () => {
    process.env.PATH = '/nonexistent';
    const input = new Uint8Array([1, 2, 3, 4]);
    const r = await concatAndRemux([input.slice(0, 2), input.slice(2)], 'audio/webm');
    expect(r.seekable).toBe(false);
    expect([...r.data]).toEqual([1, 2, 3, 4]);
  });
  it('empty input is not seekable', async () => {
    expect((await concatAndRemux([], 'audio/webm')).seekable).toBe(false);
  });
  it.skipIf(!hasFfmpeg)('with ffmpeg remuxes real audio into a file with a duration', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nr-a-'));
    try {
      const f = path.join(dir, 'a.webm');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', f]);
      const bytes = new Uint8Array(readFileSync(f));
      const r = await concatAndRemux([bytes.slice(0, 100), bytes.slice(100)], 'audio/webm;codecs=opus');
      expect(r.seekable).toBe(true);
      expect(r.data.byteLength).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
