import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPositions } from '../src/lib/data/positions';
import { getConfig } from '../src/lib/config';
import type { Market } from '../src/lib/types';

const config = getConfig();
const account = '0x0000000000000000000000000000000000001234';
const exchange = '0x0000000000000000000000000000000000005678';
const market = { exchange } as Market;

function mockClient(ids: bigint[], shortHolder = account) {
  const multicalls: string[] = [];
  const read = (address: string, functionName: string, args: any[]) => {
    if (functionName === 'positionIdsOf') {
      assert.equal(address, config.nvdaVault);
      assert.equal(args[0], account);
      return ids.slice(Number(args[1]), Number(args[1] + args[2]));
    }
    if (functionName === 'position') {
      assert.equal(address, config.nvdaVault);
      return {
        seriesId: 1n,
        shortHolder,
        longHolder: exchange,
        wrappedQuantity: 100n,
        strikeAmountUSDG: 220n,
        wrappedBalance: 0n,
        state: args[0] === 1n ? 2 : 1,
        openedAt: 100n * args[0],
      };
    }
    if (functionName === 'netPremiumOf') {
      assert.equal(address, exchange);
      assert.equal(args[0], config.nvdaVault);
      return 5n * args[1];
    }
    if (functionName === 'getSeries')
      return {
        side: 0,
        strikePricePerWrappedUSDG: 220000000n,
        tradeCutoff: 900n,
        exerciseStart: 900n,
        exerciseEnd: 999n,
      };
    throw new Error(functionName);
  };
  return {
    multicalls,
    getBlock: async () => ({ number: 1000n, timestamp: 1000n }),
    readContract: async ({ address, functionName, args }: any) => read(address, functionName, args),
    multicall: async ({ contracts, blockNumber, allowFailure }: any) => {
      assert.equal(blockNumber, 1000n);
      assert.equal(allowFailure, false);
      multicalls.push(contracts[0].functionName);
      return contracts.map((c: any) => read(c.address, c.functionName, c.args));
    },
    getLogs: async () => {
      throw new Error('Position discovery must not scan event logs');
    },
  };
}

test('an empty wallet renders without any batched reads', async () => {
  const client = mockClient([]);
  assert.deepEqual(await readPositions(config, account, market, client as any), []);
  assert.deepEqual(client.multicalls, []);
});

test('positions come from the holder index, the premium record and pinned block reads', async () => {
  const client = mockClient([1n, 2n]);
  const result = await readPositions(config, account, market, client as any);
  assert.deepEqual(
    result.map((p) => [p.id, p.status, p.openedAt, p.netPremiumUSDG]),
    [
      ['2', 'expired', 200, '10'],
      ['1', 'exercised', 100, '5'],
    ],
  );
  assert.equal(result[0].series.id, '1');
  assert.equal(result[0].series.days, 1);
  assert.equal(result[0].vault, config.nvdaVault);
  assert.deepEqual(client.multicalls.sort(), ['getSeries', 'netPremiumOf', 'position']);
});

test('the holder index is paged and every page is read', async () => {
  const ids = Array.from({ length: 501 }, (_, i) => BigInt(i + 1));
  const client = mockClient(ids);
  const result = await readPositions(config, account, market, client as any);
  assert.equal(result.length, 501);
  assert.equal(result[0].id, '501');
});

test('a position whose short holder is another wallet is rejected', async () => {
  const client = mockClient([1n], exchange);
  await assert.rejects(readPositions(config, account, market, client as any), /owner mismatch/);
});
