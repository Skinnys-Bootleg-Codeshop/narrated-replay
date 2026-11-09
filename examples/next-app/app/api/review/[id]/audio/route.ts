// Example only: add your own access check here (recordings contain voice and screen content).
import { assertSessionId } from 'narrated-replay/server';
import { store } from '../../../../../lib-store';

// Browsers can only seek in audio when the server answers Range requests, so this route does.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try { assertSessionId(id); } catch { return new Response('bad id', { status: 400 }); }
  for (const [name, type] of [['audio.webm', 'audio/webm'], ['audio.m4a', 'audio/mp4']] as const) {
    const data = await store.readFile(id, name);
    if (!data) continue;
    const headers: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, data.length - Number(m[2]));
      let end = m[1] && m[2] ? Number(m[2]) : data.length - 1;
      end = Math.min(end, data.length - 1);
      if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${data.length}` } });
      start = Math.max(0, start);
      return new Response(data.slice(start, end + 1) as BodyInit, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1) },
      });
    }
    return new Response(data as BodyInit, { headers: { ...headers, 'content-length': String(data.length) } });
  }
  return new Response('no audio', { status: 404 });
}
