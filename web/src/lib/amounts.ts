import { UserFacingError } from './errors';
import { formatUnits, parseUnits, type Address } from 'viem';
import { strikeAmountUSDG } from '../../../sdk/wrapped-assets.mjs';
import type { Balances, Market, Preview, ProductSeries, QuantityUnit } from './types';
export const WAD = 10n ** 18n;
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function parseQuantity(input: string) {
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(input))
    throw new UserFacingError('Enter a stock quantity greater than 0, with up to 18 decimal places.');
  const amount = parseUnits(input, 18);
  if (amount <= 0n || amount >= 1n << 256n) throw new UserFacingError('Enter a valid stock quantity.');
  return amount;
}
export function parseUSDG(input: string) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(input))
    throw new UserFacingError('Enter a USDG amount greater than 0, with up to 6 decimal places.');
  const amount = parseUnits(input, 6);
  if (amount <= 0n || amount >= 1n << 256n) throw new UserFacingError('Enter a valid USDG amount.');
  return amount;
}
export function previewOrder(
  input: string,
  series: ProductSeries,
  market: Market,
  account: Address,
  unit: QuantityUnit = 'stock',
): Preview {
  const inputQuantity = unit === 'usdg' ? parseUSDG(input) : parseQuantity(input);
  const rate = BigInt(market.rate);
  if (rate <= 0n) throw new UserFacingError('The wrapping rate is unavailable. Please try again later.');
  // A USDG amount converts at the series' own wrapped strike, rounding down, so the settlement amount
  // (rounded up by the SDK) never exceeds what was typed.
  const quantity =
    unit === 'usdg'
      ? (inputQuantity * WAD) / BigInt(series.strikePricePerWrappedUSDG)
      : (inputQuantity * WAD) / rate;
  if (quantity === 0n)
    throw new UserFacingError(
      unit === 'usdg'
        ? 'This amount is too small for one smallest wrapped token unit at this target.'
        : 'This quantity converts to less than one smallest wrapped token unit.',
    );
  const strike = strikeAmountUSDG(quantity, series.strikePricePerWrappedUSDG);
  return {
    order: { taker: account, vault: series.vault, seriesId: series.id, wrappedQuantity: quantity.toString() },
    series,
    inputQuantity: inputQuantity.toString(),
    inputUnit: unit,
    stockEquivalent: ((quantity * rate) / WAD).toString(),
    wrappedQuantity: quantity.toString(),
    strikeAmountUSDG: strike.toString(),
    rate: market.rate,
  };
}
// The largest order the wallet can fund: USDG at the series strike for Buy Low; for Sell High, wrapped
// tokens plus the NVDAx that preparing the order would wrap.
export function maxWrappedQuantity(balances: Balances, series: ProductSeries, rate: string) {
  return series.side === 0
    ? (BigInt(balances.usdg) * WAD) / BigInt(series.strikePricePerWrappedUSDG)
    : BigInt(balances.wrapped) + (BigInt(balances.stock) * WAD) / BigInt(rate);
}
export function exceedsBalance(balances: Balances, preview: Preview) {
  return preview.series.side === 0
    ? BigInt(preview.strikeAmountUSDG) > BigInt(balances.usdg)
    : BigInt(preview.wrappedQuantity) > maxWrappedQuantity(balances, preview.series, preview.rate);
}
// Plain decimal text for an input field (no grouping), rounded down to `places`.
export const plainDecimal = (value: string | bigint, decimals: number, places: number) =>
  formatUnits(BigInt(value) - (BigInt(value) % 10n ** BigInt(decimals - places)), decimals);
/**
 * Deposit field text for a share of the balance. Every conversion rounds down, so the order the text
 * parses back to stays within the balance. Max keeps full USDG precision; shares round to cents.
 */
export function balanceInput(
  balances: Balances,
  series: ProductSeries,
  rate: string,
  unit: QuantityUnit,
  percent: number,
) {
  const share = (value: bigint) => (value * BigInt(percent)) / 100n;
  if (unit === 'usdg' && series.side === 0)
    return plainDecimal(share(BigInt(balances.usdg)), 6, percent === 100 ? 6 : 2);
  // Sell High in NVDAx starts from the NVDAx balance itself, so Max of a whole balance stays whole.
  if (unit === 'stock' && series.side === 1)
    return plainDecimal(
      share(BigInt(balances.stock) + (BigInt(balances.wrapped) * BigInt(rate)) / WAD),
      18,
      6,
    );
  const quantity = share(maxWrappedQuantity(balances, series, rate));
  return unit === 'usdg'
    ? plainDecimal((quantity * BigInt(series.strikePricePerWrappedUSDG)) / WAD, 6, 2)
    : plainDecimal((quantity * BigInt(rate)) / WAD, 18, 6);
}
export function amount(value: string | bigint, decimals = 6, places = 2) {
  const [whole, fraction = ''] = formatUnits(BigInt(value), decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return places ? `${grouped}.${fraction.padEnd(places, '0').slice(0, places)}` : grouped;
}
// Rounded (half-up) display for derived quantities, so a typed 1 NVDAx does not show as 0.9999.
export function rounded(value: string | bigint, decimals: number, places: number) {
  const scale = 10n ** BigInt(decimals - places);
  return amount((BigInt(value) + scale / 2n) / scale, places, places);
}
export function precise(value: string | bigint, decimals = 18) {
  return formatUnits(BigInt(value), decimals);
}
// Simple (non-compounded) annualization over the time left until the exercise window closes, in basis points.
export function aprBps(numerator: string, denominator: string, secondsToExpiry: number) {
  const basis = BigInt(denominator) * BigInt(Math.floor(secondsToExpiry));
  if (basis <= 0n) return null;
  return (BigInt(numerator) * 10000n * 31536000n) / basis;
}
export function apr(numerator: string, denominator: string, secondsToExpiry: number) {
  const bps = aprBps(numerator, denominator, secondsToExpiry);
  return bps === null ? null : amount(bps, 2, 2);
}
export function stockTarget(series: ProductSeries, rate: string) {
  return ceilDiv(BigInt(series.strikePricePerWrappedUSDG) * WAD, BigInt(rate));
}
// Dates and times are shown in the viewer's own time zone; `withZone` names it, e.g. "GMT+8".
export function dateTime(seconds: string | number, withZone = false) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(withZone ? { timeZoneName: 'short' as const } : {}),
  }).format(Number(seconds) * 1000);
}
export function dateOnly(seconds: string | number) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(Number(seconds) * 1000);
}
// Time left to a deadline, to the hour while days remain: "5d 11h left", then "11h 20m left", "20m left".
export function timeLeft(seconds: number) {
  const minutes = Math.max(0, Math.floor(seconds / 60)),
    hours = Math.floor(minutes / 60),
    days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h left`;
  if (hours) return `${hours}h ${minutes % 60}m left`;
  return minutes ? `${minutes}m left` : 'Less than 1m left';
}
export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
