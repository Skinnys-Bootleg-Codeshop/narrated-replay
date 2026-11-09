import path from 'node:path';
import { defineConfig } from '@playwright/test';

const wav = path.resolve('e2e/fixtures/think-aloud.wav');
export const STORE = path.resolve('e2e/.store');
const PORT = Number(process.env.NR_E2E_PORT ?? 4399);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    cwd: 'examples/next-app',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NR_STORE: STORE, NEXT_TELEMETRY_DISABLED: '1' },
  },
});
