import raw from '../public/catalog.json' with { type: 'json' };
import { catalogSchema, type ReferenceSnapshot } from '../../sdk/catalog.mjs';
export function referenceFixture(nowMs = Date.parse('2026-09-21T08:00:00Z')): ReferenceSnapshot {
  const c = catalogSchema.parse(raw);
  return {
    version: 1,
    chainId: c.chainId,
    exchange: c.exchange,
    catalogGeneratedAt: c.generatedAt,
    updatedAtMs: nowMs,
    refreshIntervalMs: 30000,
    maxQuoteAgeMs: 30000,
    markets: c.markets.map((m) => ({
      vault: m.vault,
      rate: m.rate,
      feeBps: c.feeBps,
      blockNumber: c.blockNumber,
      observedAtMs: nowMs,
    })),
    quotes: c.markets.flatMap((m) =>
      m.series.map((s) => ({
        vault: m.vault,
        seriesId: s.id,
        terms: s,
        status: 'available' as const,
        netPremiumPerWrappedUSDG: s.side === 0 ? '500000' : '1250000',
        assetsPerWrapped: m.rate,
        calculatedAtMs: nowMs,
        marketTimestampMs: Date.parse('2026-09-18T19:59:00Z'),
        marketOpenMs: Date.parse('2026-09-18T13:30:00Z'),
        marketCloseMs: Date.parse('2026-09-18T20:00:00Z'),
        expirationCloseMs: Number(s.exerciseEnd) * 1000,
        marketDataMode: 'last_valid' as const,
        option: {
          symbol: m.symbol,
          expiration: new Date(Number(s.exerciseEnd) * 1000).toISOString().slice(0, 10),
          right: s.side === 0 ? ('put' as const) : ('call' as const),
          strikeMilli: (BigInt(s.strikePricePerWrappedUSDG) / 1000n).toString(),
        },
      })),
    ),
  };
}
