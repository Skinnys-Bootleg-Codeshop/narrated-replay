import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';

async function run(args: string[]) {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try { return await main(args); } finally { err.mockRestore(); log.mockRestore(); }
}

describe('cli exit codes', () => {
  it('2 for no command, unknown command and bad arguments', async () => {
    expect(await run([])).toBe(2);
    expect(await run(['frobnicate'])).toBe(2);
    expect(await run(['analyze'])).toBe(2);
    expect(await run(['analyze', '--store', '/tmp/x'])).toBe(2);
    expect(await run(['analyze', '--store', '/tmp/x', '--session', 'a', '--transcriber', 'nope', '--llm', 'claude-cli'])).toBe(2);
    expect(await run(['analyze', '--store', '/tmp/x', '--session', 'a', '--transcriber', 'faster-whisper', '--llm', 'nope'])).toBe(2);
    expect(await run(['analyze', '--store', '/tmp/x', '--session', 'a', '--all', '--transcriber', 'faster-whisper', '--llm', 'claude-cli'])).toBe(2);
    expect(await run(['analyze', '--bogus'])).toBe(2);
    expect(await run(['serve'])).toBe(2);
    expect(await run(['serve', '--store', '/tmp/x', '--port', '99999'])).toBe(2);
  });
  it('1 when analysis fails (unknown session)', async () => {
    expect(
      await run(['analyze', '--store', '/tmp/nr-no-such-store', '--session', '11111111-1111-4111-8111-111111111111', '--transcriber', 'faster-whisper', '--llm', 'claude-cli']),
    ).toBe(1);
  });
  it('0 for --help', async () => {
    expect(await run(['--help'])).toBe(0);
  });
});
