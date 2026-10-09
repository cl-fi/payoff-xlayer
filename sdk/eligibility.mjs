const WAD = 10n ** 18n;

// fetchedAtMs measures a successful HTTP observation, not the oracle's update time.
export function usablePrice(price, nowMs) {
  return !!price && price.status === 'available' && nowMs > 0
    && price.fetchedAtMs <= nowMs + 1000 && nowMs - price.fetchedAtMs < price.maxAgeMs;
}

export function eligibleSeries(terms, rate, price, nowMs) {
  if (!usablePrice(price, nowMs) || BigInt(rate) <= 0n || Number(terms.tradeCutoff) * 1000 <= nowMs) return false;
  // Match the displayed stock-equivalent target, rounded up to one USDG micro.
  const target = (BigInt(terms.strikePricePerWrappedUSDG) * WAD + BigInt(rate) - 1n) / BigInt(rate);
  return terms.side === 0 ? target < BigInt(price.priceMicros) : target > BigInt(price.priceMicros);
}

export const LISTED_EXPIRIES = 3;
export const DELIST_BEFORE_EXPIRY_MS = 8 * 60 * 60 * 1000;

// Offers list only the nearest expiries, and each one leaves the list a fixed time before
// it expires, so the next expiry takes its place. Positions already open are unaffected.
export function listedSeries(series, nowMs, count = LISTED_EXPIRIES, delistMs = DELIST_BEFORE_EXPIRY_MS) {
  const open = series.filter(s => Number(s.tradeCutoff) * 1000 > nowMs && Number(s.exerciseEnd) * 1000 - delistMs > nowMs);
  const ends = [...new Set(open.map(s => s.exerciseEnd))].sort((a, b) => Number(a) - Number(b)).slice(0, count);
  return open.filter(s => ends.includes(s.exerciseEnd));
}

// Select separately for each expiry and direction, so missing strikes in one expiry
// cannot displace valid offers in another. No premiums or floating point arithmetic.
export function nearestSeries(series, rate, price, nowMs, count = 3) {
  const groups = new Map();
  for (const s of series) {
    if (!eligibleSeries(s, rate, price, nowMs)) continue;
    const key = `${s.side}:${s.exerciseEnd}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.values()].flatMap(group => group.sort((a, b) => {
    const cmp = BigInt(a.strikePricePerWrappedUSDG) < BigInt(b.strikePricePerWrappedUSDG) ? -1
      : BigInt(a.strikePricePerWrappedUSDG) > BigInt(b.strikePricePerWrappedUSDG) ? 1 : 0;
    return a.side === 0 ? -cmp : cmp;
  }).slice(0, count));
}
