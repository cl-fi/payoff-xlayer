import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SettlementError } from './settlement-chain.mjs';

export async function savePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(`${path}.tmp`, 'w', 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(`${path}.tmp`, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function settlementStatus(snapshot, config) {
  const now = BigInt(snapshot.blockTimestamp), alerts = [], markets = [];
  const alert = (code, details = {}) => alerts.push({ code, ...details });
  if (BigInt(snapshot.gasBalance) < BigInt(config.settlementMinGasWei)) alert('LOW_GAS');
  let totalCallUSDG = 0n;
  for (const market of snapshot.markets) {
    let requiredUSDG = 0n, requiredWrapped = 0n;
    const positions = market.positions.map(p => {
      const start = BigInt(p.terms.exerciseStart), end = BigInt(p.terms.exerciseEnd);
      const state = p.state === 4 ? 'claimed' : p.state === 2 ? 'exercised'
        : p.state === 1 && now >= end ? 'expired' : p.state === 1 ? 'open' : 'unknown';
      const window = now < start ? 'upcoming' : now < end ? 'open' : 'ended';
      const details = { vault: market.vault, positionId: p.id, seriesId: p.seriesId };
      if (state === 'open') {
        if (p.terms.side === 0) requiredWrapped += BigInt(p.wrappedQuantity);
        else requiredUSDG += BigInt(p.strikeAmountUSDG);
        if (window === 'open') alert('MANUAL_EXERCISE_WINDOW_OPEN', details);
        else if (start - now <= BigInt(config.settlementWarningSeconds)) alert('EXERCISE_WINDOW_APPROACHING', details);
      }
      // Expiry without exercise is a valid outcome, not a failed settlement.
      return { ...p, state, window };
    });
    totalCallUSDG += requiredUSDG;
    if (BigInt(market.wrappedBalance) < requiredWrapped) alert('WRAPPED_DELIVERY_SHORTFALL', { vault: market.vault, required: String(requiredWrapped), available: market.wrappedBalance });
    if (BigInt(market.wrappedAllowance) < requiredWrapped) alert('WRAPPED_ALLOWANCE_SHORTFALL', { vault: market.vault, required: String(requiredWrapped), available: market.wrappedAllowance });
    if (BigInt(market.usdgAllowance) < requiredUSDG) alert('USDG_ALLOWANCE_SHORTFALL', { vault: market.vault, required: String(requiredUSDG), available: market.usdgAllowance });
    markets.push({ ...market, requiredUSDG: String(requiredUSDG), requiredWrapped: String(requiredWrapped), positions });
  }
  // Informational coverage of all open calls; this is not an admission cap or a
  // reservation. All Vaults share the same dealer USDG balance.
  const usdgBalance = snapshot.markets[0]?.usdgBalance ?? '0';
  if (BigInt(usdgBalance) < totalCallUSDG) alert('USDG_DELIVERY_SHORTFALL', { required: String(totalCallUSDG), available: usdgBalance });
  return { ...snapshot, mode: 'manual', automaticExercise: false, requiredUSDG: String(totalCallUSDG), markets, alerts };
}

export class SettlementMonitor {
  snapshot = null;
  pending = null;
  lastError = null;
  constructor({ config, chain, path, log = () => {} }) { Object.assign(this, { config, chain, path, log }); }
  refresh() {
    if (!this.pending) this.pending = this.update().catch(error => {
      this.lastError = { code: error instanceof SettlementError ? error.code : 'SETTLEMENT_SCAN_FAILED', atMs: Date.now() };
      this.log({ event: 'settlement_scan_failed', ...this.lastError });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async update() {
    const snapshot = settlementStatus(await this.chain.snapshot(), this.config);
    if (this.path) await savePrivate(this.path, snapshot);
    this.snapshot = snapshot; this.lastError = null;
    const key = JSON.stringify(snapshot.alerts);
    if (key !== this.alertKey || Date.now() - (this.lastAlertMs ?? 0) >= 900000) {
      this.log({ event: 'settlement_status', mode: 'manual', blockNumber: snapshot.blockNumber, alerts: snapshot.alerts,
        positions: snapshot.markets.flatMap(m => m.positions).length });
      this.alertKey = key; this.lastAlertMs = Date.now();
    }
  }
  status() {
    const stale = !this.snapshot || Date.now() - this.snapshot.observedAtMs > this.config.settlementIntervalMs * 2 + 10000;
    return { status: this.lastError || stale ? 'unavailable' : 'ready', automaticExercise: false,
      lastError: this.lastError, snapshot: this.snapshot };
  }
  async start() {
    if (this.path) {
      try {
        const value = JSON.parse(await readFile(this.path, 'utf8'));
        if (value.chainId === this.config.chainId && value.exchange?.toLowerCase() === this.config.exchange?.toLowerCase()
          && value.usdg?.toLowerCase() === this.config.usdg?.toLowerCase()
          && value.dealer.toLowerCase() === this.chain.dealer.toLowerCase()) this.snapshot = value;
      } catch { /* A fresh confirmed-chain scan reconstructs all positions. */ }
    }
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.settlementIntervalMs); this.timer.unref();
  }
  async stop() { clearInterval(this.timer); await this.pending; }
}
