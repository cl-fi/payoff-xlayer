import { UserFacingError } from './errors';
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import type { Config } from './config';
import type { AppQuote, Balances, Market, Preview } from './types';

export const tokenAbi = parseAbi([
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
]);
export const wrapperAbi = parseAbi([
  'function asset() view returns(address)',
  'function convertToAssets(uint256) view returns(uint256)',
  'function convertToShares(uint256) view returns(uint256)',
  'function deposit(uint256,address) returns(uint256)',
  'function previewMint(uint256) view returns(uint256)',
  'function mint(uint256,address) returns(uint256)',
]);
export const vaultAbi = parseAbi([
  'function wrappedStock() view returns(address)',
  'function stock() view returns(address)',
  'function usdg() view returns(address)',
  'function exchange() view returns(address)',
  'function getSeries(uint256) view returns((uint8 side,uint256 strikePricePerWrappedUSDG,uint64 tradeCutoff,uint64 exerciseStart,uint64 exerciseEnd))',
  'function position(uint256) view returns((uint256 seriesId,address shortHolder,address longHolder,uint256 wrappedQuantity,uint256 strikeAmountUSDG,uint256 wrappedBalance,uint8 state))',
  'function claim(uint256)',
  'function nextPositionId() view returns(uint256)',
  'function stateOf(uint256) view returns(uint8)',
]);
export const fillEvent = parseAbi([
  'event QuoteFilled(bytes32 indexed requestId,address indexed vault,uint256 indexed positionId,bytes32 quoteHash,address dealer,address taker,uint256 nonce,uint256 grossPremiumUSDG,uint256 protocolFeeUSDG,uint256 netPremiumUSDG)',
])[0];
export const exchangeAbi = parseAbi([
  'function feeBps() view returns(uint16)',
  'function usdg() view returns(address)',
  'function vaultAllowed(address) view returns(bool)',
  'function fill((bytes32 requestId,address vault,address dealer,address taker,uint256 seriesId,uint256 wrappedQuantity,uint256 strikeAmountUSDG,uint256 grossPremiumUSDG,uint256 protocolFeeUSDG,uint256 netPremiumUSDG,uint64 issuedAt,uint64 deadline,uint256 nonce) quote,bytes signature,(uint256 minNetPremiumUSDG,uint256 maxCollateralUSDG,uint256 maxCollateralWrapped) limits) returns(uint256)',
]);
export function chainConfig(config: Config) {
  return defineChain({
    id: config.chainId,
    name: 'X Layer Testnet',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: 'OKX Explorer', url: config.explorerUrl } },
    testnet: true,
  });
}
export function publicClient(config: Config) {
  return createPublicClient({
    chain: chainConfig(config),
    transport: http(config.rpcUrl, { retryCount: 1, timeout: 10000 }),
  });
}
export async function readBalances(
  config: Config,
  account: Address,
  market: Market,
  vault: Address,
  client = publicClient(config),
): Promise<Balances> {
  const blockNumber = await client.getBlockNumber();
  const token = (address: Address) => ({ address, abi: tokenAbi, blockNumber }) as const;
  const [okb, usdg, stock, wrapped, usdgAllowance, wrappedAllowance] = await Promise.all([
    client.getBalance({ address: account, blockNumber }),
    client.readContract({ ...token(market.usdg), functionName: 'balanceOf', args: [account] }),
    client.readContract({ ...token(market.stock), functionName: 'balanceOf', args: [account] }),
    client.readContract({ ...token(market.wrappedStock), functionName: 'balanceOf', args: [account] }),
    client.readContract({ ...token(market.usdg), functionName: 'allowance', args: [account, vault] }),
    client.readContract({ ...token(market.wrappedStock), functionName: 'allowance', args: [account, vault] }),
  ]);
  return {
    okb: String(okb),
    usdg: String(usdg),
    stock: String(stock),
    wrapped: String(wrapped),
    usdgAllowance: String(usdgAllowance),
    wrappedAllowance: String(wrappedAllowance),
  };
}
export function expectedFillData(quote: AppQuote, preview: Preview): Hex {
  if (quote.kind !== 'gateway') throw new UserFacingError('Demo quotes have no onchain transaction to send.');
  const q = quote.selection.quote;
  const values = {
    ...q,
    seriesId: BigInt(q.seriesId),
    wrappedQuantity: BigInt(q.wrappedQuantity),
    strikeAmountUSDG: BigInt(q.strikeAmountUSDG),
    grossPremiumUSDG: BigInt(q.grossPremiumUSDG),
    protocolFeeUSDG: BigInt(q.protocolFeeUSDG),
    netPremiumUSDG: BigInt(q.netPremiumUSDG),
    issuedAt: BigInt(q.issuedAt),
    deadline: BigInt(q.deadline),
    nonce: BigInt(q.nonce),
  };
  return encodeFunctionData({
    abi: exchangeAbi,
    functionName: 'fill',
    args: [
      values,
      quote.selection.signature,
      {
        minNetPremiumUSDG: BigInt(q.netPremiumUSDG),
        maxCollateralUSDG: preview.series.side === 0 ? BigInt(q.strikeAmountUSDG) : 0n,
        maxCollateralWrapped: preview.series.side === 1 ? BigInt(q.wrappedQuantity) : 0n,
      },
    ],
  });
}
