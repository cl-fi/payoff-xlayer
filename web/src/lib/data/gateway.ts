import { UserFacingError } from '../errors';
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { quoteSchema, address, hash, hex, uint } from '../../../../gateway/src/types';
import { expectedFillData, exchangeAbi, publicClient, readBalances, vaultAbi, wrapperAbi } from '../chain';
import { WAD } from '../amounts';
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
    private fetcher: typeof fetch = fetch,
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
      signal: AbortSignal.timeout(25000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        typeof result?.error?.message === 'string'
          ? result.error.message
          : 'The quote service is unavailable. Please try again later.',
      );
    return result;
  }
  async market(): Promise<Market> {
    const directory = z
      .object({
        chainId: z.literal(1952),
        exchange: address,
        usdg: address,
        markets: z.array(z.object({ vault: address, seriesIds: z.array(uint(256, true)) })).min(1),
      })
      .parse(await this.api('/v1/markets'));
    const client = publicClient(this.config);
    if ((await client.getChainId()) !== directory.chainId)
      throw new UserFacingError('The RPC network does not match the gateway configuration.');
    // The first frontend release presents one stock. More Vaults remain available at the API layer.
    const listed = directory.markets.find((m) => same(m.vault, this.config.nvdaVault));
    if (!listed)
      throw new UserFacingError('The configured NVDAx Vault is not in the gateway product directory.');
    const block = await client.getBlock();
    const read = { address: listed.vault, abi: vaultAbi, blockNumber: block.number } as const;
    const [wrappedStock, stock, usdg, exchange, feeBps] = await Promise.all([
      client.readContract({ ...read, functionName: 'wrappedStock' }),
      client.readContract({ ...read, functionName: 'stock' }),
      client.readContract({ ...read, functionName: 'usdg' }),
      client.readContract({ ...read, functionName: 'exchange' }),
      client.readContract({
        address: directory.exchange,
        abi: exchangeAbi,
        functionName: 'feeBps',
        blockNumber: block.number,
      }),
    ]);
    if (!same(usdg, directory.usdg) || !same(exchange, directory.exchange))
      throw new UserFacingError('The Vault binding does not match the gateway configuration.');
    const rate = await client.readContract({
      address: wrappedStock,
      abi: wrapperAbi,
      functionName: 'convertToAssets',
      args: [WAD],
      blockNumber: block.number,
    });
    if (rate <= 0n) throw new UserFacingError('The wrapping exchange rate is unavailable.');
    const series = await Promise.all(
      listed.seriesIds.map(async (id) => {
        const s = await client.readContract({ ...read, functionName: 'getSeries', args: [BigInt(id)] });
        if (s.side !== 0 && s.side !== 1) throw new UserFacingError('Unsupported series side.');
        return {
          id,
          side: s.side as 0 | 1,
          vault: getAddress(listed.vault),
          days: Math.max(0, Math.ceil(Number(s.exerciseEnd - block.timestamp) / 86400)),
          label: `Series #${id}`,
          strikePricePerWrappedUSDG: String(s.strikePricePerWrappedUSDG),
          tradeCutoff: String(s.tradeCutoff),
          exerciseStart: String(s.exerciseStart),
          exerciseEnd: String(s.exerciseEnd),
        };
      }),
    );
    return {
      chainId: directory.chainId,
      exchange,
      usdg,
      stock,
      wrappedStock,
      rate: String(rate),
      blockNumber: String(block.number),
      feeBps,
      series,
    };
  }
  balances(account: Address, market: Market, vault: Address) {
    return readBalances(this.config, account, market, vault);
  }
  async quote(preview: Preview, key: string): Promise<GatewayQuote | null> {
    const market = await this.market();
    let response = await this.api('/v1/rfqs', preview.order, key);
    const start = Date.now();
    while (response.status === 'collecting' && Date.now() - start < 25000) {
      const id = hash.parse(response.requestId);
      await new Promise((resolve) => setTimeout(resolve, 600));
      response = await this.api(`/v1/rfqs/${id}`);
    }
    if (response.status === 'no_quote') return null;
    if (response.status !== 'quoted')
      throw new Error(response.error?.message ?? 'No valid quote was received. Please request a new quote.');
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
