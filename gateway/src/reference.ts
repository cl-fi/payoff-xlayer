import { referenceSnapshotSchema } from '../../sdk/catalog.mjs';
import type { Config } from './config.js';

/** Read an already computed snapshot; never run pricing or fan out to makers. */
export async function fetchReference(config: Config, token?: string) {
  if (!config.referenceSource || !token) throw new Error('Reference source unavailable');
  const response = await fetch(config.referenceSource.url, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Reference source unavailable');
  const snapshot = referenceSnapshotSchema.parse(await response.json());
  if (snapshot.chainId !== config.chainId || snapshot.exchange.toLowerCase() !== config.exchange.toLowerCase())
    throw new Error('Reference domain mismatch');
  return snapshot;
}
