import { segmentsFromWords, type Transcriber } from './types.js';
import { extensionFor } from '../audio.js';

interface OpenAiLike {
  audio: { transcriptions: { create(args: Record<string, unknown>): Promise<any> } };
}

/** OpenAI transcription with word timestamps. Needs the optional peer dependency `openai` unless you pass `client`. */
export function openaiTranscribe(opts: { client?: OpenAiLike; model?: string } = {}): Transcriber {
  return {
    async transcribe(audio, mime) {
      let client = opts.client;
      if (!client) {
        let mod: any;
        try { mod = await import('openai' as string); }
        catch { throw new Error('narrated-replay: install openai to use openaiTranscribe'); }
        client = new mod.default() as OpenAiLike;
      }
      const file = new File([audio as BlobPart], `audio.${extensionFor(mime)}`, { type: mime ?? 'audio/webm' });
      const r = await client.audio.transcriptions.create({
        file,
        model: opts.model ?? 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });
      const words = ((r.words ?? []) as { word: string; start: number; end: number }[]).map((w) => ({
        text: w.word.trim(),
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      }));
      return { words, segments: segmentsFromWords(words) };
    },
  };
}
