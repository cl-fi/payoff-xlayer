import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http, parseAbi, keccak256 } from 'viem';

// Read-only RPC calls. No wallet client, private key, or transaction broadcasting.
const config = JSON.parse(await readFile(new URL('../config/xlayer.json', import.meta.url), 'utf8'));
const rpc = process.env.XLAYER_RPC_URL || config.rpc;
const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 1 }) });
const chainId = await client.getChainId();
if (chainId !== config.chainId) throw new Error(`Expected X Layer ${config.chainId}; received ${chainId}`);
const blockNumber = await client.getBlockNumber();
const block = await client.getBlock({ blockNumber });
const abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function sharesOf(address) view returns (uint256)',
  'function getCurrentMultiplier() view returns (uint256,uint256,uint256)',
  'function getSharesByUnderlyingAmount(uint256) view returns (uint256)',
  'function getUnderlyingAmountByShares(uint256) view returns (uint256)',
  'function feePerPeriod() view returns (uint256)',
  'function newMultiplier() view returns (uint256)',
  'function newMultiplierActivationTime() view returns (uint256)',
  'function isPaused() view returns (bool)',
  'function owner() view returns (address)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function convertToShares(uint256) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
]);
const evidence = {
  observedAt: new Date().toISOString(),
  // Omit custom URLs: RPC providers may encode credentials in them.
  rpc: process.env.XLAYER_RPC_URL ? 'custom (redacted)' : rpc,
  chainId, blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp,
  scope: 'Read-only calls at one explicit block. Does not prove transfer or deployment success.',
  tokens: {},
};
let failed = false;
for (const [symbol, token] of Object.entries(config.tokens)) {
  const { address } = token;
  const code = await client.getCode({ address, blockNumber });
  const calls = [['name'], ['symbol'], ['decimals'], ['totalSupply'], ['owner']];
  if (symbol === 'NVDAx') calls.push(
    ['getCurrentMultiplier'], ['feePerPeriod'], ['newMultiplier'], ['newMultiplierActivationTime'],
    ['isPaused'], ['sharesOf', [address]],
    ['getSharesByUnderlyingAmount', [10n ** 18n]],
    ['getUnderlyingAmountByShares', [10n ** 18n]],
  );
  if (token.underlying) calls.push(
    ['asset'], ['totalAssets'], ['convertToShares', [10n ** 18n]], ['convertToAssets', [10n ** 18n]],
  );
  const values = {};
  for (const [functionName, args = []] of calls) {
    try {
      values[functionName] = { ok: true, value: await client.readContract({ address, abi, functionName, args, blockNumber }) };
    } catch (error) {
      failed = true;
      values[functionName] = { ok: false, error: error.shortMessage || error.name };
    }
  }
  if (!code || code === '0x') failed = true;
  if (values.decimals?.value !== token.decimals || values.symbol?.value !== symbol) failed = true;
  if (token.underlying && values.asset?.value?.toLowerCase() !== config.tokens[token.underlying].address.toLowerCase()) failed = true;
  evidence.tokens[symbol] = { address, codeBytes: code ? (code.length - 2) / 2 : 0, codeHash: code ? keccak256(code) : null, calls: values };
}
const json = JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
const output = process.argv[2];
if (output) await writeFile(output, json, { flag: 'wx' });
process.stdout.write(json);
if (failed) process.exitCode = 1;
