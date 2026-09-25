import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessSamples, HyperliquidPrice, parseAssetContext, toMicros } from '../src/hyperliquid.mjs';
import { AutoExercise, evaluate, marketDay, windowsOf } from '../src/auto-exercise.mjs';
import { configSchema } from '../src/config.mjs';
import { settlementStatus } from '../src/settlement.mjs';
import { SettlementError } from '../src/settlement-chain.mjs';

const WAD = 10n ** 18n;
const body = coin => [{ universe: [{ name: 'xyz:AAPL', szDecimals: 3 }, { name: coin, szDecimals: 3 }, { name: 'flx:NVDA', isDelisted: true }] },
  [{ oraclePx: '250.1', midPx: '250.2', markPx: '250.15' }, { oraclePx: '226.26', midPx: '226.375', markPx: '226.36', funding: '0.00000625' },
    { oraclePx: '210.49', midPx: null, markPx: '208.99' }]];

test('prices convert exactly to USDG micros and parse from the asset context by universe index', () => {
  assert.equal(toMicros('226.26'), 226_260_000n);
  assert.equal(toMicros('0.5'), 500_000n);
  assert.equal(toMicros('226'), 226_000_000n);
  assert.equal(toMicros('226.1234567'), 226_123_456n);
  for (const bad of ['', '0', '-1', '1e3', 'abc', null, '226,26']) assert.throws(() => toMicros(bad), /INVALID_PRICE/);
  const sample = parseAssetContext(body('xyz:NVDA'), 'xyz:NVDA');
  assert.deepEqual([sample.oracleMicros, sample.midMicros, sample.markMicros, sample.oraclePx], [226_260_000n, 226_375_000n, 226_360_000n, '226.26']);
  assert.throws(() => parseAssetContext(body('xyz:NVDA'), 'flx:NVDA'), /PRICE_UNAVAILABLE/);
  assert.throws(() => parseAssetContext(body('xyz:NVDA'), 'xyz:TSLA'), /PRICE_UNAVAILABLE/);
  assert.throws(() => parseAssetContext({ error: 'x' }, 'xyz:NVDA'), /PRICE_UNAVAILABLE/);
});

test('the fetcher posts the dex query and maps transport failures to PRICE_UNAVAILABLE', async () => {
  const calls = [];
  const ok = new HyperliquidPrice({ url: 'https://example.invalid/info', dex: 'xyz', timeoutMs: 1000,
    fetch: async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => body('xyz:NVDA') }; } });
  const sample = await ok.sample('xyz:NVDA');
  assert.equal(sample.oraclePx, '226.26'); assert.ok(sample.observedAtMs > 0);
  assert.deepEqual(calls, [['https://example.invalid/info', { type: 'metaAndAssetCtxs', dex: 'xyz' }]]);
  const down = new HyperliquidPrice({ url: 'https://example.invalid/info', dex: 'xyz', fetch: async () => ({ ok: false, json: async () => ({}) }) });
  await assert.rejects(down.sample('xyz:NVDA'), /PRICE_UNAVAILABLE/);
  const broken = new HyperliquidPrice({ url: 'https://example.invalid/info', dex: 'xyz', fetch: async () => { throw new Error('secret host name'); } });
  await assert.rejects(broken.sample('xyz:NVDA'), error => error instanceof SettlementError && error.code === 'PRICE_UNAVAILABLE');
});

test('oracle guards: book divergence, empty book and an oracle that stops moving', () => {
  const settings = { oracleMidBandBps: 100, oracleUnchangedPolls: 3 };
  const s = (oracle, mid = oracle) => ({ oracleMicros: toMicros(oracle), midMicros: mid === null ? null : toMicros(mid) });
  assert.deepEqual(assessSamples([], settings), ['PRICE_UNAVAILABLE']);
  assert.deepEqual(assessSamples([s('226.26', '226.375')], settings), []);
  assert.deepEqual(assessSamples([s('226.26', '229')], settings), ['ORACLE_MID_DIVERGENCE']);
  assert.deepEqual(assessSamples([s('226.26', null)], settings), ['BOOK_EMPTY']);
  assert.deepEqual(assessSamples([s('226.26'), s('226.26'), s('226.26')], settings), ['ORACLE_UNCHANGED']);
  assert.deepEqual(assessSamples([s('226.26'), s('226.26'), s('226.27')], settings), []);
  assert.deepEqual(assessSamples([s('226.26'), s('226.26')], settings), []);
});

