import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import deployment from '../../config/xlayer-testnet.json' with { type: 'json' };
import catalog from '../public/catalog.json' with { type: 'json' };
import { exchangeAbi, tokenAbi, vaultAbi, wrapperAbi } from '../src/lib/chain';

export const TEST_ACCOUNT = '0x0000000000000000000000000000000000001234';
export const TEST_NOW = new Date('2026-09-21T08:00:00Z');
export const TEST_RATE = catalog.markets[0].rate;
const abi = [...vaultAbi, ...exchangeAbi, ...tokenAbi, ...wrapperAbi];
export type RpcRequest = { method: string; params?: unknown[] };
export function fixtureRpc(request: RpcRequest): unknown {
  const { method, params = [] } = request;
  if (method === 'eth_chainId') return '0x7a0';
  if (method === 'eth_blockNumber') return '0x100';
  if (method === 'eth_getBlockByNumber')
    return {
      number: '0x100',
      timestamp: `0x${Math.floor(+TEST_NOW / 1000).toString(16)}`,
      hash: `0x${'11'.repeat(32)}`,
      parentHash: `0x${'00'.repeat(32)}`,
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
      size: '0x100',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      transactions: [],
      uncles: [],
      miner: TEST_ACCOUNT,
      nonce: '0x0000000000000000',
      logsBloom: `0x${'00'.repeat(256)}`,
      receiptsRoot: `0x${'00'.repeat(32)}`,
      stateRoot: `0x${'00'.repeat(32)}`,
      transactionsRoot: `0x${'00'.repeat(32)}`,
    };
  if (method === 'eth_getBalance') return '0x2c68af0bb140000'; // 0.2 OKB
  if (method !== 'eth_call') throw new Error(`Unexpected RPC: ${method}`);
  const call = params[0] as { to: string; data: Hex };
  const { functionName, args } = decodeFunctionData({ abi, data: call.data });
  let result: unknown;
  switch (functionName) {
    case 'stock':
      result = deployment.stock;
      break;
    case 'wrappedStock':
      result = deployment.wrappedStock;
      break;
    case 'usdg':
      result = deployment.usdg;
      break;
    case 'exchange':
      result = deployment.exchange;
      break;
    case 'asset':
      result = deployment.stock;
      break;
    case 'convertToAssets':
      result = (BigInt(args![0] as bigint) * BigInt(TEST_RATE)) / 10n ** 18n;
      break;
    case 'feeBps':
      result = 100;
      break;
    case 'vaultAllowed':
      result = true;
      break;
    case 'decimals':
      result = call.to.toLowerCase() === deployment.usdg.toLowerCase() ? 6 : 18;
      break;
    case 'allowance':
      result = 0n;
      break;
    case 'balanceOf':
      result = call.to.toLowerCase() === deployment.usdg.toLowerCase() ? 10_000_000n : 50n * 10n ** 18n;
      break;
    case 'getSeries': {
      const id = String(args![0]);
      const series = catalog.markets[0].series.find((s) => s.id === id);
      if (!series) throw new Error(`Unpublished or unknown series requested: ${id}`);
      result = {
        side: series.side,
        strikePricePerWrappedUSDG: BigInt(series.strikePricePerWrappedUSDG),
        tradeCutoff: BigInt(series.tradeCutoff),
        exerciseStart: BigInt(series.exerciseStart),
        exerciseEnd: BigInt(series.exerciseEnd),
      };
      break;
    }
    default:
      throw new Error(`Unexpected contract call: ${functionName}`);
  }
  return encodeFunctionResult({ abi, functionName, result } as Parameters<typeof encodeFunctionResult>[0]);
}
