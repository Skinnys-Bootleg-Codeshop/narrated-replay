'use client';
import { TalkButton } from 'narrated-replay/react';

export function Talk() {
  return <TalkButton options={{ endpoint: '/api/narrated-replay', chunkMs: 2000 }} />;
}
