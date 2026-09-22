'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useProduct } from './provider';
import { TradingWallet } from '@/lib/transactions';
import { parseFaucetAmount, type FaucetAsset } from '@/lib/faucet';
import { amount, shortAddress } from '@/lib/amounts';
import { friendlyError } from '@/lib/wallet';

const assets = [
  { id: 'usdg', name: 'Payoff Test USDG', symbol: 'tUSDG', strategy: 'Buy Low', href: '/', decimals: 6 },
  {
    id: 'stock',
    name: 'Payoff Test NVIDIA',
    symbol: 'tNVDAx',
    strategy: 'Sell High',
    href: '/sell-high',
    decimals: 18,
  },
] as const;

export function FaucetPage() {
  const { config, market, balances, balancesError, connection, revision, reload, setWalletOpen } =
    useProduct();
  const [inputs, setInputs] = useState({ usdg: '10000', stock: '10' }),
    [busy, setBusy] = useState<FaucetAsset | null>(null),
    [messages, setMessages] = useState({ usdg: '', stock: '' });
  const generation = useRef(revision);
  generation.current = revision;
  useEffect(() => {
    setMessages({ usdg: '', stock: '' });
  }, [revision]);
  async function claim(asset: FaucetAsset) {
    if (!connection) {
      setWalletOpen(true);
      return;
    }
    if (!market || busy) return;
    const original = generation.current;
    const current = () => {
      if (original !== generation.current)
        throw new Error('Your wallet changed. Review the faucet request again.');
    };
    const message = (text: string) => {
      if (original === generation.current) setMessages((previous) => ({ ...previous, [asset]: text }));
    };
    setBusy(asset);
    message('');
    try {
      await new TradingWallet(config, connection, localStorage, message, current).faucet(
        market,
        parseFaucetAmount(inputs[asset], asset),
        asset,
      );
      message(
        asset === 'stock'
          ? 'Test NVIDIA received. Open Sell High to wrap your tokens and prepare an order.'
          : 'Test USDG received. You can now use it in Buy Low products.',
      );
    } catch (e) {
      message(friendlyError(e));
    } finally {
      setBusy(null);
      void reload();
    }
  }
  return (
    <div className="page positions-page">
      <section className="page-intro">
        <div>
          <div className="eyebrow">
            <span className="teal-line" /> TEST ASSETS
          </div>
          <h1>Get test tokens.</h1>
          <p>Get USDG for Buy Low, or NVIDIA test tokens for Sell High.</p>
        </div>
        <a
          className="button secondary"
          href="https://web3.okx.com/xlayer/faucet/xlayerfaucet"
          target="_blank"
          rel="noreferrer"
        >
          Get test OKB ↗
        </a>
      </section>
      <p className="test-asset-intro">
        These X Layer Testnet tokens have no monetary value. You need a little test OKB to pay network fees.
      </p>
      <div className="test-assets-grid">
        {assets.map((asset) => (
          <section
            key={asset.id}
            id={asset.id}
            className="test-asset-card"
            aria-label={`Test ${asset.id === 'stock' ? 'NVIDIA' : 'USDG'} faucet`}
          >
            <span className="eyebrow">FOR {asset.strategy.toUpperCase()}</span>
            <h2>
              {asset.name} <span className="muted">· {asset.symbol}</span>
            </h2>
            <p>
              {asset.id === 'stock'
                ? 'Receive tNVDAx to try Sell High. During asset preparation, the app wraps the needed amount into twNVDAx with your wallet confirmation.'
                : 'Mint tUSDG to try Buy Low. Deposit it at your target buying price and collect a premium upfront.'}
            </p>
            <p className="muted">No daily quota or waiting period.</p>
            <label htmlFor={`faucet-${asset.id}`}>Amount of {asset.symbol} to receive</label>
            <div className="quantity-input">
              <input
                id={`faucet-${asset.id}`}
                inputMode="decimal"
                value={inputs[asset.id]}
                onChange={(e) => setInputs((previous) => ({ ...previous, [asset.id]: e.target.value }))}
                disabled={!!busy}
              />
              <span>{asset.symbol}</span>
            </div>
            <p className="muted">
              Your balance:{' '}
              {connection && balances
                ? `${amount(balances[asset.id], asset.decimals, asset.id === 'stock' ? 4 : 2)} ${asset.symbol}`
                : connection
                  ? balancesError
                    ? 'Unavailable — refresh to retry'
                    : 'Loading balance…'
                  : 'Connect your wallet to view'}
            </p>
            <button
              className="button primary"
              onClick={() => void claim(asset.id)}
              disabled={!!busy || config.mode !== 'gateway' || !market}
            >
              {busy === asset.id
                ? 'Waiting for confirmation…'
                : `Get test ${asset.id === 'stock' ? 'NVIDIA' : 'USDG'}`}
            </button>
            {messages[asset.id] && (
              <p role="status" className="asset-message">
                {messages[asset.id]}
              </p>
            )}
            <div className="test-asset-links">
              <Link className="text-link" href={asset.href}>
                Try {asset.strategy} →
              </Link>
              {market && (
                <a
                  href={`${config.explorerUrl}/address/${market[asset.id]}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {asset.symbol} contract: {shortAddress(market[asset.id])} ↗
                </a>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
