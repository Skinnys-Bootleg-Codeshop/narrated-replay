import type { Category, FeedbackItem, Theme } from '../shared/types.js';
import type { Store } from './store.js';

/**
 * Delete one session and remove its items, quotes and references from the store-wide themes.json
 * (counts go down; themes left with no items are dropped). themes.json holds quotes from every
 * session, so deleting a session directory alone is not enough.
 *
 * Example quotes and the category of each affected theme are rebuilt from the items of the sessions
 * that remain, so this works even if the session's own items.json is already gone. If a remaining
 * item cannot be found, it throws and changes nothing.
 */
export async function forgetSession(opts: { store: Store; sessionId: string }): Promise<{ removedItems: number; removedThemes: number }> {
  const { store, sessionId } = opts;
  // Read before deleting anything: a malformed themes.json fails here and leaves the session in place.
  const prior = (await store.readJson<Theme[]>('themes.json')) ?? [];

  const cache = new Map<string, Map<string, FeedbackItem>>();
  const itemsOf = async (sid: string) => {
    let m = cache.get(sid);
    if (!m) {
      const raw = await store.readFile(sid, 'items.json');
      if (!raw) throw new Error(`narrated-replay: cannot forget ${sessionId}: items.json of session ${sid} is missing, so themes.json cannot be rebuilt safely`);
      m = new Map((JSON.parse(Buffer.from(raw).toString('utf8')) as FeedbackItem[]).map((i) => [i.id, i]));
      cache.set(sid, m);
    }
    return m;
  };

  let removedItems = 0;
  const themes: Theme[] = [];
  for (const t of prior) {
    const itemIds = t.itemIds.filter((id) => !id.startsWith(`${sessionId}:`));
    const touched = itemIds.length !== t.itemIds.length || t.sessionIds.includes(sessionId);
    removedItems += t.itemIds.length - itemIds.length;
    if (itemIds.length === 0) continue;
    if (!touched) { themes.push(t); continue; }
    const sessionIds = t.sessionIds.filter((s) => s !== sessionId);
    const surviving: FeedbackItem[] = [];
    for (const id of itemIds) {
      const sid = id.slice(0, id.lastIndexOf(':'));
      const it = (await itemsOf(sid)).get(id);
      if (!it) throw new Error(`narrated-replay: cannot forget ${sessionId}: item ${id} of theme ${t.id} not found`);
      surviving.push(it);
    }
    const counts = new Map<Category, number>();
    for (const it of surviving) if (it.category) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    const category = counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0] : t.category;
    themes.push({ ...t, itemIds, sessionIds, category, exampleQuotes: surviving.slice(0, 2).map((i) => i.quote) });
  }
  // Write the catalogue first: if deleting then fails, nothing in themes.json points at the session.
  if (prior.length) await store.writeJson('themes.json', themes);
  await store.deleteSession(sessionId);
  return { removedItems, removedThemes: prior.length - themes.length };
}
