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
  })).min(1),
  premiumBps: z.number().int().min(1).max(10000).default(5000),
  premiumBasis: z.enum(['net', 'gross']).default('net'),
  quoteTtlSeconds: z.number().int().min(5).max(120).default(30),
  maxQuoteAgeSeconds: z.number().int().min(5).max(120).default(30),
  maxBlockAgeSeconds: z.number().int().positive().default(60),
  rpcTimeoutMs: z.number().int().positive().default(5000),
  dataTimeoutMs: z.number().int().min(500).max(30000).default(7000),
}).superRefine((c, ctx) => {
  if (new Set(c.markets.map(m => m.vault.toLowerCase())).size !== c.markets.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate Vault.' });
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
