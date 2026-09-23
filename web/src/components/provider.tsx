'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getAddress, type Address } from 'viem';
import { getConfig, type Config } from '@/lib/config';
import { DEMO_ACCOUNT, DemoAdapter, STORAGE_PREFIX, initialDemoState } from '@/lib/data/demo';
import { GatewayAdapter } from '@/lib/data/gateway';
import { TestnetAdapter } from '@/lib/data/testnet';
import { staticMarket } from '@/lib/data/catalog';
import type { ReferenceSnapshot } from '../../../sdk/catalog.mjs';
import type { Balances, Market, Position, ProductAdapter, Scenario } from '@/lib/types';
import {
  connectWallet,
  discoverWallets,
  friendlyError,
  switchNetwork,
  type Connection,
  type WalletOption,
} from '@/lib/wallet';
import { readPositions } from '@/lib/data/positions';
import { readActivity, recoverActivity, type Activity } from '@/lib/activity';
import { shortAddress } from '@/lib/amounts';
import { Modal } from './modal';
import { Icon } from './icon';

type ContextValue = {
  config: Config;
  adapter: ProductAdapter | null;
  market: Market | null;
  balances: Balances | null;
  positions: Position[];
  positionsError: string;
  positionsLoading: boolean;
  balancesError: string;
  references: ReferenceSnapshot | null;
  referenceError: string;
  activity: Activity[];
  connection: Connection | null;
  loading: boolean;
  error: string;
  setError: (value: string) => void;
  walletOpen: boolean;
  setWalletOpen: (value: boolean) => void;
  reload: () => Promise<void>;
  disconnect: () => void;
  scenario: Scenario;
  setScenario: (value: Scenario) => void;
  resetDemo: () => Promise<void>;
  revision: number;
};
const Context = createContext<ContextValue | null>(null);
export function useProduct() {
  const context = useContext(Context);
  if (!context) throw new Error('Missing product provider');
  return context;
}
export function AppProvider({ children }: { children: ReactNode }) {
  const [config] = useState(getConfig);
  const [adapter, setAdapter] = useState<ProductAdapter | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [market, setMarket] = useState<Market | null>(() =>
      config.mode === 'gateway' ? staticMarket(config) : null,
    ),
    [balances, setBalances] = useState<Balances | null>(null),
    [positions, setPositions] = useState<Position[]>([]);
  const [positionsError, setPositionsError] = useState('');
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [balancesError, setBalancesError] = useState('');
  const [references, setReferences] = useState<ReferenceSnapshot | null>(null);
  const [referenceError, setReferenceError] = useState('');
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [walletOpen, setWalletOpen] = useState(false);
  const [wallets, setWallets] = useState<WalletOption[]>([]),
    [connecting, setConnecting] = useState(false),
    [walletError, setWalletError] = useState('');
  const [scenario, setScenario] = useState<Scenario>('normal'),
    [revision, setRevision] = useState(0);
  const request = useRef(0),
    generation = useRef(0),
    currentAccount = connection?.address ?? DEMO_ACCOUNT;
  useEffect(() => discoverWallets(setWallets), []);
  useEffect(() => {
    if (config.mode === 'demo' && localStorage.getItem('payoff.demo.connected') === 'yes')
      setConnection({ kind: 'demo', address: DEMO_ACCOUNT, chainId: 1952 });
  }, [config.mode]);
  useEffect(() => {
    generation.current++;
    setAdapter(
      config.mode === 'demo'
        ? new DemoAdapter(localStorage, currentAccount)
        : config.mode === 'testnet'
          ? new TestnetAdapter(config)
          : new GatewayAdapter(config),
    );
    if (config.mode !== 'gateway') setMarket(null);
  }, [config, config.mode === 'demo' ? currentAccount : null]);
  useEffect(() => {
    generation.current++;
    setBalances(null);
    setBalancesError('');
    setPositions([]);
    setPositionsError('');
    setActivity([]);
    setError('');
    setRevision((v) => v + 1);
  }, [config, connection]);
  useEffect(() => {
    if (!(adapter instanceof GatewayAdapter)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const snapshot = await adapter.references();
        if (cancelled) return;
        setReferences(snapshot);
        setReferenceError('');
        const input = snapshot.markets.find((m) => m.vault.toLowerCase() === config.nvdaVault.toLowerCase());
        if (input)
          setMarket((m) =>
            m ? { ...m, rate: input.rate, feeBps: input.feeBps, blockNumber: input.blockNumber } : m,
          );
      } catch {
        if (!cancelled) setReferenceError('Reference updates are temporarily unavailable.');
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 30000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [adapter, config]);
  const reload = useCallback(async () => {
    if (
      !adapter ||
      (adapter instanceof DemoAdapter &&
        adapter.account.toLowerCase() !== (connection?.address ?? DEMO_ACCOUNT).toLowerCase())
    )
      return;
    const req = ++request.current;
    const gen = generation.current;
    const current = () => gen === generation.current && req === request.current;
    setLoading(true);
    try {
      const m = await adapter.market();
      if (!current()) return;
      setMarket((previous) =>
        adapter instanceof GatewayAdapter && previous
          ? { ...m, rate: previous.rate, feeBps: previous.feeBps, blockNumber: previous.blockNumber }
          : m,
      );
      setLoading(false);
      setError('');
      if (connection && adapter instanceof DemoAdapter) setPositions(adapter.state().positions);
      if (connection && adapter instanceof GatewayAdapter) {
        setPositionsLoading(true);
        // History and receipt recovery must never delay catalog, balances or the trade dialog.
        void readPositions(config, connection.address, m)
          .then((p) => {
            if (current()) {
              setPositions(p);
              setPositionsError('');
            }
          })
          .catch(() => {
            if (current())
              setPositionsError('Position history could not be loaded from the chain. Refresh to try again.');
          })
          .finally(() => {
            if (current()) setPositionsLoading(false);
          });
        void recoverActivity(localStorage, config, connection.address)
          .then((transactions) => {
            if (current()) setActivity(transactions);
          })
          .catch(() => {
            if (current())
              setError(
                'Saved transaction status could not be read. Check your wallet activity before trading.',
              );
          });
      } else setPositionsLoading(false);
      try {
        const b =
          connection && m.series[0] ? await adapter.balances(connection.address, m, m.series[0].vault) : null;
        if (current()) {
          setBalances(b);
          setBalancesError('');
        }
      } catch {
        if (current()) {
          setBalances(null);
          setBalancesError('Wallet balances could not be loaded. Refresh to try again.');
        }
      }
    } catch (e) {
      if (gen === generation.current && req === request.current) {
        setError(friendlyError(e));
        setMarket(null);
        setBalances(null);
        setPositions([]);
      }
    } finally {
      if (gen === generation.current && req === request.current) setLoading(false);
    }
  }, [adapter, connection, config]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (config.mode !== 'gateway' || !connection) return;
    const update = () => {
      try {
        setActivity(readActivity(localStorage, config, connection.address));
      } catch {
        setError('Saved transaction status could not be read. Check your wallet activity before trading.');
      }
    };
    update();
    window.addEventListener('payoff:transactions', update);
    return () => window.removeEventListener('payoff:transactions', update);
  }, [config, connection?.address]);
  useEffect(() => {
    const listener = () => {
      void reload();
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, [reload]);
  useEffect(() => {
    if (connection?.kind !== 'wallet') return;
    const provider = connection.provider;
    const changed = (accounts: unknown) => {
      generation.current++;
      setRevision((v) => v + 1);
      if (!Array.isArray(accounts) || !accounts[0]) setConnection(null);
      else {
        try {
          setConnection((c) =>
            c?.kind === 'wallet' ? { ...c, address: getAddress(String(accounts[0])) } : c,
          );
        } catch {
          setConnection(null);
        }
      }
    };
    const chainChanged = (id: unknown) => {
      generation.current++;
      setRevision((v) => v + 1);
      setConnection((c) => (c?.kind === 'wallet' ? { ...c, chainId: Number(id) } : c));
    };
    const disconnected = () => {
      generation.current++;
      setRevision((v) => v + 1);
      setConnection(null);
    };
    provider.on?.('accountsChanged', changed);
    provider.on?.('chainChanged', chainChanged);
    provider.on?.('disconnect', disconnected);
    return () => {
      provider.removeListener?.('accountsChanged', changed);
      provider.removeListener?.('chainChanged', chainChanged);
      provider.removeListener?.('disconnect', disconnected);
    };
  }, [connection?.kind === 'wallet' ? connection.provider : null]);
  const disconnect = () => {
    generation.current++;
    localStorage.removeItem('payoff.demo.connected');
    setConnection(null);
    setWalletOpen(false);
    setRevision((v) => v + 1);
  };
  const resetDemo = async () => {
    if (config.mode !== 'demo') return;
    localStorage.setItem(STORAGE_PREFIX + currentAccount.toLowerCase(), JSON.stringify(initialDemoState()));
    setScenario('normal');
    setRevision((v) => v + 1);
    await reload();
  };
  const demoConnect = () => {
    localStorage.setItem('payoff.demo.connected', 'yes');
    setConnection({ kind: 'demo', address: DEMO_ACCOUNT, chainId: 1952 });
    setWalletOpen(false);
    setWalletError('');
  };
  const realConnect = async (option: WalletOption) => {
    setConnecting(true);
    setWalletError('');
    try {
      const result = await connectWallet(option);
      localStorage.removeItem('payoff.demo.connected');
      setConnection(result);
      setWalletOpen(false);
    } catch (e) {
      setWalletError(friendlyError(e));
    } finally {
      setConnecting(false);
    }
  };
  const value = useMemo(
    () => ({
      config,
      adapter,
      market,
      balances,
      positions,
      positionsError,
      positionsLoading,
      balancesError,
      references,
      referenceError,
      activity,
      connection,
      loading,
      error,
      setError,
      walletOpen,
      setWalletOpen,
      reload,
      disconnect,
      scenario,
      setScenario,
      resetDemo,
      revision,
    }),
    [
      config,
      adapter,
      market,
      balances,
      positions,
      positionsError,
      positionsLoading,
      balancesError,
      references,
      referenceError,
      activity,
      connection,
      loading,
      error,
      walletOpen,
      reload,
      scenario,
      revision,
    ],
  );
  return (
    <Context.Provider value={value}>
      {children}
      <Modal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        title={connection ? 'Your account' : 'Get started'}
        eyebrow="Your wallet"
      >
        {connection ? (
          <>
            <div className="wallet-card">
              <Icon name="wallet" size={28} />
              <div>
                <strong>
                  {connection.kind === 'demo' ? 'Demo account' : shortAddress(connection.address)}
                </strong>
                <p>
                  {connection.kind === 'demo'
                    ? 'Stored in this browser only. No real assets.'
                    : `${connection.name} · Chain ${connection.chainId}`}
                </p>
              </div>
            </div>
            {connection.kind === 'wallet' && connection.chainId !== config.chainId && (
              <button
                className="button primary full"
                onClick={async () => {
                  try {
                    await switchNetwork(connection.provider, config);
                  } catch (e) {
                    setWalletError(friendlyError(e));
                  }
                }}
              >
                Switch to X Layer Testnet
              </button>
            )}
            <button className="button secondary full" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            <p className="muted modal-intro">
              {config.mode === 'demo'
                ? 'Try the full flow with a demo account. No deposit or wallet signature needed.'
                : 'Connect your wallet to use X Layer Testnet.'}
            </p>
            {config.mode === 'demo' && (
              <button className="wallet-option featured" onClick={demoConnect}>
                <span className="option-icon">
                  <Icon name="layers" size={24} />
                </span>
                <span>
                  <strong>Use demo account</strong>
                  <small>10,000 demo USDG · 8 demo NVDAx</small>
                </span>
                <Icon name="arrow" />
              </button>
            )}
            <div className="section-divider">
              {config.mode === 'demo' ? 'Or connect your wallet' : 'Choose your wallet'}
            </div>
            {wallets.map((w) => (
              <button
                key={w.id}
                className="wallet-option"
                disabled={connecting}
                onClick={() => void realConnect(w)}
              >
                <Icon name="wallet" size={23} />
                <strong>{w.name}</strong>
                <Icon name="chevron" size={16} />
              </button>
            ))}
            {!wallets.length && (
              <div className="notice">
                No browser wallet detected. Open this page in a browser with OKX Wallet or MetaMask installed.
              </div>
            )}
            {config.mode === 'demo' && (
              <p className="fine-print">
                Even with a real wallet connected, this demo uses simulated assets and never requests
                signatures or sends transactions.
              </p>
            )}
          </>
        )}
        {walletError && (
          <div role="alert" className="notice error">
            {walletError}
          </div>
        )}
      </Modal>
    </Context.Provider>
  );
}
