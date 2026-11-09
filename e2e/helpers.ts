import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { STORE } from '../playwright.config';

export function cleanStore() {
  rmSync(STORE, { recursive: true, force: true });
}

export function sessionDirs(): string[] {
  try {
    return readdirSync(STORE).filter((n) => /^[0-9a-f-]{36}$/.test(n)).map((n) => path.join(STORE, n));
  } catch { return []; }
}

/** Click Talk until the consent dialog shows (the first click can land before hydration). */
export async function openConsent(page: Page) {
  await expect(async () => {
    await page.getByTestId('nr-talk').click();
    await expect(page.getByTestId('nr-consent')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

/** Drive the example app: consent, record while navigating and typing, stop. Returns the session id. */
export async function recordSession(page: Page): Promise<string> {
  await page.goto('/');
  await openConsent(page);
  await page.getByTestId('nr-accept').click();
  await expect(page.getByTestId('nr-recording')).toBeVisible();

  await page.fill('#title', 'Buy milk');
  await page.fill('#due', '2026-11-09');
  await page.fill('#secret', 'hunter2');
  await page.click('#btn-save');
  await expect(page.locator('#msg')).toHaveText('Error: invalid date');
  await page.waitForTimeout(1500);
  await page.click('#btn-go'); // router.push
  await expect(page).toHaveURL(/\/notes$/);
  await page.waitForTimeout(1500);
  await page.goBack(); // popstate
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => { location.hash = '#later'; }); // hashchange
  await page.waitForTimeout(4500);

  await page.getByTestId('nr-stop').click();
  await expect(page.getByTestId('nr-talk')).toBeVisible({ timeout: 20_000 });
  const dirs = sessionDirs();
  expect(dirs).toHaveLength(1);
  return path.basename(dirs[0]!);
}

export function readSessionFiles(id: string) {
  const dir = path.join(STORE, id);
  const ls = (d: string) => { try { return readdirSync(path.join(dir, d)).sort(); } catch { return []; } };
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const events = ls('events').flatMap((f) => JSON.parse(readFileSync(path.join(dir, 'events', f), 'utf8')) as any[]);
  return { dir, meta, events, eventChunks: ls('events'), audioChunks: ls('audio') };
}
