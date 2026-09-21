import { getAddress, type Address, type EIP1193Provider } from 'viem';
import type { Config } from './config';
import { UserFacingError } from './errors';

export type WalletProvider = EIP1193Provider & {
  on?: (event: string, fn: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, fn: (...args: unknown[]) => void) => void;
};
export type WalletOption = { id: string; name: string; provider: WalletProvider };
export type Connection =
  | { kind: 'demo'; address: Address; chainId: 1952 }
  | { kind: 'wallet'; address: Address; chainId: number; name: string; provider: WalletProvider };
export function discoverWallets(callback: (wallets: WalletOption[]) => void) {
  const wallets = new Map<string, WalletOption>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<{ info: { uuid: string; name: string }; provider: WalletProvider }>)
      .detail;
    if (typeof detail?.provider?.request === 'function' && detail.info?.uuid) {
      wallets.set(detail.info.uuid, {
        id: detail.info.uuid,
        name: detail.info.name,
        provider: detail.provider,
      });
      callback([...wallets.values()]);
    }
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const injected = (window as unknown as { ethereum?: WalletProvider }).ethereum;
  if (injected && !wallets.size) {
    wallets.set('injected', { id: 'injected', name: 'Browser wallet', provider: injected });
    callback([...wallets.values()]);
  }
  return () => window.removeEventListener('eip6963:announceProvider', announce);
}
export async function connectWallet(option: WalletOption): Promise<Connection> {
  const accounts = await option.provider.request({ method: 'eth_requestAccounts' });
  if (!accounts[0]) throw new UserFacingError('The wallet did not return an available account.');
  const chainId = Number(await option.provider.request({ method: 'eth_chainId' }));
  return {
    kind: 'wallet',
    address: getAddress(accounts[0]),
    chainId,
    name: option.name,
    provider: option.provider,
  };
}
export async function switchNetwork(provider: WalletProvider, config: Config) {
  const chainId = `0x${config.chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: 'X Layer Testnet',
          nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
          rpcUrls: [config.rpcUrl],
          blockExplorerUrls: [config.explorerUrl],
        },
      ],
    });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
}
export function friendlyError(error: unknown) {
  if (error instanceof UserFacingError) return error.message;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 4001)
    return 'You cancelled the wallet request. Try again when you are ready.';
  if (error instanceof Error) {
    if (/User rejected|user denied/i.test(error.message))
      return 'You cancelled the wallet request. Try again when you are ready.';
    if (/fetch|network|timeout|aborted/i.test(error.message))
      return 'The network request did not complete. Check your connection and try again.';
  }
  // Unknown provider and server errors can contain RPC URLs, encoded calls or stack traces.
  return 'The action did not complete. Please try again later.';
}
