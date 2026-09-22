import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { buildDealerApp } from '../src/app.mjs';
import { quoteTypedData } from '../../sdk/quotes.mjs';
import { NoQuote } from '../src/pricing.mjs';

test('authenticated dealer emits gateway-compatible EIP-712 quotes and refuses mismatched/failed requests', async t => {
  const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`); // Public test key; never fund.
  const exchange = '0x0000000000000000000000000000000000000010';
  const vault = '0x0000000000000000000000000000000000000020';
  const now = Date.now();
  const context = { symbol: 'NVDA', feeBps: 100, assetsPerWrapped: 10n ** 18n, stockQuantity: 10n ** 18n,
    blockNumber: 1n, timestamp: String(Math.floor(now / 1000)), strikeAmountUSDG: '220000000',
    terms: { side: 0, strikePricePerWrappedUSDG: 220000000n, tradeCutoff: BigInt(Math.floor(now / 1000) + 600), exerciseEnd: 1790366400n } };
  let fail = false;
  const provider = { ready: true, quote: async () => {
    if (fail) throw new NoQuote('MARKET_DATA_UNAVAILABLE');
    return { symbol: 'NVDA', expiration: '2026-09-25', right: 'put', strikeMilli: '220000',
      bidMicros: '1000000', askMicros: '1100000', bidSize: 1, timestampMs: now,
      marketOpenMs: now - 10000, marketCloseMs: now + 600000, expirationCloseMs: 1790366400000 };
  } };
  const config = { chainId: 1952, exchange, premiumBps: 5000, premiumBasis: 'net', maxQuoteAgeSeconds: 30, quoteTtlSeconds: 30 };
  const app = await buildDealerApp({ account, config, token: 'secret', provider,
    chain: { health: async () => {}, context: async () => context, funded: async () => {} } });
  t.after(() => app.close());
  const payload = { version: '1', requestId: `0x${'ab'.repeat(32)}`, chainId: 1952, exchange,
    order: { taker: account.address, vault, seriesId: '5', wrappedQuantity: '1000000000000000000' },
    snapshot: { terms: { strikePricePerWrappedUSDG: '1' }, feeBps: 0 }, collectUntil: new Date(now + 10000).toISOString() };
  const post = (body = payload, authorization = 'Bearer secret') => app.inject({ method: 'POST', url: '/quote', headers: { authorization }, payload: body });
  assert.equal((await post(payload, 'Bearer wrong')).statusCode, 401);
  const result = (await post()).json();
  assert.equal(result.status, 'quote'); assert.equal(result.quote.netPremiumUSDG, '500000');
  assert.equal(result.quote.strikeAmountUSDG, '220000000'); assert.notEqual(result.quote.protocolFeeUSDG, '0');
  assert.equal(await recoverTypedDataAddress({ ...quoteTypedData(1952, exchange, result.quote), signature: result.signature }), account.address);
  assert.notEqual((await post()).json().quote.nonce, result.quote.nonce);
  assert.equal((await post({ ...payload, chainId: 196 })).json().reason, 'WRONG_DOMAIN');
  fail = true;
  assert.deepEqual((await post()).json(), { status: 'no_quote', reason: 'MARKET_DATA_UNAVAILABLE' });
  assert.equal((await post({ ...payload, collectUntil: new Date(now - 1).toISOString() })).json().reason, 'COLLECTION_EXPIRED');
});
