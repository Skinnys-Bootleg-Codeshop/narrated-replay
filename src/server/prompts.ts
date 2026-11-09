import type { Moment, Theme } from '../shared/types.js';

export const CATEGORY_DEFINITIONS = `Categories (use exactly one of these four strings):
- "easy_fix": a small copy or UI tweak with an obvious fix.
- "obvious_bug": broken behaviour that is clearly wrong and can be fixed with confidence.
- "needs_design": a real problem whose fix needs design thinking or has trade-offs.
- "product_decision": whether the product should go in this direction or build this feature at all.`;

export function extractionSystem(productContext?: string): string {
  return `You analyse think-aloud usability sessions for a web app. Input: moments, each = what the user said (quote) plus the UI events at that time (clicks with element label, input shapes with the letters and digits masked, text that appeared on screen, errors, the current page).
Extract every distinct piece of FEEDBACK: a complaint, confusion, bug, wish, or a mismatch with what the user expected. Ignore pure narration and mild praise.
${CATEGORY_DEFINITIONS}
Reply with ONLY this JSON, no prose:
{"items":[{"quote":"verbatim words from the user","momentIds":["ids of the moments that support it"],"element":"element label from the UI events or null","summary":"one neutral sentence","category":"...","confidence":0.0,"rationale":"one sentence citing the UI evidence"}]}
Every item must list at least one momentId copied from the input. confidence is between 0 and 1: how sure you are of the category.${productContext ? `\n\nProduct context:\n${productContext}` : ''}`;
}

export function momentsForPrompt(moments: Moment[]) {
  return moments.map((m) => ({
    id: m.id,
    time: `${(m.startMs / 1000).toFixed(1)}s-${(m.endMs / 1000).toFixed(1)}s`,
    page: m.page,
    quote: m.quote,
    events: m.events,
  }));
}

export const CLUSTER_SYSTEM = `You merge feedback items from usability sessions into themes. You get the existing themes catalogue and a list of new items.
For each new item decide: does it describe the same underlying issue or request as an existing theme (even if worded differently)? Then assign it to that theme's id. Otherwise assign it to a new theme.
Never create a new theme for something an existing theme already covers. Items in this batch about the same new issue share one new theme. Singletons get their own new theme.
Reply with ONLY this JSON, no prose:
{"newThemes":[{"key":"short_key","title":"short title","description":"one sentence describing the underlying issue"}],"assignments":[{"ref":"item ref","themeId":"an existing theme id, or new:<key> for a theme listed in newThemes"}]}
Every item ref must appear exactly once in assignments.`;

export function clusterUser(themes: Theme[], items: { ref: string; quote: string; summary: string; page: string | null }[]) {
  return JSON.stringify(
    {
      existingThemes: themes.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        exampleQuotes: t.exampleQuotes.slice(0, 2),
      })),
      newItems: items,
    },
    null,
    1,
  );
}
