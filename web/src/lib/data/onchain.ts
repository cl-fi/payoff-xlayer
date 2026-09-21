import { getAddress } from 'viem';
import { UserFacingError } from '../errors';
import { exchangeAbi, publicClient, tokenAbi, vaultAbi, wrapperAbi } from '../chain';
import { WAD } from '../amounts';
import type { Config } from '../config';
import type { Market, ProductSeries } from '../types';

export type MarketDirectory = {
  chainId: number;
  exchange: string;
  usdg: string;
  markets: { vault: string; seriesIds: string[] }[];
};

/** Both discovery sources use the same pinned-block contract verification and term reads. */
export async function readOnchainMarket(
  config: Config,
  directory: MarketDirectory,
  client = publicClient(config),
  expectedAssets?: { stock: string; wrappedStock: string },
): Promise<Market> {
  if ((await client.getChainId()) !== directory.chainId)
    throw new UserFacingError('The RPC is not connected to X Layer Testnet.');
  const listing = directory.markets.find((m) => m.vault.toLowerCase() === config.nvdaVault.toLowerCase());
  if (!listing) throw new UserFacingError('The NVDAx Vault is not in the product catalog.');
  const block = await client.getBlock();
  const vault = getAddress(listing.vault);
  const read = { address: vault, abi: vaultAbi, blockNumber: block.number } as const;
  const [stock, wrappedStock, usdg, exchange] = await Promise.all([
    client.readContract({ ...read, functionName: 'stock' }),
    client.readContract({ ...read, functionName: 'wrappedStock' }),
    client.readContract({ ...read, functionName: 'usdg' }),
    client.readContract({ ...read, functionName: 'exchange' }),
  ]);
  for (const [actual, expected] of [
    [usdg, directory.usdg],
    [exchange, directory.exchange],
    ...(expectedAssets
      ? [
          [stock, expectedAssets.stock],
          [wrappedStock, expectedAssets.wrappedStock],
        ]
      : []),
  ])
    if (actual.toLowerCase() !== expected.toLowerCase())
      throw new UserFacingError('The onchain asset bindings do not match the product catalog.');
  const [underlying, rate, feeBps, exchangeUSDG, allowed, usdDecimals, stockDecimals, wrappedDecimals] =
    await Promise.all([
      client.readContract({
        address: wrappedStock,
        abi: wrapperAbi,
        functionName: 'asset',
        blockNumber: block.number,
      }),
      client.readContract({
        address: wrappedStock,
        abi: wrapperAbi,
        functionName: 'convertToAssets',
        args: [WAD],
        blockNumber: block.number,
      }),
      client.readContract({
        address: exchange,
        abi: exchangeAbi,
        functionName: 'feeBps',
        blockNumber: block.number,
      }),
      client.readContract({
        address: exchange,
        abi: exchangeAbi,
        functionName: 'usdg',
        blockNumber: block.number,
      }),
      client.readContract({
        address: exchange,
        abi: exchangeAbi,
        functionName: 'vaultAllowed',
        args: [vault],
        blockNumber: block.number,
      }),
      client.readContract({
        address: usdg,
        abi: tokenAbi,
        functionName: 'decimals',
        blockNumber: block.number,
      }),
      client.readContract({
        address: stock,
        abi: tokenAbi,
        functionName: 'decimals',
        blockNumber: block.number,
      }),
      client.readContract({
        address: wrappedStock,
        abi: tokenAbi,
        functionName: 'decimals',
        blockNumber: block.number,
      }),
    ]);
  if (
    underlying.toLowerCase() !== stock.toLowerCase() ||
    exchangeUSDG.toLowerCase() !== usdg.toLowerCase() ||
    !allowed ||
    rate <= 0n ||
    usdDecimals !== 6 ||
    stockDecimals !== 18 ||
    wrappedDecimals !== 18
  )
    throw new UserFacingError('The onchain market configuration could not be verified.');
  const series: ProductSeries[] = [];
  // Bound RPC concurrency; this does not limit the catalog size.
  for (let i = 0; i < listing.seriesIds.length; i += 4) {
    series.push(
      ...(await Promise.all(
        listing.seriesIds.slice(i, i + 4).map(async (id) => {
          const s = await client.readContract({ ...read, functionName: 'getSeries', args: [BigInt(id)] });
          if (
            (s.side !== 0 && s.side !== 1) ||
            s.strikePricePerWrappedUSDG <= 0n ||
            s.tradeCutoff > s.exerciseStart ||
            s.exerciseStart >= s.exerciseEnd
          )
            throw new UserFacingError('An onchain series has invalid settlement terms.');
          return {
            id,
            vault,
            side: s.side as 0 | 1,
            label: `Series #${id}`,
            days: Math.max(0, Math.ceil(Number(s.exerciseEnd - block.timestamp) / 86400)),
            strikePricePerWrappedUSDG: String(s.strikePricePerWrappedUSDG),
            tradeCutoff: String(s.tradeCutoff),
            exerciseStart: String(s.exerciseStart),
            exerciseEnd: String(s.exerciseEnd),
          };
        }),
      )),
    );
  }
  return {
    chainId: directory.chainId,
    exchange,
    usdg,
    stock,
    wrappedStock,
    rate: String(rate),
    feeBps,
    blockNumber: String(block.number),
    series,
  };
}
