import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReferencePriceService } from '../src/reference-price.mjs';
import { buildDealerApp } from '../src/app.mjs';
import { referenceSnapshotSchema } from '../../sdk/catalog.mjs';
import { usablePrice } from '../../sdk/eligibility.mjs';

test('price polls share one request, retain the original fetch time on failure, and recover without requiring a price change', async t => {
  let now = Date.parse('2026-10-01T12:00:00Z'), calls = 0, release, fail = false;
  t.mock.method(Date, 'now', () => now);
  const feed = new ReferencePriceService({ config: { coins: { NVDA: 'xyz:NVDA' }, maxAgeMs: 60000 }, price: {
    async sample() { calls++; await new Promise(resolve => { release = resolve; }); if (fail) throw new Error('offline');
      return { oracleMicros: 228000000n, observedAtMs: now }; },
  } });
  const a = feed.refresh(), b = feed.refresh();
  assert.equal(a, b); assert.equal(calls, 1); release(); await a;
  const observed = feed.get('NVDA').fetchedAtMs;
  now += 30000; fail = true; const failed = feed.refresh(); release(); await failed;
  assert.equal(feed.get('NVDA').fetchedAtMs, observed);
  assert.equal(usablePrice(feed.get('NVDA'), now), true);
  now += 30000;
  assert.equal(usablePrice(feed.get('NVDA'), now), false);
  assert.throws(() => feed.assertEligible({ symbol: 'NVDA' }), e => e.code === 'REFERENCE_PRICE_UNAVAILABLE');
  fail = false; const recovered = feed.refresh(); release(); await recovered;
  assert.equal(usablePrice(feed.get('NVDA'), now), true);
});

test('price is published before any option quote snapshot', async t => {
  const exchange = '0x0000000000000000000000000000000000000010';
  const config = { chainId: 1952, exchange, referenceIntervalMs: 30000, maxQuoteAgeSeconds: 30 };
  const prices = new ReferencePriceService({ config: { coins: { NVDA: 'xyz:NVDA' }, maxAgeMs: 60000 },
    price: { sample: async () => ({ oracleMicros: 228000000n, observedAtMs: Date.now() }) } });
  await prices.refresh();
  const app = await buildDealerApp({ config, token: 'secret', prices });
  t.after(() => app.close());
  const response = await app.inject({ url: '/reference-quotes', headers: { authorization: 'Bearer secret' } });
  const snapshot = referenceSnapshotSchema.parse(response.json());
  assert.equal(snapshot.prices[0].priceMicros, '228000000');
  assert.deepEqual(snapshot.quotes, []);
  assert.equal((await app.inject({ url: '/reference-quotes' })).statusCode, 401);
});
