import { z } from 'zod';
export const runtimeSchema = z
  .object({
    mode: z.enum(['demo', 'gateway']),
    chainId: z.literal(1952),
    rpcUrl: z.url(),
    explorerUrl: z.url(),
    gatewayUrl: z.string(),
    nvdaVault: z.string(),
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'gateway') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(c.nvdaVault))
        ctx.addIssue({
          code: 'custom',
          message: 'Set NEXT_PUBLIC_NVDA_VAULT to the Vault for the NVDAx product.',
        });
      try {
        const url = new URL(c.gatewayUrl);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Gateway mode requires a valid NEXT_PUBLIC_GATEWAY_URL.' });
      }
    }
  });
export function getConfig() {
  return runtimeSchema.parse({
    mode: process.env.NEXT_PUBLIC_DATA_MODE ?? 'demo',
    chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 1952),
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? 'https://testrpc.xlayer.tech/terigon',
    explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://www.okx.com/web3/explorer/xlayer-test',
    gatewayUrl: (process.env.NEXT_PUBLIC_GATEWAY_URL ?? '').replace(/\/$/, ''),
    nvdaVault: process.env.NEXT_PUBLIC_NVDA_VAULT ?? '',
  });
}
export type Config = ReturnType<typeof getConfig>;
