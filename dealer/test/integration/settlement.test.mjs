import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { signQuote } from '../../../sdk/quotes.mjs';
import { configSchema } from '../../src/config.mjs';
import { SettlementChain } from '../../src/settlement-chain.mjs';
import { SettlementMonitor } from '../../src/settlement.mjs';
import { ManualSettlement } from '../../src/settlement-manual.mjs';

const require = createRequire(import.meta.url);
test('manual settlement against real EVM contracts: all four outcomes, funding, pauses, recovery and duplicate guards', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'payoff-settlement-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r));
  const binary = require.resolve(`@foundry-rs/anvil-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}/bin/anvil`);
  const processNode = spawn(binary, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  t.after(async () => { if (processNode.exitCode === null) { processNode.kill(); await new Promise(r => processNode.once('exit', r)); } });
  const rpc = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ chain: foundry, transport: http(rpc, { retryCount: 0, timeout: 1000 }), pollingInterval: 20 });
  for (let i = 0; i < 100; i++) { try { await client.getChainId(); break; } catch { await new Promise(r => setTimeout(r, 30)); } }
  const [admin, dealer, user] = [1, 2, 3].map(n => privateKeyToAccount(`0x${String(n).padStart(64, '0')}`));
  const wallets = [admin, dealer, user].map(account => createWalletClient({ account, chain: foundry, transport: http(rpc) }));
  for (const account of [admin, dealer, user]) await client.request({ method: 'anvil_setBalance', params: [account.address, '0x3635c9adc5dea00000'] });
  const artifact = async name => JSON.parse(await readFile(new URL(`../../../out/${name}.sol/${name}.json`, import.meta.url)));
  const receipt = hash => client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  const write = async (wallet, name, address, functionName, args) => {
    const r = await receipt(await wallet.writeContract({ address, abi: (await artifact(name)).abi, functionName, args }));
    assert.equal(r.status, 'success'); return r;
  };
  const deploy = async (name, args = []) => { const a = await artifact(name); return (await receipt(await wallets[0].deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }))).contractAddress; };
  const usd = await deploy('MockUSDG'), stock = await deploy('MockXStock'), wrapped = await deploy('MockWrappedXStock', [stock]);
  const exchange = await deploy('RFQExchange', [usd, admin.address, admin.address, 100]);
  const vault = await deploy('SeriesVault', [usd, wrapped, admin.address, exchange]);
  await write(wallets[0], 'RFQExchange', exchange, 'setVaultAllowed', [vault, true]);
  await write(wallets[0], 'RFQExchange', exchange, 'setDealerAllowed', [dealer.address, true]);
  const now = (await client.getBlock()).timestamp, start = now + 120n, end = now + 420n;
  for (const side of [0, 1]) await write(wallets[0], 'SeriesVault', vault, 'createSeries', [side, 220000000n, start, start, end]);
  for (const wallet of [wallets[1], wallets[2]]) {
    await write(wallets[0], 'MockUSDG', usd, 'mint', [wallet.account.address, 1000000000n]);
    await write(wallet, 'MockUSDG', usd, 'approve', [wallet === wallets[1] ? exchange : vault, maxUint256]);
  }
  await write(wallets[0], 'MockXStock', stock, 'mint', [user.address, 4n * 10n ** 18n]);
  await write(wallets[2], 'MockXStock', stock, 'approve', [wrapped, maxUint256]);
  await write(wallets[2], 'MockWrappedXStock', wrapped, 'deposit', [4n * 10n ** 18n, user.address]);
  await write(wallets[2], 'MockWrappedXStock', wrapped, 'approve', [vault, maxUint256]);
  for (let i = 1; i <= 4; i++) {
    const quote = { requestId: `0x${String(i).padStart(64, '0')}`, vault, dealer: dealer.address, taker: user.address,
      seriesId: i <= 2 ? 1n : 2n, wrappedQuantity: 10n ** 18n, strikeAmountUSDG: 220000000n,
      grossPremiumUSDG: 1000000n, protocolFeeUSDG: 10000n, netPremiumUSDG: 990000n, issuedAt: now, deadline: start - 1n, nonce: BigInt(i) };
    await write(wallets[2], 'RFQExchange', exchange, 'fill', [quote, await signQuote(dealer, 31337, exchange, quote),
      { minNetPremiumUSDG: 990000n, maxCollateralUSDG: maxUint256, maxCollateralWrapped: maxUint256 }]);
  }
  // None of these actual series is in the quote allowlist.
  const config = configSchema.parse({ chainId: 31337, exchange, usdg: usd, settlementConfirmations: 1,
    markets: [{ vault, stock, wrappedStock: wrapped, symbol: 'NVDA', seriesIds: ['999'] }] });
  const chain = new SettlementChain(config, rpc, dealer.address);
  const manual = new ManualSettlement({ chain, account: dealer, path: join(dir, 'tx.json') });
  const monitor = new SettlementMonitor({ config, chain, path: join(dir, 'monitor.json') });
  await monitor.refresh(); assert.equal(monitor.snapshot.markets[0].positions.length, 4);
  assert.ok(monitor.snapshot.alerts.some(a => a.code === 'WRAPPED_DELIVERY_SHORTFALL'));
  const action = id => ({ kind: 'exercise', vault, positionId: String(id) });
  assert.ok((await manual.plan(action(1))).issues.includes('WINDOW_NOT_OPEN'));
  assert.equal((await manual.execute(action(1))).status, 'blocked');
  // Fund inventory manually; the monitor never sends or approves transactions.
  await write(wallets[0], 'MockXStock', stock, 'mint', [dealer.address, 2n * 10n ** 18n]);
  await write(wallets[1], 'MockXStock', stock, 'approve', [wrapped, maxUint256]);
  await write(wallets[1], 'MockWrappedXStock', wrapped, 'deposit', [2n * 10n ** 18n, dealer.address]);
  for (const [asset, amount] of [['wrapped', String(2n * 10n ** 18n)], ['usdg', '440000000']]) {
    const approval = { kind: 'approve', vault, asset, amount };
    assert.deepEqual((await manual.plan(approval)).issues, []);
    assert.equal((await manual.execute(approval)).status, 'success');
  }
  // Disabling new trades never blocks settlement of existing positions.
  await write(wallets[0], 'RFQExchange', exchange, 'setDealerAllowed', [dealer.address, false]);
  await write(wallets[0], 'RFQExchange', exchange, 'setVaultAllowed', [vault, false]);
  await write(wallets[0], 'SeriesVault', vault, 'setNewPositionsPaused', [true]);
  let currentTime = Number(start + 1n) * 1000; t.mock.method(Date, 'now', () => currentTime);
  const advance = async value => { currentTime = Number(value) * 1000; await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(value)] }); await client.request({ method: 'evm_mine', params: [] }); };
  await advance(start + 1n);
  await monitor.refresh(); assert.ok(monitor.snapshot.alerts.some(a => a.code === 'MANUAL_EXERCISE_WINDOW_OPEN'));
  assert.equal(monitor.snapshot.markets[0].positions.every(p => p.state === 'open'), true);
  const wrongHolder = new SettlementChain(config, rpc, user.address);
  assert.ok((await wrongHolder.exercisePlan(vault, '1')).issues.includes('NOT_POSITION_HOLDER'));
  await assert.rejects(chain.exercisePlan(usd, '1'), /UNKNOWN_VAULT/);
  const balance = (token, account) => client.readContract({ address: token, abi: (token === usd ? usdAbi : wrappedAbi), functionName: 'balanceOf', args: [account] });
  const usdAbi = (await artifact('MockUSDG')).abi, wrappedAbi = (await artifact('MockWrappedXStock')).abi;
  const beforeUsd = await balance(usd, user.address), beforeWrapped = await balance(wrapped, user.address);
  for (const id of [1, 3]) {
    assert.deepEqual((await manual.plan(action(id))).issues, []);
    assert.equal((await manual.execute(action(id))).status, 'success');
    assert.equal((await manual.execute(action(id))).status, 'blocked');
    await write(wallets[2], 'SeriesVault', vault, 'claim', [BigInt(id)]);
  }
  assert.equal(await balance(usd, user.address), beforeUsd + 220000000n);
  assert.equal(await balance(wrapped, user.address), beforeWrapped + 10n ** 18n);
  await advance(end);
  for (const id of [2, 4]) {
    assert.ok((await manual.plan(action(id))).issues.includes('WINDOW_ENDED'));
    await write(wallets[2], 'SeriesVault', vault, 'claim', [BigInt(id)]);
  }
  assert.equal(await balance(usd, user.address), beforeUsd + 440000000n);
  assert.equal(await balance(wrapped, user.address), beforeWrapped + 2n * 10n ** 18n);
  const restarted = new SettlementMonitor({ config, chain, path: join(dir, 'monitor.json') });
  await restarted.start(); await restarted.stop();
  assert.ok(restarted.snapshot.markets[0].positions.every(p => p.state === 'claimed'));
  assert.equal((await manual.reconcile()).status, 'idle');
});
