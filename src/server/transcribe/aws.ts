import { randomUUID } from 'node:crypto';
import { segmentsFromWords, type Transcriber } from './types.js';
import { extensionFor } from '../audio.js';

interface Sender { send(command: unknown): Promise<any> }

export interface AwsTranscribeOptions {
  bucket: string;
  region?: string;
  prefix?: string;
  pollMs?: number;
  /** Injected for tests; defaults to real AWS SDK clients (optional peer dependencies). */
  transcribe?: Sender;
  s3?: Sender;
  fetchJson?: (url: string) => Promise<any>;
  commands?: { transcribe: any; s3: any };
}

/**
 * AWS Transcribe batch job: upload to S3, start job, poll, parse word timings.
 * Needs @aws-sdk/client-transcribe and @aws-sdk/client-s3 unless clients are injected.
 */
export function awsTranscribe(opts: AwsTranscribeOptions): Transcriber {
  return {
    async transcribe(audio, mime) {
      let cmds = opts.commands;
      let tc = opts.transcribe;
      let s3 = opts.s3;
      if (!cmds || !tc || !s3) {
        let t: any, s: any;
        try { t = await import('@aws-sdk/client-transcribe' as string); }
        catch { throw new Error('narrated-replay: install @aws-sdk/client-transcribe to use awsTranscribe'); }
        try { s = await import('@aws-sdk/client-s3' as string); }
        catch { throw new Error('narrated-replay: install @aws-sdk/client-s3 to use awsTranscribe'); }
        cmds = { transcribe: t, s3: s };
        tc ??= new t.TranscribeClient({ region: opts.region });
        s3 ??= new s.S3Client({ region: opts.region });
      }
      const id = randomUUID();
      const key = `${opts.prefix ?? 'narrated-replay-transcribe/'}${id}.${extensionFor(mime)}`;
      const jobName = `nr-${id}`;
      let uploaded = false;
      let started = false;
      try {
        await s3!.send(new cmds.s3.PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: audio }));
        uploaded = true;
        await tc!.send(
          new cmds.transcribe.StartTranscriptionJobCommand({
            TranscriptionJobName: jobName,
            LanguageCode: 'en-US',
            Media: { MediaFileUri: `s3://${opts.bucket}/${key}` },
          }),
        );
        started = true;
        for (let i = 0; i < 600; i++) {
          const r = await tc!.send(new cmds.transcribe.GetTranscriptionJobCommand({ TranscriptionJobName: jobName }));
          const job = r.TranscriptionJob;
          if (job?.TranscriptionJobStatus === 'COMPLETED') {
            const url = job.Transcript?.TranscriptFileUri as string;
            const json = await (opts.fetchJson ?? ((u) => fetch(u).then((x) => x.json())))(url);
            return parseAwsTranscript(json);
          }
          if (job?.TranscriptionJobStatus === 'FAILED') throw new Error(`AWS Transcribe failed: ${job.FailureReason ?? 'unknown'}`);
          await new Promise((res) => setTimeout(res, opts.pollMs ?? 3000));
        }
        throw new Error('AWS Transcribe timed out');
      } finally {
        // Do not leave voice recordings or transcripts behind in the bucket or in AWS Transcribe.
        if (started) await tc!.send(new cmds.transcribe.DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })).catch(() => undefined);
        if (uploaded) await s3!.send(new cmds.s3.DeleteObjectCommand({ Bucket: opts.bucket, Key: key })).catch(() => undefined);
      }
    },
  };
}

export function parseAwsTranscript(json: any) {
  const words: { text: string; startMs: number; endMs: number }[] = [];
  for (const it of json?.results?.items ?? []) {
    const text = it.alternatives?.[0]?.content ?? '';
    if (it.type === 'pronunciation') {
      words.push({ text, startMs: Math.round(Number(it.start_time) * 1000), endMs: Math.round(Number(it.end_time) * 1000) });
    } else if (it.type === 'punctuation' && words.length) {
      words[words.length - 1]!.text += text;
    }
  }
  return { words, segments: segmentsFromWords(words) };
}
