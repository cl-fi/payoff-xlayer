import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planNativeSeries } from '../../sdk/series-planning.mjs';

const product = { side: 0, stockTargetPriceUSDG: '220000000', tradeCutoff: '2000', exerciseStart: '2000', exerciseEnd: '3800' };
test('rate changes produce a replacement at the same expiry; old terms remain intact', () => {
  const first = planNativeSeries([product], [], '1010000000000000000', 1000)[0];
  assert.equal(first.strikePricePerWrappedUSDG, '222200000');
  const existing = [{ ...first, id: '17' }];
  const before = structuredClone(existing);
  assert.equal(planNativeSeries([product], existing, '1010000000000000000', 1000)[0].existingSeriesId, '17');
  const next = planNativeSeries([product], existing, '1020000000000000000', 1100)[0];
  assert.equal(next.existingSeriesId, null);
  assert.equal(next.strikePricePerWrappedUSDG, '224400000');
  assert.equal(next.exerciseEnd, '3800');
  assert.equal(next.tradeCutoff, first.tradeCutoff);
  assert.equal(next.stockTargetPriceUSDG, first.stockTargetPriceUSDG);
  assert.deepEqual(existing, before);
});
test('both directions round up at USDG precision, reuse identical terms, and skip closed products', () => {
  for (const side of [0, 1]) {
    const products = [{ ...product, side }];
    const plan = planNativeSeries(products, [], '1001701196801074000', 1000)[0];
    assert.equal(plan.strikePricePerWrappedUSDG, '220374264');
    const existing = [{ ...plan, id: '18' }];
    assert.equal(planNativeSeries(products, existing, '1001701196801074001', 1000)[0].existingSeriesId, '18');
    assert.equal(planNativeSeries([{ ...products[0], exerciseEnd: '3900' }], existing, '1001701196801074000', 1000)[0].existingSeriesId, null);
    assert.deepEqual(planNativeSeries(products, existing, '1001701196801074000', 2000), []);
  }
  assert.throws(() => planNativeSeries([product], [], '0', 1000));
});
