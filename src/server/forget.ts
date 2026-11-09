import type { FeedbackItem, Theme } from '../shared/types.js';
import type { Store } from './store.js';

/**
 * Delete one session and remove its items, quotes and references from the store-wide themes.json
 * (counts go down; themes left with no items are dropped). themes.json holds quotes from every
 * session, so deleting a session directory alone is not enough.
 */
export async function forgetSession(opts: { store: Store; sessionId: string }): Promise<{ removedItems: number; removedThemes: number }> {
  const { store, sessionId } = opts;
  const raw = await store.readFile(sessionId, 'items.json');
  const quotes = new Set<string>(
    raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as FeedbackItem[]).map((i) => i.quote) : [],
  );
  // Read before deleting anything: a malformed themes.json fails here and leaves the session in place.
  const prior = (await store.readJson<Theme[]>('themes.json')) ?? [];
  let removedItems = 0;
  const themes: Theme[] = [];
  for (const t of prior) {
    const itemIds = t.itemIds.filter((id) => !id.startsWith(`${sessionId}:`));
    removedItems += t.itemIds.length - itemIds.length;
    if (itemIds.length === 0) continue;
    themes.push({
      ...t,
      itemIds,
      sessionIds: t.sessionIds.filter((s) => s !== sessionId),
      exampleQuotes: t.exampleQuotes.filter((q) => !quotes.has(q)),
    });
  }
  // Write the catalogue first: if deleting then fails, nothing in themes.json points at the session.
  if (prior.length) await store.writeJson('themes.json', themes);
  await store.deleteSession(sessionId);
  return { removedItems, removedThemes: prior.length - themes.length };
}
