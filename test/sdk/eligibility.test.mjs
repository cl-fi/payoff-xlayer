import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligibleSeries, listedSeries, nearestSeries, usablePrice } from '../../sdk/eligibility.mjs';
const now = Date.parse('2026-10-01T12:00:00Z');
const rate = '1000000000000000000';
const price = { status: 'available', priceMicros: '228000000', fetchedAtMs: now, maxAgeMs: 60000 };
const term = (target, side = 0, end = '1791576000') => ({ id: `${target}:${side}:${end}`, side,
  strikePricePerWrappedUSDG: String(target * 1000000), tradeCutoff: String(now / 1000 + 1000),
  exerciseStart: String(now / 1000 + 1000), exerciseEnd: end });
const grid = [0, 1].flatMap(side => Array.from({ length: 13 }, (_, i) => term(200 + i * 5, side)));

test('nearest three per side and expiry move across the grid without changing contracts', () => {
  for (const [px, low, high] of [[223, [220, 215, 210], [225, 230, 235]], [228, [225, 220, 215], [230, 235, 240]], [233, [230, 225, 220], [235, 240, 245]]]) {
    const selected = nearestSeries(grid, rate, { ...price, priceMicros: String(px * 1000000) }, now);
    assert.deepEqual(selected.filter(s => s.side === 0).map(s => Number(s.strikePricePerWrappedUSDG) / 1e6), low);
    assert.deepEqual(selected.filter(s => s.side === 1).map(s => Number(s.strikePricePerWrappedUSDG) / 1e6), high);
  }
  const extra = [term(210, 0, '1792180800'), term(205, 0, '1792180800')];
  assert.equal(nearestSeries([...grid, ...extra], rate, price, now).length, 8);
  assert.equal(grid.length, 26);
});

test('equal prices, closed series, stale/future samples and wrapped conversions use the same rule', () => {
  assert.equal(eligibleSeries(term(228), rate, price, now), false);
  assert.equal(eligibleSeries(term(228, 1), rate, price, now), false);
  assert.equal(eligibleSeries(term(450), '2000000000000000000', price, now), true);
  assert.equal(eligibleSeries(term(225, 1), rate, price, now), false);
  assert.equal(eligibleSeries({ ...term(225), tradeCutoff: String(now / 1000) }, rate, price, now), false);
  assert.equal(usablePrice(price, now + 59999), true);
  assert.equal(usablePrice(price, now + 60000), false);
  assert.equal(usablePrice({ ...price, fetchedAtMs: now + 1001 }, now), false);
  assert.deepEqual(nearestSeries(grid, rate, null, now), []);
  // A fractional target rounds up exactly as the UI does; no float threshold drift.
  assert.equal(eligibleSeries({ ...term(225), strikePricePerWrappedUSDG: '450000001' }, '2000000000000000000',
    { ...price, priceMicros: '225000001' }, now), false);
});

test('only the three nearest expiries are listed, and each leaves eight hours before it expires', () => {
  const hour = 3600;
  const week = 7 * 24 * hour;
  const first = now / 1000 + 20 * hour;
  // Trading closes 30 minutes before each expiry, like the testnet grid.
  const weekly = Array.from({ length: 5 }, (_, i) => first + i * week).flatMap(end => [0, 1].map(side =>
    ({ ...term(220, side, String(end)), tradeCutoff: String(end - 1800), exerciseStart: String(end - 1800) })));
  const ends = at => [...new Set(listedSeries(weekly, at).map(s => Number(s.exerciseEnd)))];
  assert.deepEqual(ends(now), [first, first + week, first + 2 * week]);
  assert.equal(listedSeries(weekly, now).length, 6);
  // Still listed one second before the eight-hour mark; replaced by the fourth expiry at the mark.
  assert.deepEqual(ends((first - 8 * hour) * 1000 - 1000), [first, first + week, first + 2 * week]);
  assert.deepEqual(ends((first - 8 * hour) * 1000), [first + week, first + 2 * week, first + 3 * week]);
  // Fewer remaining expiries are listed as they are, and nothing past the grid.
  assert.deepEqual(ends((first + 3 * week - 8 * hour) * 1000), [first + 4 * week]);
  assert.deepEqual(listedSeries(weekly, (first + 4 * week) * 1000), []);
  assert.deepEqual(listedSeries([], now), []);
});
