import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeFunctionData, http, maxUint256, type Address, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { configSchema } from '../../src/config.js';
import { RpcChain } from '../../src/chain.js';
import { Gateway } from '../../src/gateway.js';
import { buildApp } from '../../src/app.js';
import { GatewayError } from '../../src/errors.js';
import { db, dealer, dealerServer, json, makerA, makerB, signed, user } from '../helpers.js';
import { quoteDigest, signQuote } from '../../../sdk/quotes.mjs';
// The dealer is a separate Node service; exercise its real signer and chain reader here.
// @ts-ignore JavaScript service entry point
import { buildDealerApp } from '../../../dealer/src/app.mjs';
// @ts-ignore JavaScript service entry point
import { DealerChain } from '../../../dealer/src/chain.mjs';
import { TradingWallet } from '../../../web/src/lib/transactions.js';
import { readPositions } from '../../../web/src/lib/data/positions.js';
import { readActivity } from '../../../web/src/lib/activity.js';
import { previewOrder } from '../../../web/src/lib/amounts.js';
import { readOnchainMarket } from '../../../web/src/lib/data/onchain.js';
import type { Config } from '../../../web/src/lib/config.js';
import type { Connection } from '../../../web/src/lib/wallet.js';
import type { GatewayAdapter } from '../../../web/src/lib/data/gateway.js';

