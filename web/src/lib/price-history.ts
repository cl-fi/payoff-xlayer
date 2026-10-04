import { z } from 'zod';

// Hyperliquid perp candles for the chart only. Offers and quotes still use the gateway's oracle reference.
export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const DAY_MS = 86_400_000;
const MAX_POINTS = 400;
const INTERVALS = [
  ['15m', 900_000],
  ['30m', 1_800_000],
  ['1h', 3_600_000],
  ['2h', 7_200_000],
  ['4h', 14_400_000],
] as const;

export type Candle = { timeMs: number; close: number };
export type ChartWindow = { lookbackDays: number; interval: string; intervalMs: number };

// Show twice the time left to expiry as history (7 to 30 whole days), so the target window reads in
// proportion. Whole days keep the window stable while the clock ticks.
export function chartWindow(nowMs: number, expiryMs: number | null): ChartWindow {
  const tenorDays = expiryMs === null ? 0 : Math.max(0, expiryMs - nowMs) / DAY_MS;
  const lookbackDays = Math.min(30, Math.max(7, Math.ceil(tenorDays * 2)));
  const [interval, intervalMs] =
    INTERVALS.find(([, ms]) => (lookbackDays * DAY_MS) / ms <= MAX_POINTS) ?? INTERVALS.at(-1)!;
  return { lookbackDays, interval, intervalMs };
}

const candleSchema = z.array(z.object({ t: z.number(), c: z.string() }));

// Candles are keyed by their open time, so the in-progress candle never reaches past now.
export function parseCandles(json: unknown): Candle[] {
  return candleSchema
    .parse(json)
    .map((c) => ({ timeMs: c.t, close: Number(c.c) }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timeMs - b.timeMs);
}

export async function fetchCandles(coin: string, window: ChartWindow, nowMs: number, signal?: AbortSignal) {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: {
        coin,
        interval: window.interval,
        startTime: nowMs - window.lookbackDays * DAY_MS - window.intervalMs,
        endTime: nowMs,
      },
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Price history request failed (${response.status})`);
  return parseCandles(await response.json());
}
