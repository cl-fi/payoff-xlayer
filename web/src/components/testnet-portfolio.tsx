'use client';
import Link from 'next/link';
import { useProduct } from './provider';
import { Icon } from './icon';
import { TokenIcon } from './token-icon';
import { amount, shortAddress } from '@/lib/amounts';

export function TestnetPortfolio() {
  const { connection, balances, config, loading, error, reload, setWalletOpen } = useProduct();
  const assets = [
    { symbol: 'OKB', value: balances?.okb, decimals: 18, precision: 6 },
    { symbol: 'USDG', value: balances?.usdg, decimals: 6, precision: 2 },
    { symbol: 'tNVDAx', value: balances?.stock, decimals: 18, precision: 4 },
    { symbol: 'twNVDAx', value: balances?.wrapped, decimals: 18, precision: 6 },
  ];
  return (
    <div className="page positions-page">
      <section className="page-intro">
        <div>
          <h1>Your assets, on X Layer.</h1>
          <p>View wallet balances and explore the deployed strategies.</p>
        </div>
        <Link href="/" className="button secondary">
          Explore Dual Investment <Icon name="arrow" size={16} />
        </Link>
      </section>
      <section className="positions-section">
        <div className="section-heading">
          <h2>Wallet balances</h2>
          <button
            className="icon-button"
            aria-label="Refresh wallet balances"
            disabled={loading || !connection}
            onClick={() => void reload()}
          >
            <Icon name="refresh" size={17} />
          </button>
        </div>
        {!connection ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="wallet" size={32} />
            </div>
            <h2>Connect to view your assets.</h2>
            <p>Balances are read from X Layer Testnet. No signature is needed.</p>
            <button className="button primary" onClick={() => setWalletOpen(true)}>
              Connect wallet to view balances
            </button>
          </div>
        ) : (
          <div className="testnet-balance-content">
            <div className="testnet-assets" aria-label="Testnet wallet balances" aria-busy={loading}>
              {assets.map((asset) => (
                <div key={asset.symbol}>
                  <span>
                    <TokenIcon symbol={asset.symbol} size={16} />
                    {asset.symbol}
                  </span>
                  <strong>
                    {asset.value === undefined ? '—' : amount(asset.value, asset.decimals, asset.precision)}
                  </strong>
                </div>
              ))}
            </div>
            <p className="fine-print" role="status">
              {loading
                ? 'Refreshing onchain balances…'
                : error
                  ? 'Balances are unavailable. Reload to try again.'
                  : `Balances for ${shortAddress(connection.address)} on X Layer Testnet.`}
            </p>
            <div className="deployment-links">
              <a
                href={`${config.explorerUrl}/address/${connection.address}`}
                target="_blank"
                rel="noreferrer"
              >
                View wallet on explorer <Icon name="external" size={12} />
              </a>
            </div>
          </div>
        )}
      </section>
      <div className="notice availability-notice">
        <strong>Position history is not connected yet.</strong>
        <p>
          Wallet balances are available, but this page does not yet retrieve your onchain positions. Quotes
          and trading are unavailable until the quote service and transaction flow are connected.
        </p>
      </div>
      <p className="fine-print">
        tNVDAx and twNVDAx are test tokens for this deployment. They are not issuer-backed stocks and have no
        real value.
      </p>
    </div>
  );
}
