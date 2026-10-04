import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DAY_MS,
  HYPERLIQUID_INFO_URL,
  chartWindow,
  fetchCandles,
  parseCandles,
} from '../src/lib/price-history';

const NOW = Date.UTC(2026, 9, 4, 12);

test('history spans twice the time to expiry, clamped to 7–30 whole days', () => {
  assert.equal(chartWindow(NOW, NOW + DAY_MS / 2).lookbackDays, 7);
  assert.equal(chartWindow(NOW, null).lookbackDays, 7);
  assert.equal(chartWindow(NOW, NOW - DAY_MS).lookbackDays, 7);
  assert.equal(chartWindow(NOW, NOW + 5.2 * DAY_MS).lookbackDays, 11);
  assert.equal(chartWindow(NOW, NOW + 13 * DAY_MS).lookbackDays, 26);
  assert.equal(chartWindow(NOW, NOW + 60 * DAY_MS).lookbackDays, 30);
  // The window only moves in whole days, so a ticking clock does not refetch every second.
  assert.deepEqual(chartWindow(NOW, NOW + 5.2 * DAY_MS), chartWindow(NOW + 1000, NOW + 5.2 * DAY_MS));
});

test('the candle interval keeps the history under 400 points', () => {
  for (const days of [3, 7, 14, 30]) {
    const w = chartWindow(NOW, NOW + days * DAY_MS);
    assert.ok((w.lookbackDays * DAY_MS) / w.intervalMs <= 400, `${days}d`);
  }
  assert.equal(chartWindow(NOW, NOW + DAY_MS).interval, '30m');
  assert.equal(chartWindow(NOW, NOW + 7 * DAY_MS).interval, '1h');
  assert.equal(chartWindow(NOW, NOW + 30 * DAY_MS).interval, '2h');
});

test('candles parse to sorted open-time closes and drop unusable prices', () => {
  assert.deepEqual(
    parseCandles([
      { t: 2, T: 3, s: 'xyz:NVDA', i: '1h', o: '1', c: '234.29', h: '1', l: '1', v: '1', n: 1 },
      { t: 1, c: '233.10' },
      { t: 3, c: '0' },
      { t: 4, c: 'NaN' },
    ]),
    [
      { timeMs: 1, close: 233.1 },
      { timeMs: 2, close: 234.29 },
    ],
  );
  assert.throws(() => parseCandles({ error: 'bad request' }));
});

test('fetchCandles asks Hyperliquid for the window ending now', async (t) => {
  const calls: { url: string; body: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify([{ t: NOW - 3_600_000, c: '234.5' }]));
  });
  const w = chartWindow(NOW, NOW + 7 * DAY_MS);
  assert.deepEqual(await fetchCandles('xyz:NVDA', w, NOW), [{ timeMs: NOW - 3_600_000, close: 234.5 }]);
  assert.equal(calls[0].url, HYPERLIQUID_INFO_URL);
  assert.deepEqual(calls[0].body, {
    type: 'candleSnapshot',
    req: { coin: 'xyz:NVDA', interval: '1h', startTime: NOW - 14 * DAY_MS - 3_600_000, endTime: NOW },
  });
});
