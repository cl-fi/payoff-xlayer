/** Run once after publishing chain series; ordinary web builds require no RPC. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../web/src/lib/config.ts';
import { readOnchainMarket } from '../web/src/lib/data/onchain.ts';
import { catalogSchema } from '../sdk/catalog.mjs';

const deployment = JSON.parse(await readFile(new URL('../config/xlayer-testnet.json', import.meta.url), 'utf8'));
const config = { ...getConfig(), chainId: deployment.chainId, rpcUrl: deployment.rpcUrl };
const markets = [];
let snapshot;
for (const listing of deployment.markets) {
  const market = await readOnchainMarket({ ...config, nvdaVault: listing.vault }, deployment, undefined, deployment);
  snapshot ??= market;
  markets.push({ vault: listing.vault, stock: market.stock, wrappedStock: market.wrappedStock,
    symbol: listing.symbol ?? 'NVDA', rate: market.rate,
    series: market.series.map(({ vault, days, ...terms }) => terms) });
}
const catalog = catalogSchema.parse({ version: 1, chainId: deployment.chainId, exchange: deployment.exchange,
  usdg: deployment.usdg, generatedAt: new Date().toISOString(), blockNumber: snapshot!.blockNumber,
  feeBps: snapshot!.feeBps, markets });
const output = new URL('../web/public/catalog.json', import.meta.url);
await mkdir(new URL('../web/public/', import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Verified ${markets.reduce((n, m) => n + m.series.length, 0)} series; wrote ${fileURLToPath(output)}`);
