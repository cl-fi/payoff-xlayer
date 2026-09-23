/** Read-only rollover plan. The existing CreateTestnetSeries script executes reviewed plans. */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem';
import { planNativeSeries } from '../sdk/series-planning.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const deployment = await load('../config/xlayer-testnet.json');
const products = await load('../config/nvda-products.testnet.json');
const client = createPublicClient({ transport: http(deployment.rpcUrl) });
if (await client.getChainId() !== 1952 || products.chainId !== 1952 || deployment.chainId !== 1952
  || !deployment.markets.some(m => m.vault.toLowerCase() === products.vault.toLowerCase())) throw new Error('Testnet catalog binding mismatch');
const abi = (await load('../out/SeriesVault.sol/SeriesVault.json')).abi;
const creatorAbi = (await load('../out/CreateTestnetSeries.s.sol/CreateTestnetSeries.json')).abi;
const block = await client.getBlock();
const read = (functionName, args = []) => client.readContract({ address: products.vault, abi, functionName, args, blockNumber: block.number });
const [administrator, wrapped, exchange, usd, next] = await Promise.all([
  read('administrator'), read('wrappedStock'), read('exchange'), read('usdg'), read('nextSeriesId'),
]);
for (const [actual, expected] of [[wrapped, deployment.wrappedStock], [exchange, deployment.exchange], [usd, deployment.usdg]])
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('Onchain asset binding mismatch');
const rate = await client.readContract({ address: wrapped, abi: parseAbi(['function convertToAssets(uint256) view returns(uint256)']),
  functionName: 'convertToAssets', args: [10n ** 18n], blockNumber: block.number });
const existing = [];
for (let start = 1n; start < next; start += 4n) {
  const ids = Array.from({ length: Number(next - start < 4n ? next - start : 4n) }, (_, i) => start + BigInt(i));
  existing.push(...await Promise.all(ids.map(async id => ({ id: String(id), ...await read('getSeries', [id]) }))));
}
const jsonSafe = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v));
const series = planNativeSeries(products.products, jsonSafe(existing), rate, block.timestamp);
const call = encodeFunctionData({ abi: creatorAbi, functionName: 'run', args: [products.vault, administrator, rate,
  series.map(s => ({ ...s, strikePricePerWrappedUSDG: BigInt(s.strikePricePerWrappedUSDG),
    tradeCutoff: BigInt(s.tradeCutoff), exerciseStart: BigInt(s.exerciseStart), exerciseEnd: BigInt(s.exerciseEnd) }))] });
const plan = jsonSafe({ chainId: 1952, vault: products.vault, administrator, blockNumber: block.number,
  expectedAssetsPerWrapped: rate, series, createCount: series.filter(s => !s.existingSeriesId).length,
  forgeSignature: call, policy: 'publish-new-series-without-revoking-old-series' });
if (values.output) await writeFile(values.output, JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify({ blockNumber: plan.blockNumber, rate: plan.expectedAssetsPerWrapped,
  createCount: plan.createCount, reuseCount: series.length - plan.createCount, series }, null, 2));
