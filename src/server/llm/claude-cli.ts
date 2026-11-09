import { spawn } from 'node:child_process';
import { makeLlm, type Llm } from './types.js';

export interface ClaudeCliOptions {
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  command?: string;
  timeoutMs?: number;
}

/** Uses the local `claude` CLI in print mode (your Claude subscription). The prompt goes to stdin. */
export function claudeCli(opts: ClaudeCliOptions = {}): Llm {
  return makeLlm((system, user) => runClaude(opts, system, user));
}

function runClaude(opts: ClaudeCliOptions, system: string, user: string): Promise<string> {
  const args = [
    '-p',
    ...(opts.model ? ['--model', opts.model] : []),
    '--effort', opts.effort ?? 'low',
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--system-prompt', system,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command ?? 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not run claude CLI: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${err.slice(0, 500)}`));
      try {
        const j = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (j.is_error || typeof j.result !== 'string') return reject(new Error(`claude CLI error: ${out.slice(0, 500)}`));
        resolve(j.result);
      } catch {
        reject(new Error(`claude CLI returned non-JSON output: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.end(user);
  });
}
