import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPositions } from '../src/lib/data/positions';
import { getConfig } from '../src/lib/config';
import type { Market } from '../src/lib/types';

test('position discovery respects the public 100-block limit and recovers old series without local storage', async () => {
  const config = { ...getConfig(), deploymentBlock: '1' };
  const account = '0x0000000000000000000000000000000000001234';
  const other = '0x0000000000000000000000000000000000005678';
  const market = { exchange: other } as Market;
  const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlock: async ({ blockHash }: any = {}) => ({ number: 1000n, timestamp: blockHash ? 100n : 1000n }),
    readContract: async ({ functionName, args }: any) => {
      if (functionName === 'nextPositionId') return 3n;
      if (functionName === 'position')
        return {
          shortHolder: account,
          seriesId: 1n,
          wrappedQuantity: 100n,
          strikeAmountUSDG: 220n,
          state: args[0] === 1n ? 2 : 1,
        };
      if (functionName === 'getSeries')
        return {
          side: 0,
          strikePricePerWrappedUSDG: 220000000n,
          tradeCutoff: 900n,
          exerciseStart: 900n,
          exerciseEnd: 999n,
        };
      throw new Error(functionName);
    },
    getLogs: async (range: any) => {
      calls.push(range);
      assert.ok(range.toBlock - range.fromBlock < 100n);
      return [850n, 650n].flatMap((height, i) =>
        height >= range.fromBlock && height <= range.toBlock
          ? [
              {
                removed: false,
                blockHash: `0x${'ab'.repeat(32)}`,
                transactionHash: `0x${String(i + 1).repeat(64)}`,
                args: { positionId: BigInt(i + 1), taker: account, netPremiumUSDG: 5n },
              },
            ]
          : [],
      );
    },
  };
  const result = await readPositions(config, account, market, client as any);
  assert.equal(calls.length, 4); // All positions found; do not query the old empty deployment history.
  assert.deepEqual(
    result.map((p) => [p.id, p.status]),
    [
      ['2', 'expired'],
      ['1', 'exercised'],
    ],
  );
  assert.equal(result[0].series.id, '1');
  assert.equal(result[0].netPremiumUSDG, '5');
  client.getLogs = async () => [];
  await assert.rejects(
    readPositions({ ...config, deploymentBlock: '950' }, account, market, client as any),
    /Incomplete/,
  );
});
