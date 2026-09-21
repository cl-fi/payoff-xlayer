import { getAddress, isAddress, zeroAddress } from 'viem';
import { z } from 'zod';

export const address = z.string().refine(v => isAddress(v, { strict: false }) && v.toLowerCase() !== zeroAddress, 'Invalid address').transform(v => getAddress(v.toLowerCase()));
export const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform(v => v.toLowerCase() as `0x${string}`);
export const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as `0x${string}`);
export const uint = (bits = 256, positive = false) => z.string().max(78).regex(/^(0|[1-9][0-9]*)$/)
  .refine(v => BigInt(v) < (1n << BigInt(bits)) && (!positive || BigInt(v) > 0n), `Expected uint${bits}${positive ? ' > 0' : ''}`);
export const orderSchema = z.strictObject({ taker: address, vault: address, seriesId: uint(256, true), wrappedQuantity: uint(256, true) });
export type Order = z.infer<typeof orderSchema>;
export const quoteSchema = z.strictObject({
  requestId: hash, vault: address, dealer: address, taker: address, seriesId: uint(256, true),
  wrappedQuantity: uint(256, true), strikeAmountUSDG: uint(256, true),
  grossPremiumUSDG: uint(), protocolFeeUSDG: uint(), netPremiumUSDG: uint(),
  issuedAt: uint(64), deadline: uint(64), nonce: uint(),
});
export type Quote = z.infer<typeof quoteSchema>;
export const signedQuoteSchema = z.strictObject({ quote: quoteSchema, signature: hex });
export type SignedQuote = z.infer<typeof signedQuoteSchema>;
export const dealerResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('quote'), quote: quoteSchema, signature: hex }),
  z.strictObject({ status: z.literal('no_quote'), reason: z.string().max(200) }),
]);

export type Series = { side: 0 | 1; strikePricePerWrappedUSDG: string; tradeCutoff: string; exerciseStart: string; exerciseEnd: string };
export type Snapshot = {
  blockNumber: string; blockHash: `0x${string}`; timestamp: string;
  usdg: `0x${string}`; wrappedStock: `0x${string}`; stock: `0x${string}`;
  feeBps: number; terms: Series; strikeAmountUSDG: string;
};
export type DealerRequest = {
  version: '1'; requestId: `0x${string}`; chainId: number; exchange: `0x${string}`;
  order: Order; snapshot: Snapshot; collectUntil: string;
};
export type FillLimits = { minNetPremiumUSDG: bigint; maxCollateralUSDG: bigint; maxCollateralWrapped: bigint };
export type Transaction = { chainId: number; from: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value: '0' };
export type Selection = SignedQuote & {
  dealerId: string; dealerName: string; source: 'live' | 'test'; quoteHash: `0x${string}`;
  transaction: Transaction; checkedAtBlock: string; checkedAt: string;
};
export type Outcome = {
  dealerId: string; status: 'valid' | 'rejected' | 'no_quote' | 'timeout' | 'error';
  code?: string; elapsedMs: number; signedQuote?: SignedQuote;
};
export type RfqResult = {
  requestId: `0x${string}`; status: 'quoted' | 'no_quote' | 'failed';
  selection?: Selection; error?: { code: string; message: string };
  responses: Array<Pick<Outcome, 'dealerId' | 'status' | 'code'>>;
};
export type Settlement = {
  transactionHash: `0x${string}`; status: 'pending' | 'confirming' | 'confirmed' | 'reverted' | 'mismatched';
  confirmations: number; blockNumber?: string; blockHash?: `0x${string}`; positionId?: string;
};
