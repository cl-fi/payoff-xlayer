import type { CatalogTerms, ReferencePrice } from './catalog.mjs';
export function usablePrice(price: ReferencePrice | null | undefined, nowMs: number): boolean;
export function eligibleSeries(terms: Pick<CatalogTerms, 'side' | 'strikePricePerWrappedUSDG' | 'tradeCutoff'>, rate: string | bigint, price: ReferencePrice | null | undefined, nowMs: number): boolean;
export function nearestSeries<T extends CatalogTerms>(series: T[], rate: string | bigint, price: ReferencePrice | null | undefined, nowMs: number, count?: number): T[];
