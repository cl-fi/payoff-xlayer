import { type Address } from 'viem';
import { exchangeAbi, publicClient, vaultAbi } from '../chain';
import type { Config } from '../config';
import type { Market, Position, ProductSeries } from '../types';

/** Holder-index page size. The Vault returns an empty page past the end instead of reverting. */
const PAGE = 500n;
/** Calldata bytes per Multicall3 chunk; viem sends chunks in parallel. */
const BATCH_SIZE = 4096;

/**
 * Read this wallet's positions from the Vault's onchain holder index and the Exchange's
 * premium record. The cost does not depend on chain height, and browser storage is never
 * the position ledger.
 */
export async function readPositions(
  config: Config,
  account: Address,
  market: Market,
  client = publicClient(config),
): Promise<Position[]> {
  const vault = config.nvdaVault as Address;
  const exchange = market.exchange as Address;
  const block = await client.getBlock();
  const blockNumber = block.number;
  const ids: bigint[] = [];
  for (let offset = 0n; ; offset += PAGE) {
    const page = await client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'positionIdsOf',
      args: [account, offset, PAGE],
      blockNumber,
    });
    ids.push(...page);
    if (BigInt(page.length) < PAGE) break;
  }
  if (ids.length === 0) return [];
  const [positions, premiums] = await Promise.all([
    client.multicall({
      blockNumber,
      batchSize: BATCH_SIZE,
      allowFailure: false,
      contracts: ids.map(
        (id) => ({ address: vault, abi: vaultAbi, functionName: 'position', args: [id] }) as const,
      ),
    }),
    client.multicall({
      blockNumber,
      batchSize: BATCH_SIZE,
      allowFailure: false,
      contracts: ids.map(
        (id) =>
          ({ address: exchange, abi: exchangeAbi, functionName: 'netPremiumOf', args: [vault, id] }) as const,
      ),
    }),
  ]);
  const seriesIds = [...new Set(positions.map((p) => p.seriesId))];
  const terms = await client.multicall({
    blockNumber,
    batchSize: BATCH_SIZE,
    allowFailure: false,
    contracts: seriesIds.map(
      (id) => ({ address: vault, abi: vaultAbi, functionName: 'getSeries', args: [id] }) as const,
    ),
  });
  const termsBySeries = new Map(seriesIds.map((id, i) => [id, terms[i]]));
  return ids
    .map((id, i) => {
      const actual = positions[i];
      if (actual.shortHolder.toLowerCase() !== account.toLowerCase())
        throw new Error('Position owner mismatch');
      const s = termsBySeries.get(actual.seriesId)!;
      const series: ProductSeries = {
        id: String(actual.seriesId),
        vault,
        side: s.side as 0 | 1,
        label: `Series #${actual.seriesId}`,
        days: Math.max(1, Math.ceil(Number(s.exerciseEnd - actual.openedAt) / 86400)),
        strikePricePerWrappedUSDG: String(s.strikePricePerWrappedUSDG),
        tradeCutoff: String(s.tradeCutoff),
        exerciseStart: String(s.exerciseStart),
        exerciseEnd: String(s.exerciseEnd),
      };
      return {
        id: String(id),
        source: 'gateway',
        account,
        vault,
        series,
        wrappedQuantity: String(actual.wrappedQuantity),
        strikeAmountUSDG: String(actual.strikeAmountUSDG),
        netPremiumUSDG: String(premiums[i]),
        openedAt: Number(actual.openedAt),
        status:
          actual.state === 4
            ? 'claimed'
            : actual.state === 2
              ? 'exercised'
              : actual.state === 3 || block.timestamp >= s.exerciseEnd
                ? 'expired'
                : 'open',
      } satisfies Position;
    })
    .sort((a, b) => b.openedAt - a.openedAt || Number(BigInt(b.id) - BigInt(a.id)));
}
