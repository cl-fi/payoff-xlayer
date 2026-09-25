import { readFile } from 'node:fs/promises';
import { savePrivate } from './settlement.mjs';
import { SettlementError, jsonSafe, settlementTokenAbi } from './settlement-chain.mjs';
import { assessSamples } from './hyperliquid.mjs';

const WAD = 10n ** 18n;
const BPS = 10000n;
const KEEP_WINDOWS = 30;
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });

export function marketDay(seconds) {
  const parts = Object.fromEntries(nyDay.formatToParts(new Date(seconds * 1000)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}

// Intrinsic value of the dealer's long side at the reference price, in USDG micros.
// strikeAmountUSDG was fixed at open; the wrapper rate drifts, so the share count is
// recomputed from the current convertToAssets(1e18). One expression avoids double
// truncation. Premium already received is sunk and never enters the rule.
export function evaluate(position, rate, priceMicros, minEdgeBps = 0) {
  const notional = BigInt(position.wrappedQuantity) * BigInt(rate) * BigInt(priceMicros) / (WAD * WAD);
  const strike = BigInt(position.strikeAmountUSDG);
  const put = Number(position.terms.side) === 0;
  const intrinsic = put ? strike - notional : notional - strike;
  const edgeBps = notional > 0n ? intrinsic * BPS / notional : intrinsic > 0n ? BPS : -BPS;
  return { side: put ? 'put' : 'call', notional, intrinsic, edgeBps, exercise: intrinsic > 0n && edgeBps >= BigInt(minEdgeBps) };
}

// Open dealer positions grouped by exercise window, earliest window first.
export function windowsOf(snapshot, nowSeconds) {
  const groups = new Map();
  for (const market of snapshot.markets) {
    for (const p of market.positions) {
      const start = Number(p.terms.exerciseStart), end = Number(p.terms.exerciseEnd);
      if (Number(p.state) !== 1 || nowSeconds >= end) continue;
      const key = `${start}:${end}`;
      if (!groups.has(key)) groups.set(key, { start, end, positions: [] });
      groups.get(key).positions.push({ vault: market.vault, symbol: market.symbol, wrappedStock: market.wrappedStock, id: String(p.id),
        seriesId: String(p.seriesId), wrappedQuantity: String(p.wrappedQuantity), strikeAmountUSDG: String(p.strikeAmountUSDG), terms: p.terms });
    }
  }
  return [...groups.values()].sort((a, b) => a.end - b.end || a.start - b.start);
}

const FINAL = new Set(['success', 'reverted']);

// Runs inside the self-dealer process so the CLI's PID-based journal lock is shared:
// an operator command and the runner can never sign concurrently.
export class AutoExercise {
  stopped = false;
  phase = 'idle';
  next = null;
  last = null;
  lastError = null;
  constructor({ config, chain, manual, price, path, log = () => {}, now = () => Date.now(), sleep } = {}) {
    Object.assign(this, { config, chain, manual, price, path, log, now });
    this.settings = config.autoExercise;
    this.sleep = sleep ?? (ms => this.pause(ms));
  }
  status() {
    const { enabled, dryRun } = this.settings;
    return { enabled, dryRun, phase: enabled ? this.phase : 'disabled', next: this.next, last: this.last, lastError: this.lastError };
  }
  pause(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      timer.unref?.();
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }
  async start() {
    if (!this.settings.enabled) return;
    if (this.path) {
      try {
        const saved = JSON.parse(await readFile(this.path, 'utf8'));
        if (saved.chainId === this.config.chainId && saved.dealer?.toLowerCase() === this.chain.dealer.toLowerCase()) this.last = saved.windows.at(-1) ?? null;
      } catch { /* A fresh journal starts with the next window. */ }
    }
    this.loop = this.run();
  }
  async stop() { this.stopped = true; this.wake?.(); await this.loop; }
  async run() {
    while (!this.stopped) {
      try { await this.cycle(); this.lastError = null; }
      catch (error) {
        this.lastError = { code: error instanceof SettlementError ? error.code : 'AUTO_EXERCISE_CYCLE_FAILED', atMs: this.now() };
        this.log({ event: 'auto_exercise_cycle_failed', alert: this.lastError.code });
        await this.sleep(60000);
      }
    }
  }
  armAtMs(window) {
    const { decideBeforeEndSeconds, pollMs, oracleUnchangedPolls } = this.settings;
    return (window.end - decideBeforeEndSeconds) * 1000 - pollMs * oracleUnchangedPolls;
  }
  async cycle() {
    const snapshot = await this.chain.snapshot();
    const [window] = windowsOf(snapshot, Math.floor(this.now() / 1000));
    if (!window) {
      this.phase = 'idle'; this.next = null;
      await this.sleep(this.settings.idlePollMs);
      return;
    }
    const armAt = this.armAtMs(window);
    this.next = { start: window.start, end: window.end, decideAt: window.end - this.settings.decideBeforeEndSeconds, positions: window.positions.length };
    if (this.now() < armAt) {
      // Re-scan periodically so positions opened later and configuration changes are seen.
      this.phase = 'waiting';
      await this.sleep(Math.min(armAt - this.now(), this.settings.idlePollMs));
      return;
    }
    await this.runWindow(window);
    this.next = null;
    await this.sleep(Math.max(0, window.end * 1000 - this.now()) + 1000);
  }
  async runWindow(window) {
    const s = this.settings;
    const decideAtMs = (window.end - s.decideBeforeEndSeconds) * 1000, cutoffMs = (window.end - s.submitCutoffSeconds) * 1000;
    const day = marketDay(window.end);
    const record = { start: window.start, end: window.end, day: day.date, dryRun: s.dryRun, startedAtMs: this.now(),
      positions: window.positions.length, exercised: [], skipped: [], failed: [], alerts: [], polls: 0, outcome: null };
    const finish = async outcome => {
      record.outcome = outcome; record.finishedAtMs = this.now();
      this.last = record; this.phase = 'idle';
      this.log({ event: 'auto_exercise_window', ...record, alert: record.alerts.length ? record.alerts[0].code : undefined });
      if (this.path) await this.save(record);
      return record;
    };
    const alert = (code, details = {}) => { record.alerts.push({ code, ...details }); this.log({ event: 'auto_exercise_alert', alert: code, ...details }); };
    if (['Sat', 'Sun'].includes(day.weekday) || s.skipDates.includes(day.date)) {
      alert('MARKET_CLOSED_IN_WINDOW', { day: day.date });
      return finish('market_closed');
    }
    this.phase = 'deciding';
    this.log({ event: 'auto_exercise_armed', start: window.start, end: window.end, decideAt: decideAtMs / 1000, cutoff: cutoffMs / 1000, positions: window.positions.length, dryRun: s.dryRun });
    const remaining = new Map(window.positions.map(p => [`${p.vault.toLowerCase()}:${p.id}`, p]));
    for (const [key, p] of remaining) {
      if (!s.coins[p.symbol]) { alert('NO_PRICE_SOURCE', { symbol: p.symbol }); record.skipped.push({ vault: p.vault, positionId: p.id, reason: 'NO_PRICE_SOURCE' }); remaining.delete(key); }
    }
    const samples = new Map(), lastEdge = new Map();
    let halted = null;
    while (!this.stopped && !halted && remaining.size && this.now() < cutoffMs) {
      for (const coin of new Set([...remaining.values()].map(p => s.coins[p.symbol]))) {
        try {
          const list = samples.get(coin) ?? [];
          list.push(await this.price.sample(coin));
          samples.set(coin, list.slice(-s.oracleUnchangedPolls));
        } catch (error) {
          this.log({ event: 'auto_exercise_price_failed', coin, alert: error instanceof SettlementError ? error.code : 'PRICE_UNAVAILABLE' });
        }
      }
      if (this.now() < decideAtMs) { await this.sleep(s.pollMs); continue; }
      record.polls++;
      // Rate reads start together; a rejection resolves to null so a poll that never
      // awaits it (price guard fired) cannot become an unhandled rejection.
      const rates = new Map();
      for (const p of remaining.values()) {
        if (!rates.has(p.wrappedStock)) rates.set(p.wrappedStock,
          Promise.resolve().then(() => this.chain.read(p.wrappedStock, settlementTokenAbi, 'convertToAssets', [WAD])).then(v => v, () => null));
      }
      const candidates = [], poll = { event: 'auto_exercise_poll', atMs: this.now(), prices: {}, positions: [] };
      for (const p of remaining.values()) {
        const coin = s.coins[p.symbol], list = samples.get(coin) ?? [], issues = assessSamples(list, s);
        const latest = list.at(-1);
        poll.prices[coin] = latest ? { oraclePx: latest.oraclePx, midPx: latest.midPx, issues } : { issues };
        if (issues.length) continue;
        const rate = await rates.get(p.wrappedStock);
        if (rate === null || rate === undefined) { poll.positions.push({ positionId: p.id, issue: 'RATE_UNAVAILABLE' }); continue; }
        const result = evaluate(p, rate, latest.oracleMicros, s.minEdgeBps);
        lastEdge.set(p.id, { ...result, price: latest.oraclePx, rate: String(rate) });
        poll.positions.push({ vault: p.vault, positionId: p.id, side: result.side, edgeBps: String(result.edgeBps), intrinsic: String(result.intrinsic), exercise: result.exercise });
        if (result.exercise) candidates.push({ position: p, result, price: latest.oraclePx, rate: String(rate) });
      }
      this.log(jsonSafe(poll));
      candidates.sort((a, b) => (a.result.edgeBps < b.result.edgeBps ? 1 : a.result.edgeBps > b.result.edgeBps ? -1 : 0));
      for (const { position: p, result, price, rate } of candidates) {
        if (this.stopped || halted || this.now() >= cutoffMs) break;
        const key = `${p.vault.toLowerCase()}:${p.id}`;
        const decision = { vault: p.vault, positionId: p.id, side: result.side, price, rate, edgeBps: String(result.edgeBps), intrinsic: String(result.intrinsic), atMs: this.now() };
        if (s.dryRun) {
          remaining.delete(key); record.exercised.push({ ...decision, dryRun: true });
          this.log({ event: 'auto_exercise_dry_run', ...decision });
          continue;
        }
        let outcome;
        try { outcome = await this.manual.execute({ kind: 'exercise', vault: p.vault, positionId: p.id }); }
        catch (error) {
          const code = error instanceof SettlementError ? error.code : 'EXERCISE_FAILED';
          this.log({ event: 'auto_exercise_execute_failed', ...decision, alert: code });
          if (code === 'WINDOW_ENDED') { halted = code; break; }
          // An operator command holds the journal lock: retry the whole list next poll.
          if (code === 'TRANSACTION_LOCKED') break;
          continue;
        }
        if (!FINAL.has(outcome.status) && outcome.status !== 'blocked') outcome = await this.settle(cutoffMs, outcome);
        const hash = outcome.transaction?.hash;
        if (outcome.status === 'success') { remaining.delete(key); record.exercised.push({ ...decision, hash }); this.log({ event: 'auto_exercise_executed', ...decision, hash }); }
        else if (outcome.status === 'reverted') { remaining.delete(key); record.failed.push({ ...decision, hash, reason: 'REVERTED' }); alert('AUTO_EXERCISE_REVERTED', { positionId: p.id, hash }); }
        else if (outcome.status === 'blocked') {
          const reason = outcome.reason ?? outcome.plan?.issues?.join(',') ?? 'BLOCKED';
          if (outcome.reason === 'PREVIOUS_TRANSACTION_UNRESOLVED') { halted = reason; alert('AUTO_EXERCISE_HALTED', { reason }); break; }
          remaining.delete(key); record.failed.push({ ...decision, reason }); alert('AUTO_EXERCISE_BLOCKED', { positionId: p.id, reason });
        } else { halted = outcome.status; alert('AUTO_EXERCISE_HALTED', { positionId: p.id, reason: outcome.status, hash }); }
      }
      if (remaining.size && !halted) await this.sleep(s.pollMs);
    }
    for (const p of remaining.values()) {
      const last = lastEdge.get(p.id);
      const reason = halted ?? (this.stopped ? 'STOPPED' : !last ? 'NO_DECISION' : last.exercise ? 'SUBMIT_CUTOFF' : 'NO_ADVANTAGE');
      record.skipped.push({ vault: p.vault, positionId: p.id, reason, ...(last ? { edgeBps: String(last.edgeBps), price: last.price } : {}) });
    }
    return finish(halted ? 'halted' : this.stopped ? 'stopped' : 'completed');
  }
  // A broadcast that is not final yet owns the wallet nonce. Reconcile it until it
  // settles or the cutoff passes; never send another exercise meanwhile.
  async settle(cutoffMs, outcome) {
    while (!this.stopped && this.now() < cutoffMs + this.settings.submitCutoffSeconds * 1000) {
      if (FINAL.has(outcome.status) || outcome.status === 'nonce_consumed_needs_review' || outcome.status === 'idle') return outcome;
      await this.sleep(2000);
      try { outcome = await this.manual.reconcile(); } catch { /* transient; keep polling */ }
    }
    return outcome;
  }
  async save(record) {
    let journal = { version: 1, chainId: this.config.chainId, dealer: this.chain.dealer, windows: [] };
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version === 1 && saved.chainId === this.config.chainId && saved.dealer?.toLowerCase() === this.chain.dealer.toLowerCase() && Array.isArray(saved.windows)) journal = saved;
    } catch { /* start a new journal */ }
    journal.windows = [...journal.windows, record].slice(-KEEP_WINDOWS);
    await savePrivate(this.path, jsonSafe(journal));
  }
}
