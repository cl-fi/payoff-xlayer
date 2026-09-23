import { sameTerms, type ReferenceSnapshot } from '../../../../sdk/catalog.mjs';
import type { Preview, ProductSeries } from '../types';
import { WAD } from '../amounts';

// The published reference for one series, or null when it is missing, unavailable, observed in the
// future, priced on other terms or at another wrapping rate, or the series is closed to new positions.
export function referenceQuote(
  snapshot: ReferenceSnapshot | null,
  series: ProductSeries,
  rate: string,
  nowMs: number,
) {
  if (!snapshot || Number(series.tradeCutoff) * 1000 <= nowMs) return null;
  const quote = snapshot.quotes.find(
    (q) => q.seriesId === series.id && q.vault.toLowerCase() === series.vault.toLowerCase(),
  );
  if (
    !quote ||
    !sameTerms(quote.terms, series) ||
    quote.status !== 'available' ||
    quote.assetsPerWrapped !== rate ||
    quote.marketTimestampMs > nowMs + 1000
  )
    return null;
  return quote;
}

export function referenceEstimate(
  snapshot: ReferenceSnapshot | null,
  preview: Preview | null,
  nowMs: number,
) {
  if (!snapshot || !preview) return null;
  const quote = referenceQuote(snapshot, preview.series, preview.rate, nowMs);
  if (!quote) return null;
  const live =
    quote.marketDataMode === 'live' &&
    nowMs >= quote.marketOpenMs &&
    nowMs < quote.marketCloseMs &&
    nowMs - quote.marketTimestampMs < snapshot.maxQuoteAgeMs;
  return {
    netPremiumUSDG: (
      (BigInt(quote.netPremiumPerWrappedUSDG) * BigInt(preview.wrappedQuantity)) /
      WAD
    ).toString(),
    quote,
    live,
    delayed: nowMs - snapshot.updatedAtMs > Math.max(90000, snapshot.refreshIntervalMs * 3),
  };
}