test('the rule compares fixed strike USDG with shares at the current wrapper rate; premium is ignored', () => {
  const rate = 1_500_000_000_000_000_000n; // 1 wrapped = 1.5 shares
  const put = { wrappedQuantity: (2n * WAD).toString(), strikeAmountUSDG: '320000000', terms: { side: 0 } };
  const call = { ...put, terms: { side: 1 } };
  const price = 100_000_000n; // 3 shares × $100 = $300 notional
  const p = evaluate(put, rate, price);
  assert.deepEqual([p.side, p.notional, p.intrinsic, p.edgeBps, p.exercise], ['put', 300_000_000n, 20_000_000n, 666n, true]);
  const c = evaluate(call, rate, price);
  assert.deepEqual([c.side, c.intrinsic, c.exercise], ['call', -20_000_000n, false]);
  assert.equal(evaluate(put, rate, price, 700).exercise, false);
  assert.equal(evaluate(put, rate, price, 666).exercise, true);
  // Exactly at the strike there is no advantage, so no exercise even with a zero threshold.
  const flat = evaluate({ ...put, strikeAmountUSDG: '300000000' }, rate, price, 0);
  assert.deepEqual([flat.intrinsic, flat.exercise], [0n, false]);
  assert.equal(evaluate({ ...call, strikeAmountUSDG: '299999999' }, rate, price, 0).exercise, true);
  assert.equal(evaluate(put, WAD, price).notional, 200_000_000n);
});

const snapshot = (positions, extra = {}) => ({ chainId: 1952, dealer: '0xdea1', markets: [{ vault: '0xVault', symbol: 'NVDA', wrappedStock: '0xWrap',
  usdgBalance: '0', wrappedBalance: '0', usdgAllowance: '0', wrappedAllowance: '0', positions }], ...extra });
const pos = (id, side, strike, { state = 1, start = 1790364600, end = 1790366400 } = {}) =>
  ({ id, seriesId: id, state, wrappedQuantity: WAD.toString(), strikeAmountUSDG: strike, longHolder: '0xdea1', terms: { side, exerciseStart: String(start), exerciseEnd: String(end) } });

test('windows group open positions by exercise window and drop settled or ended ones', () => {
  const later = { start: 1790969400, end: 1790971200 };
  const windows = windowsOf(snapshot([pos('1', 0, '230000000', later), pos('2', 1, '220000000'), pos('3', 0, '1', { state: 2 }), pos('4', 0, '1', { start: 1, end: 2 })]), 1790300000);
  assert.deepEqual(windows.map(w => [w.start, w.end, w.positions.map(p => p.id)]), [[1790364600, 1790366400, ['2']], [1790969400, 1790971200, ['1']]]);
  assert.equal(windows[0].positions[0].vault, '0xVault');
  assert.deepEqual(windowsOf(snapshot([pos('2', 1, '220000000')]), 1790366400), []);
  assert.deepEqual(marketDay(1790366400), { date: '2026-09-25', weekday: 'Fri' });
  assert.deepEqual(marketDay(1790452800), { date: '2026-09-26', weekday: 'Sat' });
});

const baseConfig = { chainId: 1952, exchange: '0x8D59286d1b728599bA897436cC6C3Ce1a8DB6D6a', usdg: '0x56C62A3d7b0B7F0fC32F88635B4Ab140C02B3B53',
  markets: [{ vault: '0x0d90A6561D8F9399dB6Bb9E8CafbB43269a6f90d', stock: '0x1DDa57B38E0461a29c0281497c15fb77657450Eb',
    wrappedStock: '0x691fFBCd11f0bA0B58D387B9f2649F6393b71E57', symbol: 'NVDA', seriesIds: ['1'] }] };

