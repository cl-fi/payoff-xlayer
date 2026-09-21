import { parseAbi } from 'viem';

const WAD = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;
const wrapperAbi = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function convertToShares(uint256 assets) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
]);

function uint(value, name, allowZero = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Unsafe numeric ${name}`);
  const n = BigInt(value);
  if (n < (allowZero ? 0n : 1n) || n > MAX_UINT256) throw new Error(`Invalid ${name}`);
  return n;
}
const ceilDiv = (n, d) => (n + d - 1n) / d;

/** q: wrapped base units (18 dp); K: USDG base units per whole wrapped token (6 dp). */
export function strikeAmountUSDG(wrappedQuantity, strikePricePerWrappedUSDG) {
  return uint(ceilDiv(uint(wrappedQuantity, 'wrappedQuantity') * uint(strikePricePerWrappedUSDG, 'wrapped strike'), WAD), 'strikeAmountUSDG');
}

/** Proposed series strike, rounded up to one USDG base unit per wrapped token. */
export function wrappedStrikeFromStockPrice(stockTargetPriceUSDG, assetsPerWrapped) {
  return uint(ceilDiv(uint(stockTargetPriceUSDG, 'stock target') * uint(assetsPerWrapped, 'conversion rate'), WAD), 'wrapped strike');
}

/**
 * Quote-time reference only: all conversions read at ONE block. No transaction, wrapping, or signing.
 * Confirm the returned wrapped quantity and rounded USDG total before creating/signing a quote.
 * Existing series keep their original wrapped strike; do not overwrite it using a newer rate.
 */
export async function previewStockOrder(client, wrappedStock, { stockQuantity, stockTargetPriceUSDG }) {
  const requestedStockQuantity = uint(stockQuantity, 'stock quantity');
  const target = uint(stockTargetPriceUSDG, 'stock target');
  const blockNumber = await client.getBlockNumber();
  const read = (functionName, args = []) => client.readContract({ address: wrappedStock, abi: wrapperAbi, functionName, args, blockNumber });
  const [underlyingStock, decimals, quantity, rate] = await Promise.all([
    read('asset'), read('decimals'), read('convertToShares', [requestedStockQuantity]), read('convertToAssets', [WAD]),
  ]);
  if (Number(decimals) !== 18) throw new Error('Wrapped asset must use 18 decimals');
  const wrappedQuantity = uint(quantity, 'wrappedQuantity');
  const assetsPerWrapped = uint(rate, 'conversion rate');
  const stockEquivalentAtQuote = uint(await read('convertToAssets', [wrappedQuantity]), 'stock equivalent');
  if (stockEquivalentAtQuote > requestedStockQuantity) throw new Error('Conversion exceeds requested stock quantity');
  const strikePricePerWrappedUSDG = wrappedStrikeFromStockPrice(target, assetsPerWrapped);
  return {
    blockNumber, wrappedStock, underlyingStock, requestedStockQuantity,
    stockTargetPriceUSDG: target, assetsPerWrapped, stockEquivalentAtQuote,
    wrappedQuantity, strikePricePerWrappedUSDG,
    strikeAmountUSDG: strikeAmountUSDG(wrappedQuantity, strikePricePerWrappedUSDG),
  };
}

/** Display-only effective stock price, rounded UP in USDG base units; excludes premium and fees. */
export function stockEquivalentStrikeUSDG(fixedStrikeAmountUSDG, currentStockEquivalent) {
  return uint(ceilDiv(uint(fixedStrikeAmountUSDG, 'fixed USDG total') * WAD, uint(currentStockEquivalent, 'stock equivalent')), 'stock equivalent strike');
}
