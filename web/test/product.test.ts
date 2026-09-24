import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEMO_ACCOUNT,
  DemoAdapter,
  claimDemo,
  createDemoQuote,
  demoMarket,
  initialDemoState,
  openDemo,
  prepareDemo,
  readDemoState,
  STORAGE_PREFIX,
  type Storage,
} from '../src/lib/data/demo';
import { apr, aprBps, parseQuantity, previewOrder, rounded, WAD } from '../src/lib/amounts';

test('aprBps backs both the two-decimal APR and the one-decimal strike labels', () => {
  const year = 31536000;
  assert.equal(aprBps('1000000', '10000000', year), 1000n);
  assert.equal(apr('1000000', '10000000', year), '10.00');
  assert.equal(rounded(aprBps('1845000', '10000000', year)!, 2, 1), '18.5');
  assert.equal(aprBps('1000000', '10000000', 0), null);
  assert.equal(apr('1000000', '10000000', 0), null);
});
import { expectedFillData } from '../src/lib/chain';
import { runtimeSchema } from '../src/lib/config';
import { GatewayAdapter, validateSelection } from '../src/lib/data/gateway';
import type { GatewayQuote, Selection } from '../src/lib/types';
import { friendlyError } from '../src/lib/wallet';
const memory = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
  };
};
const now = Math.floor(Date.now() / 1000),
  market = demoMarket(now);
const preview = (side: 0 | 1, qty = '1') =>
  previewOrder(
    qty,
    market.series.find((s) => s.side === side)!,
    market,
    DEMO_ACCOUNT,
  );
const config = runtimeSchema.parse({
  mode: 'demo',
  chainId: 1952,
  rpcUrl: 'https://example.test',
  explorerUrl: 'https://example.test',
  gatewayUrl: '',
  nvdaVault: '',
});

test('English app errors remain useful while raw provider errors stay private', () => {
  try {
    parseQuantity('0');
    assert.fail('Zero quantity must be rejected');
  } catch (error) {
    assert.equal(friendlyError(error), 'Enter a valid stock quantity.');
  }
  assert.equal(
    friendlyError(new Error('RPC failed at https://example.test/private-credential with calldata 0x1234')),
    'The action did not complete. Please try again later.',
  );
  assert.equal(
    friendlyError({ code: 4001 }),
    'You cancelled the wallet request. Try again when you are ready.',
  );
});

