import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const externalUrl = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 35_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  use: {
    ...devices['iPhone 13'],
    defaultBrowserType: 'chromium',
    baseURL: externalUrl ?? 'http://127.0.0.1:5173',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: externalUrl ? undefined : {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { DATABASE_PATH: resolve('artifacts/playwright/game.db') },
  },
});