const require = createRequire(import.meta.url);
async function artifact(name: string) {
  return JSON.parse(await readFile(new URL(`../../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
}
async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const p = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return p;
}
test('gateway against deployed contracts on a local Anvil EVM', { timeout: 120000 }, async t => {
  const number = await port();
  const platform = `@foundry-rs/anvil-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const binary = require.resolve(`${platform}/bin/anvil`);
  const node = spawn(binary, ['--host', '127.0.0.1', '--port', String(number), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  let spawnError: Error | undefined; node.once('error', e => { spawnError = e; });
  t.after(async () => { if (node.exitCode === null) { node.kill('SIGTERM'); await new Promise<void>(resolve => node.once('exit', () => resolve())); } });
  const rpc = `http://127.0.0.1:${number}`;
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpc, { retryCount: 0, timeout: 1000 }), pollingInterval: 20 });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (spawnError) throw spawnError;
    try { await publicClient.getChainId(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  assert.ok(ready, 'Anvil did not start');
  const owner = createWalletClient({ account: makerA, chain: foundry, transport: http(rpc) });
  const second = createWalletClient({ account: makerB, chain: foundry, transport: http(rpc) });
  const taker = createWalletClient({ account: user, chain: foundry, transport: http(rpc) });
  for (const account of [makerA, makerB, user]) await publicClient.request({ method: 'anvil_setBalance' as any, params: [account.address, '0x3635c9adc5dea00000'] as any });
  const receipt = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  const deploy = async (name: string, args: any[] = []): Promise<Address> => {
    const a = await artifact(name);
    const result = await receipt(await owner.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }));
    assert.equal(result.status, 'success'); return result.contractAddress!;
  };
  const write = async (client: typeof owner | typeof second | typeof taker, name: string, address: Address, functionName: string, args: any[] = []) => {
    const result = await receipt(await client.writeContract({ address, abi: (await artifact(name)).abi, functionName, args }));
    assert.equal(result.status, 'success'); return result;
  };
  const usd = await deploy('MockUSDG'); const stock = await deploy('MockXStock');
  const wrapped = await deploy('MockWrappedXStock', [stock]);
  const feeRecipient = '0x00000000000000000000000000000000000000F0';
  const exchange = await deploy('RFQExchange', [usd, makerA.address, feeRecipient, 100]);
  const vault = await deploy('SeriesVault', [usd, wrapped, makerA.address, exchange]);
  await write(owner, 'RFQExchange', exchange, 'setVaultAllowed', [vault, true]);
  for (const account of [makerA, makerB]) await write(owner, 'RFQExchange', exchange, 'setDealerAllowed', [account.address, true]);
  const now = (await publicClient.getBlock()).timestamp;
  for (const side of [0, 1]) await write(owner, 'SeriesVault', vault, 'createSeries', [side, 180000000n, now + 3600n, now + 4000n, now + 4300n]);
  for (const account of [makerA, makerB, user]) await write(owner, 'MockUSDG', usd, 'mint', [account.address, 10000000000n]);
  await write(owner, 'MockXStock', stock, 'mint', [user.address, 100n * 10n ** 18n]);
  await write(taker, 'MockXStock', stock, 'approve', [wrapped, maxUint256]);
  await write(taker, 'MockWrappedXStock', wrapped, 'deposit', [100n * 10n ** 18n, user.address]);
  await write(taker, 'MockWrappedXStock', wrapped, 'approve', [vault, maxUint256]);
  await write(taker, 'MockUSDG', usd, 'approve', [vault, maxUint256]);
  for (const client of [owner, second]) await write(client, 'MockUSDG', usd, 'approve', [exchange, maxUint256]);

  const database = await db(); t.after(database.close);
  let mode = 'normal';
  const a = await dealerServer(async (r, res) => {
    const response = await signed(r, '3000000');
    if (mode === 'bad-signature') response.signature = await signQuote(makerB, r.chainId, r.exchange, response.quote);
    if (mode === 'wrong-domain') response.signature = await signQuote(makerA, 196, r.exchange, response.quote);
    if (mode === 'expired') { response.quote.deadline = response.quote.issuedAt; response.signature = await signQuote(makerA, r.chainId, r.exchange, response.quote); }
    json(res, { status: 'quote', ...response });
  }); t.after(a.close);
  const b = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r, '2000000', makerB) })); t.after(b.close);
  const cfg = configSchema.parse({ chainId: 31337, exchange, usdg: usd, markets: [{ vault, seriesIds: ['1', '2'] }],
    dealers: [dealer('a', a.url), dealer('b', b.url, makerB)], collectMs: 1500, requestTimeoutMs: 15000, confirmations: 1 });
  const chain = new RpcChain(cfg, rpc); const gateway = new Gateway(cfg, chain, database.store);
  const app = await buildApp(gateway); t.after(() => app.close());
  const order = { taker: user.address, vault, seriesId: '1', wrappedQuantity: '1000000000000000000' };
  const rfq = async (input = order) => {
    const response = await app.inject({ method: 'POST', url: '/v1/rfqs', headers: { 'idempotency-key': randomUUID() }, payload: input });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  await t.test('startup checks the configured chain and Exchange', async () => {
    await chain.health();
    await assert.rejects(new RpcChain({ ...cfg, chainId: 196 }, rpc).health(), (e: GatewayError) => e.code === 'WRONG_CHAIN');
  });
  await t.test('signed put quote is simulated, filled by the taker and verified from its receipt', async () => {
    const result = await rfq(); assert.equal(result.status, 'quoted', JSON.stringify(result)); assert.equal(result.selection.dealerId, 'a');
    const prepared = await gateway.prepare(result.requestId); assert.equal(prepared.selection.transaction.data, result.selection.transaction.data);
    const tx = await taker.sendTransaction({ to: exchange, data: result.selection.transaction.data, value: 0n });
    await receipt(tx);
    const observed = await gateway.transaction(result.requestId, tx);
    assert.equal(observed.status, 'confirmed'); assert.equal(observed.positionId, '1');
    await assert.rejects(gateway.prepare(result.requestId), (e: GatewayError) => e.code === 'NONCE_UNAVAILABLE');
  });
  await t.test('call quote locks the exact wrapped quantity and settles its premium atomically', async () => {
    const result = await rfq({ ...order, seriesId: '2' }); assert.equal(result.status, 'quoted', JSON.stringify(result));
    const tx = await taker.sendTransaction({ to: exchange, data: result.selection.transaction.data, value: 0n }); await receipt(tx);
    assert.equal((await gateway.transaction(result.requestId, tx)).status, 'confirmed');
    const position = await publicClient.readContract({ address: vault, abi: (await artifact('SeriesVault')).abi, functionName: 'position', args: [2n] }) as any;
    assert.equal(position.wrappedQuantity, 10n ** 18n); assert.equal(position.wrappedBalance, 10n ** 18n);
  });
  await t.test('50%-bid dealer uses prior-session bids for both sides, signs, simulates and executes', async () => {
    const dealerConfig = { ...cfg, markets: [{ vault, stock, wrappedStock: wrapped, symbol: 'NVDA', seriesIds: ['1', '2'] }],
      premiumBps: 5000, premiumBasis: 'net', quoteTtlSeconds: 30, maxQuoteAgeSeconds: 30 };
    const dealerChain = new DealerChain(dealerConfig, rpc, makerB.address);
    await dealerChain.health();
    const makerApp = await buildDealerApp({ config: dealerConfig, chain: dealerChain, account: makerB, token: 'integration-token',
      provider: { ready: true, quote: async (option: any) => ({ ...option, bidMicros: '1000000', askMicros: '1100000', bidSize: 5,
        timestampMs: Date.now() - 86400000, marketOpenMs: Date.now() - 90000000, marketCloseMs: Date.now() - 82800000,
        expirationCloseMs: Number(now + 4300n) * 1000 }) } });
    await makerApp.listen({ host: '127.0.0.1', port: 0 });
    try {
      const url = `http://127.0.0.1:${(makerApp.server.address() as { port: number }).port}/quote`;
      const g = new Gateway({ ...cfg, dealers: [{ ...dealer('real-service', url, makerB), bearerTokenEnv: 'TOKEN' }] },
        chain, database.store, new Map([['real-service', 'integration-token']]));
      for (const seriesId of ['1', '2']) {
        const result = (await g.create({ ...order, seriesId }, randomUUID())).body as any;
        assert.equal(result.status, 'quoted', JSON.stringify(result));
        assert.equal(result.selection.quote.netPremiumUSDG, '500000');
        const tx = await taker.sendTransaction({ to: exchange, data: result.selection.transaction.data, value: 0n });
        assert.equal((await receipt(tx)).status, 'success');
        assert.equal((await g.transaction(result.requestId, tx)).status, 'confirmed');
      }
    } finally { await makerApp.close(); }
  });
  for (const testMode of ['bad-signature', 'wrong-domain', 'expired']) {
    await t.test(`${testMode} higher bid loses to a valid lower bid`, async () => {
      mode = testMode;
      try { const result = await rfq(); assert.equal(result.selection.dealerId, 'b', JSON.stringify(result)); }
      finally { mode = 'normal'; }
    });
  }
  await t.test('dealer removed from whitelist is rejected', async () => {
    await write(owner, 'RFQExchange', exchange, 'setDealerAllowed', [makerA.address, false]);
    try { assert.equal((await rfq()).selection.dealerId, 'b'); }
    finally { await write(owner, 'RFQExchange', exchange, 'setDealerAllowed', [makerA.address, true]); }
  });
  await t.test('revoked allowance and empty balance both prevent selection', async () => {
    await write(owner, 'MockUSDG', usd, 'approve', [exchange, 0n]);
    try { const result = await rfq(); assert.equal(result.selection.dealerId, 'b'); assert.equal(result.responses[0].code, 'DEALER_ALLOWANCE'); }
    finally { await write(owner, 'MockUSDG', usd, 'approve', [exchange, maxUint256]); }
    const balance = await publicClient.readContract({ address: usd, abi: (await artifact('MockUSDG')).abi, functionName: 'balanceOf', args: [makerA.address] }) as bigint;
    await write(owner, 'MockUSDG', usd, 'transfer', [feeRecipient, balance]);
    try { const result = await rfq(); assert.equal(result.selection.dealerId, 'b'); assert.equal(result.responses[0].code, 'DEALER_BALANCE'); }
    finally { await write(owner, 'MockUSDG', usd, 'mint', [makerA.address, 10000000000n]); }
  });
  await t.test('nonce cancellation after selection is discovered by prepare', async () => {
    const result = await rfq();
    await write(owner, 'RFQExchange', exchange, 'cancelNonce', [BigInt(result.selection.quote.nonce)]);
    await assert.rejects(gateway.prepare(result.requestId), (e: GatewayError) => e.code === 'NONCE_UNAVAILABLE');
  });
  await t.test('full simulation detects abnormal token transfers even when balances and allowances pass', async () => {
    await write(owner, 'MockUSDG', usd, 'setTransferFee', [true]);
    try { const result = await rfq(); assert.equal(result.status, 'no_quote'); assert.ok(result.responses.every((r: any) => r.code === 'SIMULATION_REVERTED')); }
    finally { await write(owner, 'MockUSDG', usd, 'setTransferFee', [false]); }
  });
  await t.test('ERC-1271 maker wallet is accepted using the same on-chain validation semantics', async () => {
    const wallet = await deploy('MockDealerWallet');
    await write(owner, 'RFQExchange', exchange, 'setDealerAllowed', [wallet, true]);
    await write(owner, 'MockUSDG', usd, 'mint', [wallet, 1000000000n]);
    await write(owner, 'MockDealerWallet', wallet, 'execute', [usd, encodeFunctionData({ abi: (await artifact('MockUSDG')).abi, functionName: 'approve', args: [exchange, maxUint256] })]);
    const endpoint = await dealerServer(async (r, res) => {
      const response = await signed(r, '4000000', makerA, { dealer: wallet });
      await write(owner, 'MockDealerWallet', wallet, 'approveDigest', [quoteDigest(r.chainId, r.exchange, response.quote), true]);
      response.signature = '0x'; json(res, { status: 'quote', ...response });
    });
    try {
      const walletConfig = { ...cfg, dealers: [{ ...dealer('wallet', endpoint.url), address: wallet }] };
      const g = new Gateway(walletConfig, chain, database.store);
      const result = (await g.create(order, randomUUID())).body as any; assert.equal(result.status, 'quoted', JSON.stringify(result));
      const tx = await taker.sendTransaction({ to: exchange, data: result.selection.transaction.data, value: 0n }); await receipt(tx);
      assert.equal((await g.transaction(result.requestId, tx)).status, 'confirmed');
    } finally { await endpoint.close(); }
  });
  await t.test('unrelated transaction cannot be registered as a fill; an actual reverted fill is reported as reverted', async () => {
    const result = await rfq();
    const unrelated = await write(owner, 'MockUSDG', usd, 'mint', [user.address, 1n]);
    await assert.rejects(gateway.transaction(result.requestId, unrelated.transactionHash), (e: GatewayError) => e.code === 'TRANSACTION_MISMATCH');
    await write(owner, 'RFQExchange', exchange, 'cancelNonce', [BigInt(result.selection.quote.nonce)]);
    const tx = await taker.sendTransaction({ to: exchange, data: result.selection.transaction.data, value: 0n, gas: 800000n });
    assert.equal((await receipt(tx)).status, 'reverted'); assert.equal((await gateway.transaction(result.requestId, tx)).status, 'reverted');
  });
  await t.test('frontend wallet wraps, approves, fills both sides, recovers positions, and claims exercise/expiry proceeds', async () => {
    const c = { mode: 'gateway', chainId: 31337, rpcUrl: rpc, explorerUrl: 'https://example.test', gatewayUrl: '', nvdaVault: vault, deploymentBlock: '0' } as unknown as Config;
    const market = await readOnchainMarket(c, { chainId: 31337, exchange, usdg: usd, markets: [{ vault, seriesIds: ['1', '2'] }] }, publicClient as any);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const provider = { request: async ({ method, params }: any) => {
      if (method === 'eth_accounts') return [user.address];
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_sendTransaction') {
        const tx = params[0];
        return taker.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gas: BigInt(tx.gas) });
      }
      throw new Error(`Unexpected wallet method ${method}`);
    } };
    const connection = { kind: 'wallet', address: user.address, chainId: 31337, name: 'Anvil wallet', provider } as Connection;
    const confirmingClient = { ...publicClient, waitForTransactionReceipt: async (options: any) => {
      await publicClient.waitForTransactionReceipt({ ...options, confirmations: 1, pollingInterval: 20 });
      await publicClient.request({ method: 'evm_mine' as any, params: [] as any });
      return publicClient.waitForTransactionReceipt({ ...options, pollingInterval: 20 });
    } };
    {
      const trader = new TradingWallet(c, connection, storage, () => {}, () => {}, confirmingClient as any);
      await write(taker, 'MockUSDG', usd, 'approve', [vault, 0n]);
      const wrappedBalance = await publicClient.readContract({ address: wrapped, abi: (await artifact('MockWrappedXStock')).abi, functionName: 'balanceOf', args: [user.address] }) as bigint;
      await write(taker, 'MockWrappedXStock', wrapped, 'transfer', [feeRecipient, wrappedBalance]);
      await write(taker, 'MockWrappedXStock', wrapped, 'approve', [vault, 0n]);
      await write(taker, 'MockXStock', stock, 'approve', [wrapped, 0n]);
      await write(owner, 'MockXStock', stock, 'mint', [user.address, 10n ** 18n]);
      const opened = [];
      const adapter = { prepare: async (q: any) => ({ kind: 'gateway', requestId: q.requestId, selection: (await gateway.prepare(q.requestId)).selection }),
        settlement: (id: any, hash: any) => gateway.transaction(id, hash) } as unknown as GatewayAdapter;
      for (const series of market.series) {
        const preview = previewOrder('0.001', series, market, user.address);
        await trader.prepareAssets(preview, market);
        const result = (await gateway.create(preview.order, randomUUID())).body as any;
        assert.equal(result.status, 'quoted');
        opened.push(await trader.fill(adapter, preview, { kind: 'gateway', requestId: result.requestId, selection: result.selection }, market));
      }
      const recovered = await readPositions(c, user.address, market, publicClient as any);
      for (const p of opened) assert.ok(recovered.some(r => r.id === p.id && r.netPremiumUSDG === p.netPremiumUSDG));
      assert.equal(readActivity(storage, c, user.address).some(tx => tx.status === 'pending'), false);
      assert.ok(readActivity(storage, c, user.address).some(tx => tx.kind === 'wrap'));
      await publicClient.request({ method: 'evm_setNextBlockTimestamp' as any, params: [Number(now + 4000n)] as any });
      await publicClient.request({ method: 'evm_mine' as any, params: [] as any });
      await write(owner, 'MockUSDG', usd, 'approve', [vault, 180000n]);
      await write(owner, 'SeriesVault', vault, 'exercise', [BigInt(opened[1].id)]);
      await trader.claim(opened[1]);
      await publicClient.request({ method: 'evm_setNextBlockTimestamp' as any, params: [Number(now + 4300n)] as any });
      await publicClient.request({ method: 'evm_mine' as any, params: [] as any });
      await trader.claim(opened[0]);
      const claimed = await readPositions(c, user.address, market, publicClient as any);
      for (const p of opened) assert.equal(claimed.find(r => r.id === p.id)?.status, 'claimed');
    }
  });
});
