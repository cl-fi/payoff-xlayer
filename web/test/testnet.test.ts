import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult } from 'viem';
import deployment from '../../config/xlayer-testnet.json';
import { chainConfig, wrapperAbi, vaultAbi, exchangeAbi, tokenAbi } from '../src/lib/chain';
import { runtimeSchema } from '../src/lib/config';
import { TestnetAdapter } from '../src/lib/data/testnet';
import { previewOrder } from '../src/lib/amounts';
import { fixtureRpc, TEST_ACCOUNT, TEST_RATE, type RpcRequest } from './testnet-fixture';

const config = runtimeSchema.parse({
  mode: 'testnet',
  chainId: 1952,
  rpcUrl: deployment.rpcUrl,
  explorerUrl: deployment.explorerUrl,
  gatewayUrl: '',
  nvdaVault: deployment.markets[0].vault,
});
const client = (handler = fixtureRpc) =>
  createPublicClient({
    chain: chainConfig(config),
    transport: custom({ request: async (request) => handler(request as RpcRequest) }, { retryCount: 0 }),
  });

test('testnet discovers only the deployed catalog and reads fixed terms and balances without a gateway', async () => {
  const requests: RpcRequest[] = [];
  const adapter = new TestnetAdapter(
    config,
    client((request) => {
      requests.push(request);
      return fixtureRpc(request);
    }),
  );
  const market = await adapter.market();
  assert.deepEqual(
    market.series.map((s) => s.id),
    deployment.markets[0].seriesIds,
  );
  assert.equal(market.rate, TEST_RATE);
  assert.equal(market.series[0].strikePricePerWrappedUSDG, '220374264');
  assert.equal(market.series[7].strikePricePerWrappedUSDG, '245416794');
  assert.equal(market.series[15].exerciseEnd, '1790971200');
  assert.equal(market.feeBps, 1000);
  for (const request of requests.filter((r) => r.method === 'eth_call'))
    assert.equal(request.params?.[1], '0x100');
  const balances = await adapter.balances(TEST_ACCOUNT, market, market.series[0].vault);
  assert.equal(balances.usdg, '10000000');
  assert.equal(balances.stock, '50000000000000000000');
  assert.equal(balances.wrapped, '50000000000000000000');
  assert.equal(balances.okb, '200000000000000000');
  const preview = previewOrder('2', market.series[0], market, TEST_ACCOUNT);
  const nativeTargetTotal = 440000000n;
  const rounding = BigInt(preview.strikeAmountUSDG) - nativeTargetTotal;
  assert.ok(rounding >= 0n && rounding <= 2n, 'two NVDAx settle at 440 USDG, within micro-unit rounding');
  await assert.rejects(adapter.quote(preview, 'test-key'), /quote service is not connected/);
});

test('testnet fails closed on wrong network, token binding or wrapper rate', async () => {
  for (const fault of ['chain', 'binding', 'rate'] as const) {
    const adapter = new TestnetAdapter(
      config,
      client((request) => {
        if (fault === 'chain' && request.method === 'eth_chainId') return '0x1';
        if (request.method === 'eth_call') {
          const { data } = request.params![0] as { data: `0x${string}` };
          const { functionName } = decodeFunctionData({
            abi: [...vaultAbi, ...wrapperAbi, ...exchangeAbi, ...tokenAbi],
            data,
          });
          if (fault === 'binding' && functionName === 'stock')
            return encodeFunctionResult({ abi: vaultAbi, functionName: 'stock', result: TEST_ACCOUNT });
          if (fault === 'rate' && functionName === 'convertToAssets')
            return encodeFunctionResult({ abi: wrapperAbi, functionName: 'convertToAssets', result: 0n });
        }
        return fixtureRpc(request);
      }),
    );
    await assert.rejects(
      adapter.market(),
      fault === 'chain' ? /not connected/ : fault === 'binding' ? /bindings/ : /could not be verified/,
    );
  }
});

test('testnet refuses an unrelated configured vault', () => {
  assert.throws(() => runtimeSchema.parse({ ...config, nvdaVault: TEST_ACCOUNT }), /must use the Vault/);
});
