const WAD = 10n ** 18n;
const BPS = 10000n;
const MAX_UINT = 2n ** 256n - 1n;
export class NoQuote extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function optionFor(context) {
  const { terms, assetsPerWrapped, symbol } = context;
  // An explicit reference is a pricing input, never a replacement for fixed onchain terms.
  // Without one, retain strict matching; do not silently round to a listed stock strike.
  let strikeMilli;
  if (context.referenceStrikeMilli !== undefined) {
    strikeMilli = BigInt(context.referenceStrikeMilli);
  } else {
    const numerator = BigInt(terms.strikePricePerWrappedUSDG) * WAD;
    const denominator = BigInt(assetsPerWrapped) * 1000n;
    if (denominator <= 0n || numerator % denominator !== 0n) throw new NoQuote('NO_EXACT_STRIKE');
    strikeMilli = numerator / denominator;
  }
  if (strikeMilli <= 0n) throw new NoQuote('NO_EXACT_STRIKE');
  return { symbol, expiration: nyDate.format(new Date(Number(terms.exerciseEnd) * 1000)),
    right: terms.side === 0 ? 'put' : 'call', strikeMilli: strikeMilli.toString(),
    strike: `${strikeMilli / 1000n}.${(strikeMilli % 1000n).toString().padStart(3, '0')}` };
}
export function calculatePremium(bidMicros, stockQuantity, feeBps, config) {
  const target = BigInt(bidMicros) * BigInt(stockQuantity) * BigInt(config.premiumBps) / (WAD * BPS);
  const feeRate = BigInt(feeBps);
  if (target <= 0n) throw new NoQuote('PREMIUM_TOO_SMALL');
  if (feeRate < 0n || feeRate > BPS || (config.premiumBasis === 'net' && feeRate === BPS)) throw new NoQuote('INVALID_FEE');
  // Smallest gross for which gross - floor(gross * fee / 10000) == target.
  const gross = config.premiumBasis === 'net' ? (target - 1n) * BPS / (BPS - feeRate) + 1n : target;
  if (gross > MAX_UINT) throw new NoQuote('AMOUNT_OVERFLOW');
  const fee = gross * feeRate / BPS;
  return { grossPremiumUSDG: gross.toString(), protocolFeeUSDG: fee.toString(), netPremiumUSDG: (gross - fee).toString() };
}
export function validateMarket(expected, market, nowMs = Date.now()) {
  if (!market || typeof market !== 'object') throw new NoQuote('INVALID_MARKET_DATA');
  if (market.symbol !== expected.symbol || market.expiration !== expected.expiration
    || market.right !== expected.right || market.strikeMilli !== expected.strikeMilli) throw new NoQuote('MARKET_CONTRACT_MISMATCH');
  for (const field of ['timestampMs', 'marketOpenMs', 'marketCloseMs', 'expirationCloseMs']) {
    if (!Number.isSafeInteger(market[field])) throw new NoQuote('INVALID_MARKET_DATA');
  }
  // Validate when the observation was made, not whether the market is open now.
  if (market.timestampMs <= 0 || market.timestampMs > nowMs + 1000
    || market.marketOpenMs >= market.marketCloseMs || market.timestampMs < market.marketOpenMs
    || market.timestampMs > market.marketCloseMs || market.timestampMs > market.expirationCloseMs)
    throw new NoQuote('INVALID_MARKET_TIMESTAMP');
  if (typeof market.bidMicros !== 'string' || typeof market.askMicros !== 'string'
    || !/^\d{1,78}$/.test(market.bidMicros) || !/^\d{1,78}$/.test(market.askMicros)
    || BigInt(market.bidMicros) <= 0n || BigInt(market.askMicros) < BigInt(market.bidMicros)
    || !Number.isSafeInteger(market.bidSize) || market.bidSize <= 0) throw new NoQuote('NO_VALID_BID');
}
export function marketDataMode(market, config, nowMs = Date.now()) {
  return nowMs >= market.marketOpenMs && nowMs < market.marketCloseMs
    && nowMs - market.timestampMs < config.maxQuoteAgeSeconds * 1000 ? 'live' : 'last_valid';
}
export function priceQuote(context, market, config, nowMs = Date.now()) {
  validateMarket(optionFor(context), market, nowMs);
  if (BigInt(context.terms.exerciseEnd) * 1000n !== BigInt(market.expirationCloseMs)) throw new NoQuote('EXPIRY_TIME_MISMATCH');
  const now = Math.floor(nowMs / 1000);
  // Each RFQ gets a new, short-lived signature even when its reference bid is old.
  const deadline = Math.min(now + config.quoteTtlSeconds, Number(context.terms.tradeCutoff),
    Math.floor(market.expirationCloseMs / 1000));
  if (deadline <= now + 3) throw new NoQuote('QUOTE_WINDOW_TOO_SHORT');
  return { ...calculatePremium(market.bidMicros, context.stockQuantity, context.feeBps, config), deadline: String(deadline) };
}
