import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TradingWallet } from '../src/lib/transactions';
import { activityKey, readActivity, recoverActivity, saveActivity } from '../src/lib/activity';
import { runtimeSchema } from '../src/lib/config';
import type { Connection } from '../src/lib/wallet';

const account = '0x0000000000000000000000000000000000001234' as const;
const to = '0x0000000000000000000000000000000000005678' as const;
const hash = `0x${'ab'.repeat(32)}` as const;
const config = runtimeSchema.parse({
  mode: 'gateway',
  chainId: 1952,
  rpcUrl: 'https://example.test',
  explorerUrl: 'https://example.test',
  gatewayUrl: 'https://api.payoff.finance',
  nvdaVault: to,
});
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let selected: string = account,
    chainId = '0x7a0',
    reject = false,
    sent = 0,
    pending = false;
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_accounts') return [selected];
      if (method === 'eth_chainId') return chainId;
      if (method === 'eth_sendTransaction') {
        if (reject) throw { code: 4001 };
        sent++;
        return hash;
      }
      throw new Error(method);
    },
  };
  const client = {
    estimateGas: async () => 100000n,
    waitForTransactionReceipt: async () => {
      if (pending) throw new Error('Timeout');
      return { transactionHash: hash, status: 'success', blockNumber: 10n, logs: [] };
    },
  };
  const connection = {
    kind: 'wallet',
    address: account,
    chainId: 1952,
    name: 'Test',
    provider,
  } as Connection;
  return {
    storage,
    client,
    connection,
    values,
    sent: () => sent,
    select: (next: string) => {
      selected = next;
    },
    network: (next: string) => {
      chainId = next;
    },
    reject: () => {
      reject = true;
    },
    pending: () => {
      pending = true;
    },
    trader: new TradingWallet(
      config,
      connection,
      storage,
      () => {},
      () => {},
      client as any,
    ),
  };
}
test('wallet checks account and network before sending, and rejected wallet requests create no fake receipt', async () => {
  const f = fixture();
  f.select(to);
  await assert.rejects(f.trader.send(to, '0x', 'approval', 'Approval'), /account changed/);
  f.select(account);
  f.network('0x1');
  await assert.rejects(f.trader.send(to, '0x', 'approval', 'Approval'), /Switch your wallet/);
  f.network('0x7a0');
  f.reject();
  await assert.rejects(f.trader.send(to, '0x', 'approval', 'Approval'));
  assert.equal(f.sent(), 0);
  assert.deepEqual(readActivity(f.storage, config, account), []);
});
test('receipt timeout retains the broadcast hash and blocks duplicate actions until chain recovery', async () => {
  const f = fixture();
  f.pending();
  await assert.rejects(f.trader.send(to, '0x1234', 'wrap', 'Wrapping'), /Transaction submitted/);
  assert.equal(readActivity(f.storage, config, account)[0].hash, hash);
  await assert.rejects(f.trader.send(to, '0x1234', 'wrap', 'Wrapping'), /still pending/);
  assert.equal(f.sent(), 1);
  const recovered = await recoverActivity(f.storage, config, account, {
    getTransactionReceipt: async () => ({ blockNumber: 10n, status: 'success' }),
    getTransaction: async () => ({ from: account, to, input: '0x1234', value: 0n }),
    getBlockNumber: async () => 11n,
  } as any);
  assert.equal(recovered[0].status, 'confirmed');
  assert.equal(readActivity(f.storage, config, to).length, 0);
});
test('recovery keeps unavailable receipts pending and distinguishes reverted or unrelated transactions', async () => {
  for (const status of ['missing', 'reverted', 'changed'] as const) {
    const f = fixture();
    saveActivity(f.storage, config, {
      hash,
      account,
      to,
      data: '0x',
      value: '0',
      kind: 'fill',
      status: 'pending',
      label: 'Opening',
      createdAt: Date.now(),
    });
    const recovered = await recoverActivity(f.storage, config, account, {
      getTransactionReceipt: async () => {
        if (status === 'missing') throw new Error('Not found');
        return { blockNumber: 10n, status: status === 'reverted' ? 'reverted' : 'success' };
      },
      getTransaction: async () => ({
        from: account,
        to,
        input: status === 'changed' ? '0x01' : '0x',
        value: 0n,
      }),
      getBlockNumber: async () => 11n,
    } as any);
    assert.equal(
      recovered[0].status,
      status === 'missing' ? 'pending' : status === 'changed' ? 'cancelled' : 'reverted',
    );
  }
});
test('demo mode cannot use the wallet sender and corrupt transaction records do not silently disappear', async () => {
  const f = fixture();
  const demo = new TradingWallet(
    { ...config, mode: 'demo' },
    f.connection,
    f.storage,
    () => {},
    () => {},
    f.client as any,
  );
  await assert.rejects(demo.send(to, '0x', 'fill', 'Opening'), /Connect a wallet/);
  f.values.set(activityKey(config, account), '{}');
  await assert.rejects(f.trader.send(to, '0x', 'fill', 'Opening'));
  assert.equal(f.sent(), 0);
});
test('blocked browser storage prevents broadcasting a transaction', async () => {
  const f = fixture();
  f.storage.setItem = () => {
    throw new Error('Quota exceeded');
  };
  await assert.rejects(f.trader.send(to, '0x', 'approval', 'Approval'), /Enable browser storage/);
  assert.equal(f.sent(), 0);
});
