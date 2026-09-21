import { loadRuntime } from './config.js';
import { RpcChain } from './chain.js';
import { Gateway } from './gateway.js';
import { buildApp } from './app.js';
import { database } from './database.js';

async function main() {
  const runtime = await loadRuntime();
  const { pool, store } = database(runtime.databaseUrl);
  const gateway = new Gateway(runtime.config, new RpcChain(runtime.config, runtime.rpcUrl), store, runtime.dealerTokens);
  const app = await buildApp(gateway, true);
  app.addHook('onClose', async () => { await pool.end(); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  try {
    await store.health();
    await gateway.chain.health();
    await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8080) });
  } catch (error) { await app.close(); throw error; }
}
main().catch(() => { console.error('Gateway startup failed. Check configuration, required environment variables, and database migrations.'); process.exitCode = 1; });
