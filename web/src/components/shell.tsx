'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useProduct } from './provider';
import { Icon, Mark } from './icon';
import { Modal } from './modal';
import { shortAddress } from '@/lib/amounts';
import type { Scenario } from '@/lib/types';

export function Shell({ children }: { children: ReactNode }) {
  const { config, connection, setWalletOpen, scenario, setScenario, resetDemo, error, reload, activity } =
    useProduct();
  const pathname = usePathname(),
    [settings, setSettings] = useState(false),
    [resetting, setResetting] = useState(false);
  const options: { value: Scenario; label: string; hint: string }[] = [
    { value: 'normal', label: 'Normal flow', hint: 'Fixed quotes with simulated successful trades' },
    { value: 'no-quote', label: 'No quotes', hint: 'See what happens when no dealer offers a quote' },
    { value: 'expired', label: 'Expired quote', hint: 'Receive a quote that has already expired' },
    { value: 'rejected', label: 'Cancel confirmation', hint: 'Simulate a declined confirmation' },
    { value: 'failed', label: 'Failed trade', hint: 'Simulate a failed trade with assets unchanged' },
    { value: 'offline', label: 'Service unavailable', hint: 'Simulate an unavailable quote service' },
  ];
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className="environment-strip">
        <span className="environment-label">
          <span className="environment-dot" />
          {config.mode === 'demo' ? 'Product demo' : 'X Layer Testnet'}
        </span>
        <span className="strip-divider" />
        <span className="environment-message">
          {config.mode === 'demo'
            ? 'Fixed test quotes · Simulated assets and trades. No onchain transactions.'
            : config.mode === 'testnet'
              ? 'Onchain series and wallet balances · Quote service not connected.'
              : 'Payoff tUSDG test assets · 24/7 dealer quotes · Wallet-confirmed trades.'}
        </span>
      </div>
      <header className="site-header">
        <div className="header-inner">
          <Link className="brand" href="/" aria-label="Payoff home">
            <Mark />
            <span>
              Payoff<span className="brand-period">.</span>
            </span>
          </Link>
          <nav aria-label="Main navigation">
            {[
              { href: '/', label: 'Products' },
              { href: '/positions', label: 'My positions' },
              ...(config.mode === 'gateway' ? [{ href: '/faucet', label: 'Get test tokens' }] : []),
              { href: '/how-it-works', label: 'How it works' },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={
                  pathname === item.href || (item.href === '/positions' && pathname.startsWith('/positions/'))
                    ? 'active'
                    : ''
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="header-actions">
            <span className="network-label">
              <span className="network-dot" />
              {config.mode === 'demo' ? 'Demo environment' : 'X Layer Testnet'}
            </span>
            <button className="button wallet-button" onClick={() => setWalletOpen(true)}>
              <Icon name="wallet" size={17} />
              <span>
                {connection
                  ? connection.kind === 'demo'
                    ? 'Demo account'
                    : shortAddress(connection.address)
                  : 'Connect wallet'}
              </span>
            </button>
          </div>
        </div>
      </header>
      <main id="main">
        {config.mode === 'gateway' && activity.some((tx) => tx.status === 'pending') && (
          <div className="global-alert" role="status">
            <Icon name="clock" />
            <span>
              Transaction submitted. Waiting for confirmation.{' '}
              {activity
                .filter((tx) => tx.status === 'pending')
                .map((tx) => (
                  <a
                    key={tx.hash}
                    href={`${config.explorerUrl}/tx/${tx.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tx.label} ↗{' '}
                  </a>
                ))}
            </span>
            <button onClick={() => void reload()}>Check status</button>
          </div>
        )}
        {config.mode !== 'demo' && connection?.kind === 'wallet' && connection.chainId !== config.chainId && (
          <div className="global-alert" role="status">
            <Icon name="info" />
            <span>Your wallet is on another network. Data shown here is from X Layer Testnet.</span>
            <button onClick={() => setWalletOpen(true)}>Switch network</button>
          </div>
        )}
        {error && (
          <div className="global-alert" role="alert">
            <Icon name="info" />
            <span>{error}</span>
            <button onClick={() => void reload()}>Reload</button>
          </div>
        )}
        {children}
      </main>
      <footer className="site-footer">
        <div className="footer-top">
          <Link className="brand" href="/">
            <Mark size={23} />
            <span>Payoff.</span>
          </Link>
          <p>Your target price. Clear settlement terms.</p>
          <span className="built-on">
            BUILT ON <strong>X LAYER</strong>
          </span>
        </div>
        <div className="footer-bottom">
          <span>
            © {new Date().getFullYear()} Payoff ·{' '}
            {config.mode === 'demo' ? 'Product demo. Quotes do not reflect live markets.' : 'Testnet version'}
          </span>
          <div>
            <Link href="/how-it-works">
              Understand the rules <Icon name="external" size={12} />
            </Link>
            {config.mode === 'demo' && (
              <button onClick={() => setSettings(true)}>
                <Icon name="settings" size={14} />
                Demo settings{scenario !== 'normal' && <span className="tiny-dot" />}
              </button>
            )}
          </div>
        </div>
      </footer>
      <Modal
        open={settings}
        onClose={() => setSettings(false)}
        title="Explore different outcomes"
        eyebrow="DEMO CONTROLS"
      >
        <p className="muted modal-intro">
          These settings only affect this local demo. Wallet and onchain assets are unchanged.
        </p>
        <div className="scenario-list">
          {options.map((o) => (
            <label key={o.value} className={scenario === o.value ? 'selected' : ''}>
              <input
                type="radio"
                name="scenario"
                value={o.value}
                checked={scenario === o.value}
                onChange={() => setScenario(o.value)}
              />
              <span>
                <strong>{o.label}</strong>
                <small>{o.hint}</small>
              </span>
              {scenario === o.value && <Icon name="check" />}
            </label>
          ))}
        </div>
        <div className="reset-zone">
          <p>Reset clears demo positions for this account and restores starting balances and fresh series.</p>
          <button
            className="button secondary full"
            disabled={resetting}
            onClick={async () => {
              setResetting(true);
              try {
                await resetDemo();
                setSettings(false);
              } finally {
                setResetting(false);
              }
            }}
          >
            <Icon name="refresh" size={16} />
            {resetting ? 'Resetting…' : 'Reset demo account'}
          </button>
        </div>
      </Modal>
    </>
  );
}
