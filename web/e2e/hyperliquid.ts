import type { Page } from '@playwright/test';

const STEP_MS: Record<string, number> = {
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
};

// Deterministic chart history so specs never reach the real Hyperliquid API.
export async function routeCandles(page: Page, center = 226) {
  await page.route('https://api.hyperliquid.xyz/**', async (route) => {
    const { req } = route.request().postDataJSON();
    const step = STEP_MS[req.interval];
    const candles = [];
    for (let t = Math.ceil(req.startTime / step) * step; t <= req.endTime; t += step)
      candles.push({ t, c: (center + 3 * Math.sin(t / 86_400_000)).toFixed(2) });
    await route.fulfill({ json: candles });
  });
}
