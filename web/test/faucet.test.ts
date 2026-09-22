import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import deployment from '../../config/xlayer-testnet.json';
import { parseFaucetAmount } from '../src/lib/faucet';
import { TradingWallet } from '../src/lib/transactions';
import { getConfig } from '../src/lib/config';
import { staticMarket } from '../src/lib/data/catalog';
import { faucetAbi } from '../src/lib/chain';
import { readActivity } from '../src/lib/activity';

test('faucet amounts preserve six decimals and allow large quantities without an application quota', () => {
  assert.equal(parseFaucetAmount('0.000001'), 1n);
  assert.equal(parseFaucetAmount('10000'), 10_000_000_000n);
  assert.equal(parseFaucetAmount('1000000000000.123456'), 1000000000000123456n);
  for (const input of ['', '0', '-1', '1e6', '1.0000001', 'NaN', String(2n ** 256n)])
    assert.throws(() => parseFaucetAmount(input));
});

test('faucet mints the chosen amount to the current token, records its receipt and rejects foreign deployments', async () => {
  const config = { ...getConfig(), mode: 'gateway' as const };
  const market = staticMarket(config);
  const address = '0x0000000000000000000000000000000000001234' as const;
  const hash = `0x${'fa'.repeat(32)}` as const;
  const saved = new Map();
  const storage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => saved.set(k, v),
  };
  const sent: any[] = [];
  let symbol = 'tUSDG';
  const provider = {
    request: async ({ method, params }: any) => {
      if (method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return '0x7a0';
      if (method === 'eth_sendTransaction') {
        sent.push(params[0]);
        return hash;
      }
      throw new Error(method);
    },
  };
  const client = {
    readContract: async ({ functionName }: any) => (functionName === 'symbol' ? symbol : 6),
    estimateGas: async () => 100000n,
    waitForTransactionReceipt: async () => ({
      transactionHash: hash,
      status: 'success',
      blockNumber: 1n,
      logs: [],
    }),
  };
  const wallet = new TradingWallet(
    config,
    { kind: 'wallet', address, chainId: 1952, name: 'Test', provider } as any,
    storage,
    () => {},
    () => {},
    client as any,
  );
  await wallet.faucet(market, 12_345_678n);
  assert.equal(sent[0].to.toLowerCase(), deployment.usdg.toLowerCase());
  assert.deepEqual(decodeFunctionData({ abi: faucetAbi, data: sent[0].data }), {
    functionName: 'faucet',
    args: [12_345_678n],
  });
  assert.equal(readActivity(storage, config, address)[0].kind, 'faucet');
  assert.equal(readActivity(storage, config, address)[0].status, 'confirmed');
  await assert.rejects(wallet.faucet({ ...market, usdg: address }, 1n), /does not match/);
  await assert.rejects(wallet.faucet(market, 0n), /does not match/);
  symbol = 'USDG';
  await assert.rejects(wallet.faucet(market, 1n), /unavailable/);
  assert.equal(sent.length, 1);
});
