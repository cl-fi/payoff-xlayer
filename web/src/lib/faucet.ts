import { parseUnits } from 'viem';
import { UserFacingError } from './errors';

export function parseFaucetAmount(input: string) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(input))
    throw new UserFacingError('Enter an amount greater than 0, with up to 6 decimal places.');
  const amount = parseUnits(input, 6);
  if (amount <= 0n || amount >= 2n ** 256n) throw new UserFacingError('Enter a valid test token amount.');
  return amount;
}
