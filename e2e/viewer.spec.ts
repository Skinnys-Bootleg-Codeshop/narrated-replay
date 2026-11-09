import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { cleanStore, readSessionFiles, recordSession } from './helpers';
import { concatAndRemux, createFileStore } from '../dist/server/index.js';
import { STORE } from '../playwright.config';

test.beforeAll(cleanStore);

test('replay and audio stay in sync; clicking an item seeks both', async ({ page }) => {
  const id = await recordSession(page);
  const store = createFileStore(STORE);
  const s = await store.readSession(id);
  const { data, seekable } = await concatAndRemux(s.audio, s.meta.audioMimeType);
  expect(seekable).toBe(true); // ffmpeg is needed for this test
  await store.writeFile(id, 'audio.webm', data);
  const items = [
    { id: `${id}:0`, sessionId: id, quote: 'It says invalid date.', startMs: 3000, endMs: 4500, momentIds: [], page: '/', element: null,
      summary: 'Date rejected', category: 'obvious_bug', confidence: 0.9, rationale: 'x', needsHumanReview: false, themeId: 't1' },
    { id: `${id}:1`, sessionId: id, quote: 'I expected a date picker.', startMs: 6000, endMs: 7500, momentIds: [], page: '/', element: null,
      summary: 'Wants a picker', category: 'product_decision', confidence: 0.9, rationale: 'x', needsHumanReview: true, themeId: 't2' },
  ];
  await store.writeFile(id, 'items.json', JSON.stringify(items));
  writeFileSync(path.join(STORE, 'viewer-session.txt'), id);

  await page.goto(`/review/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).__nrViewer?.player);
  await page.waitForFunction(() => (document.querySelector('audio') as HTMLAudioElement).readyState >= 1);

  // criterion 10a: seek the player to replay time p; audio follows within 0.25 s
  for (const audioSec of [2, 4, 6]) {
    const result = await page.evaluate(async (sec) => {
      const v = (window as any).__nrViewer;
      v.player.goto(sec * 1000 + v.offsetMs);
      await new Promise((r) => setTimeout(r, 700));
      return v.audio.currentTime as number;
    }, audioSec);
    expect(Math.abs(result - audioSec), `seek to ${audioSec}s`).toBeLessThan(0.25);
  }

  // criterion 10b: clicking an item seeks both to its startMs
  await page.getByTestId('nr-item').nth(1).click();
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => {
    const v = (window as any).__nrViewer;
    return { audio: v.audio.currentTime as number, replay: v.player.getReplayer().getCurrentTime() as number, offset: v.offsetMs as number };
  });
  expect(Math.abs(after.audio - 6)).toBeLessThan(0.25);
  expect(Math.abs((after.replay - after.offset) / 1000 - 6)).toBeLessThan(0.25);
  // item text is plain text (never HTML)
  await expect(page.getByTestId('nr-items')).toContainText('Wants a picker');
});
