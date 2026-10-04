import { referencePriceSchema } from '../../sdk/catalog.mjs';
import { eligibleSeries, usablePrice } from '../../sdk/eligibility.mjs';
import { NoQuote } from './pricing.mjs';

// Runs independently of ThetaData and automatic exercise. Browsers/RFQs only read
// the shared cache; a failed poll never renews a previous observation's lifetime.
export class ReferencePriceService {
  samples = new Map();
  pending = null;
  constructor({ config, price, log = () => {} }) { Object.assign(this, { config, price, log }); }
  get(symbol) {
    const coin = this.config.coins[symbol];
    if (!coin) return null;
    return this.samples.get(symbol) ?? { symbol, coin, source: 'hyperliquid', field: 'oraclePx',
      maxAgeMs: this.config.maxAgeMs, status: 'unavailable' };
  }
  snapshot() { return Object.keys(this.config.coins).map(symbol => this.get(symbol)); }
  assertEligible(context) {
    const price = this.get(context.symbol);
    if (!usablePrice(price, Date.now())) throw new NoQuote('REFERENCE_PRICE_UNAVAILABLE');
    if (!eligibleSeries(context.terms, context.assetsPerWrapped, price, Date.now())) throw new NoQuote('TARGET_OUTSIDE_STRATEGY');
    return price;
  }
  refresh() {
    if (!this.pending) this.pending = this.update().finally(() => { this.pending = null; });
    return this.pending;
  }
  async update() {
    for (const [symbol, coin] of Object.entries(this.config.coins)) {
      try {
        const sample = await this.price.sample(coin);
        this.samples.set(symbol, referencePriceSchema.parse({ symbol, coin, source: 'hyperliquid', field: 'oraclePx',
          status: 'available', priceMicros: String(sample.oracleMicros), fetchedAtMs: sample.observedAtMs, maxAgeMs: this.config.maxAgeMs }));
      } catch { this.log({ event: 'reference_price_fetch_failed', symbol }); }
    }
  }
  start() {
    const initial = this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.pollMs);
    this.timer.unref();
    return initial;
  }
  async stop() { clearInterval(this.timer); await this.pending; }
}
