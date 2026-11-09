// Example only: add your own access check here (recordings contain voice and screen content).
import 'narrated-replay/viewer.css';
import type { FeedbackItem } from 'narrated-replay/server';
import { assertSessionId } from 'narrated-replay/server';
import { notFound } from 'next/navigation';
import { store } from '../../../lib-store';
import { Viewer } from './viewer';

export const dynamic = 'force-dynamic';

export default async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { assertSessionId(id); } catch { notFound(); }
  const session = await store.readSession(id).catch(() => null);
  if (!session) notFound();
  const raw = await store.readFile(id, 'items.json');
  const items: FeedbackItem[] = raw ? JSON.parse(Buffer.from(raw).toString('utf8')) : [];
  return (
    <main>
      <h1>Session {id}</h1>
      <Viewer meta={session.meta} events={session.events} items={items} audioUrl={`/api/review/${id}/audio`} />
    </main>
  );
}
