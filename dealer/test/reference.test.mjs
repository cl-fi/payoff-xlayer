import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import rawCatalog from '../../web/public/catalog.json' with { type: 'json' };
import { configSchema } from '../src/config.mjs';
import { ReferenceService } from '../src/reference.mjs';
import { LastValidBidProvider } from '../src/market.mjs';
import { NoQuote, priceQuote } from '../src/pricing.mjs';

test('public references share formal pricing, preserve old bid timestamps and persist catalog fallback without funds', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-22T06:00:00Z') });
  const dir = await mkdtemp(join(tmpdir(), 'payoff-reference-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const catalog = structuredClone(rawCatalog);
  catalog.generatedAt = '2026-09-21T00:00:00Z';
  catalog.markets[0].series = [catalog.markets[0].series[0], catalog.markets[0].series[3], catalog.markets[0].series[1]];
  const m = catalog.markets[0];
  m.rate = '1000000000000000000'; // Stable fixture, independent of the published rate snapshot.
  for (let i = 0; i < m.series.length; i++) m.series[i].strikePricePerWrappedUSDG = String([220, 225, 215][i] * 1000000);
  const config = configSchema.parse({ chainId: catalog.chainId, exchange: catalog.exchange, usdg: catalog.usdg,
    markets: [{ ...m, series: undefined, rate: undefined, seriesIds: m.series.map(s => s.id) }].map(({ series, rate, ...v }) => v) });
  let offline = false, chainReads = 0, providerReads = 0, catalogReads = 0;
  const originalTime = Date.parse('2026-09-21T19:59:00Z');
  const upstream = { close() {}, ready: true, async quote(option) {
    providerReads++;
    if (offline || option.strikeMilli === '215000') throw new NoQuote('NO_VALID_BID_HISTORY');
    return { ...option, bidMicros: '1000000', askMicros: '1200000', bidSize: 10, timestampMs: originalTime,
      marketOpenMs: Date.parse('2026-09-21T13:30:00Z'), marketCloseMs: Date.parse('2026-09-21T20:00:00Z'),
      expirationCloseMs: 1790366400000 };
  } };
  const provider = await LastValidBidProvider.open(upstream, join(dir, 'bids.json'));
  const options = { config, provider, prices: { get: () => ({ status: 'available', priceMicros: '223000000', fetchedAtMs: Date.now(), maxAgeMs: 60000 }) }, catalogPath: join(dir, 'catalog.json'),
    fetcher: async () => { catalogReads++; if (offline) throw new Error('offline'); return new Response(JSON.stringify(catalog)); },
    chain: { async referenceMarket() { chainReads++; return { vault: m.vault, rate: m.rate, feeBps: 100, blockNumber: '123', observedAtMs: Date.now() }; } },
  };
  const reference = new ReferenceService(options);
  await Promise.all([reference.refresh(), reference.refresh()]);
  assert.equal(chainReads, 1); assert.equal(providerReads, 3); assert.equal(catalogReads, 1);
  const put = reference.snapshot.quotes.find(q => q.seriesId === m.series[0].id);
  const call = reference.snapshot.quotes.find(q => q.seriesId === m.series[1].id);
  assert.equal(put.netPremiumPerWrappedUSDG, '500000'); assert.equal(call.netPremiumPerWrappedUSDG, '500000');
  assert.equal(put.marketTimestampMs, originalTime); assert.equal(put.marketDataMode, 'last_valid');
  assert.equal(reference.snapshot.quotes.find(q => q.seriesId === m.series[2].id).status, 'unavailable');
  const formal = priceQuote({ terms: put.terms, symbol: m.symbol, assetsPerWrapped: m.rate, stockQuantity: m.rate, feeBps: 100 }, await provider.quote(put.option), config);
  assert.equal(formal.netPremiumUSDG, put.netPremiumPerWrappedUSDG);
  assert.ok(!JSON.stringify(reference.snapshot).includes('signature'));
  assert.equal(JSON.parse(await readFile(options.catalogPath)).version, 1);
  offline = true;
  const restarted = new ReferenceService({ ...options, provider: await LastValidBidProvider.open(upstream, join(dir, 'bids.json')) });
  await restarted.refresh();
  assert.equal(restarted.snapshot.quotes.find(q => q.seriesId === m.series[0].id).marketTimestampMs, originalTime);
  assert.equal(restarted.snapshot.quotes.find(q => q.seriesId === m.series[0].id).netPremiumPerWrappedUSDG, '500000');
  assert.equal(restarted.snapshot.quotes.find(q => q.seriesId === m.series[2].id).status, 'unavailable');
  // A different wrapped rate changes both native strike and native quantity, as in formal pricing.
  restarted.chain = { async referenceMarket() { return { vault: m.vault, rate: '2000000000000000000', feeBps: 100, blockNumber: '124', observedAtMs: Date.now() }; } };
  restarted.prices = { get: () => ({ status: 'available', priceMicros: '111000000', fetchedAtMs: Date.now(), maxAgeMs: 60000 }) };
  offline = false;
  await restarted.refresh();
  const doubled = restarted.snapshot.quotes.find(q => q.seriesId === m.series[0].id);
  assert.equal(doubled.option.strikeMilli, '110000'); assert.equal(doubled.netPremiumPerWrappedUSDG, '1000000');
  config.markets[0].referenceStrikes = Object.fromEntries(m.series.map(s => [s.id, (BigInt(s.strikePricePerWrappedUSDG) / 1000n).toString()]));
  restarted.chain = { async referenceMarket() { return { vault: m.vault, rate: '1001701196801074000', feeBps: 100, blockNumber: '125', observedAtMs: Date.now() }; } };
  restarted.prices = options.prices;
  await restarted.refresh();
  for (const s of m.series.slice(0, 2)) {
    const q = restarted.snapshot.quotes.find(q => q.seriesId === s.id);
    assert.equal(q.option.strikeMilli, config.markets[0].referenceStrikes[s.id]);
    const signedPricing = priceQuote({ terms: s, symbol: m.symbol, referenceStrikeMilli: config.markets[0].referenceStrikes[s.id],
      assetsPerWrapped: '1001701196801074000', stockQuantity: '1001701196801074000', feeBps: 100 }, await provider.quote(q.option), config);
    assert.equal(q.netPremiumPerWrappedUSDG, '500850');
    assert.equal(signedPricing.netPremiumUSDG, q.netPremiumPerWrappedUSDG);
  }
  t.mock.timers.setTime(1790364600000);
  await restarted.refresh();
  assert.equal(restarted.snapshot.quotes.length, 0);
});

test('a catalog from another chain cannot replace the published domain', () => {
  const service = new ReferenceService({ config: { chainId: rawCatalog.chainId, exchange: rawCatalog.exchange, usdg: rawCatalog.usdg } });
  assert.throws(() => service.validateCatalog({ ...rawCatalog, chainId: 196 }), /Wrong catalog domain/);
});

test('wide grids quote visible offers before candidates and publish without waiting for the batch', async t => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const catalog = structuredClone(rawCatalog), market = catalog.markets[0];
  market.rate = '1000000000000000000';
  market.series = [0, 1].flatMap(side => Array.from({ length: 13 }, (_, i) => ({
    id: String(side * 13 + i + 1), label: 'test', side, strikePricePerWrappedUSDG: String((200 + i * 5) * 1e6),
    tradeCutoff: '1791574200', exerciseStart: '1791574200', exerciseEnd: '1791576000',
  })));
  const calls = [], waiting = [];
  const service = new ReferenceService({
    config: { chainId: catalog.chainId, exchange: catalog.exchange, usdg: catalog.usdg,
      catalogRefreshMs: 300000, referenceIntervalMs: 30000, maxQuoteAgeSeconds: 30,
      markets: [{ vault: market.vault, symbol: 'NVDA', seriesIds: market.series.map(s => s.id) }] },
    prices: { get: () => ({ status: 'available', priceMicros: '228000000', fetchedAtMs: now, maxAgeMs: 60000 }) },
    chain: { referenceMarket: async () => ({ vault: market.vault, rate: market.rate, feeBps: 100, blockNumber: '1', observedAtMs: now }) },
    provider: { quote: option => { calls.push(option); return new Promise((_, reject) => waiting.push(() => reject(new NoQuote('NO_VALID_BID_HISTORY')))); } },
    fetcher: async () => new Response(JSON.stringify(catalog)),
  });
  const refresh = service.refresh();
  while (!waiting.length) await new Promise(r => setImmediate(r));
  assert.ok(service.snapshot); assert.equal(service.snapshot.markets.length, 1);
  // Continue the workers without real quotes; only the eligible nearby grid is touched.
  for (let i = 0; i < 10; i++) {
    while (waiting.length) waiting.shift()();
    await new Promise(r => setImmediate(r));
  }
  await refresh;
  assert.equal(calls.length, 10);
  assert.deepEqual(calls.slice(0, 6).map(o => `${o.right}:${o.strikeMilli}`),
    ['put:225000', 'put:220000', 'put:215000', 'call:230000', 'call:235000', 'call:240000']);
});
