import { readFile } from 'node:fs/promises';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { z } from 'zod';

const address = z.string().refine(v => isAddress(v, { strict: false }) && v.toLowerCase() !== zeroAddress)
  .transform(v => getAddress(v.toLowerCase()));
export const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) < 2n ** 256n);
export const configSchema = z.strictObject({
  chainId: z.number().int().positive(), exchange: address, usdg: address,
  markets: z.array(z.strictObject({
    vault: address, stock: address, wrappedStock: address, symbol: z.string().regex(/^[A-Z]{1,10}$/),
    seriesIds: z.array(uint).min(1),
    referenceStrikes: z.record(uint, uint.refine(v => BigInt(v) > 0n)).optional(),
  })).min(1),
  premiumBps: z.number().int().min(1).max(10000).default(5000),
  premiumBasis: z.enum(['net', 'gross']).default('net'),
  quoteTtlSeconds: z.number().int().min(5).max(120).default(30),
  maxQuoteAgeSeconds: z.number().int().min(5).max(120).default(30),
  maxBlockAgeSeconds: z.number().int().positive().default(60),
  rpcTimeoutMs: z.number().int().positive().default(5000),
  dataTimeoutMs: z.number().int().min(500).max(30000).default(7000),
  catalogUrl: z.url().default('https://www.payoff.finance/catalog.json'),
  catalogRefreshMs: z.number().int().positive().default(300000),
  referenceIntervalMs: z.number().int().positive().default(30000),
  settlementIntervalMs: z.number().int().min(1000).default(60000),
  settlementWarningSeconds: z.number().int().positive().default(86400),
  settlementConfirmations: z.number().int().min(1).max(20).default(2),
  settlementMinGasWei: uint.default('100000000000000'),
  // Automatic exercise decides on the Hyperliquid perpetual oracle price near the end
  // of each exercise window. Disabled and dry-run by default: an absent block keeps
  // settlement manual.
  autoExercise: z.strictObject({
    enabled: z.boolean().default(false),
    dryRun: z.boolean().default(true),
    coins: z.record(z.string().regex(/^[A-Z]{1,10}$/), z.string().min(1).max(40)).default({}),
    hyperliquidUrl: z.url().default('https://api.hyperliquid.xyz/info'),
    hyperliquidDex: z.string().max(20).default('xyz'),
    priceTimeoutMs: z.number().int().min(500).max(30000).default(5000),
    pollMs: z.number().int().min(2000).max(60000).default(10000),
    oracleMidBandBps: z.number().int().min(1).max(10000).default(100),
    oracleUnchangedPolls: z.number().int().min(2).max(100).default(6),
    minEdgeBps: z.number().int().min(0).max(10000).default(0),
    decideBeforeEndSeconds: z.number().int().min(60).max(1800).default(300),
    submitCutoffSeconds: z.number().int().min(30).max(600).default(60),
    idlePollMs: z.number().int().min(10000).default(300000),
    skipDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  }).prefault({}),
}).superRefine((c, ctx) => {
  if (new Set(c.markets.map(m => m.vault.toLowerCase())).size !== c.markets.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate Vault.' });
  for (const market of c.markets) {
    if (Object.keys(market.referenceStrikes ?? {}).some(id => !market.seriesIds.includes(id)))
      ctx.addIssue({ code: 'custom', message: 'Reference strikes must belong to listed series.' });
    if (c.autoExercise.enabled && !c.autoExercise.coins[market.symbol])
      ctx.addIssue({ code: 'custom', message: `Automatic exercise needs a Hyperliquid coin for ${market.symbol}.` });
  }
  if (c.autoExercise.decideBeforeEndSeconds <= c.autoExercise.submitCutoffSeconds)
    ctx.addIssue({ code: 'custom', message: 'Decision time must precede the submit cutoff.' });
});
export async function loadConfig() {
  const config = configSchema.parse(JSON.parse(await readFile(process.env.DEALER_CONFIG_PATH ?? 'config.local.json', 'utf8')));
  const privateKey = process.env.DEALER_PRIVATE_KEY;
  const token = process.env.SELF_DEALER_API_TOKEN;
  const rpcUrl = process.env.XLAYER_RPC_URL;
  if (!/^0x[\da-fA-F]{64}$/.test(privateKey ?? '') || !token || token.length < 32 || !rpcUrl || !process.env.THETADATA_API_KEY)
    throw new Error('Missing dealer configuration or credentials.');
  return { config, privateKey, token, rpcUrl };
}
