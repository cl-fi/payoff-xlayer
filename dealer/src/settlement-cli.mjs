import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { configSchema } from './config.mjs';
import { SettlementChain, SettlementError } from './settlement-chain.mjs';
import { settlementStatus } from './settlement.mjs';
import { ManualSettlement } from './settlement-manual.mjs';
import { HyperliquidPrice } from './hyperliquid.mjs';
import { evaluate, windowsOf } from './auto-exercise.mjs';
import { settlementTokenAbi } from './settlement-chain.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    vault: { type: 'string' }, position: { type: 'string' }, asset: { type: 'string' }, amount: { type: 'string' }, execute: { type: 'boolean', default: false },
  } });
  const [command] = positionals;
  if (positionals.length !== 1 || !['status', 'evaluate', 'exercise', 'approve', 'reconcile', 'rebroadcast'].includes(command))
    throw new SettlementError('USAGE: status | evaluate | exercise --vault ADDRESS --position ID [--execute] | approve --vault ADDRESS --asset usdg|wrapped --amount BASE_UNITS [--execute] | reconcile | rebroadcast --execute');
  const config = configSchema.parse(JSON.parse(await readFile(process.env.DEALER_CONFIG_PATH ?? 'config.local.json', 'utf8')));
  if (!/^0x[\da-fA-F]{64}$/.test(process.env.DEALER_PRIVATE_KEY ?? '') || !process.env.XLAYER_RPC_URL)
    throw new SettlementError('MISSING_SETTLEMENT_CREDENTIALS');
  const account = privateKeyToAccount(process.env.DEALER_PRIVATE_KEY);
  const chain = new SettlementChain(config, process.env.XLAYER_RPC_URL, account.address);
  const manual = new ManualSettlement({ chain, account, path: process.env.DEALER_SETTLEMENT_TX_PATH ?? 'data/settlement-transactions.json' });
  let result;
  if (command === 'status') result = settlementStatus(await chain.snapshot(), config);
  else if (command === 'evaluate') result = await evaluateNow(config, chain);
  else if (command === 'reconcile') result = await manual.reconcile();
  else if (command === 'rebroadcast') {
    if (!values.execute) throw new SettlementError('REBROADCAST_REQUIRES_EXECUTE');
    result = await manual.rebroadcast();
  } else {
    if (!values.vault || (command === 'exercise' && !values.position)) throw new SettlementError('MISSING_TARGET');
    const action = command === 'exercise' ? { kind: command, vault: values.vault, positionId: values.position }
      : { kind: command, vault: values.vault, asset: values.asset, amount: values.amount };
    result = values.execute ? await manual.execute(action) : { status: 'preview', plan: await manual.plan(action) };
  }
  console.log(JSON.stringify(result, null, 2));
  if (['blocked', 'broadcast_uncertain', 'nonce_consumed_needs_review'].includes(result.status)) process.exitCode = 2;
}
// Read-only preview of the automatic rule on the live oracle price; nothing is signed.
async function evaluateNow(config, chain) {
  const s = config.autoExercise;
  const price = new HyperliquidPrice({ url: s.hyperliquidUrl, dex: s.hyperliquidDex, timeoutMs: s.priceTimeoutMs });
  const windows = windowsOf(await chain.snapshot(), Math.floor(Date.now() / 1000));
  const samples = new Map(), rates = new Map(), out = [];
  for (const window of windows) {
    for (const p of window.positions) {
      const coin = s.coins[p.symbol];
      if (!coin) { out.push({ vault: p.vault, positionId: p.id, issue: 'NO_PRICE_SOURCE' }); continue; }
      if (!samples.has(coin)) samples.set(coin, await price.sample(coin));
      if (!rates.has(p.wrappedStock)) rates.set(p.wrappedStock, await chain.read(p.wrappedStock, settlementTokenAbi, 'convertToAssets', [10n ** 18n]));
      const sample = samples.get(coin), rate = rates.get(p.wrappedStock);
      const e = evaluate(p, rate, sample.oracleMicros, s.minEdgeBps);
      out.push({ vault: p.vault, positionId: p.id, seriesId: p.seriesId, side: e.side, window: { start: window.start, end: window.end },
        coin, oraclePx: sample.oraclePx, midPx: sample.midPx, rate: String(rate), strikeAmountUSDG: p.strikeAmountUSDG,
        notionalUSDG: String(e.notional), intrinsicUSDG: String(e.intrinsic), edgeBps: String(e.edgeBps), wouldExercise: e.exercise });
    }
  }
  return { mode: !s.enabled ? 'manual' : s.dryRun ? 'automatic_dry_run' : 'automatic', minEdgeBps: s.minEdgeBps, evaluatedAt: new Date().toISOString(), positions: out };
}
main().catch(error => {
  // Never emit RPC errors, environment values or raw signed transactions.
  console.error(JSON.stringify({ error: error instanceof SettlementError ? error.code : 'SETTLEMENT_COMMAND_FAILED' })); process.exitCode = 1;
});
