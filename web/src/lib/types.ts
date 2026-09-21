import type { Address } from 'viem';
import type { Order, Quote, Selection, Settlement, Series } from '../../../gateway/src/types';
export type { Order, Quote, Selection, Settlement };

export type Mode = 'demo' | 'gateway';
export type Scenario = 'normal' | 'no-quote' | 'expired' | 'rejected' | 'failed' | 'offline';
export type ProductSeries = Series & { id: string; days: number; vault: Address; label: string };
export type Market = {
  chainId: number;
  exchange: Address;
  usdg: Address;
  stock: Address;
  wrappedStock: Address;
  rate: string;
  blockNumber: string;
  feeBps: number;
  series: ProductSeries[];
};
export type Balances = {
  usdg: string;
  stock: string;
  wrapped: string;
  usdgAllowance: string;
  wrappedAllowance: string;
};
export type Preview = {
  order: Order;
  series: ProductSeries;
  requestedStock: string;
  stockEquivalent: string;
  wrappedQuantity: string;
  strikeAmountUSDG: string;
  rate: string;
};
export type DemoQuote = {
  kind: 'demo';
  requestId: string;
  quote: Quote;
  dealerName: string;
  signature: null;
  transaction: null;
};
export type GatewayQuote = { kind: 'gateway'; requestId: string; selection: Selection };
export type AppQuote = DemoQuote | GatewayQuote;
export type PositionStatus = 'open' | 'exercised' | 'expired' | 'claimed';
export type Position = {
  id: string;
  source: Mode;
  account: Address;
  vault: Address;
  series: ProductSeries;
  wrappedQuantity: string;
  strikeAmountUSDG: string;
  netPremiumUSDG: string;
  entryRate: string;
  openedAt: number;
  status: PositionStatus;
  outcome?: 'exercised' | 'expired';
  transactionHash?: `0x${string}`;
};
export type DemoState = {
  version: 1;
  anchor: number;
  balances: Balances;
  positions: Position[];
  filledRequests: string[];
};
export interface ProductAdapter {
  readonly mode: Mode;
  market(): Promise<Market>;
  balances(account: Address, market: Market, vault: Address): Promise<Balances>;
  quote(preview: Preview, key: string, scenario?: Scenario): Promise<AppQuote | null>;
  prepare(quote: AppQuote): Promise<AppQuote>;
}
export const quoteTerms = (quote: AppQuote): Quote =>
  quote.kind === 'demo' ? quote.quote : quote.selection.quote;