test('demo deducts 10% of gross premium and preserves the gross/net split', () => {
  const q = createDemoQuote(preview(0), now).quote;
  assert.equal(market.feeBps, 1000);
  assert.equal(BigInt(q.protocolFeeUSDG), BigInt(q.grossPremiumUSDG) / 10n);
  assert.equal(BigInt(q.netPremiumUSDG) + BigInt(q.protocolFeeUSDG), BigInt(q.grossPremiumUSDG));
});
test('quantity conversion uses integer arithmetic and existing strike SDK', () => {
  const p = preview(0);
  assert.equal(p.wrappedQuantity, ((WAD * WAD) / 1003000000000000000n).toString());
  assert.equal(p.strikeAmountUSDG, '175000000');
  assert.equal(preview(1).strikeAmountUSDG, '185000000');
  assert(BigInt(p.stockEquivalent) <= WAD);
  assert.equal(parseQuantity('1.000000000000000001'), WAD + 1n);
});
test('rounded display rounds half-up instead of truncating', () => {
  assert.equal(rounded('999999999999999999', 18, 4), '1.0000');
  assert.equal(rounded('998301000000000000', 18, 4), '0.9983');
  assert.equal(rounded('998350000000000000', 18, 4), '0.9984');
  assert.equal(rounded('1003000000000000000', 18, 6), '1.003000');
  assert.equal(rounded('1234567', 6, 2), '1.23');
});
test('APR annualizes net premium over the time left to expiry and rejects empty bases', () => {
  assert.equal(apr('500000', '220374264', 388800), '18.40');
  assert.equal(apr('500000', '220374264', 388800.9), '18.40');
  assert.equal(apr('500000', '0', 388800), null);
  assert.equal(apr('500000', '220374264', 0), null);
  assert.equal(apr('500000', '220374264', -60), null);
});
test('invalid, underflowing and overflowing amounts are rejected', () => {
  for (const input of ['0', '-1', '1e2', '1,000', ' 1', '1.0000000000000000001', '0x1', '9'.repeat(90)])
    assert.throws(() => preview(0, input));
  assert.throws(() => preview(0, '0.000000000000000001'));
});
test('native and wrapped inputs express the same order at a non-unit rate; direct units retain 18-digit precision', () => {
  for (const side of [0, 1] as const) {
    const series = market.series.find((s) => s.side === side)!;
    const native = previewOrder('1.003', series, market, DEMO_ACCOUNT, 'stock');
    const wrapped = previewOrder('1', series, market, DEMO_ACCOUNT, 'wrapped');
    assert.deepEqual(native.order, wrapped.order);
    assert.equal(wrapped.wrappedQuantity, WAD.toString());
    assert.equal(wrapped.stockEquivalent, '1003000000000000000');
    assert.equal(wrapped.strikeAmountUSDG, native.strikeAmountUSDG);
    assert.equal(wrapped.strikeAmountUSDG, series.strikePricePerWrappedUSDG);
    assert.equal(
      previewOrder('1.000000000000000001', series, market, DEMO_ACCOUNT, 'wrapped').wrappedQuantity,
      (WAD + 1n).toString(),
    );
    assert.throws(
      () => previewOrder('1', series, { ...market, rate: '0' }, DEMO_ACCOUNT, 'wrapped'),
      /wrapping rate/,
    );
    for (const input of ['0', '-1', '1e2', '1.0000000000000000001'])
      assert.throws(() => previewOrder(input, series, market, DEMO_ACCOUNT, 'wrapped'));
  }
});
for (const side of [0, 1] as const)
  for (const outcome of ['exercised', 'expired'] as const) {
    test(`${side === 0 ? 'put' : 'call'} → ${outcome}: collateral, premium and claim reconcile`, () => {
      const original = initialDemoState(now),
        p = preview(side),
        q = createDemoQuote(p, now);
      const prepared = prepareDemo(original, p);
      assert.equal(original.balances.usdgAllowance, '0'); // pure operation
      if (side === 1)
        assert.equal(
          BigInt(prepared.balances.stock) + (BigInt(p.wrappedQuantity) * BigInt(p.rate) + WAD - 1n) / WAD,
          8n * WAD,
        );
      const filled = openDemo(prepared, p, q, now),
        position = filled.positions[0];
      assert.equal(position.wrappedQuantity, p.wrappedQuantity);
      assert.equal(
        BigInt(filled.balances.usdg),
        10000000000n + BigInt(q.quote.netPremiumUSDG) - (side === 0 ? BigInt(p.strikeAmountUSDG) : 0n),
      );
      assert.throws(() => openDemo(filled, p, q, now), /already been filled/);
      assert.throws(() => claimDemo(filled, position.id), /not claimable yet/);
      position.status = outcome;
      const claimed = claimDemo(filled, position.id),
        returnsUSDG = (side === 0 && outcome === 'expired') || (side === 1 && outcome === 'exercised');
      assert.equal(
        BigInt(claimed.balances.usdg) - BigInt(filled.balances.usdg),
        returnsUSDG ? BigInt(p.strikeAmountUSDG) : 0n,
      );
      assert.equal(
        BigInt(claimed.balances.wrapped) - BigInt(filled.balances.wrapped),
        returnsUSDG ? 0n : BigInt(p.wrappedQuantity),
      );
      assert.equal(claimed.positions[0].status, 'claimed');
      assert.throws(() => claimDemo(claimed, position.id), /already been claimed/);
    });
  }
