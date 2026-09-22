import { createPublicClient, http, parseAbi } from 'viem';
import { same } from './pricing.mjs';

export const settlementVaultAbi = parseAbi([
  'function exchange() view returns (address)', 'function usdg() view returns (address)',
  'function stock() view returns (address)', 'function wrappedStock() view returns (address)',
  'function RULES_VERSION() view returns (uint256)', 'function nextPositionId() view returns (uint256)',
  'function position(uint256) view returns ((uint256 seriesId,address shortHolder,address longHolder,uint256 wrappedQuantity,uint256 strikeAmountUSDG,uint256 wrappedBalance,uint8 state))',
  'function getSeries(uint256) view returns ((uint8 side,uint256 strikePricePerWrappedUSDG,uint64 tradeCutoff,uint64 exerciseStart,uint64 exerciseEnd))',
  'function exercise(uint256)',
]);
export const settlementTokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)',
  'function asset() view returns (address)', 'function convertToAssets(uint256) view returns (uint256)',
]);
export const jsonSafe = value => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
export class SettlementError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Settlement deliberately ignores quote admission, pauses and the active catalog:
// previously opened positions remain exercisable even after a product is removed.
export class SettlementChain {
  constructor(config, rpcUrl, dealer, client) {
    this.config = config; this.dealer = dealer;
    this.client = client ?? createPublicClient({ transport: http(rpcUrl, { timeout: config.rpcTimeoutMs, retryCount: 0 }) });
  }
  market(vault) {
    const market = this.config.markets.find(m => same(m.vault, vault));
    if (!market) throw new SettlementError('UNKNOWN_VAULT');
    return market;
  }
  async block(confirmations = 1) {
    if (await this.client.getChainId() !== this.config.chainId) throw new SettlementError('WRONG_CHAIN');
    const latest = await this.client.getBlock();
    const number = latest.number - BigInt(confirmations - 1);
    const block = confirmations === 1 ? latest : await this.client.getBlock({ blockNumber: number < 0n ? 0n : number });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (block.timestamp + BigInt(this.config.maxBlockAgeSeconds) < now || block.timestamp > now + 1n)
      throw new SettlementError('STALE_CHAIN');
    return block;
  }
  read(address, abi, functionName, args, blockNumber) {
    return this.client.readContract({ address, abi, functionName, args, blockNumber });
  }
  async validate(market, blockNumber) {
    const v = name => this.read(market.vault, settlementVaultAbi, name, [], blockNumber);
    const t = (address, name) => this.read(address, settlementTokenAbi, name, [], blockNumber);
    const [exchange, usd, stock, wrapped, version, asset, usdDecimals, wrappedDecimals] = await Promise.all([
      v('exchange'), v('usdg'), v('stock'), v('wrappedStock'), v('RULES_VERSION'),
      t(market.wrappedStock, 'asset'), t(this.config.usdg, 'decimals'), t(market.wrappedStock, 'decimals'),
    ]);
    if (!same(exchange, this.config.exchange) || !same(usd, this.config.usdg) || !same(stock, market.stock)
      || !same(wrapped, market.wrappedStock) || !same(asset, market.stock) || version !== 2n || usdDecimals !== 6 || wrappedDecimals !== 18)
      throw new SettlementError('MARKET_CONFIGURATION');
  }
  async inventory(market, blockNumber) {
    const t = (address, name, args) => this.read(address, settlementTokenAbi, name, args, blockNumber);
    const [usdgBalance, wrappedBalance, usdgAllowance, wrappedAllowance] = await Promise.all([
      t(this.config.usdg, 'balanceOf', [this.dealer]), t(market.wrappedStock, 'balanceOf', [this.dealer]),
      t(this.config.usdg, 'allowance', [this.dealer, market.vault]), t(market.wrappedStock, 'allowance', [this.dealer, market.vault]),
    ]);
    return { usdgBalance, wrappedBalance, usdgAllowance, wrappedAllowance };
  }
  async position(market, id, blockNumber) {
    const position = await this.read(market.vault, settlementVaultAbi, 'position', [BigInt(id)], blockNumber);
    const terms = await this.read(market.vault, settlementVaultAbi, 'getSeries', [position.seriesId], blockNumber);
    return { id: String(id), vault: market.vault, symbol: market.symbol, ...position, terms };
  }
  async snapshot() {
    const block = await this.block(this.config.settlementConfirmations);
    const gasBalance = await this.client.getBalance({ address: this.dealer, blockNumber: block.number });
    const markets = [];
    for (const market of this.config.markets) {
      await this.validate(market, block.number);
      const [next, inventory] = await Promise.all([
        this.read(market.vault, settlementVaultAbi, 'nextPositionId', [], block.number), this.inventory(market, block.number),
      ]);
      const positions = [];
      // No series allowlist: recover every owned position, including unpublished test
      // batches and products no longer offered by the RFQ service.
      for (let start = 1n; start < next; start += 4n) {
        const ids = Array.from({ length: Number(next - start < 4n ? next - start : 4n) }, (_, i) => start + BigInt(i));
        const rows = await Promise.all(ids.map(id => this.position(market, id, block.number)));
        positions.push(...rows.filter(p => same(p.longHolder, this.dealer)));
      }
      markets.push({ vault: market.vault, symbol: market.symbol, wrappedStock: market.wrappedStock, ...inventory, positions });
    }
    return jsonSafe({ chainId: this.config.chainId, dealer: this.dealer, observedAtMs: Date.now(),
      blockNumber: block.number, blockTimestamp: block.timestamp, gasBalance, markets });
  }
  async exercisePlan(vault, id) {
    if (!/^[1-9][0-9]*$/.test(String(id))) throw new SettlementError('INVALID_POSITION_ID');
    const market = this.market(vault), block = await this.block();
    await this.validate(market, block.number);
    const [position, inventory, gasBalance] = await Promise.all([
      this.position(market, id, block.number), this.inventory(market, block.number),
      this.client.getBalance({ address: this.dealer, blockNumber: block.number }),
    ]);
    const { terms } = position, put = terms.side === 0;
    const issues = [];
    if (!same(position.longHolder, this.dealer)) issues.push('NOT_POSITION_HOLDER');
    if (position.state !== 1) issues.push('POSITION_NOT_OPEN');
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (block.timestamp < terms.exerciseStart || now < terms.exerciseStart) issues.push('WINDOW_NOT_OPEN');
    if (block.timestamp >= terms.exerciseEnd || now >= terms.exerciseEnd) issues.push('WINDOW_ENDED');
    const amount = put ? position.wrappedQuantity : position.strikeAmountUSDG;
    if ((put ? inventory.wrappedBalance : inventory.usdgBalance) < amount) issues.push('DELIVERY_BALANCE_LOW');
    if ((put ? inventory.wrappedAllowance : inventory.usdgAllowance) < amount) issues.push('DELIVERY_ALLOWANCE_LOW');
    return jsonSafe({ action: 'exercise', chainId: this.config.chainId, dealer: this.dealer,
      vault: market.vault, positionId: String(id), blockNumber: block.number, position, inventory, gasBalance,
      delivery: { token: put ? market.wrappedStock : this.config.usdg, amount },
      receives: { token: put ? this.config.usdg : market.wrappedStock, amount: put ? position.strikeAmountUSDG : position.wrappedQuantity },
      issues });
  }
}
