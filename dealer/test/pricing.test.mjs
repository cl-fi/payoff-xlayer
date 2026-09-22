import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculatePremium, marketDataMode, optionFor, priceQuote, NoQuote } from '../src/pricing.mjs';

const config = { premiumBps: 5000, premiumBasis: 'net', maxQuoteAgeSeconds: 30, quoteTtlSeconds: 30 };
const now = Date.parse('2026-09-21T16:00:00Z');
const context = { symbol: 'NVDA', feeBps: 100, assetsPerWrapped: 10n ** 18n, stockQuantity: 10n ** 18n,
  terms: { side: 0, strikePricePerWrappedUSDG: 220000000n, tradeCutoff: 1790364600n, exerciseEnd: 1790366400n } };
const market = { symbol: 'NVDA', expiration: '2026-09-25', right: 'put', strikeMilli: '220000',
  bidMicros: '1000000', askMicros: '1100000', bidSize: 2, timestampMs: now,
  marketOpenMs: Date.parse('2026-09-21T13:30:00Z'), marketCloseMs: Date.parse('2026-09-21T20:00:00Z'),
  expirationCloseMs: Date.parse('2026-09-25T20:00:00Z') };
const code = expected => error => error instanceof NoQuote && error.code === expected;

test('bid $1 per share gives exactly $0.50 net; no spurious 100-share contract multiplier', () => {
  const q = priceQuote(context, market, config, now);
  assert.equal(q.netPremiumUSDG, '500000');
  assert.equal(BigInt(q.grossPremiumUSDG) * 100n / 10000n, BigInt(q.protocolFeeUSDG));
  assert.equal(BigInt(q.grossPremiumUSDG) - BigInt(q.protocolFeeUSDG), 500000n);
});
test('gross basis follows the existing fee; fractional quantities and rounding stay in integers', () => {
  assert.deepEqual(calculatePremium('1000000', 10n ** 18n, 100, { ...config, premiumBasis: 'gross' }),
    { grossPremiumUSDG: '500000', protocolFeeUSDG: '5000', netPremiumUSDG: '495000' });
  assert.equal(calculatePremium('1170000', 10n ** 16n, 100, config).netPremiumUSDG, '5850');
  for (const fee of [0, 1, 100, 9999]) {
    for (const amount of [2n, 3n, 198n, 199n, 1000001n, 9007199254740993n]) {
      const q = calculatePremium(amount, 10n ** 18n, fee, config);
      assert.equal(BigInt(q.netPremiumUSDG), amount / 2n);
      assert.equal(BigInt(q.grossPremiumUSDG) - BigInt(q.grossPremiumUSDG) * BigInt(fee) / 10000n, amount / 2n);
    }
  }
});
test('wrapped rate converts BOTH strike and quantity; put/call and expiry are exact', () => {
  const c = { ...context, assetsPerWrapped: 2n * 10n ** 18n, stockQuantity: 2n * 10n ** 18n,
    terms: { ...context.terms, side: 1 } };
  assert.deepEqual(optionFor(c), { symbol: 'NVDA', expiration: '2026-09-25', right: 'call', strikeMilli: '110000', strike: '110.000' });
  const result = priceQuote(c, { ...market, right: 'call', strikeMilli: '110000' }, config, now);
  assert.equal(result.netPremiumUSDG, '1000000');
  assert.throws(() => optionFor({ ...c, assetsPerWrapped: 1003000000000000000n }), code('NO_EXACT_STRIKE'));
});
test('invalid bids, future timestamps, wrong contracts and expiry mismatches still cannot be priced', () => {
  for (const [override, expected] of [
    [{ timestampMs: now + 2000 }, 'INVALID_MARKET_TIMESTAMP'],
    [{ timestampMs: market.marketOpenMs - 1 }, 'INVALID_MARKET_TIMESTAMP'],
    [{ bidMicros: '0' }, 'NO_VALID_BID'], [{ bidSize: 0 }, 'NO_VALID_BID'],
    [{ askMicros: '999999' }, 'NO_VALID_BID'], [{ right: 'call' }, 'MARKET_CONTRACT_MISMATCH'],
    [{ expiration: '2026-10-02' }, 'MARKET_CONTRACT_MISMATCH'],
    [{ expirationCloseMs: market.expirationCloseMs - 3600000 }, 'EXPIRY_TIME_MISMATCH'],
  ]) assert.throws(() => priceQuote(context, { ...market, ...override }, config, now), code(expected));
});
test('stale, overnight and weekend bids receive new short-lived quotes with original market timestamps', () => {
  for (const at of [now + 30000, Date.parse('2026-09-21T23:00:00Z'), Date.parse('2026-09-22T08:00:00Z')]) {
    assert.equal(priceQuote(context, market, config, at).netPremiumUSDG, '500000');
    assert.equal(priceQuote(context, market, config, at).deadline, String(at / 1000 + 30));
    assert.equal(marketDataMode(market, config, at), 'last_valid');
  }
  const friday = { ...market, timestampMs: Date.parse('2026-09-18T19:59:59Z'),
    marketOpenMs: Date.parse('2026-09-18T13:30:00Z'), marketCloseMs: Date.parse('2026-09-18T20:00:00Z') };
  assert.equal(priceQuote(context, friday, config, Date.parse('2026-09-20T12:00:00Z')).netPremiumUSDG, '500000');
  assert.equal(marketDataMode(market, config, now), 'live');
  assert.equal(market.timestampMs, now);
});
test('signature TTL crosses market close but never the series trading cutoff or option expiry', () => {
  assert.equal(priceQuote(context, { ...market, marketCloseMs: now + 5000 }, config, now).deadline, String(now / 1000 + 30));
  const closing = { ...context, terms: { ...context.terms, tradeCutoff: BigInt(now / 1000 + 5) } };
  assert.equal(priceQuote(closing, market, config, now).deadline, String(now / 1000 + 5));
  assert.throws(() => priceQuote(closing, market, config, now + 5000), code('QUOTE_WINDOW_TOO_SHORT'));
  assert.throws(() => priceQuote(context, market, config, market.expirationCloseMs), code('QUOTE_WINDOW_TOO_SHORT'));
});
