import test from 'node:test';
import assert from 'node:assert/strict';
import { previewStockOrder, strikeAmountUSDG, wrappedStrikeFromStockPrice, stockEquivalentStrikeUSDG } from '../../sdk/wrapped-assets.mjs';
import { quoteTypedData } from '../../sdk/quotes.mjs';

const WAD = 10n ** 18n;
const USD = 10n ** 6n;
const wrapper = '0x1111111111111111111111111111111111111111';
const underlying = '0x2222222222222222222222222222222222222222';
function clientAt(rate, decimals = 18) {
  return {
    getBlockNumber: async () => 100n,
    readContract: async ({ address, blockNumber, functionName, args }) => {
      assert.equal(address, wrapper);
      assert.equal(blockNumber, 100n, 'every conversion must use the quote snapshot block');
      if (functionName === 'asset') return underlying;
      if (functionName === 'decimals') return decimals;
      if (functionName === 'convertToShares') return args[0] * WAD / rate;
      if (functionName === 'convertToAssets') return args[0] * rate / WAD;
      throw new Error('Unexpected call');
    },
  };
}

test('100 stocks at rate 2 become 50 wrapped with a fixed 10,000 USDG total', async () => {
  const order = await previewStockOrder(clientAt(2n * WAD), wrapper, { stockQuantity: 100n * WAD, stockTargetPriceUSDG: 100n * USD });
  assert.equal(order.wrappedQuantity, 50n * WAD);
  assert.equal(order.strikePricePerWrappedUSDG, 200n * USD);
  assert.equal(order.strikeAmountUSDG, 10_000n * USD);
  assert.equal(order.stockEquivalentAtQuote, 100n * WAD);
  assert.equal(order.underlyingStock, underlying);
  for (const [rate, equivalent, effectivePrice] of [
    [2_004n * WAD / 1000n, 1002n * WAD / 10n, 99_800_400n],
    [4n * WAD, 200n * WAD, 50n * USD],
    [WAD, 50n * WAD, 200n * USD],
  ]) {
    assert.equal(order.wrappedQuantity * rate / WAD, equivalent);
    assert.equal(stockEquivalentStrikeUSDG(order.strikeAmountUSDG, equivalent), effectivePrice);
    assert.equal(order.strikeAmountUSDG, 10_000n * USD);
  }
});

test('non-unit entry rate and rounding do not award pre-entry dividends', async () => {
  const rate = 1003n * WAD / 1000n;
  const order = await previewStockOrder(clientAt(rate), wrapper, { stockQuantity: WAD, stockTargetPriceUSDG: 100n * USD });
  assert.equal(order.wrappedQuantity, WAD * WAD / rate);
  assert.ok(order.stockEquivalentAtQuote <= WAD);
  assert.ok(order.stockEquivalentAtQuote >= WAD - 2n);
  assert.equal(order.strikePricePerWrappedUSDG, 100_300_000n);
  assert.equal(order.strikeAmountUSDG, 100n * USD);
  assert.equal(strikeAmountUSDG(1n, 1n), 1n);
  assert.equal(wrappedStrikeFromStockPrice(1n, WAD + 1n), 2n);
});

test('reject zero, unsafe or overflowing values and unsupported conversions', async () => {
  assert.throws(() => strikeAmountUSDG(0n, 1n), /Invalid/);
  assert.throws(() => strikeAmountUSDG(1e18, 1n), /Unsafe/);
  assert.throws(() => strikeAmountUSDG((1n << 256n) - 1n, (1n << 256n) - 1n), /Invalid/);
  await assert.rejects(previewStockOrder(clientAt(WAD, 6), wrapper, { stockQuantity: WAD, stockTargetPriceUSDG: USD }), /18 decimals/);
  await assert.rejects(previewStockOrder(clientAt(4n * WAD), wrapper, { stockQuantity: 1n, stockTargetPriceUSDG: USD }), /wrappedQuantity/);
});

test('legacy stock-quantity quotes are not silently converted or signed', () => {
  const legacy = { requestId: '0x' + 'ab'.repeat(32), vault: wrapper, dealer: wrapper, taker: underlying,
    seriesId: 1n, deliveryQty: WAD, maxCollateralShares: WAD, strikeAmountUSDG: USD,
    grossPremiumUSDG: 10n, protocolFeeUSDG: 0n, netPremiumUSDG: 10n, issuedAt: 1n, deadline: 2n, nonce: 1n };
  assert.throws(() => quoteTypedData(196, wrapper, legacy), /Missing quote field: wrappedQuantity/);
  const current = { ...legacy, wrappedQuantity: WAD };
  delete current.deliveryQty;
  delete current.maxCollateralShares;
  assert.equal(quoteTypedData(196, wrapper, current).domain.version, '2');
});
