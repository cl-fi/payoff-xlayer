import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '../public/catalog.json' with { type: 'json' };
import products from '../../config/nvda-products.testnet.json' with { type: 'json' };
import generation from '../../config/nvda-series-generation.testnet.json' with { type: 'json' };

test('published generation uses native targets at its creation rate and retains the product expiries', () => {
  const listing = catalog.markets.find((m) => m.vault.toLowerCase() === generation.vault.toLowerCase())!;
  assert.ok(listing);
  assert.deepEqual(
    listing.series.map((s) => s.id),
    generation.publishedSeries.map((s) => s.id),
  );
  const rate = BigInt(generation.assetsPerWrapped);
  for (const published of listing.series) {
    const source = generation.publishedSeries.find((s) => s.id === published.id)!;
    const product = products.products.find(
      (p) =>
        p.side === published.side &&
        p.stockTargetPriceUSDG === source.stockTargetPriceUSDG &&
        p.exerciseEnd === published.exerciseEnd,
    )!;
    assert.ok(product);
    assert.equal(published.tradeCutoff, product.tradeCutoff);
    assert.equal(published.exerciseStart, product.exerciseStart);
    assert.equal(published.strikePricePerWrappedUSDG, source.strikePricePerWrappedUSDG);
    // The actual contract strike, not just its label, must recover the native target
    // within one USDG base unit of per-wrapped-token rounding.
    const difference =
      BigInt(published.strikePricePerWrappedUSDG) * 10n ** 18n - BigInt(product.stockTargetPriceUSDG) * rate;
    assert.ok(difference >= 0n && difference < 10n ** 18n);
  }
});
