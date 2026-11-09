import { expect, test } from '@playwright/test';
import { cleanStore, openConsent, readSessionFiles, recordSession } from './helpers';

test.beforeAll(cleanStore);

test('consent, record across client-side navigation, upload, shared clock', async ({ page }) => {
  const id = await recordSession(page);
  const { meta, events, eventChunks, audioChunks } = readSessionFiles(id);

  // criterion 3: events, audio, meta stored; clocks within 200 ms
  expect(eventChunks.length).toBeGreaterThan(0);
  expect(audioChunks.length).toBeGreaterThan(0);
  expect(meta.sessionId).toBe(id);
  expect(meta.audioStart).toBeGreaterThan(0);
  expect(Math.abs(meta.audioStart - meta.rrwebStart)).toBeLessThan(200);
  expect(meta.audioMimeType).toContain('audio/');

  // criterion 4: route changes through pushState, popstate and hashchange
  const routes = events.filter((e) => e.type === 5 && e.data.tag === 'nr:route').map((e) => e.data.payload.href as string);
  expect(routes.some((h) => h.endsWith('/notes'))).toBe(true); // router.push -> history.pushState
  expect(routes.filter((h) => h.endsWith('/')).length).toBeGreaterThanOrEqual(2); // initial + popstate (back)
  expect(routes.some((h) => h.endsWith('#later'))).toBe(true); // hashchange

  // criterion 5: input recorded in shape only, passwords fully masked
  const inputs = events.filter((e) => e.type === 3 && e.data.source === 5).map((e) => e.data.text as string);
  expect(inputs).toContain('9999-99-99');
  expect(inputs).toContain('aaa aaaa');
  expect(inputs.some((t) => t.includes('2026') || t.includes('hunter2') || t.includes('milk'))).toBe(false);
  expect(inputs).toContain('*******');
  // clicks were recorded (source 2, type 2)
  expect(events.some((e) => e.type === 3 && e.data.source === 2 && e.data.type === 2)).toBe(true);
});

test('declining consent does not start recording', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('narrated-replay:consent'));
  await openConsent(page);
  await page.getByTestId('nr-decline').click();
  await expect(page.getByTestId('nr-recording')).toHaveCount(0);
});
