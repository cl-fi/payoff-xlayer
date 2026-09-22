import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData } from 'viem';
import { GatewayAdapter } from '../src/lib/data/gateway';
import { staticMarket } from '../src/lib/data/catalog';
import { getConfig } from '../src/lib/config';
import { previewOrder } from '../src/lib/amounts';
import { referenceEstimate } from '../src/lib/data/reference';
import { referenceFixture } from './reference-fixture';
import { fixtureRpc, TEST_ACCOUNT, TEST_NOW } from './testnet-fixture';
import { vaultAbi } from '../src/lib/chain';

test('published catalog needs no network; formal inquiry verifies only its selected series', async () => {
  const config = getConfig();
  const reads: string[] = [];
  const client = createPublicClient({
    transport: custom({
      request: async (request) => {
        if (request.method === 'eth_call') {
          try {
            const decoded = decodeFunctionData({ abi: vaultAbi, data: request.params![0].data });
            if (decoded.functionName === 'getSeries') reads.push(String(decoded.args![0]));
          } catch {
            /* Other verified asset bindings. */
          }
        }
        return fixtureRpc(request);
      },
    }),
  });
  const adapter = new GatewayAdapter(
    config,
    async () => {
      throw new Error('Unexpected HTTP request');
    },
    client as any,
  );
  const market = await adapter.market();
  assert.equal(market.series.length, 16);
  assert.deepEqual(reads, []);
  const preview = previewOrder('1', market.series[0], market, TEST_ACCOUNT);
  const checked = await adapter.selectedMarket(preview);
  assert.deepEqual(reads, ['5']);
  assert.equal(checked.series.length, 1);
  await assert.rejects(
    adapter.selectedMarket({ ...preview, series: { ...preview.series, strikePricePerWrappedUSDG: '1' } }),
    /terms changed/,
  );
});

test('reference estimates scale without a wallet and reject other terms, rates, future observations and closed series', () => {
  const market = staticMarket(getConfig());
  const snapshot = referenceFixture();
  const preview = previewOrder('2', market.series[0], market, TEST_ACCOUNT);
  const now = +TEST_NOW;
  const estimate = referenceEstimate(snapshot, preview, now)!;
  assert.equal(estimate.netPremiumUSDG, '1000000');
  assert.equal(estimate.live, false);
  assert.equal(referenceEstimate(snapshot, { ...preview, rate: '2000000000000000000' }, now), null);
  assert.equal(
    referenceEstimate(snapshot, { ...preview, series: { ...preview.series, side: 1 } }, now),
    null,
  );
  assert.equal(referenceEstimate(snapshot, preview, Number(preview.series.tradeCutoff) * 1000), null);
  assert.equal(referenceEstimate(snapshot, preview, now + 100000)?.delayed, true);
  const q = snapshot.quotes[0];
  if (q.status === 'available') {
    q.marketTimestampMs = now + 10000;
    assert.equal(referenceEstimate(snapshot, preview, now), null);
    q.marketTimestampMs = now;
    q.marketOpenMs = now - 1000;
    q.marketCloseMs = now + 100000;
    q.marketDataMode = 'live';
    assert.equal(referenceEstimate(snapshot, preview, now)?.live, true);
    assert.equal(referenceEstimate(snapshot, preview, now + 31000)?.live, false);
  }
});
