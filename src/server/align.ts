import type { Moment, MomentEvent, SessionMeta, Transcript } from '../shared/types.js';

interface SNode {
  id: number;
  type: number; // 0 document, 1 doctype, 2 element, 3 text, 4 cdata, 5 comment
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: SNode[];
}
type RrEvent = { type: number; timestamp: number; data: any };

export interface AlignOptions {
  /** Include UI events from this long before a spoken sentence starts. */
  windowBeforeMs?: number;
  /** ... and this long after it ends. */
  windowAfterMs?: number;
}

/** Tracks the DOM node map through the full snapshot and every mutation, so clicks can be named. */
class NodeMap {
  private nodes = new Map<number, SNode>();
  private parent = new Map<number, number | null>();

  addTree(n: SNode, parentId: number | null): SNode[] {
    const added: SNode[] = [];
    const walk = (x: SNode, p: number | null) => {
      this.nodes.set(x.id, x);
      this.parent.set(x.id, p);
      added.push(x);
      x.childNodes ??= [];
      for (const c of x.childNodes) walk(c, x.id);
    };
    walk(n, parentId);
    return added;
  }
  reset() {
    this.nodes.clear();
    this.parent.clear();
  }
  get(id: number) { return this.nodes.get(id); }
  attach(n: SNode, parentId: number | null | undefined): SNode[] {
    const existing = this.nodes.get(n.id);
    if (existing) this.detach(n.id);
    const added = this.addTree(n, parentId ?? null);
    const p = parentId != null ? this.nodes.get(parentId) : undefined;
    if (p) {
      p.childNodes ??= [];
      if (!p.childNodes.some((c) => c.id === n.id)) p.childNodes.push(n);
    }
    return added;
  }
  detach(id: number) {
    const pid = this.parent.get(id);
    const p = pid != null ? this.nodes.get(pid) : undefined;
    if (p?.childNodes) p.childNodes = p.childNodes.filter((c) => c.id !== id);
    this.nodes.delete(id);
    this.parent.delete(id);
  }
  text(id: number): string {
    const n = this.nodes.get(id);
    if (!n) return '';
    if (n.type === 3) return (n.textContent ?? '').trim();
    return (n.childNodes ?? []).map((c) => this.text(c.id)).filter(Boolean).join(' ');
  }
  /** `tag#id`, an aria-label if present and the visible text (up to 60 characters). */
  label(id: number): string | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const a = n.attributes ?? {};
    let out = `${n.tagName ?? 'node'}${typeof a.id === 'string' && a.id ? '#' + a.id : ''}`;
    if (typeof a['aria-label'] === 'string') out += ` [aria-label="${(a['aria-label'] as string).slice(0, 60)}"]`;
    const t = this.text(id).slice(0, 60);
    if (t) out += ` "${t}"`;
    return out;
  }
}

function pageOf(href: string): string {
  try {
    const u = new URL(href);
    if (u.hash.startsWith('#/')) return u.hash.slice(1);
    return u.pathname;
  } catch {
    return href;
  }
}

interface TimelineEntry { tMs: number; kind: MomentEvent['kind']; detail: string; element?: string | null }

export function buildTimeline(events: unknown[], meta: SessionMeta): TimelineEntry[] {
  const t0 = meta.audioStart ?? meta.rrwebStart;
  const map = new NodeMap();
  const out: TimelineEntry[] = [];
  for (const e of events as RrEvent[]) {
    const tMs = e.timestamp - t0;
    if (e.type === 2) {
      map.reset();
      map.addTree(e.data.node, null);
    } else if (e.type === 5) {
      const tag = e.data?.tag as string;
      const p = e.data?.payload ?? {};
      if (tag === 'nr:route' || tag === 'route') out.push({ tMs, kind: 'navigate', detail: String(p.href) });
      else if (tag === 'nr:error' || tag === 'console') {
        out.push({ tMs, kind: 'error', detail: `${p.level}: ${p.message ?? p.msg}` });
      }
    } else if (e.type === 3) {
      const d = e.data;
      if (d.source === 0) {
        for (const r of d.removes ?? []) map.detach(r.id);
        for (const a of d.adds ?? []) {
          for (const n of map.attach(a.node, a.parentId)) {
            const txt = (n.textContent ?? '').trim();
            if (n.type === 3 && txt && txt.length < 80) out.push({ tMs, kind: 'dom_text_appeared', detail: txt });
          }
        }
        for (const at of d.attributes ?? []) {
          // Attribute mutations (an aria-label change, say) change how later clicks are named.
          const n = map.get(at.id);
          if (!n) continue;
          n.attributes ??= {};
          for (const [k, v] of Object.entries(at.attributes ?? {})) {
            if (v === null || v === undefined) delete n.attributes[k];
            else n.attributes[k] = v;
          }
        }
        for (const tx of d.texts ?? []) {
          const n = map.get(tx.id);
          if (!n) continue;
          const next = tx.value ?? '';
          const changed = next !== (n.textContent ?? '');
          n.textContent = next;
          const txt = next.trim();
          if (changed && txt && txt.length < 80) out.push({ tMs, kind: 'text', detail: txt });
        }
      } else if (d.source === 2 && d.type === 2) {
        const label = map.label(d.id);
        out.push({ tMs, kind: 'click', detail: label ?? `node ${d.id}`, element: label });
      } else if (d.source === 5) {
        const label = map.label(d.id);
        out.push({ tMs, kind: 'input', detail: `${label} typed (masked format) ${JSON.stringify(d.text)}`, element: label });
      }
    }
  }
  return out;
}

export function buildMoments(
  events: unknown[],
  transcript: Transcript,
  meta: SessionMeta,
  opts: AlignOptions = {},
): Moment[] {
  const before = opts.windowBeforeMs ?? 3000;
  const after = opts.windowAfterMs ?? 1000;
  const timeline = buildTimeline(events, meta);

  const sentences: Transcript['words'][] = [];
  let cur: Transcript['words'] = [];
  for (const w of transcript.words) {
    cur.push(w);
    if (/[.?!]$/.test(w.text.trim())) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);

  return sentences.map((ws, k) => {
    const startMs = ws[0]!.startMs;
    const endMs = ws[ws.length - 1]!.endMs;
    const ctx = timeline.filter((x) => x.tMs >= startMs - before && x.tMs <= endMs + after);
    const nav = timeline.filter((x) => x.kind === 'navigate' && x.tMs <= endMs + 500);
    const lastNav = nav[nav.length - 1];
    return {
      id: `${meta.sessionId}-m${k}`,
      sessionId: meta.sessionId,
      startMs,
      endMs,
      quote: ws.map((w) => w.text.trim()).join(' '),
      page: lastNav ? pageOf(lastNav.detail) : null,
      events: ctx.map((x) => ({
        t: Math.round(x.tMs / 100) / 10,
        kind: x.kind,
        detail: x.kind === 'navigate' ? pageOf(x.detail) : x.detail,
      })),
    };
  });
}
