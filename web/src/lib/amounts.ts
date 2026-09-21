import { UserFacingError } from './errors';
import { formatUnits, parseUnits, type Address } from 'viem';
import { strikeAmountUSDG } from '../../../sdk/wrapped-assets.mjs';
import type { Market, Preview, ProductSeries } from './types';
export const WAD = 10n ** 18n;
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function parseQuantity(input: string) {
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(input))
    throw new UserFacingError('Enter a stock quantity greater than 0, with up to 18 decimal places.');
  const amount = parseUnits(input, 18);
  if (amount <= 0n || amount >= 1n << 256n) throw new UserFacingError('Enter a valid stock quantity.');
  return amount;
}
export function previewOrder(
  input: string,
  series: ProductSeries,
  market: Market,
  account: Address,
): Preview {
  const requestedStock = parseQuantity(input);
  const quantity = (requestedStock * WAD) / BigInt(market.rate);
  if (quantity === 0n)
    throw new UserFacingError('This quantity converts to less than one smallest wrapped token unit.');
  const strike = strikeAmountUSDG(quantity, series.strikePricePerWrappedUSDG);
  return {
    order: { taker: account, vault: series.vault, seriesId: series.id, wrappedQuantity: quantity.toString() },
    series,
    requestedStock: requestedStock.toString(),
    stockEquivalent: ((quantity * BigInt(market.rate)) / WAD).toString(),
    wrappedQuantity: quantity.toString(),
    strikeAmountUSDG: strike.toString(),
    rate: market.rate,
  };
}
export function amount(value: string | bigint, decimals = 6, places = 2) {
  const [whole, fraction = ''] = formatUnits(BigInt(value), decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return places ? `${grouped}.${fraction.padEnd(places, '0').slice(0, places)}` : grouped;
}
export function precise(value: string | bigint, decimals = 18) {
  return formatUnits(BigInt(value), decimals);
}
export function ratio(numerator: string, denominator: string) {
  if (BigInt(denominator) === 0n) return '0.00';
  return amount((BigInt(numerator) * 10000n) / BigInt(denominator), 2, 2);
}
export function stockTarget(series: ProductSeries, rate: string) {
  return ceilDiv(BigInt(series.strikePricePerWrappedUSDG) * WAD, BigInt(rate));
}
export function dateTime(seconds: string | number, timeZone?: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone, timeZoneName: 'short' as const } : {}),
  }).format(Number(seconds) * 1000);
}
export function dateOnly(seconds: string | number, timeZone?: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(
    Number(seconds) * 1000,
  );
}
export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
