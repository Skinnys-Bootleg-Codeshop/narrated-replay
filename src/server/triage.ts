import { z } from 'zod';
import { concatAndRemux, extensionFor } from './audio.js';
import { buildMoments } from './align.js';
import type { Llm } from './llm/types.js';
import { CLUSTER_SYSTEM, clusterUser, extractionSystem, momentsForPrompt } from './prompts.js';
import type { Store } from './store.js';
import type { Transcriber } from './transcribe/types.js';
import {
  CategorySchema,
  type Category,
  type FeedbackItem,
  type Moment,
  type Theme,
  type Transcript,
} from '../shared/types.js';

export const REVIEW_CONFIDENCE = 0.7;

export interface AnalyzeOptions {
  store: Store;
  sessionId: string;
  transcriber: Transcriber;
  llm: Llm;
  extraction?: 'session' | 'moment';
  productContext?: string;
}

export interface AnalyzeResult {
  items: FeedbackItem[];
  themes: Theme[];
  seekable: boolean;
}

/** The rule is enforced here, after the model has answered, not trusted from the model. */
export function needsHumanReview(category: Category, confidence: number): boolean {
  return category === 'product_decision' || confidence < REVIEW_CONFIDENCE;
}

function extractionSchema(validIds: Set<string>) {
  return z.object({
    items: z.array(
      z.object({
        quote: z.string().min(1),
        momentIds: z
          .array(z.string())
          .min(1)
          .refine((ids) => ids.every((i) => validIds.has(i)), 'momentIds must be copied from the input'),
        element: z.string().nullable().optional(),
        summary: z.string().min(1),
        category: CategorySchema,
        confidence: z.number().min(0).max(1),
        rationale: z.string(),
      }),
    ),
  });
}

function clusterSchema(refs: Set<string>, existing: Set<string>) {
  return z
    .object({
      newThemes: z.array(z.object({ key: z.string().min(1), title: z.string().min(1), description: z.string() })),
      assignments: z.array(z.object({ ref: z.string(), themeId: z.string() })),
    })
    .superRefine((v, ctx) => {
      const keys = new Set(v.newThemes.map((t) => `new:${t.key}`));
      const seen = new Set<string>();
      for (const a of v.assignments) {
        if (!refs.has(a.ref)) ctx.addIssue({ code: 'custom', message: `unknown item ref ${a.ref}` });
        if (seen.has(a.ref)) ctx.addIssue({ code: 'custom', message: `item ${a.ref} assigned twice` });
        seen.add(a.ref);
        if (!existing.has(a.themeId) && !keys.has(a.themeId)) {
          ctx.addIssue({ code: 'custom', message: `themeId ${a.themeId} is neither an existing theme nor a new:<key> from newThemes` });
        }
      }
      for (const r of refs) if (!seen.has(r)) ctx.addIssue({ code: 'custom', message: `item ${r} has no assignment` });
    });
}

type Extracted = z.infer<ReturnType<typeof extractionSchema>>['items'][number];

