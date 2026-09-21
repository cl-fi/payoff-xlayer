import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { configSchema, type Config, type Dealer } from '../src/config.js';
import { Store, type Sql } from '../src/store.js';
import type { Chain } from '../src/chain.js';
import type { DealerRequest, Order, SignedQuote, Snapshot } from '../src/types.js';
import { signQuote } from '../../sdk/quotes.mjs';

// Public deterministic test keys. Never use these accounts for real assets.
export const makerA = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
export const makerB = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
export const user = privateKeyToAccount(`0x${'3'.padStart(64, '0')}`);
export const exchange = '0x0000000000000000000000000000000000000010' as const;
export const usdg = '0x0000000000000000000000000000000000000020' as const;
export const vault = '0x0000000000000000000000000000000000000030' as const;
export const order: Order = { taker: user.address, vault, seriesId: '1', wrappedQuantity: '1000000000000000000' };
export function config(dealers: Dealer[] = []): Config {
  return configSchema.parse({ chainId: 196, exchange, usdg, markets: [{ vault, seriesIds: ['1', '2'] }], dealers,
    collectMs: 250, requestTimeoutMs: 5000, allowedOrigins: ['https://payoff.example'], confirmations: 1 });
}
export const fakeChain = (): Chain => ({
  health: async () => {},
  snapshot: async (_order): Promise<Snapshot> => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return { blockNumber: '10', blockHash: `0x${'00'.repeat(32)}`, timestamp: now.toString(), usdg,
      wrappedStock: '0x0000000000000000000000000000000000000040', stock: '0x0000000000000000000000000000000000000050',
      feeBps: 100, strikeAmountUSDG: '180000000', terms: { side: _order.seriesId === '2' ? 1 : 0,
        strikePricePerWrappedUSDG: '180000000', tradeCutoff: (now + 500n).toString(), exerciseStart: (now + 600n).toString(), exerciseEnd: (now + 700n).toString() } };
  },
  takerReady: async () => {}, validate: async () => ({ blockNumber: '11' }),
  settlement: async (_selection, transactionHash) => ({ transactionHash, status: 'pending', confirmations: 0 }),
});
export async function db() {
  if (process.env.TEST_DATABASE_URL) {
    const namespace = `gateway_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${namespace}` });
    const store = new Store(pool); await store.migrate();
    return { store, sql: pool as Sql, close: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${namespace} CASCADE`); await admin.end(); } };
  }
  // Runs the same SQL against PostgreSQL compiled to WASM when a native test server is unavailable.
  const engine = new PGlite();
  const sql: Sql = { query: async (text, params) => {
    if (!params && text.includes('CREATE TABLE')) { await engine.exec(text); return { rows: [] }; }
    return engine.query(text, params);
  } };
  const store = new Store(sql); await store.migrate();
  return { store, sql, close: () => engine.close() };
}
export async function dealerServer(handler: (request: DealerRequest, response: ServerResponse, authorization?: string) => Promise<void> | void) {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await handler(JSON.parse(Buffer.concat(chunks).toString()), res, req.headers.authorization);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/quote`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export function dealer(id: string, url: string, account = makerA): Dealer {
  return { id, name: `TEST ONLY ${id}`, address: account.address, url, allowHttp: true, enabled: true, source: 'test' };
}
export async function signed(request: DealerRequest, gross = '2000000', account = makerA, overrides: Record<string, string> = {}): Promise<SignedQuote> {
  const fee = BigInt(gross) * BigInt(request.snapshot.feeBps) / 10000n;
  const quote = { ...request.order, requestId: request.requestId, dealer: account.address, strikeAmountUSDG: request.snapshot.strikeAmountUSDG,
    grossPremiumUSDG: gross, protocolFeeUSDG: fee.toString(), netPremiumUSDG: (BigInt(gross) - fee).toString(),
    issuedAt: request.snapshot.timestamp, deadline: (BigInt(request.snapshot.timestamp) + 60n).toString(),
    nonce: BigInt(`0x${randomUUID().replaceAll('-', '')}`).toString(), ...overrides };
  return { quote, signature: await signQuote(account, request.chainId, request.exchange, quote) };
}
export function json(response: ServerResponse, body: unknown) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
export const txHash = `0x${'ab'.repeat(32)}` as Hex;
