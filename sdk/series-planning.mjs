import { termsSchema, sameTerms } from './catalog.mjs';
import { wrappedStrikeFromStockPrice } from './wrapped-assets.mjs';

/** Native targets are product configuration; each generation fixes its wrapped strike. */
export function planNativeSeries(products, existingSeries, rate, nowSeconds) {
  return products.map(product => {
    const terms = termsSchema.parse({ ...product,
      strikePricePerWrappedUSDG: wrappedStrikeFromStockPrice(product.stockTargetPriceUSDG, rate).toString() });
    return { stockTargetPriceUSDG: BigInt(product.stockTargetPriceUSDG).toString(), ...terms };
  }).filter(product => BigInt(product.tradeCutoff) > BigInt(nowSeconds)).map(product => ({
    ...product,
    existingSeriesId: existingSeries.find(series => sameTerms(series, product))?.id ?? null,
  }));
}
