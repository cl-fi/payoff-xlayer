import { parseUnits } from 'viem';
import { UserFacingError } from './errors';

export type FaucetAsset = 'usdg' | 'stock';

export function parseFaucetAmount(input: string, asset: FaucetAsset = 'usdg') {
  const decimals = asset === 'stock' ? 18 : 6;
  if (!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${decimals}})?$`).test(input))
    throw new UserFacingError(`Enter an amount greater than 0, with up to ${decimals} decimal places.`);
  const amount = parseUnits(input, decimals);
  if (amount <= 0n || amount >= 2n ** 256n) throw new UserFacingError('Enter a valid test token amount.');
  return amount;
}
