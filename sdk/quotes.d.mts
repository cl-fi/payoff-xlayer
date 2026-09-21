import type { Address, Hex, TypedData } from 'viem';
export const quoteTypes: TypedData;
export function quoteTypedData(chainId: number, exchange: Address, quote: Record<string, string | bigint>): {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  primaryType: string;
  types: TypedData;
  message: Record<string, string | bigint>;
};
export function quoteDigest(chainId: number, exchange: Address, quote: Record<string, string | bigint>): Hex;
export function signQuote(signer: { signTypedData: (data: ReturnType<typeof quoteTypedData>) => Promise<Hex> }, chainId: number, exchange: Address, quote: Record<string, string | bigint>): Promise<Hex>;
