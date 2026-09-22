import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LastValidBidProvider } from '../src/market.mjs';
import { NoQuote } from '../src/pricing.mjs';

const now = Date.now();
const option = { symbol: 'NVDA', expiration: '2030-09-20', right: 'put', strikeMilli: '220000' };
const sample = { ...option, bidMicros: '1000000', askMicros: '1100000', bidSize: 5,
  timestampMs: now - 100000, marketOpenMs: now - 3600000, marketCloseMs: now - 60000,
  expirationCloseMs: now + 86400000 };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'payoff-bids-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bids.json');
  let current = sample;
  const upstream = { ready: true, close() {}, quote: async () => {
    if (current instanceof Error) throw current;
    return current;
  } };
  return { path, upstream, set(value) { current = value; }, provider: await LastValidBidProvider.open(upstream, path) };
}
test('last valid bid persists across restart and remains available while upstream is down', async t => {
  const f = await fixture(t);
  const first = await f.provider.quote(option);
  assert.equal(first.bidMicros, '1000000');
  f.set(new NoQuote('MARKET_DATA_TIMEOUT'));
  f.upstream.ready = false;
  const restarted = await LastValidBidProvider.open(f.upstream, f.path);
  assert.equal(restarted.ready, true);
  const reused = await restarted.quote(option);
  assert.equal(reused.timestampMs, sample.timestampMs);
  assert.equal(reused.bidMicros, first.bidMicros);
  assert.equal(reused.referenceSource, 'cache');
  assert.equal(reused.fallbackReason, 'MARKET_DATA_TIMEOUT');
  await assert.rejects(restarted.quote({ ...option, right: 'call' }), { code: 'NO_VALID_BID_HISTORY' });
  await assert.rejects(restarted.quote({ ...option, expiration: '2030-09-27' }), { code: 'NO_VALID_BID_HISTORY' });
  await assert.rejects(restarted.quote({ ...option, strikeMilli: '225000' }), { code: 'NO_VALID_BID_HISTORY' });
  await assert.rejects(restarted.quote({ ...option, symbol: 'INTC' }), { code: 'NO_VALID_BID_HISTORY' });
});
test('invalid or older incoming quotes cannot replace a valid bid; newer valid quote does', async t => {
  const f = await fixture(t);
  await f.provider.quote(option);
  for (const override of [{ bidMicros: '0' }, { bidSize: 0 }, { askMicros: '1' }, { right: 'call' },
    { timestampMs: now + 60000 }, { timestampMs: sample.timestampMs - 1, bidMicros: '900000' }]) {
    f.set({ ...sample, ...override });
    assert.equal((await f.provider.quote(option)).bidMicros, sample.bidMicros);
  }
  f.set({ ...sample, timestampMs: sample.timestampMs + 1000, bidMicros: '1050000' });
  assert.equal((await f.provider.quote(option)).bidMicros, '1050000');
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(saved.markets.length, 1);
  assert.equal(saved.markets[0].timestampMs, sample.timestampMs + 1000);
});
test('empty history declines and concurrent contracts are persisted without lost writes', async t => {
  const f = await fixture(t);
  f.set(new NoQuote('NO_VALID_BID_HISTORY'));
  await assert.rejects(f.provider.quote(option), { code: 'NO_VALID_BID_HISTORY' });
  let requests = 0;
  f.upstream.quote = async o => { requests++; return { ...sample, ...o }; };
  const call = { ...option, right: 'call' };
  await Promise.all([f.provider.quote(option), f.provider.quote(call), f.provider.quote(option)]);
  assert.equal(requests, 2);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).markets.length, 2);
});
