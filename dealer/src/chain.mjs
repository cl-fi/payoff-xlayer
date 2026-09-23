import { createPublicClient, http, parseAbi } from 'viem';
import { strikeAmountUSDG } from '../../sdk/wrapped-assets.mjs';
import { NoQuote, same } from './pricing.mjs';

const exchangeAbi = parseAbi(['function usdg() view returns (address)', 'function feeBps() view returns (uint16)',
  'function newPositionsPaused() view returns (bool)', 'function dealerAllowed(address) view returns (bool)', 'function vaultAllowed(address) view returns (bool)']);
const vaultAbi = parseAbi(['function exchange() view returns (address)', 'function usdg() view returns (address)',
  'function wrappedStock() view returns (address)', 'function stock() view returns (address)',
  'function RULES_VERSION() view returns (uint256)', 'function newPositionsPaused() view returns (bool)',
  'function getSeries(uint256) view returns ((uint8 side,uint256 strikePricePerWrappedUSDG,uint64 tradeCutoff,uint64 exerciseStart,uint64 exerciseEnd))']);
const tokenAbi = parseAbi(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function asset() view returns (address)', 'function convertToAssets(uint256) view returns (uint256)']);
export class DealerChain {
  constructor(config, rpcUrl, dealer) {
    this.config = config; this.dealer = dealer;
    this.client = createPublicClient({ transport: http(rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 0 }) });
  }
  async health() {
    const c = this.config;
    const [id, usdg, allowed] = await Promise.all([this.client.getChainId(),
      this.client.readContract({ address: c.exchange, abi: exchangeAbi, functionName: 'usdg' }),
      this.client.readContract({ address: c.exchange, abi: exchangeAbi, functionName: 'dealerAllowed', args: [this.dealer] })]);
    if (id !== c.chainId || !same(usdg, c.usdg) || !allowed) throw new NoQuote('DEALER_CONFIGURATION');
  }
  async context(order) {
    const c = this.config;
    const market = c.markets.find(m => same(m.vault, order.vault) && m.seriesIds.includes(order.seriesId));
    if (!market) throw new NoQuote('MARKET_NOT_LISTED');
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (block.timestamp + BigInt(c.maxBlockAgeSeconds) < now || block.timestamp > now + 1n) throw new NoQuote('STALE_CHAIN');
    const read = (address, abi, functionName, args = []) => this.client.readContract({ address, abi, functionName, args, blockNumber: block.number });
    const [terms, exchange, usdg, stock, wrappedStock, version, vaultPaused, paused, allowed, dealerAllowed, feeBps,
      asset, stockDecimals, wrappedDecimals, assetsPerWrapped, stockQuantity] = await Promise.all([
      read(market.vault, vaultAbi, 'getSeries', [BigInt(order.seriesId)]), read(market.vault, vaultAbi, 'exchange'),
      read(market.vault, vaultAbi, 'usdg'), read(market.vault, vaultAbi, 'stock'), read(market.vault, vaultAbi, 'wrappedStock'),
      read(market.vault, vaultAbi, 'RULES_VERSION'), read(market.vault, vaultAbi, 'newPositionsPaused'),
      read(c.exchange, exchangeAbi, 'newPositionsPaused'), read(c.exchange, exchangeAbi, 'vaultAllowed', [market.vault]),
      read(c.exchange, exchangeAbi, 'dealerAllowed', [this.dealer]), read(c.exchange, exchangeAbi, 'feeBps'),
      read(market.wrappedStock, tokenAbi, 'asset'), read(market.stock, tokenAbi, 'decimals'),
      read(market.wrappedStock, tokenAbi, 'decimals'), read(market.wrappedStock, tokenAbi, 'convertToAssets', [10n ** 18n]),
      read(market.wrappedStock, tokenAbi, 'convertToAssets', [BigInt(order.wrappedQuantity)]),
    ]);
    if (!same(exchange, c.exchange) || !same(usdg, c.usdg) || !same(stock, market.stock) || !same(wrappedStock, market.wrappedStock)
      || !same(asset, stock) || version !== 2n || stockDecimals !== 18 || wrappedDecimals !== 18 || terms.side > 1)
      throw new NoQuote('MARKET_CONFIGURATION');
    if (paused || vaultPaused || !allowed || !dealerAllowed || terms.tradeCutoff <= now) throw new NoQuote('MARKET_UNAVAILABLE');
    return { ...market, terms, feeBps, assetsPerWrapped, stockQuantity, blockNumber: block.number,
      referenceStrikeMilli: market.referenceStrikes?.[order.seriesId],
      timestamp: block.timestamp.toString(), strikeAmountUSDG: strikeAmountUSDG(order.wrappedQuantity, terms.strikePricePerWrappedUSDG).toString() };
  }
  async funded(gross, blockNumber) {
    const read = (functionName, args) => this.client.readContract({ address: this.config.usdg, abi: tokenAbi, functionName, args, blockNumber });
    const [balance, allowance] = await Promise.all([read('balanceOf', [this.dealer]), read('allowance', [this.dealer, this.config.exchange])]);
    if (balance < BigInt(gross) || allowance < BigInt(gross)) throw new NoQuote('DEALER_UNFUNDED');
  }
  // Public estimates need no maker/taker balance, allowance or signature. Read shared
  // mutable inputs once per Vault, using the published catalog for immutable terms.
  async referenceMarket(market) {
    const c = this.config;
    const known = c.markets.find(m => same(m.vault, market.vault));
    if (!known || !same(known.stock, market.stock) || !same(known.wrappedStock, market.wrappedStock))
      throw new NoQuote('MARKET_CONFIGURATION');
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (block.timestamp + BigInt(c.maxBlockAgeSeconds) < now || block.timestamp > now + 1n) throw new NoQuote('STALE_CHAIN');
    const read = (address, abi, functionName, args = []) => this.client.readContract({ address, abi, functionName, args, blockNumber: block.number });
    const [rate, feeBps, asset, exchange, usdg, stock, wrapped, allowed, paused, vaultPaused] = await Promise.all([
      read(market.wrappedStock, tokenAbi, 'convertToAssets', [10n ** 18n]), read(c.exchange, exchangeAbi, 'feeBps'),
      read(market.wrappedStock, tokenAbi, 'asset'), read(market.vault, vaultAbi, 'exchange'),
      read(market.vault, vaultAbi, 'usdg'), read(market.vault, vaultAbi, 'stock'), read(market.vault, vaultAbi, 'wrappedStock'),
      read(c.exchange, exchangeAbi, 'vaultAllowed', [market.vault]), read(c.exchange, exchangeAbi, 'newPositionsPaused'),
      read(market.vault, vaultAbi, 'newPositionsPaused'),
    ]);
    if (!same(asset, market.stock) || !same(exchange, c.exchange) || !same(usdg, c.usdg)
      || !same(stock, market.stock) || !same(wrapped, market.wrappedStock) || rate <= 0n)
      throw new NoQuote('MARKET_CONFIGURATION');
    if (!allowed || paused || vaultPaused) throw new NoQuote('MARKET_UNAVAILABLE');
    return { vault: market.vault, rate: rate.toString(), feeBps, blockNumber: block.number.toString(), observedAtMs: Date.now() };
  }
}
