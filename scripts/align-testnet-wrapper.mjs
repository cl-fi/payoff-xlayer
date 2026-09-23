/** Test-only, one-time rate alignment. Default is read-only; never signs on mainnet. */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';

const WAD = 10n ** 18n;
export function backingDonation(rate, assets, supply) {
  if (rate <= 0n || assets < 0n || supply <= 0n) throw new Error('Invalid or empty test wrapper.');
  const current = WAD * (assets + 1n) / (supply + 1n);
  if (rate < current) throw new Error('Cannot lower the rate by adding backing.');
  if (rate === current) return 0n;
  const targetAssets = (rate * (supply + 1n) + WAD - 1n) / WAD - 1n;
  if (targetAssets >= 2n ** 256n || WAD * (targetAssets + 1n) / (supply + 1n) !== rate)
    throw new Error('Target rate is not exactly representable.');
  return targetAssets - assets;
}

async function main() {
  const { values } = parseArgs({ options: { broadcast: { type: 'boolean', default: false },
    account: { type: 'string' }, 'password-file': { type: 'string' }, cast: { type: 'string', default: 'cast' } } });
  const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const mainnet = await load('../config/xlayer.json'), testnet = await load('../config/xlayer-testnet.json');
  const main = createPublicClient({ transport: http(mainnet.rpc, { timeout: 20000 }) });
  const test = createPublicClient({ transport: http(testnet.rpcUrl, { timeout: 20000 }) });
  if (await main.getChainId() !== 196 || await test.getChainId() !== 1952) throw new Error('Wrong network.');
  const abi = parseAbi(['function asset() view returns(address)', 'function decimals() view returns(uint8)',
    'function convertToAssets(uint256) view returns(uint256)', 'function totalAssets() view returns(uint256)',
    'function totalSupply() view returns(uint256)', 'function minter() view returns(address)',
    'function mint(address,uint256)', 'function balanceOf(address) view returns(uint256)']);
  const sourceBlock = await main.getBlock();
  const readMain = (functionName, args = []) => main.readContract({ address: mainnet.tokens.wNVDAx.address, abi, functionName, args, blockNumber: sourceBlock.number });
  const [rate, sourceAsset, sourceDecimals] = await Promise.all([readMain('convertToAssets', [WAD]), readMain('asset'), readMain('decimals')]);
  if (sourceAsset.toLowerCase() !== mainnet.tokens.NVDAx.address.toLowerCase() || sourceDecimals !== 18) throw new Error('Wrong mainnet asset binding.');
  const beforeBlock = await test.getBlockNumber();
  const readTest = (functionName, args = [], address = testnet.wrappedStock, blockNumber = beforeBlock) => test.readContract({ address, abi, functionName, args, blockNumber });
  const [asset, decimals, assets, supply, minter, stockDecimals] = await Promise.all([
    readTest('asset'), readTest('decimals'), readTest('totalAssets'), readTest('totalSupply'),
    readTest('minter', [], testnet.stock), readTest('decimals', [], testnet.stock),
  ]);
  if (asset.toLowerCase() !== testnet.stock.toLowerCase() || decimals !== 18 || stockDecimals !== 18) throw new Error('Wrong testnet asset binding.');
  const donation = backingDonation(rate, assets, supply);
  const plan = { source: { chainId: 196, wrapper: mainnet.tokens.wNVDAx.address, blockNumber: sourceBlock.number, timestamp: sourceBlock.timestamp, rate },
    target: { chainId: 1952, wrapper: testnet.wrappedStock, stock: testnet.stock, beforeBlock, assets, supply, donation } };
  console.log(json(plan));
  if (!values.broadcast || donation === 0n) return;
  if (!values.account || !values['password-file']) throw new Error('Broadcast requires an encrypted Foundry account and password file.');
  const run = promisify(execFile);
  const signerArgs = ['--account', values.account, '--password-file', values['password-file']];
  const sender = (await run(values.cast, ['wallet', 'address', ...signerArgs])).stdout.trim();
  if (sender.toLowerCase() !== minter.toLowerCase()) throw new Error('Signer is not the test stock minter.');
  const vaultAbi = (await load('../out/SeriesVault.sol/SeriesVault.json')).abi;
  const positions = [];
  for (const { vault } of testnet.markets) {
    const next = await test.readContract({ address: vault, abi: vaultAbi, functionName: 'nextPositionId', blockNumber: beforeBlock });
    for (let id = 1n; id < next; id++) {
      const p = await test.readContract({ address: vault, abi: vaultAbi, functionName: 'position', args: [id], blockNumber: beforeBlock });
      positions.push({ vault, id, W: p.wrappedQuantity, U: p.strikeAmountUSDG });
    }
  }
  // Refuse a stale plan if deposits/redemptions changed backing while reading existing positions.
  const freshBlock = await test.getBlockNumber({ cacheTime: 0 });
  const [freshAssets, freshSupply] = await Promise.all([readTest('totalAssets', [], testnet.wrappedStock, freshBlock), readTest('totalSupply', [], testnet.wrappedStock, freshBlock)]);
  if (freshAssets !== assets || freshSupply !== supply) throw new Error('Wrapper changed; rerun the read-only plan.');
  await test.simulateContract({ address: testnet.stock, abi, functionName: 'mint', args: [testnet.wrappedStock, donation], account: sender });
  // Print the tx hash immediately; on interruption inspect its receipt before any retry.
  const hash = (await run(values.cast, ['send', testnet.stock, 'mint(address,uint256)', testnet.wrappedStock,
    donation.toString(), '--rpc-url', testnet.rpcUrl, ...signerArgs, '--async'], { timeout: 120000 })).stdout.trim();
  console.log(`Submitted testnet transaction: ${hash}`);
  const receipt = await test.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120000 });
  if (receipt.status !== 'success') throw new Error(`Testnet mint reverted: ${hash}`);
  const actualRate = await readTest('convertToAssets', [WAD], testnet.wrappedStock, receipt.blockNumber);
  for (const { vault, id, W, U } of positions) {
    const p = await test.readContract({ address: vault, abi: vaultAbi, functionName: 'position', args: [id], blockNumber: receipt.blockNumber });
    if (p.wrappedQuantity !== W || p.strikeAmountUSDG !== U) throw new Error('Existing position terms changed.');
  }
  const record = { ...plan, transactionHash: hash, blockNumber: receipt.blockNumber, actualRate,
    checkedExistingPositions: positions.length, observedAt: new Date().toISOString(), mode: 'one-time-testnet-backing-donation' };
  await writeFile(new URL('../config/testnet-wrapper-rate.json', import.meta.url), json(record) + '\n');
  if (actualRate !== rate) throw new Error('Transaction mined, but concurrent wrapper activity changed the final rate; inspect the saved receipt before proceeding.');
  console.log(`Aligned rate ${rate}; verified ${positions.length} existing positions retained W/U.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  // CLI failures can contain provider URLs; keep credentials out of logs.
  console.error(error.shortMessage ?? (error.cmd ? 'Foundry command failed; inspect local account/RPC configuration and transaction receipts.' : error.message));
  process.exitCode = 1;
});
