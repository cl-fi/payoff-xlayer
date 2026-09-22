import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: 'gateway.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:3102' },
  webServer: {
    command: 'npm run dev -- --port 3102',
    url: 'http://127.0.0.1:3102',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      NEXT_PUBLIC_DATA_MODE: 'gateway',
      NEXT_PUBLIC_GATEWAY_URL: 'https://gateway.example.test',
      NEXT_PUBLIC_NVDA_VAULT: '',
    },
  },
});
