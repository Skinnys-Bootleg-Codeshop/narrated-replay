import { z } from 'zod';

export const CATEGORIES = ['easy_fix', 'obvious_bug', 'needs_design', 'product_decision'] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CHUNK_KINDS = ['events', 'audio', 'meta'] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export const SessionMetaSchema = z.object({
  sessionId: z.string(),
  rrwebStart: z.number(),
  audioStart: z.number().nullable(),
  audioMimeType: z.string().nullable(),
  userAgent: z.string(),
  url: z.string(),
  appMetadata: z.record(z.string()).optional(),
  endedAt: z.number(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const MomentEventSchema = z.object({
  t: z.number(),
  kind: z.enum(['click', 'input', 'navigate', 'error', 'dom_text_appeared', 'text']),
  detail: z.string(),
});
export type MomentEvent = z.infer<typeof MomentEventSchema>;

export const MomentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  quote: z.string(),
  page: z.string().nullable(),
  events: z.array(MomentEventSchema),
});
export type Moment = z.infer<typeof MomentSchema>;

export const FeedbackItemSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  quote: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  momentIds: z.array(z.string()),
  page: z.string().nullable(),
  element: z.string().nullable(),
  summary: z.string(),
  category: CategorySchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  needsHumanReview: z.boolean(),
  themeId: z.string(),
});
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const ThemeSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  exampleQuotes: z.array(z.string()),
  itemIds: z.array(z.string()),
  sessionIds: z.array(z.string()),
  category: CategorySchema,
});
export type Theme = z.infer<typeof ThemeSchema>;

export interface TranscriptWord { text: string; startMs: number; endMs: number }
export interface Transcript { words: TranscriptWord[]; segments: TranscriptWord[] }

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
