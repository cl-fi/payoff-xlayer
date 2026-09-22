import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { address, hash, hex } from '../../../gateway/src/types';
import type { Config } from './config';
import { publicClient } from './chain';
import type { Storage } from './data/demo';

const activitySchema = z.object({
  hash,
  account: address,
  to: address,
  data: hex,
  value: z.literal('0'),
  kind: z.enum(['approval', 'wrap', 'fill', 'claim', 'faucet']),
  status: z.enum(['pending', 'confirmed', 'reverted', 'cancelled']),
  label: z.string(),
  requestId: hash.optional(),
  createdAt: z.number(),
});
export type Activity = z.infer<typeof activitySchema>;
export function activityKey(config: Config, account: Address) {
  return `payoff.transactions.v1.${config.chainId}.${account.toLowerCase()}`;
}
export function readActivity(storage: Storage, config: Config, account: Address): Activity[] {
  const value = storage.getItem(activityKey(config, account));
  if (!value) return [];
  return z.array(activitySchema).parse(JSON.parse(value));
}
export function saveActivity(storage: Storage, config: Config, item: Activity, previousHash?: Hex) {
  const items = readActivity(storage, config, item.account).filter(
    (i) => i.hash !== item.hash && i.hash !== previousHash,
  );
  const pending = items.filter((i) => i.status === 'pending');
  const completed = items.filter((i) => i.status !== 'pending').slice(0, 49);
  storage.setItem(activityKey(config, item.account), JSON.stringify([item, ...pending, ...completed]));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('payoff:transactions'));
}
export async function recoverActivity(
  storage: Storage,
  config: Config,
  account: Address,
  client = publicClient(config),
) {
  const items = readActivity(storage, config, account);
  for (const item of items.filter((i) => i.status === 'pending')) {
    try {
      const [receipt, tx, height] = await Promise.all([
        client.getTransactionReceipt({ hash: item.hash }),
        client.getTransaction({ hash: item.hash }),
        client.getBlockNumber(),
      ]);
      if (height < receipt.blockNumber + 1n) continue;
      const unchanged =
        tx.from.toLowerCase() === item.account.toLowerCase() &&
        tx.to?.toLowerCase() === item.to.toLowerCase() &&
        tx.input === item.data &&
        tx.value === 0n;
      item.status = !unchanged ? 'cancelled' : receipt.status === 'success' ? 'confirmed' : 'reverted';
      saveActivity(storage, config, item);
    } catch {
      /* Keep the submitted hash visible and pending until there is chain evidence. */
    }
  }
  return readActivity(storage, config, account);
}
