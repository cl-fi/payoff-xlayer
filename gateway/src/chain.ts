import {
  createPublicClient, decodeEventLog, encodeFunctionData, http, parseAbi, recoverTypedDataAddress,
  TransactionNotFoundError, TransactionReceiptNotFoundError, ContractFunctionRevertedError, BaseError,
  type Address, type Hex,
} from 'viem';
import { quoteDigest, quoteTypedData } from '../../sdk/quotes.mjs';
import { strikeAmountUSDG } from '../../sdk/wrapped-assets.mjs';
import type { Config } from './config.js';
import { GatewayError } from './errors.js';
import type { DealerRequest, FillLimits, Order, Quote, Selection, Settlement, SignedQuote, Snapshot, Transaction } from './types.js';

const quoteTuple = '(bytes32 requestId,address vault,address dealer,address taker,uint256 seriesId,uint256 wrappedQuantity,uint256 strikeAmountUSDG,uint256 grossPremiumUSDG,uint256 protocolFeeUSDG,uint256 netPremiumUSDG,uint64 issuedAt,uint64 deadline,uint256 nonce)';
export const exchangeAbi = parseAbi([
  'function usdg() view returns (address)', 'function feeBps() view returns (uint16)',
  'function newPositionsPaused() view returns (bool)', 'function vaultAllowed(address) view returns (bool)',
  'function dealerAllowed(address) view returns (bool)', 'function nonceUnavailable(address,uint256) view returns (bool)',
  `function fill(${quoteTuple} quote,bytes signature,(uint256 minNetPremiumUSDG,uint256 maxCollateralUSDG,uint256 maxCollateralWrapped) limits) returns (uint256)`,
  'event QuoteFilled(bytes32 indexed requestId,address indexed vault,uint256 indexed positionId,bytes32 quoteHash,address dealer,address taker,uint256 nonce,uint256 grossPremiumUSDG,uint256 protocolFeeUSDG,uint256 netPremiumUSDG)',
]);
export const vaultAbi = parseAbi([
  'function exchange() view returns (address)', 'function usdg() view returns (address)',
  'function wrappedStock() view returns (address)', 'function stock() view returns (address)',
  'function RULES_VERSION() view returns (uint256)', 'function newPositionsPaused() view returns (bool)',
  'function getSeries(uint256) view returns ((uint8 side,uint256 strikePricePerWrappedUSDG,uint64 tradeCutoff,uint64 exerciseStart,uint64 exerciseEnd))',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const signatureAbi = parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function contractQuote(q: Quote) {
  return { ...q, seriesId: BigInt(q.seriesId), wrappedQuantity: BigInt(q.wrappedQuantity), strikeAmountUSDG: BigInt(q.strikeAmountUSDG),
    grossPremiumUSDG: BigInt(q.grossPremiumUSDG), protocolFeeUSDG: BigInt(q.protocolFeeUSDG), netPremiumUSDG: BigInt(q.netPremiumUSDG),
    issuedAt: BigInt(q.issuedAt), deadline: BigInt(q.deadline), nonce: BigInt(q.nonce) };
}
export function fillLimits(q: Quote, side: number): FillLimits {
  return { minNetPremiumUSDG: BigInt(q.netPremiumUSDG), maxCollateralUSDG: side === 0 ? BigInt(q.strikeAmountUSDG) : 0n,
    maxCollateralWrapped: side === 1 ? BigInt(q.wrappedQuantity) : 0n };
}
export function transactionFor(config: Config, signed: SignedQuote, side: number): Transaction {
  return { chainId: config.chainId, from: signed.quote.taker, to: config.exchange, value: '0',
    data: encodeFunctionData({ abi: exchangeAbi, functionName: 'fill', args: [contractQuote(signed.quote), signed.signature, fillLimits(signed.quote, side)] }) };
}
export interface Chain {
  health(): Promise<void>;
  snapshot(order: Order): Promise<Snapshot>;
  takerReady(order: Order, snapshot: Snapshot): Promise<void>;
  validate(request: DealerRequest, signed: SignedQuote): Promise<{ blockNumber: string }>;
  settlement(selection: Selection, transactionHash: Hex): Promise<Settlement>;
}
export class RpcChain implements Chain {
  private client;
  constructor(private config: Config, rpcUrl: string) {
    this.client = createPublicClient({ transport: http(rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 0 }) });
  }
  async health() {
    if (await this.client.getChainId() !== this.config.chainId) throw new GatewayError('WRONG_CHAIN', 'RPC chain differs from gateway configuration.', 503);
    const token = await this.client.readContract({ address: this.config.exchange, abi: exchangeAbi, functionName: 'usdg' });
    if (!same(token, this.config.usdg)) throw new GatewayError('WRONG_EXCHANGE', 'Exchange settlement asset differs from configuration.', 503);
    await this.freshBlock();
  }
  private async freshBlock() {
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (block.timestamp + BigInt(this.config.maxBlockAgeSeconds) < now || block.timestamp > now + 10n) {
      throw new GatewayError('STALE_CHAIN', 'RPC block time is stale or the server clock is incorrect.', 503);
    }
    return block;
  }
  async snapshot(order: Order): Promise<Snapshot> {
    if (!this.config.markets.some(m => same(m.vault, order.vault) && m.seriesIds.includes(order.seriesId))) {
      throw new GatewayError('MARKET_NOT_LISTED', 'This Vault/series is not listed by the gateway.');
    }
    const block = await this.freshBlock();
    const e = { address: this.config.exchange, abi: exchangeAbi, blockNumber: block.number } as const;
    const v = { address: order.vault, abi: vaultAbi, blockNumber: block.number } as const;
    const [allowed, paused, feeBps, exchange, usdg, wrappedStock, stock, version, vaultPaused, terms] = await Promise.all([
      this.client.readContract({ ...e, functionName: 'vaultAllowed', args: [order.vault] }),
      this.client.readContract({ ...e, functionName: 'newPositionsPaused' }),
      this.client.readContract({ ...e, functionName: 'feeBps' }),
      this.client.readContract({ ...v, functionName: 'exchange' }), this.client.readContract({ ...v, functionName: 'usdg' }),
      this.client.readContract({ ...v, functionName: 'wrappedStock' }), this.client.readContract({ ...v, functionName: 'stock' }),
      this.client.readContract({ ...v, functionName: 'RULES_VERSION' }), this.client.readContract({ ...v, functionName: 'newPositionsPaused' }),
      this.client.readContract({ ...v, functionName: 'getSeries', args: [BigInt(order.seriesId)] }),
    ]);
    if (!allowed || paused || vaultPaused) throw new GatewayError('MARKET_UNAVAILABLE', 'New positions are not enabled for this market.');
    if (!same(exchange, this.config.exchange) || !same(usdg, this.config.usdg) || version !== 2n || terms.side > 1) {
      throw new GatewayError('MARKET_CONFIGURATION', 'Vault configuration does not match the gateway.', 503);
    }
    if (terms.tradeCutoff <= block.timestamp || terms.tradeCutoff <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new GatewayError('TRADE_CLOSED', 'This series is closed to new positions.');
    }
    let strikeAmount: string;
    try { strikeAmount = strikeAmountUSDG(order.wrappedQuantity, terms.strikePricePerWrappedUSDG).toString(); }
    catch { throw new GatewayError('ORDER_AMOUNT_OVERFLOW', 'The requested quantity produces a USDG amount outside uint256.'); }
    return { blockNumber: block.number.toString(), blockHash: block.hash, timestamp: block.timestamp.toString(),
      usdg, stock, wrappedStock, feeBps,
      terms: { side: terms.side as 0 | 1, strikePricePerWrappedUSDG: terms.strikePricePerWrappedUSDG.toString(),
        tradeCutoff: terms.tradeCutoff.toString(), exerciseStart: terms.exerciseStart.toString(), exerciseEnd: terms.exerciseEnd.toString() },
      strikeAmountUSDG: strikeAmount };
  }
  private async funding(token: Address, holder: Address, spender: Address, required: bigint, blockNumber: bigint, party: 'TAKER' | 'DEALER') {
    const c = { address: token, abi: erc20Abi, blockNumber } as const;
    const [balance, allowance] = await Promise.all([
      this.client.readContract({ ...c, functionName: 'balanceOf', args: [holder] }),
      this.client.readContract({ ...c, functionName: 'allowance', args: [holder, spender] }),
    ]);
    if (balance < required) throw new GatewayError(`${party}_BALANCE`, `${party.toLowerCase()} token balance is insufficient.`);
    if (allowance < required) throw new GatewayError(`${party}_ALLOWANCE`, `${party.toLowerCase()} token allowance is insufficient.`);
  }
  async takerReady(order: Order, snapshot: Snapshot) {
    const put = snapshot.terms.side === 0;
    await this.funding(put ? snapshot.usdg : snapshot.wrappedStock, order.taker, order.vault,
      BigInt(put ? snapshot.strikeAmountUSDG : order.wrappedQuantity), BigInt(snapshot.blockNumber), 'TAKER');
  }
  async validate(request: DealerRequest, signed: SignedQuote) {
    const q = signed.quote;
    // All checks and the simulation use one fresh block; no fake balance/allowance overrides.
    const snapshot = await this.snapshot(request.order);
    const blockNumber = BigInt(snapshot.blockNumber);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(q.issuedAt) > BigInt(snapshot.timestamp) || BigInt(q.deadline) < BigInt(q.issuedAt)
      || BigInt(q.deadline) <= now || BigInt(q.deadline) < BigInt(snapshot.timestamp) || BigInt(q.deadline) > BigInt(snapshot.terms.tradeCutoff)) {
      throw new GatewayError('QUOTE_TIME', 'Quote is not currently valid or exceeds the series cutoff.');
    }
    const e = { address: this.config.exchange, abi: exchangeAbi, blockNumber } as const;
    const [allowed, unavailable, bytecode] = await Promise.all([
      this.client.readContract({ ...e, functionName: 'dealerAllowed', args: [q.dealer] }),
      this.client.readContract({ ...e, functionName: 'nonceUnavailable', args: [q.dealer, BigInt(q.nonce)] }),
      this.client.getCode({ address: q.dealer, blockNumber }),
    ]);
    if (!allowed) throw new GatewayError('DEALER_NOT_ALLOWED', 'Dealer is not on the Exchange whitelist.');
    if (unavailable) throw new GatewayError('NONCE_UNAVAILABLE', 'Quote was already filled or cancelled.');
    let valid = false;
    if (bytecode && bytecode !== '0x') {
      try { valid = await this.client.readContract({ address: q.dealer, abi: signatureAbi, functionName: 'isValidSignature',
        args: [quoteDigest(this.config.chainId, this.config.exchange, q), signed.signature], blockNumber }) === '0x1626ba7e'; } catch { valid = false; }
    } else if (signed.signature.length === 132) {
      try { valid = same(await recoverTypedDataAddress({ ...quoteTypedData(this.config.chainId, this.config.exchange, q), signature: signed.signature }), q.dealer); } catch { valid = false; }
    }
    if (!valid) throw new GatewayError('INVALID_SIGNATURE', 'Quote signature is invalid for this dealer and Exchange.');
    await Promise.all([this.takerReady(request.order, snapshot), this.funding(snapshot.usdg, q.dealer, this.config.exchange, BigInt(q.grossPremiumUSDG), blockNumber, 'DEALER')]);
    try {
      await this.client.simulateContract({ address: this.config.exchange, abi: exchangeAbi, functionName: 'fill', account: q.taker,
        args: [contractQuote(q), signed.signature, fillLimits(q, snapshot.terms.side)], blockNumber });
    } catch (error) {
      if (error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) {
        throw new GatewayError('SIMULATION_REVERTED', 'The complete fill transaction currently reverts.');
      }
      throw new GatewayError('RPC_UNAVAILABLE', 'Could not simulate this quote.', 503);
    }
    return { blockNumber: snapshot.blockNumber };
  }
  async settlement(selection: Selection, transactionHash: Hex): Promise<Settlement> {
    let tx;
    try { tx = await this.client.getTransaction({ hash: transactionHash }); }
    catch (e) {
      if (e instanceof TransactionNotFoundError) throw new GatewayError('TRANSACTION_NOT_FOUND', 'RPC has not seen this transaction yet; retry.', 404);
      throw e;
    }
    if (!same(tx.from, selection.quote.taker) || !tx.to || !same(tx.to, this.config.exchange) || tx.input !== selection.transaction.data) {
      throw new GatewayError('TRANSACTION_MISMATCH', 'Transaction does not match the selected quote and exact fill limits.');
    }
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: transactionHash }); }
    catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return { transactionHash, status: 'pending', confirmations: 0 };
      throw e;
    }
    const [head, canonical] = await Promise.all([this.client.getBlockNumber({ cacheTime: 0 }), this.client.getBlock({ blockNumber: receipt.blockNumber })]);
    if (canonical.hash !== receipt.blockHash) return { transactionHash, status: 'pending', confirmations: 0 };
    const base = { transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
      confirmations: Number(head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n) };
    if (receipt.status !== 'success') return { ...base, status: 'reverted' };
    for (const log of receipt.logs) {
      if (!same(log.address, this.config.exchange)) continue;
      try {
        const event = decodeEventLog({ abi: exchangeAbi, eventName: 'QuoteFilled', data: log.data, topics: log.topics });
        if (event.args.requestId === selection.quote.requestId && event.args.quoteHash === selection.quoteHash) {
          return { ...base, status: base.confirmations >= this.config.confirmations ? 'confirmed' : 'confirming', positionId: event.args.positionId.toString() };
        }
      } catch { /* Ignore unrelated logs from the same transaction. */ }
    }
    return { ...base, status: 'mismatched' };
  }
}
