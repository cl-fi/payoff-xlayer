import { UserFacingError } from '../errors';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { quoteSchema, address, hash, hex, uint } from '../../../../gateway/src/types';
import { expectedFillData, publicClient, readBalances } from '../chain';
import { readOnchainMarket } from './onchain';
import { staticMarket } from './catalog';
import { referenceSnapshotSchema, sameTerms } from '../../../../sdk/catalog.mjs';
import type { Config } from '../config';
import type {
  AppQuote,
  GatewayQuote,
  Market,
  Preview,
  ProductAdapter,
  Selection,
  Settlement,
} from '../types';

const selectionSchema = z.object({
  quote: quoteSchema,
  signature: hex,
  quoteHash: hash,
  dealerId: z.string(),
  dealerName: z.string(),
  source: z.enum(['live', 'test']),
  checkedAt: z.string(),
  checkedAtBlock: uint(),
  transaction: z.object({
    chainId: z.number(),
    from: address,
    to: address,
    value: z.literal('0'),
    data: hex,
  }),
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function validateSelection(selection: Selection, preview: Preview, market: Market): GatewayQuote {
  const q = selection.quote,
    p = preview.order,
    tx = selection.transaction;
  if (
    !same(q.taker, p.taker) ||
    !same(q.vault, p.vault) ||
    q.seriesId !== p.seriesId ||
    q.wrappedQuantity !== p.wrappedQuantity ||
    q.strikeAmountUSDG !== preview.strikeAmountUSDG
  )
    throw new UserFacingError('The gateway quote does not match the current order.');
  const fee = (BigInt(q.grossPremiumUSDG) * BigInt(market.feeBps)) / 10000n;
  if (BigInt(q.protocolFeeUSDG) !== fee || BigInt(q.netPremiumUSDG) + fee !== BigInt(q.grossPremiumUSDG))
    throw new UserFacingError('Quote fees do not match.');
  const quote: GatewayQuote = { kind: 'gateway', requestId: q.requestId, selection };
  if (
    tx.chainId !== market.chainId ||
    !same(tx.from, p.taker) ||
    !same(tx.to, market.exchange) ||
    tx.value !== '0' ||
    tx.data !== expectedFillData(quote, preview)
  )
    throw new UserFacingError('The gateway transaction parameters do not match the confirmed terms.');
  return quote;
}
export class GatewayAdapter implements ProductAdapter {
  readonly mode = 'gateway' as const;
  private context = new Map<string, { preview: Preview; market: Market }>();
  constructor(
    readonly config: Config,
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private client = publicClient(config),
  ) {}
  private async api(path: string, body?: unknown, key?: string) {
    const response = await this.fetcher(this.config.gatewayUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(35000),
    });
    const result = await response.json();
    if (!response.ok) throw new UserFacingError(gatewayError(result?.error?.code));
    return result;
  }
  async market(): Promise<Market> {
    return staticMarket(this.config);
  }
  async references() {
    const snapshot = referenceSnapshotSchema.parse(await this.api('/v1/reference-quotes'));
    const market = staticMarket(this.config);
    if (snapshot.chainId !== market.chainId || !same(snapshot.exchange, market.exchange))
      throw new UserFacingError('Reference prices do not match this network.');
    return snapshot;
  }
  async selectedMarket(preview: Preview): Promise<Market> {
    const published = staticMarket(this.config);
    const market = await readOnchainMarket(
      this.config,
      {
        chainId: published.chainId,
        exchange: published.exchange,
        usdg: published.usdg,
        markets: [{ vault: preview.order.vault, seriesIds: [preview.order.seriesId] }],
      },
      this.client,
      published,
    );
    if (!sameTerms(market.series[0], preview.series))
      throw new UserFacingError('The published product terms changed. Reload before trading.');
    if (market.rate !== preview.rate)
      throw new UserFacingError(
        'The wrapping rate changed. Wait for the reference update and review your quantity again.',
      );
    return market;
  }

  balances(account: Address, market: Market, vault: Address) {
    return readBalances(this.config, account, market, vault);
  }
  async quote(preview: Preview, key: string): Promise<GatewayQuote | null> {
    const market = await this.selectedMarket(preview);
    let response = await this.api('/v1/rfqs', preview.order, key);
    const start = Date.now();
    while (response.status === 'collecting' && Date.now() - start < 25000) {
      const id = hash.parse(response.requestId);
      await new Promise((resolve) => setTimeout(resolve, 600));
      response = await this.api(`/v1/rfqs/${id}`);
    }
    if (response.status === 'no_quote') return null;
    if (response.status !== 'quoted')
      throw new UserFacingError('No valid quote was received. Please request a new quote.');
    const selection = selectionSchema.parse(response.selection),
      quote = validateSelection(selection, preview, market);
    this.context.set(quote.requestId, { preview, market });
    return quote;
  }
  async prepare(quote: AppQuote): Promise<GatewayQuote> {
    if (quote.kind !== 'gateway')
      throw new UserFacingError('Demo quotes cannot be submitted to a live gateway.');
    const context = this.context.get(quote.requestId);
    if (!context) throw new UserFacingError('The order context has expired. Please request a new quote.');
    const response = await this.api(`/v1/rfqs/${quote.requestId}/prepare`, {});
    if (response.status !== 'ready')
      throw new UserFacingError('This quote is no longer executable. Request a new quote.');
    const checked = validateSelection(
      selectionSchema.parse(response.selection),
      context.preview,
      context.market,
    );
    if (
      checked.selection.quoteHash !== quote.selection.quoteHash ||
      checked.selection.transaction.data !== quote.selection.transaction.data
    )
      throw new UserFacingError('The quote changed during preparation. Please review it again.');
    return checked;
  }
  async settlement(requestId: string, transactionHash: Hex): Promise<Settlement> {
    return z
      .object({
        transactionHash: hash,
        status: z.enum(['pending', 'confirming', 'confirmed', 'reverted', 'mismatched']),
        confirmations: z.number(),
        blockNumber: uint().optional(),
        blockHash: hash.optional(),
        positionId: uint().optional(),
      })
      .parse(await this.api(`/v1/rfqs/${hash.parse(requestId)}/transactions`, { transactionHash }));
  }
}
function gatewayError(code: unknown) {
  const messages: Record<string, string> = {
    TAKER_BALANCE: 'Insufficient collateral. Reduce the quantity or fund your wallet.',
    TAKER_ALLOWANCE: 'Approve the required collateral before requesting a quote.',
    QUOTE_EXPIRED: 'The quote expired. Request a new quote.',
    NONCE_UNAVAILABLE: 'This quote has already been used or cancelled. Request a new quote.',
    DEALER_BALANCE: 'The dealer cannot fund this quote now. Try a smaller quantity or request a new quote.',
    DEALER_ALLOWANCE: 'The dealer cannot execute this quote now. Request a new quote.',
    SIMULATION_REVERTED:
      'The trade cannot execute with the current balances or terms. Refresh and request a new quote.',
  };
  return (
    messages[String(code)] ?? 'The quote service could not complete this request. Refresh and try again.'
  );
}
