import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, STORAGE_STATE } from './fixtures/env';

/**
 * Playwright acceptance configuration for the JKANNEL console.
 *
 * Assumes the stack (frontend + API) is ALREADY RUNNING — there is deliberately
 * no `webServer` that rebuilds or serves the app. See README.md for how to
 * start the stack and run the suite.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],

  timeout: 45_000,
  expect: { timeout: 10_000 },

  globalSetup: require.resolve('./global-setup'),

  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
