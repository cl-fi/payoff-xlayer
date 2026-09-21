'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useProduct } from './provider';
import { Icon } from './icon';
import { Modal } from './modal';
import { DemoAdapter, claimAmounts, positionStatus } from '@/lib/data/demo';
import { amount, dateTime, precise, WAD } from '@/lib/amounts';
import { friendlyError } from '@/lib/wallet';
import type { Position } from '@/lib/types';

const labels = {
  open: 'Open',
  exercised: 'Exercised · Claimable',
  expired: 'Expired · Claimable',
  claimed: 'Claimed',
};
export function PositionsPage() {
  const {
    positions,
    balances,
    connection,
    setWalletOpen,
    adapter,
    market,
    reload,
    config,
    revision,
    loading,
  } = useProduct();
  const [filter, setFilter] = useState('all'),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setSelected(null);
    setMessage('');
  }, [revision]);
  const position = positions.find((p) => p.id === selected),
    status = position ? positionStatus(position, now) : null;
  const active = positions.filter((p) => positionStatus(p, now) !== 'claimed');
  const lockedUSDG = active.reduce(
    (sum, p) =>
      sum + (positionStatus(p, now) === 'open' && p.series.side === 0 ? BigInt(p.strikeAmountUSDG) : 0n),
    0n,
  );
  const lockedWrapped = active.reduce(
    (sum, p) =>
      sum + (positionStatus(p, now) === 'open' && p.series.side === 1 ? BigInt(p.wrappedQuantity) : 0n),
    0n,
  );
  const earned = positions.reduce((sum, p) => sum + BigInt(p.netPremiumUSDG), 0n);
  const visible = positions.filter((p) => {
    const s = positionStatus(p, now);
    return filter === 'all' || (filter === 'ready' ? ['exercised', 'expired'].includes(s) : s === filter);
  });
  async function claim(p: Position) {
    if (!(adapter instanceof DemoAdapter)) return;
    setBusy(true);
    setMessage('');
    try {
      await adapter.claim(p.id);
      await reload();
      setMessage('Assets claimed to your demo account.');
    } catch (e) {
      setMessage(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function simulate(outcome: 'exercised' | 'expired') {
    if (!(adapter instanceof DemoAdapter) || !position) return;
    setBusy(true);
    setMessage('');
    try {
      adapter.simulateOutcome(position.id, outcome);
      await reload();
    } catch (e) {
      setMessage(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  const claimable = position ? claimAmounts(position, now) : null;
  return (
    <div className="page positions-page">
      <section className="page-intro">
        <div>
          <div className="eyebrow">
            <span className="teal-line" /> YOUR POSITIONS
          </div>
          <h1>Every position, at a glance.</h1>
          <p>Track your premiums, settlement terms and assets ready to claim.</p>
        </div>
        <Link href="/" className="button secondary">
          Create an order <Icon name="arrow" size={16} />
        </Link>
      </section>
      <div className="portfolio-stats">
        <div>
          <span>Total net premiums</span>
          <strong className="teal-text">
            {amount(earned)} <small>USDG</small>
          </strong>
          <p>Collected at opening</p>
        </div>
        <div>
          <span>Open · Locked USDG</span>
          <strong>
            {amount(lockedUSDG)} <small>USDG</small>
          </strong>
          <p>Buy Low collateral</p>
        </div>
        <div>
          <span>Open · Locked wrapped stocks</span>
          <strong>
            {amount(lockedWrapped, 18, 6)} <small>wNVDAx</small>
          </strong>
          <p>Sell High collateral</p>
        </div>
      </div>
      <section className="positions-section">
        <div className="section-heading">
          <div className="filter-tabs" aria-label="Filter positions">
            {[
              { key: 'all', label: 'All' },
              { key: 'open', label: 'Open' },
              { key: 'ready', label: 'Claimable' },
              { key: 'claimed', label: 'Claimed' },
            ].map((f) => (
              <button
                key={f.key}
                aria-pressed={filter === f.key}
                className={filter === f.key ? 'active' : ''}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            aria-label="Refresh positions"
            onClick={() => void reload()}
            disabled={loading}
          >
            <Icon name="refresh" size={17} />
          </button>
        </div>
        {!connection ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="wallet" size={32} />
            </div>
            <h2>Your next position starts here.</h2>
            <p>Connect to view your positions and assets.</p>
            <button className="button primary" onClick={() => setWalletOpen(true)}>
              Connect account
            </button>
          </div>
        ) : !visible.length ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="layers" size={34} />
            </div>
            <h2>{positions.length ? 'No positions here yet' : 'Your first position awaits.'}</h2>
            <p>
              {positions.length
                ? 'Try another filter.'
                : 'Choose a price that works for you and try your first Buy Low or Sell High order.'}
            </p>
            <Link href="/" className="button primary">
              Explore products <Icon name="arrow" size={16} />
            </Link>
          </div>
        ) : (
          <div className="position-table">
            <div className="table-heading">
              <span>Product / strategy</span>
              <span>Fixed settlement terms</span>
              <span>Net premium</span>
              <span>Expiry</span>
              <span>Status</span>
              <span />
            </div>
            {visible.map((p) => (
              <button
                className="position-row"
                key={p.id}
                onClick={() => {
                  setSelected(p.id);
                  setMessage('');
                }}
              >
                <span className="table-product">
                  <span className="mini-avatar">N</span>
                  <span>
                    <strong>NVDAx · {p.series.side === 0 ? 'Buy Low' : 'Sell High'}</strong>
                    <small>
                      {p.source === 'demo' ? 'Demo position' : `Position #${p.id}`} · {p.series.days} days
                    </small>
                  </span>
                </span>
                <span>
                  <strong>{amount(p.wrappedQuantity, 18, 6)} wNVDAx</strong>
                  <small>{amount(p.strikeAmountUSDG)} USDG</small>
                </span>
                <span className="teal-text">
                  <strong>+{amount(p.netPremiumUSDG, 6, 4)}</strong>
                  <small>USDG · Collected</small>
                </span>
                <span>
                  <strong>{dateTime(p.series.exerciseEnd)}</strong>
                  <small>Local time</small>
                </span>
                <span>
                  <span className={`status-badge ${positionStatus(p, now)}`}>
                    {labels[positionStatus(p, now)]}
                  </span>
                </span>
                <Icon name="chevron" size={17} />
              </button>
            ))}
          </div>
        )}
      </section>
      {balances && (
        <section className="balance-panel">
          <div>
            <div className="eyebrow">{config.mode === 'demo' ? 'DEMO BALANCE' : 'WALLET BALANCE'}</div>
            <h2>Available assets</h2>
            <p>
              {config.mode === 'demo'
                ? 'Local demo balances, separate from real wallet assets.'
                : 'Available balances from the latest onchain check.'}
            </p>
          </div>
          <div>
            <strong>{amount(balances.usdg)}</strong>
            <span>USDG</span>
          </div>
          <div>
            <strong>{amount(balances.stock, 18, 4)}</strong>
            <span>NVDAx</span>
          </div>
          <div>
            <strong>{amount(balances.wrapped, 18, 6)}</strong>
            <span>wNVDAx</span>
          </div>
        </section>
      )}
      {config.mode === 'gateway' && (
        <p className="fine-print">
          This version shows positions saved in this browser. Full history indexing and onchain actions will
          follow during integration.
        </p>
      )}
      <Modal
        open={!!position}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
        title={`NVDAx · ${position?.series.side === 0 ? 'Buy Low' : 'Sell High'}`}
        eyebrow="POSITION DETAILS"
      >
        {position && status && (
          <>
            <div className="position-detail-heading">
              <span className={`status-badge ${status}`}>{labels[status]}</span>
              <span className="fine-print">
                {position.source === 'demo' ? 'Demo record' : `#${position.id}`}
              </span>
            </div>
            <div className="premium-display compact">
              <span>Net premium collected</span>
              <strong>
                +{amount(position.netPremiumUSDG, 6, 4)} <small>USDG</small>
              </strong>
            </div>
            <div className="receipt-list">
              <div>
                <span>Fixed delivery quantity</span>
                <strong>{amount(position.wrappedQuantity, 18, 6)} wNVDAx</strong>
              </div>
              <div>
                <span>Fixed settlement amount</span>
                <strong>{amount(position.strikeAmountUSDG)} USDG</strong>
              </div>
              <div>
                <span>Current stock equivalent</span>
                <span>
                  {market
                    ? amount((BigInt(position.wrappedQuantity) * BigInt(market.rate)) / WAD, 18, 6)
                    : '—'}{' '}
                  NVDAx
                </span>
              </div>
              <div>
                <span>Opened at</span>
                <span>{dateTime(position.openedAt)}</span>
              </div>
              <div>
                <span>Exercise starts</span>
                <span>{dateTime(position.series.exerciseStart)}</span>
              </div>
              <div>
                <span>Exercise ends</span>
                <span>{dateTime(position.series.exerciseEnd)}</span>
              </div>
            </div>
            <details className="technical-details">
              <summary>
                Full precision <Icon name="chevron" size={14} />
              </summary>
              <p>
                {precise(position.wrappedQuantity)} wNVDAx
                <br />
                {precise(position.strikeAmountUSDG, 6)} USDG
              </p>
            </details>
            {['exercised', 'expired'].includes(status) && claimable && (
              <div className="claim-panel">
                <span>Ready to claim</span>
                <strong>
                  {BigInt(claimable.usdg) > 0n
                    ? `${amount(claimable.usdg)} USDG`
                    : `${amount(claimable.wrapped, 18, 6)} wNVDAx`}
                </strong>
                <p>
                  {status === 'exercised'
                    ? 'The dealer exercised. Claim your settlement proceeds.'
                    : 'Expired without exercise. Reclaim your original collateral.'}
                </p>
                <button
                  className="button primary full"
                  disabled={busy || config.mode !== 'demo'}
                  onClick={() => void claim(position)}
                >
                  {busy
                    ? 'Simulating claim…'
                    : config.mode === 'demo'
                      ? 'Claim demo assets'
                      : 'Testnet claims coming soon'}
                </button>
              </div>
            )}
            {status === 'open' && (
              <div className="notice">
                Your assets are locked. Return here to claim after the dealer exercises or the position
                expires.
              </div>
            )}
            {status === 'claimed' && (
              <div className="notice success">
                <Icon name="check" size={16} />
                Assets claimed. The premium remains yours.
              </div>
            )}
            {message && (
              <div role="status" className="notice">
                {message}
              </div>
            )}
            {config.mode === 'demo' && status === 'open' && (
              <details className="simulation-controls">
                <summary>
                  <Icon name="settings" size={16} />
                  Simulate an outcome
                </summary>
                <p>
                  Preview the next steps without changing the series schedule or sending an onchain
                  transaction.
                </p>
                <div>
                  <button
                    disabled={busy}
                    className="button secondary"
                    onClick={() => void simulate('exercised')}
                  >
                    Simulate dealer exercise
                  </button>
                  <button
                    disabled={busy}
                    className="button secondary"
                    onClick={() => void simulate('expired')}
                  >
                    Simulate expiry without exercise
                  </button>
                </div>
              </details>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
