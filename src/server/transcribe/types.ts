import type { Transcript } from '../../shared/types.js';
export type { Transcript } from '../../shared/types.js';

export interface Transcriber {
  transcribe(audio: Uint8Array, mime: string | null): Promise<Transcript>;
}

/** Group word timings into sentences ending in . ? ! (used when a service returns only words). */
export function segmentsFromWords(words: Transcript['words']): Transcript['segments'] {
  const out: Transcript['segments'] = [];
  let cur: Transcript['words'] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.text).join(' '), startMs: cur[0]!.startMs, endMs: cur[cur.length - 1]!.endMs });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    if (/[.?!]$/.test(w.text.trim())) flush();
  }
  flush();
  return out;
}
