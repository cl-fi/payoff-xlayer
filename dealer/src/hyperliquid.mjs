import { SettlementError } from './settlement-chain.mjs';

const BPS = 10000n;
const abs = value => (value < 0n ? -value : value);

// Exact decimal string to USDG micros (6 decimals). Never floats: the result feeds
// BigInt settlement math. Extra decimals are truncated, never rounded.
export function toMicros(value) {
  const match = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(String(value ?? ''));
  if (!match) throw new SettlementError('INVALID_PRICE');
  const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0').slice(0, 6));
  if (micros <= 0n) throw new SettlementError('INVALID_PRICE');
  return micros;
}

// `metaAndAssetCtxs` returns [meta, contexts]; the context of an asset sits at the
// asset's index in meta.universe. Delisted markets keep a frozen context.
export function parseAssetContext(body, coin) {
  if (!Array.isArray(body) || body.length !== 2) throw new SettlementError('PRICE_UNAVAILABLE');
  const [meta, contexts] = body;
  const index = Array.isArray(meta?.universe) ? meta.universe.findIndex(asset => asset?.name === coin) : -1;
  const context = index >= 0 && Array.isArray(contexts) ? contexts[index] : null;
  if (!context || meta.universe[index].isDelisted) throw new SettlementError('PRICE_UNAVAILABLE');
  const mid = context.midPx == null ? null : toMicros(context.midPx);
  return { coin, oraclePx: String(context.oraclePx), midPx: context.midPx == null ? null : String(context.midPx),
    markPx: String(context.markPx), oracleMicros: toMicros(context.oraclePx), midMicros: mid, markMicros: toMicros(context.markPx) };
}

// Public, keyless read of a HIP-3 perpetual context. The decision uses `oraclePx`:
// while the US market is open it is the externally derived reference price, whereas
// mid and mark carry the perpetual premium.
export class HyperliquidPrice {
  constructor({ url, dex, timeoutMs = 5000, fetch: fetchImpl = globalThis.fetch } = {}) {
    Object.assign(this, { url, dex, timeoutMs, fetch: fetchImpl });
  }
  async sample(coin) {
    const startedAt = Date.now();
    let body;
    try {
      const response = await this.fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: this.dex }), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new Error('status');
      body = await response.json();
    } catch { throw new SettlementError('PRICE_UNAVAILABLE'); }
    return { ...parseAssetContext(body, coin), observedAtMs: Date.now(), latencyMs: Date.now() - startedAt };
  }
}

// The oracle carries no timestamp, so a stuck relayer looks fresh. Two proxies flag it:
// the oracle drifting away from the live book, and the oracle not moving across
// consecutive polls of a market that trades continuously.
export function assessSamples(samples, { oracleMidBandBps, oracleUnchangedPolls }) {
  const latest = samples.at(-1);
  if (!latest) return ['PRICE_UNAVAILABLE'];
  const issues = [];
  if (latest.midMicros === null) issues.push('BOOK_EMPTY');
  else if (abs(latest.oracleMicros - latest.midMicros) * BPS / latest.oracleMicros > BigInt(oracleMidBandBps)) issues.push('ORACLE_MID_DIVERGENCE');
  if (samples.length >= oracleUnchangedPolls && samples.slice(-oracleUnchangedPolls).every(s => s.oracleMicros === latest.oracleMicros))
    issues.push('ORACLE_UNCHANGED');
  return issues;
}
