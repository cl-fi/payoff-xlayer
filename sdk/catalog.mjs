import { z } from 'zod';
import { getAddress, isAddress, zeroAddress } from 'viem';

const address = z.string().refine(v => isAddress(v, { strict: false }) && v.toLowerCase() !== zeroAddress)
  .transform(v => getAddress(v.toLowerCase()));
const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) < 2n ** 256n);
const positive = uint.refine(v => BigInt(v) > 0n);
export const termsSchema = z.object({
  side: z.union([z.literal(0), z.literal(1)]), strikePricePerWrappedUSDG: positive,
  tradeCutoff: positive, exerciseStart: positive, exerciseEnd: positive,
}).refine(s => BigInt(s.tradeCutoff) <= BigInt(s.exerciseStart) && BigInt(s.exerciseStart) < BigInt(s.exerciseEnd)
  && BigInt(s.exerciseEnd) < 2n ** 64n);
const seriesSchema = z.object({ id: positive, label: z.string().min(1), ...termsSchema.shape }).refine(s => termsSchema.safeParse(s).success);
export const catalogSchema = z.object({
  version: z.literal(1), chainId: z.number().int().positive(), exchange: address, usdg: address,
  generatedAt: z.iso.datetime(), blockNumber: uint, feeBps: z.number().int().min(0).max(10000),
  markets: z.array(z.object({
    vault: address, stock: address, wrappedStock: address, symbol: z.string().regex(/^[A-Z]{1,10}$/),
    rate: positive, series: z.array(seriesSchema).refine(ss => new Set(ss.map(s => s.id)).size === ss.length),
  })).min(1),
}).refine(c => new Set(c.markets.map(m => m.vault)).size === c.markets.length);

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = { vault: address, seriesId: positive, terms: termsSchema };
export const referenceSnapshotSchema = z.object({
  version: z.literal(1), chainId: z.number().int().positive(), exchange: address,
  updatedAtMs: timestamp, catalogGeneratedAt: z.iso.datetime(),
  refreshIntervalMs: z.number().int().positive(), maxQuoteAgeMs: z.number().int().positive(),
  markets: z.array(z.object({ vault: address, rate: positive, feeBps: z.number().int().min(0).max(10000),
    blockNumber: uint, observedAtMs: timestamp })),
  quotes: z.array(z.discriminatedUnion('status', [
    z.object({ ...base, status: z.literal('available'), netPremiumPerWrappedUSDG: positive,
      assetsPerWrapped: positive, calculatedAtMs: timestamp, marketTimestampMs: timestamp,
      marketOpenMs: timestamp, marketCloseMs: timestamp, expirationCloseMs: timestamp,
      marketDataMode: z.enum(['live', 'last_valid']),
      option: z.object({ symbol: z.string(), expiration: z.string(), right: z.enum(['put', 'call']), strikeMilli: positive }),
    }),
    z.object({ ...base, status: z.literal('unavailable'), reason: z.string().regex(/^[A-Z_]+$/) }),
  ])),
});

export const sameTerms = (a, b) => ['side', 'strikePricePerWrappedUSDG', 'tradeCutoff', 'exerciseStart', 'exerciseEnd']
  .every(key => a[key] === b[key]);
