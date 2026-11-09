import type { ZodType } from 'zod';

export interface JsonArgs<T> {
  system: string;
  user: string;
  schema: ZodType<T>;
}

export interface Llm {
  json<T>(args: JsonArgs<T>): Promise<T>;
}

/** Pull the first JSON object or array out of a model reply (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const open = t.search(/[[{]/);
  if (open < 0) throw new Error('no JSON found in model reply');
  const close = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (close <= open) throw new Error('unterminated JSON in model reply');
  return JSON.parse(t.slice(open, close + 1));
}

export class LlmValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmValidationError';
  }
}

/**
 * Builds an Llm from a plain completion function. The reply must be JSON that passes the zod schema;
 * on failure it retries once with the validation error appended, then throws.
 */
export function makeLlm(complete: (system: string, user: string) => Promise<string>): Llm {
  return {
    async json<T>({ system, user, schema }: JsonArgs<T>): Promise<T> {
      let lastError = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const prompt =
          attempt === 0
            ? user
            : `${user}\n\nYour previous reply was rejected: ${lastError}\nReply again with ONLY valid JSON that fixes this.`;
        const reply = await complete(system, prompt);
        try {
          const parsed = schema.safeParse(extractJson(reply));
          if (parsed.success) return parsed.data;
          lastError = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      throw new LlmValidationError(`model did not return valid JSON after one retry: ${lastError}`);
    },
  };
}