test('configuration defaults keep settlement manual; enabling requires a coin per market', () => {
  const parsed = configSchema.parse(baseConfig);
  assert.equal(parsed.autoExercise.enabled, false); assert.equal(parsed.autoExercise.dryRun, true);
  assert.equal(parsed.autoExercise.hyperliquidDex, 'xyz'); assert.equal(parsed.autoExercise.minEdgeBps, 0);
  assert.equal(parsed.autoExercise.decideBeforeEndSeconds, 300); assert.equal(parsed.autoExercise.oracleUnchangedPolls, 6);
  assert.throws(() => configSchema.parse({ ...baseConfig, autoExercise: { enabled: true } }), /Hyperliquid coin/);
  assert.throws(() => configSchema.parse({ ...baseConfig, autoExercise: { decideBeforeEndSeconds: 60, submitCutoffSeconds: 60 } }), /precede/);
  assert.throws(() => configSchema.parse({ ...baseConfig, autoExercise: { unknown: 1 } }));
  const live = configSchema.parse({ ...baseConfig, autoExercise: { enabled: true, dryRun: false, coins: { NVDA: 'xyz:NVDA' } } });
  assert.equal(live.autoExercise.coins.NVDA, 'xyz:NVDA');
  const cfg = { chainId: 1952, settlementMinGasWei: '0', settlementWarningSeconds: 1, settlementIntervalMs: 1000, settlementConfirmations: 1 };
  const snap = { chainId: 1952, dealer: 'maker', observedAtMs: Date.now(), blockTimestamp: '1', gasBalance: '1', markets: [] };
  assert.deepEqual([settlementStatus(snap, cfg).mode, settlementStatus(snap, cfg).automaticExercise], ['manual', false]);
  assert.deepEqual([settlementStatus(snap, { ...cfg, autoExercise: { enabled: true, dryRun: true } }).mode, settlementStatus(snap, { ...cfg, autoExercise: { enabled: true, dryRun: true } }).automaticExercise], ['automatic_dry_run', false]);
  assert.deepEqual([settlementStatus(snap, { ...cfg, autoExercise: live.autoExercise }).mode, settlementStatus(snap, { ...cfg, autoExercise: live.autoExercise }).automaticExercise], ['automatic', true]);
});

const settings = { enabled: true, dryRun: true, coins: { NVDA: 'xyz:NVDA' }, pollMs: 10000, oracleMidBandBps: 100, oracleUnchangedPolls: 3,
  minEdgeBps: 0, decideBeforeEndSeconds: 300, submitCutoffSeconds: 60, idlePollMs: 300000, skipDates: [] };
const window = { start: 1790364600, end: 1790366400 };
const decideAtMs = (window.end - 300) * 1000, cutoffMs = (window.end - 60) * 1000;

// Fake clock: every sleep advances time; the price path drifts upward so the
// unchanged-oracle guard never fires unless a test asks for a frozen price.
function harness({ positions, dryRun = true, startMs = decideAtMs - 30000, execute, reconcile, prices, rate = WAD, path, samples = 'drift' }) {
  let clock = startMs, fetches = 0;
  const events = [], executed = [];
  const config = { chainId: 1952, autoExercise: { ...settings, dryRun } };
  const chain = { dealer: '0xdea1', snapshot: async () => snapshot(positions), read: async () => (typeof rate === 'function' ? rate() : rate) };
  const price = { sample: async () => {
    fetches++;
    if (samples === 'fail') throw new SettlementError('PRICE_UNAVAILABLE');
    const oracle = samples === 'frozen' ? '226.26' : prices?.[Math.min(fetches - 1, prices.length - 1)] ?? (226 + fetches / 100).toFixed(2);
    return { ...parseAssetContext([{ universe: [{ name: 'xyz:NVDA' }] }, [{ oraclePx: oracle, midPx: oracle, markPx: oracle }]], 'xyz:NVDA'), observedAtMs: clock, latencyMs: 5 };
  } };
  const manual = {
    execute: async action => { executed.push(action.positionId); return execute ? execute(action, executed.length, ms => { clock += ms; }) : { status: 'success', transaction: { hash: `0x${action.positionId}` } }; },
    reconcile: async () => reconcile ? reconcile() : { status: 'idle' },
  };
  const runner = new AutoExercise({ config, chain, manual, price, path, log: e => events.push(e), now: () => clock, sleep: async ms => { clock += ms; } });
  return { runner, events, executed, clockNow: () => clock, fetchCount: () => fetches };
}
const positions = [pos('1', 0, '230000000'), pos('2', 1, '230000000'), pos('3', 1, '220000000'), pos('4', 0, '226260000')];