export async function analyzeSession(o: AnalyzeOptions): Promise<AnalyzeResult> {
  const { store, sessionId, llm } = o;
  const extraction = o.extraction ?? 'session';
  // Starts as failed; set to ok only after every output is written.
  await store.writeFile(sessionId, 'analysis.json', JSON.stringify({ status: 'failed', at: Date.now() }));

  const { meta, events, audio } = await store.readSession(sessionId);
  let seekable = false;
  let transcript: Transcript = { words: [], segments: [] };
  if (audio.byteLength > 0 && meta.audioStart !== null) {
    const remuxed = await concatAndRemux(audio, meta.audioMimeType);
    seekable = remuxed.seekable;
    await store.writeFile(sessionId, `audio.${extensionFor(meta.audioMimeType)}`, remuxed.data);
    transcript = await o.transcriber.transcribe(remuxed.data, meta.audioMimeType);
    await store.writeFile(sessionId, 'transcript.json', JSON.stringify(transcript));
  }

  const moments = buildMoments(events, transcript, meta);
  await store.writeFile(sessionId, 'moments.json', JSON.stringify(moments, null, 2));
  const byId = new Map(moments.map((m) => [m.id, m]));

  // 1. Extraction
  const extracted: Extracted[] = [];
  if (moments.length > 0) {
    const system = extractionSystem(o.productContext);
    if (extraction === 'session') {
      const r = await llm.json({
        system,
        user: JSON.stringify(momentsForPrompt(moments), null, 1),
        schema: extractionSchema(new Set(moments.map((m) => m.id))),
      });
      extracted.push(...r.items);
    } else {
      for (const m of moments) {
        const r = await llm.json({
          system,
          user: JSON.stringify(momentsForPrompt([m]), null, 1),
          schema: extractionSchema(new Set([m.id])),
        });
        extracted.push(...r.items);
      }
    }
  }

  const prior = (await store.readJson<Theme[]>('themes.json')) ?? [];
  // Re-analysing a session replaces its earlier items, including their example quotes.
  const oldRaw = await store.readFile(sessionId, 'items.json');
  const oldQuotes = new Set<string>(
    oldRaw ? (JSON.parse(Buffer.from(oldRaw).toString('utf8')) as FeedbackItem[]).map((i) => i.quote) : [],
  );
  const themes: Theme[] = prior
    .map((t) => ({
      ...t,
      exampleQuotes: t.exampleQuotes.filter((q) => !oldQuotes.has(q)),
      itemIds: t.itemIds.filter((id) => !id.startsWith(`${sessionId}:`)),
      sessionIds: t.sessionIds.filter((s) => s !== sessionId),
    }))
    .filter((t) => t.itemIds.length > 0);

  const items: FeedbackItem[] = [];
  if (extracted.length > 0) {
    const refs = extracted.map((_, i) => `i${i}`);
    const cluster = await llm.json({
      system: CLUSTER_SYSTEM,
      user: clusterUser(
        themes,
        extracted.map((e, i) => ({ ref: refs[i]!, quote: e.quote, summary: e.summary, page: byId.get(e.momentIds[0]!)?.page ?? null })),
      ),
      schema: clusterSchema(new Set(refs), new Set(themes.map((t) => t.id))),
    });

    let nextTheme = themes.reduce((n, t) => Math.max(n, Number(/^t(\d+)$/.exec(t.id)?.[1] ?? 0)), 0) + 1;
    const newIds = new Map<string, string>();
    for (const nt of cluster.newThemes) {
      const id = `t${nextTheme++}`;
      newIds.set(`new:${nt.key}`, id);
      themes.push({ id, title: nt.title, description: nt.description, exampleQuotes: [], itemIds: [], sessionIds: [], category: 'needs_design' });
    }
    const themeById = new Map(themes.map((t) => [t.id, t]));

    extracted.forEach((e, i) => {
      const ms = e.momentIds.map((id) => byId.get(id)!) as Moment[];
      const a = cluster.assignments.find((x) => x.ref === refs[i])!;
      const themeId = newIds.get(a.themeId) ?? a.themeId;
      const item: FeedbackItem = {
        id: `${sessionId}:${i}`,
        sessionId,
        quote: e.quote,
        startMs: Math.min(...ms.map((m) => m.startMs)),
        endMs: Math.max(...ms.map((m) => m.endMs)),
        momentIds: e.momentIds,
        page: ms[0]!.page,
        element: e.element ?? null,
        summary: e.summary,
        category: e.category,
        confidence: e.confidence,
        rationale: e.rationale,
        needsHumanReview: needsHumanReview(e.category, e.confidence),
        themeId,
      };
      items.push(item);
      const t = themeById.get(themeId)!;
      t.itemIds.push(item.id);
      if (!t.sessionIds.includes(sessionId)) t.sessionIds.push(sessionId);
      if (t.exampleQuotes.length < 2) t.exampleQuotes.push(item.quote);
    });
  }
  // Theme category: the most common category among all of its items, across every session.
  const itemsBySession = new Map<string, FeedbackItem[]>([[sessionId, items]]);
  for (const t of themes) {
    const counts = new Map<Category, number>();
    for (const sid of t.sessionIds) {
      if (!itemsBySession.has(sid)) {
        const raw = await store.readFile(sid, 'items.json').catch(() => null);
        itemsBySession.set(sid, raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as FeedbackItem[]) : []);
      }
      for (const it of itemsBySession.get(sid)!) {
        if (t.itemIds.includes(it.id)) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
      }
    }
    if (counts.size) t.category = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  }

  await store.writeFile(sessionId, 'items.json', JSON.stringify(items, null, 2));
  await store.writeJson('themes.json', themes);
  await store.writeFile(sessionId, 'report.md', renderReport({ sessionId, items, themes, seekable, hadAudio: audio.byteLength > 0, hasSpeech: transcript.words.length > 0 }));
  await store.writeFile(sessionId, 'analysis.json', JSON.stringify({ status: 'ok', at: Date.now(), extraction }));
  return { items, themes, seekable };
}

export function renderReport(r: {
  sessionId: string;
  items: FeedbackItem[];
  themes: Theme[];
  seekable: boolean;
  hadAudio: boolean;
  hasSpeech: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`# Feedback report: session ${r.sessionId}`, '');
  lines.push('> Generated by AI. Categories and themes are suggestions; items flagged "needs human review" need a person.', '');
  if (!r.hadAudio) lines.push('No audio was recorded for this session.', '');
  else if (!r.hasSpeech) lines.push('No speech detected, so there are no feedback items.', '');
  if (r.hadAudio && !r.seekable) {
    lines.push('Note: ffmpeg was not available, so the audio was not remuxed; seeking in the replay may not work.', '');
  }
  if (r.items.length) {
    lines.push('## Items', '');
    for (const it of r.items) {
      const t = (it.startMs / 1000).toFixed(1);
      lines.push(
        `### ${it.summary}`,
        '',
        `- Category: ${it.category} (confidence ${it.confidence.toFixed(2)})${it.needsHumanReview ? ' - **needs human review**' : ''}`,
        `- At ${t}s on ${it.page ?? 'unknown page'}${it.element ? `, element ${it.element}` : ''}`,
        `- Quote: "${it.quote}"`,
        `- Why: ${it.rationale}`,
        `- Theme: ${it.themeId}`,
        '',
      );
    }
    lines.push('## Themes touched', '');
    const touched = new Set(r.items.map((i) => i.themeId));
    for (const t of r.themes.filter((t) => touched.has(t.id))) {
      lines.push(`- **${t.title}** (${t.id}): ${t.itemIds.length} item(s) from ${t.sessionIds.length} session(s). ${t.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
