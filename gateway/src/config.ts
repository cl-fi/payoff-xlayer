import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { address, uint } from './types.js';

const dealerSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), name: z.string().min(1).max(100), address,
  url: z.url(), enabled: z.boolean().default(true), source: z.enum(['live', 'test']).default('live'),
  bearerTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(), allowHttp: z.boolean().default(false),
}).superRefine((d, ctx) => {
  const u = new URL(d.url);
  if (u.username || u.password || u.hash || u.search || (u.protocol !== 'https:' && !(d.allowHttp && u.protocol === 'http:'))) {
    ctx.addIssue({ code: 'custom', message: 'Dealer URL must use HTTPS (explicit allowHttp for a trusted internal network), with no credentials, query or fragment.' });
  }
});
export type Dealer = z.infer<typeof dealerSchema>;
export const configSchema = z.strictObject({
  chainId: z.number().int().positive(), exchange: address, usdg: address,
  rpcUrlEnv: z.string().default('XLAYER_RPC_URL'),
  markets: z.array(z.strictObject({ vault: address, seriesIds: z.array(uint(256, true)).min(1) })),
  dealers: z.array(dealerSchema), allowedOrigins: z.array(z.url()).default([]),
  trustedProxies: z.array(z.string()).default([]),
  collectMs: z.number().int().min(10).max(60000).default(800),
  rpcTimeoutMs: z.number().int().min(100).max(60000).default(3000),
  requestTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
  maxBlockAgeSeconds: z.number().int().positive().default(60),
  confirmations: z.number().int().positive().default(2),
  requestsPerMinute: z.number().int().positive().default(60),
  maxConcurrentRfqs: z.number().int().positive().default(32),
}).superRefine((c, ctx) => {
  for (const values of [c.dealers.map(d => d.id), c.dealers.map(d => d.address.toLowerCase()), c.markets.map(m => m.vault.toLowerCase())]) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'Duplicate dealer ID/address or market Vault.' });
  }
  if (c.collectMs >= c.requestTimeoutMs) ctx.addIssue({ code: 'custom', message: 'Collection timeout must be shorter than the whole RFQ timeout.' });
});
export type Config = z.infer<typeof configSchema>;
export type Runtime = { config: Config; rpcUrl: string; databaseUrl: string; dealerTokens: Map<string, string> };
export async function loadRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const config = configSchema.parse(JSON.parse(await readFile(env.GATEWAY_CONFIG_PATH ?? 'config.local.json', 'utf8')));
  const rpcUrl = env[config.rpcUrlEnv];
  const databaseUrl = env.DATABASE_URL;
  if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) throw new Error(`Set ${config.rpcUrlEnv} to an HTTP RPC endpoint.`);
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('Set DATABASE_URL to PostgreSQL.');
  const dealerTokens = new Map<string, string>();
  for (const d of config.dealers.filter(d => d.enabled)) {
    if (env.NODE_ENV === 'production' && d.source === 'test') throw new Error('Test dealers are forbidden in production.');
    if (d.bearerTokenEnv) {
      const value = env[d.bearerTokenEnv];
      if (!value) throw new Error(`Missing credential environment variable for dealer ${d.id}.`);
      dealerTokens.set(d.id, value);
    }
  }
  return { config, rpcUrl, databaseUrl, dealerTokens };
}
