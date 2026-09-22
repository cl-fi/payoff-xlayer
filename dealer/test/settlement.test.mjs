import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';
import { SettlementMonitor, settlementStatus } from '../src/settlement.mjs';
import { ManualSettlement } from '../src/settlement-manual.mjs';
import { buildDealerApp } from '../src/app.mjs';

const cfg = { chainId: 1952, settlementMinGasWei: '100', settlementWarningSeconds: 100, settlementIntervalMs: 1000, settlementConfirmations: 2 };
const position = (id, side, state = 1) => ({ id, seriesId: id, state, wrappedQuantity: '5', strikeAmountUSDG: '200', terms: { side, exerciseStart: '1100', exerciseEnd: '1200' } });
const market = { vault: 'a', usdgBalance: '300', wrappedBalance: '0', usdgAllowance: '0', wrappedAllowance: '0', positions: [position('1', 0), position('2', 1)] };
const snapshot = { chainId: 1952, dealer: 'maker', observedAtMs: Date.now(), blockTimestamp: '1050', gasBalance: '99', markets: [market] };

test('monitor reports all delivery needs without reserving money; expiry is a valid outcome', () => {
  const before = settlementStatus(snapshot, cfg);
  assert.equal(before.automaticExercise, false);
  assert.deepEqual(before.alerts.map(a => a.code), ['LOW_GAS', 'EXERCISE_WINDOW_APPROACHING', 'EXERCISE_WINDOW_APPROACHING', 'WRAPPED_DELIVERY_SHORTFALL', 'WRAPPED_ALLOWANCE_SHORTFALL', 'USDG_ALLOWANCE_SHORTFALL']);
  assert.equal(before.requiredUSDG, '200');
  const during = settlementStatus({ ...snapshot, blockTimestamp: '1100' }, cfg);
  assert.ok(during.alerts.some(a => a.code === 'MANUAL_EXERCISE_WINDOW_OPEN'));
  const after = settlementStatus({ ...snapshot, gasBalance: '100', blockTimestamp: '1200' }, cfg);
  assert.deepEqual(after.alerts, []);
  assert.equal(after.markets[0].positions[0].state, 'expired');
  assert.equal(after.markets[0].requiredWrapped, '0');
  const shared = settlementStatus({ ...snapshot, markets: [market, { ...market, vault: 'b' }] }, cfg);
  assert.equal(shared.requiredUSDG, '400');
  assert.ok(shared.alerts.some(a => a.code === 'USDG_DELIVERY_SHORTFALL'));
});

test('failed scans retain last observation marked unavailable; restart persists status without signing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'payoff-monitor-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let fail = false, reads = 0;
  const chain = { dealer: 'maker', snapshot: async () => { reads++; if (fail) throw new Error('private upstream text'); return snapshot; } };
  const monitor = new SettlementMonitor({ config: cfg, chain, path: join(dir, 'snapshot.json') });
  await Promise.all([monitor.refresh(), monitor.refresh()]); assert.equal(reads, 1);
  assert.equal(monitor.status().status, 'ready');
  fail = true; await monitor.refresh();
  assert.equal(monitor.status().status, 'unavailable'); assert.equal(monitor.snapshot.observedAtMs, snapshot.observedAtMs);
  assert.equal(monitor.lastError.code, 'SETTLEMENT_SCAN_FAILED');
  const restarted = new SettlementMonitor({ config: cfg, chain, path: join(dir, 'snapshot.json') });
  await restarted.start(); await restarted.stop();
  assert.equal(restarted.snapshot.blockTimestamp, '1050');
  assert.equal(restarted.status().status, 'unavailable');
});

test('settlement endpoint is private and read-only even if quote readiness is broken', async t => {
  const app = await buildDealerApp({ config: {}, chain: {}, provider: {}, account: {}, token: 'private',
    settlement: { status: () => ({ status: 'ready', automaticExercise: false, snapshot }) } });
  t.after(() => app.close());
  assert.equal((await app.inject('/settlement')).statusCode, 401);
  const response = await app.inject({ url: '/settlement', headers: { authorization: 'Bearer private' } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().automaticExercise, false);
  assert.equal((await app.inject({ method: 'POST', url: '/settlement', headers: { authorization: 'Bearer private' } })).statusCode, 404);
});

test('uncertain broadcast survives restart, blocks new nonces and only explicitly rebroadcasts the saved hash', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'payoff-manual-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`); // Public test-only key.
  let accepted = false, sends = [], receipt = null, nonce = 0;
  const chain = { config: cfg, block: async () => ({}), client: {
    getTransactionCount: async () => nonce, getBlockNumber: async () => 10n,
    sendRawTransaction: async ({ serializedTransaction }) => { sends.push(keccak256(serializedTransaction)); if (!accepted) throw new Error('timeout'); return keccak256(serializedTransaction); },
    waitForTransactionReceipt: async () => { receipt = { status: 'success', blockNumber: 9n }; return receipt; },
    getTransactionReceipt: async () => { if (!receipt) { const e = new Error(); e.name = 'TransactionReceiptNotFoundError'; throw e; } return receipt; },
  } };
  const make = () => {
    const manual = new ManualSettlement({ chain, account, path: join(dir, 'tx.json') });
    manual.plan = async () => ({ issues: [], position: { terms: { exerciseEnd: '9999999999' } },
      transaction: { to: account.address, data: '0x', gas: '21000', gasPrice: '1' } });
    return manual;
  };
  const action = { kind: 'exercise', vault: account.address, positionId: '1' };
  const first = await make().execute(action);
  assert.equal(first.status, 'broadcast_uncertain');
  assert.equal(JSON.stringify(first).includes('"raw"'), false);
  assert.ok(JSON.parse(await readFile(join(dir, 'tx.json'))).pending.raw);
  const restarted = make();
  assert.equal((await restarted.execute(action)).status, 'blocked'); assert.equal(sends.length, 1);
  nonce = 1;
  assert.equal((await restarted.reconcile()).status, 'nonce_consumed_needs_review');
  assert.equal((await restarted.rebroadcast()).status, 'nonce_consumed_needs_review'); assert.equal(sends.length, 1);
  nonce = 0; accepted = true;
  assert.equal((await restarted.rebroadcast()).status, 'success');
  assert.equal(sends.length, 2); assert.equal(sends[0], sends[1]);
  assert.equal((await restarted.reconcile()).status, 'idle');
  const journal = JSON.parse(await readFile(join(dir, 'tx.json')));
  assert.equal(journal.pending, null); assert.equal(journal.history.length, 1); assert.equal(journal.history[0].raw, undefined);
});
