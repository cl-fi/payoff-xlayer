import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: 'testnet.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:3101' },
  webServer: {
    command: 'npm run dev -- --port 3101',
    url: 'http://127.0.0.1:3101',
    reuseExistingServer: false,
    timeout: 120000,
    env: { NEXT_PUBLIC_DATA_MODE: 'testnet', NEXT_PUBLIC_GATEWAY_URL: '', NEXT_PUBLIC_NVDA_VAULT: '' },
  },
});
