import { sameTerms, type ReferenceSnapshot } from '../../../../sdk/catalog.mjs';
import type { Preview } from '../types';
import { WAD } from '../amounts';

export function referenceEstimate(
  snapshot: ReferenceSnapshot | null,
  preview: Preview | null,
  nowMs: number,
) {
  if (!snapshot || !preview || Number(preview.series.tradeCutoff) * 1000 <= nowMs) return null;
  const quote = snapshot.quotes.find(
    (q) => q.seriesId === preview.series.id && q.vault.toLowerCase() === preview.series.vault.toLowerCase(),
  );
  if (
    !quote ||
    !sameTerms(quote.terms, preview.series) ||
    quote.status !== 'available' ||
    quote.assetsPerWrapped !== preview.rate ||
    quote.marketTimestampMs > nowMs + 1000
  )
    return null;
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
