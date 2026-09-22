import { z } from 'zod';
import deployment from '../../../config/xlayer-testnet.json';
export const runtimeSchema = z
  .object({
    mode: z.enum(['demo', 'testnet', 'gateway']),
    chainId: z.literal(1952),
    rpcUrl: z.url(),
    explorerUrl: z.url(),
    gatewayUrl: z.string(),
    nvdaVault: z.string(),
    deploymentBlock: z.string().regex(/^\d+$/).default(deployment.deploymentBlock),
  })
  .superRefine((c, ctx) => {
    if (c.mode === 'testnet' && c.nvdaVault.toLowerCase() !== deployment.markets[0].vault.toLowerCase())
      ctx.addIssue({
        code: 'custom',
        message: 'Testnet mode must use the Vault in config/xlayer-testnet.json.',
      });
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
    mode: process.env.NEXT_PUBLIC_DATA_MODE ?? 'gateway',
    chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 1952),
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? deployment.rpcUrl,
    explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? deployment.explorerUrl,
    gatewayUrl: (process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'https://api.payoff.finance').replace(/\/$/, ''),
    nvdaVault: process.env.NEXT_PUBLIC_NVDA_VAULT || deployment.markets[0].vault,
    deploymentBlock: process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK ?? deployment.deploymentBlock,
  });
}
export type Config = ReturnType<typeof getConfig>;
