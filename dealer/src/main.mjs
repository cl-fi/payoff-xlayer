import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from './config.mjs';
import { DealerChain } from './chain.mjs';
import { ThetaProvider } from './theta.mjs';
import { LastValidBidProvider } from './market.mjs';
import { buildDealerApp } from './app.mjs';
import { ReferenceService } from './reference.mjs';
import { SettlementChain } from './settlement-chain.mjs';
import { SettlementMonitor } from './settlement.mjs';
import { ManualSettlement } from './settlement-manual.mjs';
import { HyperliquidPrice } from './hyperliquid.mjs';
import { AutoExercise } from './auto-exercise.mjs';

async function main() {
  const { config, privateKey, token, rpcUrl } = await loadConfig();
  const account = privateKeyToAccount(privateKey);
  const chain = new DealerChain(config, rpcUrl, account.address);
  await chain.health();
  const upstream = new ThetaProvider({ timeoutMs: config.dataTimeoutMs });
  let provider;
  try { provider = await LastValidBidProvider.open(upstream, process.env.DEALER_BID_CACHE_PATH ?? 'data/last-valid-bids.json'); }
  catch (error) { upstream.close(); throw error; }
  const reference = new ReferenceService({ config, chain, provider,
    catalogPath: process.env.DEALER_CATALOG_PATH ?? '/var/lib/payoff-dealer/catalog.json',
    bundledPath: new URL('../../web/public/catalog.json', import.meta.url) });
  const settlementChain = new SettlementChain(config, rpcUrl, account.address);
  const settlement = new SettlementMonitor({ config, chain: settlementChain,
    path: process.env.DEALER_SETTLEMENT_PATH ?? '/var/lib/payoff-dealer/settlement.json' });
  // Same journal path as the CLI: the PID lock serializes operator commands and the runner.
  const autoExercise = new AutoExercise({ config, chain: settlementChain,
    manual: new ManualSettlement({ chain: settlementChain, account, path: process.env.DEALER_SETTLEMENT_TX_PATH ?? 'data/settlement-transactions.json' }),
    price: new HyperliquidPrice({ url: config.autoExercise.hyperliquidUrl, dex: config.autoExercise.hyperliquidDex, timeoutMs: config.autoExercise.priceTimeoutMs }),
    path: process.env.DEALER_AUTO_EXERCISE_PATH ?? '/var/lib/payoff-dealer/auto-exercise.json' });
  const app = await buildDealerApp({ config, account, chain, provider, token, reference, settlement, autoExercise, logger: true });
  reference.log = data => app.log.info(data, 'reference pricing');
  settlement.log = data => data.event === 'settlement_scan_failed' || data.alerts?.length
    ? app.log.warn(data, 'manual settlement attention') : app.log.info(data, 'manual settlement status');
  autoExercise.log = data => data.alert ? app.log.warn(data, 'automatic exercise attention') : app.log.info(data, 'automatic exercise');
  app.addHook('onClose', async () => { await Promise.all([reference.stop(), settlement.stop(), autoExercise.stop()]); await provider.close(); });
  reference.start();
  await settlement.start();
  await autoExercise.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  try { await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8081) }); }
  catch (error) { await app.close(); throw error; }
}
main().catch(() => { console.error('Dealer startup failed. Check configuration, credentials and on-chain admission.'); process.exitCode = 1; });
