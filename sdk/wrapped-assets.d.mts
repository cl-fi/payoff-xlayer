import type { Address, PublicClient } from 'viem';
export function strikeAmountUSDG(wrappedQuantity: string | bigint, strikePricePerWrappedUSDG: string | bigint): bigint;
export function wrappedStrikeFromStockPrice(stockTargetPriceUSDG: string | bigint, assetsPerWrapped: string | bigint): bigint;
export function stockEquivalentStrikeUSDG(fixedStrikeAmountUSDG: string | bigint, currentStockEquivalent: string | bigint): bigint;
export function previewStockOrder(client: PublicClient, wrappedStock: Address, input: { stockQuantity: string | bigint; stockTargetPriceUSDG: string | bigint }): Promise<{
  blockNumber: bigint; wrappedStock: Address; underlyingStock: Address; requestedStockQuantity: bigint;
  stockTargetPriceUSDG: bigint; assetsPerWrapped: bigint; stockEquivalentAtQuote: bigint; wrappedQuantity: bigint;
  strikePricePerWrappedUSDG: bigint; strikeAmountUSDG: bigint;
}>;
