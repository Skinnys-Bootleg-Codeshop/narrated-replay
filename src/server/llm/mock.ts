import { makeLlm, type Llm } from './types.js';

export type MockReply = string | object;
export interface MockCall { system: string; user: string }

/** Deterministic LLM for tests: a list of replies consumed in order, or a function of the call. */
export function mockLlm(replies: MockReply[] | ((call: MockCall) => MockReply)): Llm & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  let i = 0;
  const llm = makeLlm(async (system, user) => {
    calls.push({ system, user });
    const r = typeof replies === 'function' ? replies({ system, user }) : replies[i++];
    if (r === undefined) throw new Error('mockLlm: no reply left');
    return typeof r === 'string' ? r : JSON.stringify(r);
  });
  return Object.assign(llm, { calls });
}