test('dry run decides on the oracle price near the end of the window and signs nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'payoff-auto-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auto-exercise.json');
  const h = harness({ positions, prices: ['226.10', '226.20', '226.30', '226.26'], path });
  const record = await h.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.equal(h.executed.length, 0);
  assert.equal(record.outcome, 'completed'); assert.equal(record.dryRun, true); assert.equal(record.day, '2026-09-25');
  // Highest edge first: the 220 call (2.77%) before the 230 put (1.65%).
  assert.deepEqual(record.exercised.map(d => [d.positionId, d.side, d.price, d.dryRun]), [['3', 'call', '226.26', true], ['1', 'put', '226.26', true]]);
  assert.equal(record.exercised[0].intrinsic, '6260000'); assert.equal(record.exercised[0].edgeBps, '276');
  assert.deepEqual(record.skipped.map(d => [d.positionId, d.reason]).sort(), [['2', 'NO_ADVANTAGE'], ['4', 'NO_ADVANTAGE']]);
  assert.ok(record.polls >= 1); assert.ok(record.finishedAtMs >= cutoffMs);
  assert.ok(h.events.some(e => e.event === 'auto_exercise_dry_run' && e.positionId === '3'));
  assert.ok(!h.events.some(e => e.event === 'auto_exercise_poll' && e.atMs < decideAtMs), 'no decision before decideAt');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(journal.windows.length, 1); assert.equal(journal.windows[0].exercised.length, 2); assert.equal(journal.dealer, '0xdea1');
  assert.deepEqual(h.runner.status().last.exercised.map(d => d.positionId), ['3', '1']);
});

test('live mode executes through the settlement journal in edge order and reconciles a pending broadcast', async () => {
  let reconciles = 0;
  const h = harness({ positions, dryRun: false, prices: ['226.10', '226.20', '226.30', '226.26'],
    execute: (action, n) => n === 1 ? { status: 'pending', transaction: { hash: '0xpending' } } : { status: 'success', transaction: { hash: `0x${action.positionId}` } },
    reconcile: () => (++reconciles < 2 ? { status: 'pending', transaction: { hash: '0xpending' } } : { status: 'success', transaction: { hash: '0xpending' } }) });
  const record = await h.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.deepEqual(h.executed, ['3', '1']);
  assert.deepEqual(record.exercised.map(d => [d.positionId, d.hash, d.dryRun]), [['3', '0xpending', undefined], ['1', '0x1', undefined]]);
  assert.equal(reconciles, 2); assert.equal(record.outcome, 'completed'); assert.deepEqual(record.alerts, []);
});

test('an unresolved previous transaction halts the window instead of burning nonces', async () => {
  const h = harness({ positions, dryRun: false, execute: () => ({ status: 'blocked', reason: 'PREVIOUS_TRANSACTION_UNRESOLVED', previous: { status: 'pending' } }) });
  const record = await h.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.deepEqual(h.executed, ['3']);
  assert.equal(record.outcome, 'halted');
  assert.deepEqual(record.alerts.map(a => a.code), ['AUTO_EXERCISE_HALTED']);
  assert.deepEqual(record.skipped.map(d => [d.positionId, d.reason]).sort(), [['1', 'PREVIOUS_TRANSACTION_UNRESOLVED'], ['2', 'PREVIOUS_TRANSACTION_UNRESOLVED'], ['3', 'PREVIOUS_TRANSACTION_UNRESOLVED'], ['4', 'PREVIOUS_TRANSACTION_UNRESOLVED']]);
});

test('per-position blocks are recorded, a locked journal is retried, and the cutoff stops new sends', async () => {
  let attempts = 0;
  const h = harness({ positions, dryRun: false, startMs: cutoffMs - 25000, execute: (action, _n, advance) => {
    attempts++;
    if (attempts === 1) throw new SettlementError('TRANSACTION_LOCKED');
    if (action.positionId === '3') { advance(20000); return { status: 'blocked', plan: { issues: ['DELIVERY_ALLOWANCE_LOW'] } }; }
    return { status: 'success', transaction: { hash: `0x${action.positionId}` } };
  } });
  const record = await h.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  // Poll 1: position 3 hits the lock and is retried on poll 2, where its block consumes the remaining time.
  assert.deepEqual(h.executed, ['3', '3']);
  assert.deepEqual(record.failed.map(d => [d.positionId, d.reason]), [['3', 'DELIVERY_ALLOWANCE_LOW']]);
  assert.deepEqual(record.skipped.find(d => d.positionId === '1').reason, 'SUBMIT_CUTOFF');
  assert.ok(record.alerts.some(a => a.code === 'AUTO_EXERCISE_BLOCKED'));
  assert.equal(record.outcome, 'completed');
});