test('expired and changed orders cannot fill or consume balances', () => {
  const p = preview(0),
    original = prepareDemo(initialDemoState(now), p);
  assert.throws(() => openDemo(original, p, createDemoQuote(p, now, true), now), /expired/);
  assert.throws(() => openDemo(original, preview(0, '2'), createDemoQuote(p, now), now), /changed/);
  assert.equal(original.positions.length, 0);
  assert.throws(() => prepareDemo(initialDemoState(now), preview(0, '100')), /Insufficient/);
  assert.throws(() => prepareDemo(initialDemoState(now), preview(1, '100')), /Insufficient/);
});
test('persisted ledger is isolated per account and corrupted data is surfaced', async () => {
  const storage = memory(),
    adapter = new DemoAdapter(storage, DEMO_ACCOUNT, 0);
  await adapter.market();
  await adapter.prepareAssets(preview(0));
  const q = await adapter.quote(preview(0), 'first');
  assert(q);
  await adapter.fill(preview(0), q, 'normal');
  assert.equal(new DemoAdapter(storage, DEMO_ACCOUNT, 0).state().positions.length, 1);
  assert.equal(
    new DemoAdapter(storage, '0x0000000000000000000000000000000000000001', 0).state().positions.length,
    0,
  );
  storage.setItem(STORAGE_PREFIX + DEMO_ACCOUNT.toLowerCase(), '{}');
  assert.throws(() => readDemoState(storage, DEMO_ACCOUNT), /could not be read/);
});
test('RFQ retries are idempotent; changed payload, no quote and failures stay distinct', async () => {
  const a = new DemoAdapter(memory(), DEMO_ACCOUNT, 0),
    p = preview(0);
  await a.market();
  await a.prepareAssets(preview(0, '2'));
  const q = await a.quote(p, 'same');
  assert(q);
  assert.equal((await a.quote(p, 'same'))?.requestId, q.requestId);
  await assert.rejects(a.quote(preview(0, '2'), 'same'), /different orders/);
  assert.equal(await a.quote(p, 'empty', 'no-quote'), null);
  await assert.rejects(a.quote(p, 'offline', 'offline'), /unavailable/);
  const before = a.state();
  await assert.rejects(a.fill(p, q, 'rejected'), /cancellation/);
  await assert.rejects(a.fill(p, q, 'failed'), /failure/);
  assert.deepEqual(a.state(), before);
});
test('expired open position returns collateral without manual state override', () => {
  const p = preview(0),
    state = openDemo(prepareDemo(initialDemoState(now), p), p, createDemoQuote(p, now), now);
  state.positions[0].series.exerciseEnd = String(now - 1);
  assert.equal(claimDemo(state, state.positions[0].id).positions[0].outcome, 'expired');
});
test('mock quote cannot produce wallet calldata, and real gateway refuses mock quotes', async () => {
  const q = createDemoQuote(preview(0), now);
  assert.equal(q.signature, null);
  assert.equal(q.transaction, null);
  assert.throws(() => expectedFillData(q, preview(0)), /Demo quotes/);
  const adapter = new GatewayAdapter({ ...config, mode: 'gateway' });
  await assert.rejects(adapter.prepare(q), /Demo quotes cannot/);
});
test('gateway selection must match order, fee, destination and exact transaction', () => {
  const p = preview(0),
    demo = createDemoQuote(p, now);
  const selection: Selection = {
    quote: demo.quote,
    signature: '0x12',
    quoteHash: `0x${'a'.repeat(64)}`,
    source: 'test',
    dealerId: 'house',
    dealerName: 'House',
    checkedAt: new Date().toISOString(),
    checkedAtBlock: '1',
    transaction: { chainId: 1952, from: DEMO_ACCOUNT, to: market.exchange, value: '0', data: '0x' },
  };
  const q: GatewayQuote = { kind: 'gateway', feeBps: market.feeBps, requestId: demo.requestId, selection };
  selection.transaction.data = expectedFillData(q, p);
  assert.equal(validateSelection(selection, p, market).kind, 'gateway');
  assert.throws(
    () => validateSelection({ ...selection, quote: { ...selection.quote, wrappedQuantity: '2' } }, p, market),
    /does not match/,
  );
  assert.throws(
    () => validateSelection({ ...selection, quote: { ...selection.quote, protocolFeeUSDG: '0' } }, p, market),
    /fees/,
  );
  assert.throws(
    () =>
      validateSelection({ ...selection, transaction: { ...selection.transaction, chainId: 1 } }, p, market),
    /transaction parameters/,
  );
  assert.throws(
    () =>
      validateSelection(
        { ...selection, transaction: { ...selection.transaction, data: '0x1234' } },
        p,
        market,
      ),
    /transaction parameters/,
  );
});
