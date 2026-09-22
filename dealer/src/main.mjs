import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from './config.mjs';
import { DealerChain } from './chain.mjs';
import { ThetaProvider } from './theta.mjs';
import { LastValidBidProvider } from './market.mjs';
import { buildDealerApp } from './app.mjs';

async function main() {
  const { config, privateKey, token, rpcUrl } = await loadConfig();
  const account = privateKeyToAccount(privateKey);
  const chain = new DealerChain(config, rpcUrl, account.address);
  await chain.health();
  const upstream = new ThetaProvider({ timeoutMs: config.dataTimeoutMs });
  let provider;
  try { provider = await LastValidBidProvider.open(upstream, process.env.DEALER_BID_CACHE_PATH ?? 'data/last-valid-bids.json'); }
  catch (error) { upstream.close(); throw error; }
  const app = await buildDealerApp({ config, account, chain, provider, token, logger: true });
  app.addHook('onClose', async () => provider.close());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  try { await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8081) }); }
  catch (error) { await app.close(); throw error; }
}
main().catch(() => { console.error('Dealer startup failed. Check configuration, credentials and on-chain admission.'); process.exitCode = 1; });
