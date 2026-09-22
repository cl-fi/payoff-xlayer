import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NoQuote, validateMarket } from './pricing.mjs';

const keyOf = o => JSON.stringify([o.symbol, o.expiration, o.right, o.strikeMilli]);
const fields = ['symbol', 'expiration', 'right', 'strikeMilli', 'bidMicros', 'askMicros', 'bidSize',
  'timestampMs', 'marketOpenMs', 'marketCloseMs', 'expirationCloseMs'];

// One dealer process owns this file. The named volume survives container replacement.
export class LastValidBidProvider {
  cache = new Map();
  pending = new Map();
  writes = Promise.resolve();
  constructor(upstream, path) { this.upstream = upstream; this.path = path; }
  static async open(upstream, path) {
    const provider = new LastValidBidProvider(upstream, path);
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.markets)) throw new Error('Invalid bid cache');
      for (const market of saved.markets) {
        validateMarket(market, market);
        if (market.expirationCloseMs > Date.now()) provider.cache.set(keyOf(market), market);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return provider;
  }
  get ready() { return this.upstream.ready || this.cache.size > 0; }
  async quote(option) {
    const key = keyOf(option);
    if (!this.pending.has(key)) {
      const job = this.lookup(option).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    return this.pending.get(key);
  }
  async lookup(option) {
    const key = keyOf(option);
    let observed;
    let failure;
    try {
      observed = await this.upstream.quote(option);
      validateMarket(option, observed);
    } catch (error) { observed = undefined; failure = error; }
    if (observed) {
      const market = Object.fromEntries(fields.map(field => [field, observed[field]]));
      // Serialize read/compare/write so concurrent responses cannot roll the cache back.
      const write = this.writes.catch(() => {}).then(async () => {
        const previous = this.cache.get(key);
        if (previous && previous.timestampMs >= market.timestampMs) return;
        const updated = new Map([...this.cache].filter(([, value]) => value.expirationCloseMs > Date.now()));
        updated.set(key, market);
        await mkdir(dirname(this.path), { recursive: true });
        const file = await open(`${this.path}.tmp`, 'w', 0o600);
        try {
          await file.writeFile(JSON.stringify({ version: 1, markets: [...updated.values()] }) + '\n');
          await file.sync();
        } finally { await file.close(); }
        await rename(`${this.path}.tmp`, this.path);
        this.cache = updated;
      });
      this.writes = write;
      await write;
    }
    const market = this.cache.get(key);
    if (!market) throw new NoQuote('NO_VALID_BID_HISTORY');
    validateMarket(option, market);
    if (Date.now() >= market.expirationCloseMs) throw new NoQuote('REFERENCE_OPTION_EXPIRED');
    return { ...market, referenceSource: observed && observed.timestampMs === market.timestampMs ? 'provider' : 'cache',
      fallbackReason: failure instanceof NoQuote ? failure.code : failure ? 'MARKET_DATA_UNAVAILABLE' : undefined };
  }
  async close() { this.upstream.close(); await this.writes.catch(() => {}); }
}
