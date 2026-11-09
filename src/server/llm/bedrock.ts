import { DEFAULT_MODEL, request, textOf } from './anthropic.js';
import { makeLlm, type Llm } from './types.js';

export interface BedrockOptions {
  /** Bedrock model id; defaults to the Mantle form of the default model. */
  model?: string;
  region: string;
  maxTokens?: number;
  client?: { messages: { create(args: Record<string, unknown>): Promise<any> } };
}

/** Claude on Amazon Bedrock via the Messages-API (Mantle) client. Needs the optional peer dependency @anthropic-ai/bedrock-sdk. */
export function bedrock(opts: BedrockOptions): Llm {
  return makeLlm(async (system, user) => {
    let client = opts.client;
    if (!client) {
      let mod: any;
      try { mod = await import('@anthropic-ai/bedrock-sdk' as string); }
      catch { throw new Error('narrated-replay: install @anthropic-ai/bedrock-sdk to use the bedrock LLM adapter'); }
      client = new mod.AnthropicBedrockMantle({ awsRegion: opts.region });
    }
    const model = opts.model ?? `anthropic.${DEFAULT_MODEL}`;
    return textOf(await client!.messages.create(request({ model, maxTokens: opts.maxTokens }, system, user)));
  });
}
