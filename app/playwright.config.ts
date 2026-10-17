import { defineConfig, devices } from '@playwright/test';

// End to end on Stellar testnet with a virtual passkey authenticator.
// Needs the real public/testnet.json (written by the "App on testnet" workflow).
export default defineConfig({
  testDir: 'e2e',
  timeout: 15 * 60_000,
  expect: { timeout: 120_000 },
  retries: 1,
  // In CI the github reporter turns each failure into an annotation on the run.
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  use: {
    baseURL: 'http://localhost:4173/kyros2.0/',
    ...devices['Pixel 7'],
    // The flow below reads the Spanish texts; the language test switches it.
    locale: 'es-ES',
    // PW_CHROMIUM: a local Chromium build to use instead of Playwright's download.
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/kyros2.0/',
    reuseExistingServer: true,
  },
});
