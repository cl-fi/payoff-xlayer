import type { Address } from 'viem';
import deployment from '../../../../config/xlayer-testnet.json';
import { UserFacingError } from '../errors';
import { publicClient, readBalances } from '../chain';
import { readOnchainMarket } from './onchain';
import type { Config } from '../config';
import type { AppQuote, Market, Preview, ProductAdapter } from '../types';

export const QUOTES_UNAVAILABLE =
  'The quote service is not connected yet. You can explore onchain series and view your wallet balances. Trading is unavailable.';

/** Public addresses and discovery IDs only. All financial terms and rates come from the RPC. */
export class TestnetAdapter implements ProductAdapter {
  readonly mode = 'testnet' as const;
  constructor(
    readonly config: Config,
    private client = publicClient(config),
  ) {}
  market(): Promise<Market> {
    return readOnchainMarket(this.config, deployment, this.client, deployment);
  }
  balances(account: Address, market: Market, vault: Address) {
    return readBalances(this.config, account, market, vault, this.client);
  }
  async quote(_preview: Preview, _key: string): Promise<null> {
    throw new UserFacingError(QUOTES_UNAVAILABLE);
  }
  async prepare(_quote: AppQuote): Promise<never> {
    throw new UserFacingError(QUOTES_UNAVAILABLE);
  }
}