test('a frozen oracle or a failing feed produces no decision; weekends and skip dates refuse the window', async () => {
  const frozen = harness({ positions, dryRun: false, samples: 'frozen' });
  let record = await frozen.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.equal(frozen.executed.length, 0);
  assert.ok(record.skipped.every(d => d.reason === 'NO_DECISION'));
  assert.ok(frozen.events.some(e => e.event === 'auto_exercise_poll' && e.prices['xyz:NVDA'].issues.includes('ORACLE_UNCHANGED')));
  const failing = harness({ positions, dryRun: false, samples: 'fail' });
  record = await failing.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.equal(failing.executed.length, 0);
  assert.ok(failing.events.some(e => e.event === 'auto_exercise_price_failed' && e.alert === 'PRICE_UNAVAILABLE'));
  assert.ok(record.skipped.every(d => d.reason === 'NO_DECISION'));
  const saturday = { start: 1790451000, end: 1790452800 };
  const satPositions = positions.map(p => pos(p.id, p.terms.side, p.strikeAmountUSDG, saturday));
  const weekend = harness({ positions: satPositions, dryRun: false, startMs: (saturday.end - 330) * 1000 });
  record = await weekend.runner.runWindow({ ...saturday, positions: windowsOf(snapshot(satPositions), 0)[0].positions });
  assert.equal(record.outcome, 'market_closed'); assert.equal(weekend.executed.length, 0); assert.equal(weekend.fetchCount(), 0);
  const skipped = harness({ positions, dryRun: false });
  skipped.runner.settings = { ...skipped.runner.settings, skipDates: ['2026-09-25'] };
  record = await skipped.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.equal(record.outcome, 'market_closed'); assert.deepEqual(record.alerts.map(a => a.code), ['MARKET_CLOSED_IN_WINDOW']);
});

test('a failing wrapper-rate read never becomes an unhandled rejection, with or without a usable price', async () => {
  const rpcDown = () => { throw new Error('rpc down'); };
  const frozen = harness({ positions, dryRun: false, samples: 'frozen', rate: rpcDown });
  let record = await frozen.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.equal(record.outcome, 'completed'); assert.equal(frozen.executed.length, 0);
  assert.ok(record.skipped.every(d => d.reason === 'NO_DECISION'));
  const moving = harness({ positions, dryRun: false, rate: rpcDown });
  record = await moving.runner.runWindow({ ...window, positions: windowsOf(snapshot(positions), 0)[0].positions });
  assert.equal(record.outcome, 'completed'); assert.equal(moving.executed.length, 0);
  assert.ok(record.skipped.every(d => d.reason === 'NO_DECISION'));
  assert.ok(moving.events.some(e => e.event === 'auto_exercise_poll' && e.positions.some(p => p.issue === 'RATE_UNAVAILABLE')));
  // Rejections settle after the poll moved on; give them a tick to surface if unhandled.
  await new Promise(r => setTimeout(r, 20));
});

test('the daemon waits for the next window, exposes it in status, stops promptly and stays off when disabled', async () => {
  const future = Math.floor(Date.now() / 1000) + 10 * 86400;
  const events = [];
  const config = { chainId: 1952, autoExercise: { ...settings } };
  const chain = { dealer: '0xdea1', snapshot: async () => snapshot([pos('1', 0, '230000000', { start: future, end: future + 1800 })]) };
  const runner = new AutoExercise({ config, chain, manual: {}, price: {}, log: e => events.push(e) });
  await runner.start();
  for (let i = 0; i < 50 && runner.status().phase !== 'waiting'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(runner.status().phase, 'waiting');
  assert.deepEqual(runner.status().next, { start: future, end: future + 1800, decideAt: future + 1500, positions: 1 });
  const stopping = Date.now(); await runner.stop();
  assert.ok(Date.now() - stopping < 1000);
  const disabled = new AutoExercise({ config: { chainId: 1952, autoExercise: { ...settings, enabled: false } }, chain, manual: {}, price: {} });
  await disabled.start(); await disabled.stop();
  assert.equal(disabled.status().phase, 'disabled');
  const failing = new AutoExercise({ config, chain: { dealer: '0xdea1', snapshot: async () => { throw new Error('rpc secret'); } }, manual: {}, price: {}, log: e => events.push(e) });
  await failing.start();
  for (let i = 0; i < 50 && !failing.status().lastError; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(failing.status().lastError.code, 'AUTO_EXERCISE_CYCLE_FAILED');
  await failing.stop();
});
