import rawCatalog from '../../../public/catalog.json';
import { catalogSchema } from '../../../../sdk/catalog.mjs';
import { UserFacingError } from '../errors';
import type { Config } from '../config';
import type { Market } from '../types';

export const catalog = catalogSchema.parse(rawCatalog);
export function staticMarket(config: Config): Market {
  const listing = catalog.markets.find((m) => m.vault.toLowerCase() === config.nvdaVault.toLowerCase());
  if (!listing || catalog.chainId !== config.chainId)
    throw new UserFacingError('Publish a verified product catalog for this network and Vault.');
  return {
    chainId: catalog.chainId,
    exchange: catalog.exchange,
    usdg: catalog.usdg,
    stock: listing.stock,
    wrappedStock: listing.wrappedStock,
    rate: listing.rate,
    feeBps: catalog.feeBps,
    blockNumber: catalog.blockNumber,
    series: listing.series.map((s) => ({ ...s, vault: listing.vault, days: 0 })),
  };
}
