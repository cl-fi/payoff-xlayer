import { type Address } from 'viem';
import { publicClient, fillEvent, vaultAbi } from '../chain';
import type { Config } from '../config';
import type { Market, Position, ProductSeries } from '../types';

/** Recover this Vault's history from chain events; browser storage is never the position ledger. */
export async function readPositions(
  config: Config,
  account: Address,
  market: Market,
  client = publicClient(config),
): Promise<Position[]> {
  const vault = config.nvdaVault as Address;
  const block = await client.getBlock();
  const last = await client.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'nextPositionId',
    blockNumber: block.number,
  });
  if (last === 1n) return [];
  const events: Awaited<ReturnType<typeof client.getLogs<typeof fillEvent>>> = [];
  const discovered = new Set<string>();
  const first = BigInt(config.deploymentBlock);
  // The public X Layer RPC allows only 100 blocks per log request. Walk backwards
  // with bounded concurrency and stop once every Vault position is accounted for.
  // This skips old empty history without imposing a position or history limit.
  for (let end = block.number; end >= first && BigInt(discovered.size) < last - 1n; end -= 400n) {
    const ranges = [];
    for (let i = 0n; i < 4n; i++) {
      const to = end - i * 100n;
      if (to < first) break;
      ranges.push({ fromBlock: to - 99n > first ? to - 99n : first, toBlock: to });
    }
    const pages = await Promise.all(
      ranges.map((range) =>
        client.getLogs({
          address: market.exchange,
          event: fillEvent,
          args: { vault },
          ...range,
          strict: true,
        }),
      ),
    );
    for (const event of pages.flat()) {
      if (event.removed || event.args.positionId === undefined) continue;
      const id = String(event.args.positionId);
      if (!discovered.has(id)) events.push(event);
      discovered.add(id);
    }
  }
  if (BigInt(discovered.size) !== last - 1n) throw new Error('Incomplete Vault event history');
  const owned = events.filter((e) => !e.removed && e.args.taker?.toLowerCase() === account.toLowerCase());
  const result: Position[] = [];
  for (let i = 0; i < owned.length; i += 4) {
    result.push(
      ...(await Promise.all(
        owned.slice(i, i + 4).map(async (event) => {
          const id = event.args.positionId!;
          const actual = await client.readContract({
            address: vault,
            abi: vaultAbi,
            functionName: 'position',
            args: [id],
            blockNumber: block.number,
          });
          if (actual.shortHolder.toLowerCase() !== account.toLowerCase())
            throw new Error('Position owner mismatch');
          const [terms, opened] = await Promise.all([
            client.readContract({
              address: vault,
              abi: vaultAbi,
              functionName: 'getSeries',
              args: [actual.seriesId],
              blockNumber: block.number,
            }),
            client.getBlock({ blockHash: event.blockHash! }),
          ]);
          const series: ProductSeries = {
            id: String(actual.seriesId),
            vault,
            side: terms.side as 0 | 1,
            label: `Series #${actual.seriesId}`,
            days: Math.max(1, Math.ceil(Number(terms.exerciseEnd - opened.timestamp) / 86400)),
            strikePricePerWrappedUSDG: String(terms.strikePricePerWrappedUSDG),
            tradeCutoff: String(terms.tradeCutoff),
            exerciseStart: String(terms.exerciseStart),
            exerciseEnd: String(terms.exerciseEnd),
          };
          return {
            id: String(id),
            source: 'gateway',
            account,
            vault,
            series,
            wrappedQuantity: String(actual.wrappedQuantity),
            strikeAmountUSDG: String(actual.strikeAmountUSDG),
            netPremiumUSDG: String(event.args.netPremiumUSDG!),
            openedAt: Number(opened.timestamp),
            transactionHash: event.transactionHash!,
            status:
              actual.state === 4
                ? 'claimed'
                : actual.state === 2
                  ? 'exercised'
                  : block.timestamp >= terms.exerciseEnd
                    ? 'expired'
                    : 'open',
          } satisfies Position;
        }),
      )),
    );
  }
  return result.sort((a, b) => b.openedAt - a.openedAt || Number(BigInt(b.id) - BigInt(a.id)));
}
