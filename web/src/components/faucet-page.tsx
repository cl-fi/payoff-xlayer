'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useProduct } from './provider';
import { TradingWallet } from '@/lib/transactions';
import { parseFaucetAmount } from '@/lib/faucet';
import { amount, shortAddress } from '@/lib/amounts';
import { friendlyError } from '@/lib/wallet';

export function FaucetPage() {
  const { config, market, balances, connection, revision, reload, setWalletOpen } = useProduct();
  const [input, setInput] = useState('10000'),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const generation = useRef(revision);
  generation.current = revision;
  useEffect(() => {
    setMessage('');
  }, [revision]);
  async function claim() {
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
    setBusy(true);
    setMessage('');
    try {
      await new TradingWallet(
        config,
        connection,
        localStorage,
        (text) => {
          if (original === generation.current) setMessage(text);
        },
        current,
      ).faucet(market, parseFaucetAmount(input));
      if (original === generation.current)
        setMessage('Test USDG received. You can now use it in Buy Low products.');
    } catch (e) {
      if (original === generation.current) setMessage(friendlyError(e));
    } finally {
      setBusy(false);
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
          <h1>Get test USDG.</h1>
          <p>Mint Payoff tUSDG to your connected wallet and explore the products.</p>
        </div>
        <Link className="button secondary" href="/">
          Explore products
        </Link>
      </section>
      <section className="test-asset-card" aria-label="Test USDG faucet">
        <h2>
          Payoff Test USDG <span className="muted">· tUSDG</span>
        </h2>
        <p>
          Freely mintable on X Layer Testnet. No daily quota or waiting period. These tokens have no monetary
          value.
        </p>
        <p>
          The USDG amounts shown in current products use this token. You need a little test OKB to pay network
          fees.
        </p>
        <label htmlFor="faucet-amount">Amount to receive</label>
        <div className="quantity-input">
          <input
            id="faucet-amount"
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <span>tUSDG</span>
        </div>
        <p className="muted">
          Your balance:{' '}
          {connection && balances ? `${amount(balances.usdg)} tUSDG` : 'Connect your wallet to view'}
        </p>
        <button
          className="button primary"
          onClick={() => void claim()}
          disabled={busy || config.mode !== 'gateway' || !market}
        >
          {busy ? 'Waiting for confirmation…' : connection ? 'Get test USDG' : 'Connect wallet to receive'}
        </button>
        {message && (
          <p role="status" className="asset-message">
            {message}
          </p>
        )}
        <div className="test-asset-links">
          <a href="https://web3.okx.com/xlayer/faucet/xlayerfaucet" target="_blank" rel="noreferrer">
            Get test OKB ↗
          </a>
          {market && (
            <a href={`${config.explorerUrl}/address/${market.usdg}`} target="_blank" rel="noreferrer">
              tUSDG contract: {shortAddress(market.usdg)} ↗
            </a>
          )}
        </div>
      </section>
    </div>
  );
}
