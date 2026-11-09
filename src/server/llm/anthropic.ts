import { makeLlm, type Llm } from './types.js';

export interface AnthropicOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  /** Inject a client (tests); otherwise `@anthropic-ai/sdk` is imported. */
  client?: { messages: { create(args: Record<string, unknown>): Promise<any> } };
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Direct Anthropic API. Needs the optional peer dependency @anthropic-ai/sdk and ANTHROPIC_API_KEY (or apiKey). */
export function anthropic(opts: AnthropicOptions = {}): Llm {
  return makeLlm(async (system, user) => {
    let client = opts.client;
    if (!client) {
      let mod: any;
      try { mod = await import('@anthropic-ai/sdk' as string); }
      catch { throw new Error('narrated-replay: install @anthropic-ai/sdk to use the anthropic LLM adapter'); }
      client = new mod.default(opts.apiKey ? { apiKey: opts.apiKey } : {});
    }
    return textOf(await client!.messages.create(request(opts, system, user)));
  });
}

export function request(opts: { model?: string; maxTokens?: number }, system: string, user: string) {
  return {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low' },
  };
}

export function textOf(res: { content?: { type: string; text?: string }[] }): string {
  return (res.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}
