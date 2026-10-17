import { defineConfig, devices } from '@playwright/test';

// End to end on Stellar testnet with a virtual passkey authenticator.
// Needs the real public/testnet.json (written by the "App on testnet" workflow).
export default defineConfig({
  testDir: 'e2e',
  timeout: 15 * 60_000,
  expect: { timeout: 120_000 },
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  use: {
    baseURL: 'http://localhost:4173/kyros2.0/',
    ...devices['Pixel 7'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/kyros2.0/',
    reuseExistingServer: true,
  },
});
