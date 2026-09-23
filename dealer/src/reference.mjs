import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { catalogSchema, referenceSnapshotSchema } from '../../sdk/catalog.mjs';
import { calculatePremium, marketDataMode, NoQuote, optionFor, same, validateMarket } from './pricing.mjs';

export class ReferenceService {
  snapshot = null;
  catalog = null;
  catalogCheckedAt = 0;
  pending = null;
  constructor({ config, chain, provider, catalogPath, bundledPath, fetcher = fetch, log = () => {} }) {
    Object.assign(this, { config, chain, provider, catalogPath, bundledPath, fetcher, log });
  }
  validateCatalog(value) {
    const catalog = catalogSchema.parse(value);
    if (catalog.chainId !== this.config.chainId || !same(catalog.exchange, this.config.exchange) || !same(catalog.usdg, this.config.usdg))
      throw new Error('Wrong catalog domain');
    return catalog;
  }
  async loadCatalog() {
    if (!this.catalog) {
      for (const path of [this.catalogPath, this.bundledPath]) {
        if (!path) continue;
        try { this.catalog = this.validateCatalog(JSON.parse(await readFile(path, 'utf8'))); break; } catch { /* Try the bundled fallback. */ }
      }
    }
    if (Date.now() - this.catalogCheckedAt < this.config.catalogRefreshMs) return;
    this.catalogCheckedAt = Date.now();
    try {
      const response = await this.fetcher(this.config.catalogUrl, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
      if (!response.ok) throw new Error('Catalog unavailable');
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error('Catalog too large');
      const catalog = this.validateCatalog(JSON.parse(text));
      if (this.catalog && Date.parse(catalog.generatedAt) < Date.parse(this.catalog.generatedAt)) return;
      if (this.catalogPath) {
        await mkdir(dirname(this.catalogPath), { recursive: true });
        await writeFile(`${this.catalogPath}.tmp`, JSON.stringify(catalog), { mode: 0o600 });
        await rename(`${this.catalogPath}.tmp`, this.catalogPath);
      }
      this.catalog = catalog;
    } catch { this.log({ event: 'reference_catalog_fallback', available: !!this.catalog }); }
  }
  refresh() {
    if (!this.pending) this.pending = this.update().catch(() => this.log({ event: 'reference_refresh_failed' }))
      .finally(() => { this.pending = null; });
    return this.pending;
  }
  async update() {
    await this.loadCatalog();
    if (!this.catalog) return;
    const catalog = this.catalog;
    const quotes = new Map();
    const inputs = new Map();
    const publish = () => {
      this.snapshot = referenceSnapshotSchema.parse({ version: 1, chainId: catalog.chainId, exchange: catalog.exchange,
        catalogGeneratedAt: catalog.generatedAt, updatedAtMs: Date.now(), refreshIntervalMs: this.config.referenceIntervalMs,
        maxQuoteAgeMs: this.config.maxQuoteAgeSeconds * 1000, markets: [...inputs.values()], quotes: [...quotes.values()] });
    };
    // One Vault at a time; only two market-data workers, leaving capacity for formal RFQs.
    for (const market of catalog.markets) {
      const configured = this.config.markets.find(m => same(m.vault, market.vault));
      const active = market.series.filter(s => Number(s.tradeCutoff) * 1000 > Date.now());
      if (!active.length) continue;
      let input;
      try { input = await this.chain.referenceMarket(market); inputs.set(market.vault, input); }
      catch (error) {
        for (const s of active) quotes.set(`${market.vault}:${s.id}`, { vault: market.vault, seriesId: s.id, terms: s,
          status: 'unavailable', reason: error instanceof NoQuote ? error.code : 'CHAIN_UNAVAILABLE' });
        continue;
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < active.length) {
          const terms = active[cursor++];
          const base = { vault: market.vault, seriesId: terms.id, terms };
          let quote;
          try {
            if (!configured?.seriesIds.includes(terms.id)) throw new NoQuote('MARKET_NOT_LISTED');
            const context = { terms, symbol: configured.symbol, assetsPerWrapped: input.rate,
              referenceStrikeMilli: configured.referenceStrikes?.[terms.id] };
            const option = optionFor(context);
            const observation = await this.provider.quote(option);
            validateMarket(option, observation);
            if (BigInt(terms.exerciseEnd) * 1000n !== BigInt(observation.expirationCloseMs)) throw new NoQuote('EXPIRY_TIME_MISMATCH');
            if (Number(terms.tradeCutoff) * 1000 <= Date.now()) throw new NoQuote('SERIES_CLOSED');
            const premium = calculatePremium(observation.bidMicros, input.rate, input.feeBps, this.config);
            quote = { ...base, status: 'available', netPremiumPerWrappedUSDG: premium.netPremiumUSDG,
              assetsPerWrapped: input.rate, calculatedAtMs: Date.now(), marketTimestampMs: observation.timestampMs,
              marketOpenMs: observation.marketOpenMs, marketCloseMs: observation.marketCloseMs,
              expirationCloseMs: observation.expirationCloseMs, marketDataMode: marketDataMode(observation, this.config), option };
          } catch (error) {
            quote = { ...base, status: 'unavailable', reason: error instanceof NoQuote ? error.code : 'MARKET_DATA_UNAVAILABLE' };
          }
          quotes.set(`${market.vault}:${terms.id}`, quote);
        }
      };
      await Promise.all([worker(), worker()]);
    }
    publish();
    this.log({ event: 'reference_refreshed', available: [...quotes.values()].filter(q => q.status === 'available').length, total: quotes.size });
  }
  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.referenceIntervalMs);
    this.timer.unref();
  }
  async stop() { clearInterval(this.timer); await this.pending; }
}
