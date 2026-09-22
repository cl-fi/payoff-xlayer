'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProduct } from './provider';
import { Icon } from './icon';
import { Modal } from './modal';
import { DEMO_ACCOUNT, DemoAdapter, isPrepared } from '@/lib/data/demo';
import { amount, dateOnly, dateTime, precise, previewOrder, ratio, stockTarget } from '@/lib/amounts';
import { QUOTES_UNAVAILABLE } from '@/lib/data/testnet';
import { quoteTerms, type AppQuote, type Position } from '@/lib/types';
import { friendlyError, switchNetwork } from '@/lib/wallet';
import { GatewayAdapter } from '@/lib/data/gateway';
import { TradingWallet } from '@/lib/transactions';
import { UserFacingError } from '@/lib/errors';
import { referenceEstimate } from '@/lib/data/reference';

export function ProductPage() {
  const {
    adapter,
    market,
    balances,
    connection,
    setWalletOpen,
    reload,
    scenario,
    revision,
    config,
    loading,
    error,
    activity,
    references,
    referenceError,
    balancesError,
  } = useProduct();
  const [side, setSide] = useState<0 | 1>(0),
    [selectedSeries, setSelectedSeries] = useState<string | null>(null),
    [selectedExpiry, setSelectedExpiry] = useState<string | null>(null),
    [quantity, setQuantity] = useState('1');
  const [quote, setQuote] = useState<AppQuote | null>(null),
    [dialog, setDialog] = useState<'assets' | 'quote' | 'success' | null>(null);
  const [busy, setBusy] = useState(''),
    [message, setMessage] = useState(''),
    [accepted, setAccepted] = useState(false),
    [completed, setCompleted] = useState<Position | null>(null);
  const [now, setNow] = useState(0),
    operation = useRef(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const available = market?.series.filter((s) => s.side === side && Number(s.tradeCutoff) * 1000 > now) ?? [];
  const expiries = [...new Set(available.map((s) => s.exerciseEnd))].sort((a, b) => Number(a) - Number(b));
  const expiry = selectedExpiry && expiries.includes(selectedExpiry) ? selectedExpiry : expiries[0];
  const pricedSeries = available
    .filter((s) => s.exerciseEnd === expiry)
    .sort((a, b) => {
      const comparison =
        BigInt(a.strikePricePerWrappedUSDG) < BigInt(b.strikePricePerWrappedUSDG)
          ? -1
          : BigInt(a.strikePricePerWrappedUSDG) > BigInt(b.strikePricePerWrappedUSDG)
            ? 1
            : 0;
      return side === 0 ? -comparison : comparison;
    });
  const series = pricedSeries.find((s) => s.id === selectedSeries) ?? pricedSeries[0];
  const calculation = useMemo(() => {
    if (!market || !series) return { preview: null, error: '' };
    try {
      return {
        preview: previewOrder(quantity, series, market, connection?.address ?? DEMO_ACCOUNT),
        error: '',
      };
    } catch (e) {
      return { preview: null, error: friendlyError(e) };
    }
  }, [quantity, series, market, connection?.address]);
  const preview = calculation.preview,
    prepared = !!(balances && preview && isPrepared(balances, preview));
  const estimate = referenceEstimate(references, preview, now);
  const terms = quote ? quoteTerms(quote) : null,
    remaining = terms ? Math.max(0, Math.ceil(Number(terms.deadline) - now / 1000)) : 0;
  const cutoff = !!series && now >= Number(series.tradeCutoff) * 1000;
  const readOnly = config.mode === 'testnet';
  const pending = activity.some((tx) => tx.status === 'pending');
  const wrongNetwork = connection?.kind === 'wallet' && connection.chainId !== config.chainId;
  const timeZone = config.mode === 'demo' ? undefined : 'America/New_York';
  // Changing any order input invalidates both the visible quote and responses still in flight.
  useEffect(() => {
    operation.current++;
    setQuote(null);
    setDialog(null);
    setAccepted(false);
    setMessage('');
    setBusy('');
  }, [quantity, side, series?.id, market?.rate, connection?.address, scenario, revision]);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  async function inquire() {
    if (!adapter || !preview || !connection) return;
    const op = ++operation.current;
    setBusy('Requesting a dealer quote…');
    setMessage('');
    try {
      const result = await adapter.quote(preview, crypto.randomUUID(), scenario);
      if (op !== operation.current) return;
      if (!result) {
        setMessage(
          'No quotes are available right now. Your assets are still in your account. Please try again later.',
        );
        setDialog(null);
        return;
      }
      setQuote(result);
      setAccepted(false);
      setNow(Date.now());
      setDialog('quote');
    } catch (e) {
      if (op === operation.current) setMessage(friendlyError(e));
    } finally {
      if (op === operation.current) setBusy('');
    }
  }
  async function prepare() {
    if (!adapter || !preview || !market || !connection) return;
    const op = ++operation.current;
    setBusy(config.mode === 'demo' ? 'Simulating asset preparation…' : 'Checking balances and allowances…');
    setMessage('');
    try {
      if (adapter instanceof DemoAdapter) await adapter.prepareAssets(preview);
      else if (adapter instanceof GatewayAdapter) await trader(op).prepareAssets(preview, market);
      else return;
      if (op !== operation.current) return;
      await reload();
      if (op === operation.current) setDialog(null);
    } catch (e) {
      if (op === operation.current) setMessage(friendlyError(e));
    } finally {
      if (op === operation.current) setBusy('');
    }
  }
  async function fill() {
    if (!adapter || !preview || !quote || !market || !accepted || remaining <= 0) return;
    const op = ++operation.current;
    setBusy(config.mode === 'demo' ? 'Simulating position opening…' : 'Rechecking your quote…');
    setMessage('');
    try {
      let position: Position;
      if (adapter instanceof DemoAdapter && quote.kind === 'demo') {
        await adapter.prepare(quote);
        position = await adapter.fill(preview, quote, scenario);
      } else if (adapter instanceof GatewayAdapter && quote.kind === 'gateway') {
        position = await trader(op).fill(adapter, preview, quote, market);
      } else throw new UserFacingError('This quote does not belong to the current trading environment.');
      if (op !== operation.current) return;
      setCompleted(position);
      setQuote(null);
      setDialog('success');
      await reload();
    } catch (e) {
      if (op === operation.current) setMessage(friendlyError(e));
    } finally {
      if (op === operation.current) {
        setBusy('');
        if (config.mode === 'gateway') void reload();
      }
    }
  }
  function trader(op: number) {
    if (!connection) throw new UserFacingError('Connect your wallet first.');
    return new TradingWallet(
      config,
      connection,
      localStorage,
      (text) => {
        if (op === operation.current) setBusy(text);
      },
      () => {
        if (op !== operation.current)
          throw new UserFacingError('Your order changed. Review it before continuing.');
      },
    );
  }
  const primary = () => {
    if (!connection) {
      setWalletOpen(true);
      return;
    }
    if (readOnly) return;
    if (wrongNetwork && connection.kind === 'wallet') {
      void switchNetwork(connection.provider, config).catch((e) => setMessage(friendlyError(e)));
      return;
    }
    if (pending) return;
    if (!prepared) {
      setMessage('');
      setDialog('assets');
      return;
    }
    void inquire();
  };
  const isPut = side === 0;
  return (
    <div className="page product-page">
      <section className="page-intro">
        <div>
          <div className="eyebrow">
            <span className="teal-line" /> YOUR PRICE. YOUR PAYOFF.
          </div>
          <h1>Make your waiting count.</h1>
          <p>Set a price you are willing to buy or sell at, and earn a premium upfront.</p>
        </div>
        <Link className="text-link intro-link" href="/how-it-works">
          See how it works <Icon name="arrow" size={17} />
        </Link>
      </section>
      <div className="product-grid">
        <section className="strategy-panel">
          <div className="asset-header">
            <div className="asset-identity">
              <div className="stock-avatar">N</div>
              <div>
                <h2>
                  NVDAx{' '}
                  <span className="subtle-badge">{config.mode === 'demo' ? 'xStocks' : 'Test asset'}</span>
                </h2>
                <p>
                  {config.mode === 'demo' ? 'NVIDIA · Tokenized stock' : 'NVIDIA strategy · tNVDAx / twNVDAx'}
                </p>
              </div>
            </div>
            <span className="asset-tag">
              <span className="teal-dot" />
              {config.mode === 'demo' ? 'Demo product' : 'Testnet product'}
            </span>
          </div>
          <div className="strategy-tabs" role="tablist" aria-label="Strategy">
            <button
              role="tab"
              aria-selected={isPut}
              onClick={() => setSide(0)}
              className={isPut ? 'selected' : ''}
            >
              <Icon name="down" />
              <span>
                Buy Low<small>Set a target buying price</small>
              </span>
            </button>
            <button
              role="tab"
              aria-selected={!isPut}
              onClick={() => setSide(1)}
              className={!isPut ? 'selected' : ''}
            >
              <Icon name="up" />
              <span>
                Sell High<small>Set a target selling price</small>
              </span>
            </button>
          </div>
          <div className="strategy-content">
            <div className="eyebrow">{isPut ? 'BUY LOWER' : 'SELL HIGHER'}</div>
            <h2>{isPut ? 'Get paid to wait for your price.' : 'Give your holdings a selling target.'}</h2>
            <p className="strategy-description">
              {isPut
                ? 'Deposit USDG and collect a premium upfront. If the dealer exercises, buy wrapped stocks on the agreed terms. Otherwise, reclaim your USDG at expiry.'
                : 'Deposit wrapped stocks and collect a premium upfront. If the dealer exercises, sell on the agreed terms. Otherwise, reclaim your wrapped stocks at expiry.'}
            </p>
            <div className="outcome-visual">
              <div className="visual-label">
                <span>One order. Two possible outcomes.</span>
                <span>Keep the premium in either case</span>
              </div>
              <div className="flow-source">
                <span className="flow-icon">
                  <Icon name={isPut ? 'wallet' : 'layers'} />
                </span>
                <div>
                  <small>You lock</small>
                  <strong>{isPut ? 'USDG' : 'wNVDAx'}</strong>
                </div>
                <span className="premium-pill">＋ Earn a premium</span>
              </div>
              <div className="flow-branches">
                <div>
                  <span className="branch-caption">Dealer exercises</span>
                  <strong>{isPut ? 'Receive wrapped stocks' : 'Receive USDG'}</strong>
                  <small>{isPut ? 'Buy for the agreed amount' : 'Sell for the agreed amount'}</small>
                </div>
                <div>
                  <span className="branch-caption">Expires without exercise</span>
                  <strong>{isPut ? 'Reclaim USDG' : 'Reclaim wrapped stocks'}</strong>
                  <small>You keep the premium</small>
                </div>
              </div>
            </div>
            <p className="fine-print rule-note">
              <Icon name="info" size={15} />
              The dealer chooses whether to exercise. Reaching the target price does not trigger automatic
              settlement.
            </p>
          </div>
          <div className="strategy-bottom">
            <span>
              <Icon name="shield" size={16} />
              Fully collateralized
            </span>
            <span>
              <Icon name="layers" size={16} />
              Fixed wrapped units
            </span>
            <span>
              <Icon name="clock" size={16} />
              Defined expiry
            </span>
          </div>
        </section>
        <section className="order-card" aria-label="Create order">
          <div className="order-heading">
            <h2>Create {isPut ? 'Buy Low' : 'Sell High'} order</h2>
            <span className="subtle-badge">NVDAx</span>
          </div>
          {readOnly && (
            <div className="notice availability-notice" role="status">
              <strong>Quotes are not available yet.</strong>
              <p>{QUOTES_UNAVAILABLE}</p>
            </div>
          )}
          <div className="field-label" id="expiry-label">
            Choose an expiry <span>{config.mode === 'demo' ? 'Fixed expiry' : 'New York time'}</span>
          </div>
          <div className="tenor-options" role="group" aria-labelledby="expiry-label">
            {expiries.map((end) => {
              const s = available.find((s) => s.exerciseEnd === end)!;
              const remainingDays = Math.ceil((Number(end) - now / 1000) / 86400);
              return (
                <button
                  key={end}
                  onClick={() => setSelectedExpiry(end)}
                  aria-pressed={end === expiry}
                  className={end === expiry ? 'selected' : ''}
                >
                  <strong>{config.mode === 'demo' ? `${s.days} days` : dateOnly(end, timeZone)}</strong>
                  <small>
                    {config.mode === 'demo'
                      ? `${dateTime(end)} expiry`
                      : now
                        ? `${remainingDays < 2 ? 'Less than 1 day' : `${remainingDays} days`} remaining`
                        : 'Fixed expiry'}
                  </small>
                </button>
              );
            })}
            {!available.length &&
              (loading ? (
                <div className="skeleton" />
              ) : (
                <p className="muted">
                  {error
                    ? 'Series could not be loaded. Please reload.'
                    : 'No series are open for new positions.'}
                </p>
              ))}
          </div>
          {pricedSeries.length > 0 && (
            <>
              <div className="field-label" id="strike-label">
                Choose a target price <span>USDG per NVDAx equivalent</span>
              </div>
              <div className="strike-options" role="group" aria-labelledby="strike-label">
                {pricedSeries.map((s) => (
                  <button
                    key={s.id}
                    aria-pressed={s.id === series?.id}
                    className={s.id === series?.id ? 'selected' : ''}
                    onClick={() => setSelectedSeries(s.id)}
                  >
                    {market && amount(stockTarget(s, market.rate))}
                    <small>USDG</small>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="target-block">
            <div>
              <span className="field-label">
                Reference {isPut ? 'buy' : 'sell'} price <span>per NVDAx</span>
              </span>
              <strong>
                {series && market ? amount(stockTarget(series, market.rate)) : '—'} <small>USDG</small>
              </strong>
            </div>
            <span className="target-icon">
              <Icon name={isPut ? 'down' : 'up'} size={24} />
            </span>
          </div>
          <label className="field-label" htmlFor="quantity">
            Stock quantity <span>At the current exchange rate</span>
          </label>
          <div className={`quantity-input ${calculation.error ? 'invalid' : ''}`}>
            <input
              id="quantity"
              inputMode="decimal"
              autoComplete="off"
              value={quantity}
              aria-invalid={!!calculation.error}
              aria-describedby={calculation.error ? 'quantity-error' : 'quantity-help'}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <span>NVDAx</span>
          </div>
          {calculation.error ? (
            <p id="quantity-error" className="field-error">
              {calculation.error}
            </p>
          ) : (
            <p id="quantity-help" className="input-help">
              ≈ {preview ? amount(preview.wrappedQuantity, 18, 6) : '—'} wNVDAx. Settlement uses this fixed
              quantity.
            </p>
          )}
          <div className="order-summary">
            <div>
              <span>{isPut ? 'USDG to lock' : 'Wrapped stocks to lock'}</span>
              <strong>
                {preview
                  ? isPut
                    ? `${amount(preview.strikeAmountUSDG)} USDG`
                    : `${amount(preview.wrappedQuantity, 18, 6)} wNVDAx`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>{config.mode === 'gateway' ? 'Estimated net premium' : 'Net premium'}</span>
              <strong data-testid="reference-premium">
                {config.mode !== 'gateway'
                  ? 'Available after quoting'
                  : estimate
                    ? `${amount(estimate.netPremiumUSDG, 6, 6)} USDG`
                    : !references && !referenceError
                      ? 'Loading reference…'
                      : 'Temporarily unavailable'}
              </strong>
            </div>
            {config.mode === 'gateway' && (
              <div>
                <span>Estimated term yield</span>
                <strong data-testid="reference-yield">
                  {estimate && preview ? `${ratio(estimate.netPremiumUSDG, preview.strikeAmountUSDG)}%` : '—'}
                </strong>
              </div>
            )}
            <div>
              <span>Exercise window</span>
              <span>
                {series
                  ? `${dateTime(series.exerciseStart, timeZone)} · ${(Number(series.exerciseEnd) - Number(series.exerciseStart)) / 60} min`
                  : '—'}
              </span>
            </div>
          </div>
          {config.mode === 'gateway' && (
            <div className="reference-note" role="status">
              <p>Reference estimate · Final premium is confirmed in your trade quote.</p>
              {estimate && (
                <>
                  <p>
                    {estimate.live ? 'Live market bid' : 'Last valid market bid'} ·{' '}
                    {dateTime(estimate.quote.marketTimestampMs / 1000, 'America/New_York')}
                  </p>
                  <p>
                    Term yield = net premium ÷ {isPut ? 'USDG collateral' : 'agreed sale amount'}. Not
                    annualized.
                  </p>
                  {(estimate.delayed || referenceError) && (
                    <p>Updates delayed. Showing the last available reference.</p>
                  )}
                </>
              )}
              {!estimate && referenceError && <p>{referenceError}</p>}
            </div>
          )}
          {balancesError && (
            <div className="notice" role="status">
              {balancesError}
            </div>
          )}
          {balances && (
            <div className="available-balance">
              <Icon name="wallet" size={14} />
              Available:{' '}
              {isPut
                ? `${amount(balances.usdg)} USDG`
                : `${amount(balances.stock, 18, 4)} NVDAx · ${amount(balances.wrapped, 18, 4)} wNVDAx`}
            </div>
          )}
          {message && !dialog && (
            <div role="alert" className="notice">
              {message}
            </div>
          )}
          <button
            className="button primary full main-cta"
            onClick={primary}
            disabled={!!busy || !preview || cutoff || pending || (readOnly && !!connection)}
          >
            {busy ? (
              <>
                <span className="spinner" />
                {busy}
              </>
            ) : cutoff ? (
              'Series closed to new positions'
            ) : !connection ? (
              'Connect to get started'
            ) : readOnly ? (
              'Quotes unavailable'
            ) : wrongNetwork ? (
              'Switch to X Layer Testnet'
            ) : pending ? (
              'Transaction pending'
            ) : !prepared ? (
              'Prepare assets'
            ) : (
              'Get a quote'
            )}
            {!busy && !cutoff && !(readOnly && connection) && <Icon name="arrow" size={18} />}
          </button>
          <p className="cta-note">
            {config.mode === 'demo'
              ? 'Demo quotes only · No real assets needed'
              : readOnly
                ? 'Live testnet data · Trading is not enabled'
                : 'Quotes requested directly from the gateway'}
          </p>
          {preview && (
            <details className="technical-details">
              <summary>
                View settlement terms <Icon name="chevron" size={14} />
              </summary>
              <dl>
                <dt>Fixed delivery quantity</dt>
                <dd>{precise(preview.wrappedQuantity)} wNVDAx</dd>
                <dt>Fixed settlement amount</dt>
                <dd>{precise(preview.strikeAmountUSDG, 6)} USDG</dd>
                <dt>Current wrapping rate</dt>
                <dd>1 wNVDAx = {market && precise(market.rate)} NVDAx</dd>
                <dt>Trading cutoff</dt>
                <dd>{dateTime(preview.series.tradeCutoff, timeZone)}</dd>
                <dt>Exercise ends</dt>
                <dd>{dateTime(preview.series.exerciseEnd, timeZone)}</dd>
                {config.mode !== 'demo' && (
                  <>
                    <dt>Onchain series</dt>
                    <dd>Series #{preview.series.id}</dd>
                    <dt>Fixed price per wrapped token</dt>
                    <dd>{precise(preview.series.strikePricePerWrappedUSDG, 6)} USDG</dd>
                  </>
                )}
              </dl>
              <p>
                The reference target uses the current exchange rate. After opening, wrapped units and the
                settlement amount are fixed. Underlying rights affected by dividends and splits transfer with
                the wrapped tokens.
              </p>
            </details>
          )}
          {config.mode !== 'demo' && market && (
            <div className="deployment-links">
              <a href={`${config.explorerUrl}/address/${config.nvdaVault}`} target="_blank" rel="noreferrer">
                View Vault <Icon name="external" size={12} />
              </a>
              <a href={`${config.explorerUrl}/address/${market.exchange}`} target="_blank" rel="noreferrer">
                View Exchange <Icon name="external" size={12} />
              </a>
              <button disabled={loading} onClick={() => void reload()}>
                {loading ? 'Refreshing…' : 'Refresh onchain data'}
              </button>
            </div>
          )}
        </section>
      </div>
      <section className="process-strip">
        <div>
          <span>01</span>
          <div>
            <h3>Choose your target</h3>
            <p>Pick a strategy, quantity and expiry</p>
          </div>
        </div>
        <div>
          <span>02</span>
          <div>
            <h3>Review your quote</h3>
            <p>Review your net premium and both outcomes</p>
          </div>
        </div>
        <div>
          <span>03</span>
          <div>
            <h3>Track your position</h3>
            <p>Claim your assets after exercise or expiry</p>
          </div>
        </div>
      </section>
      <Modal
        open={dialog === 'assets'}
        onClose={() => {
          if (!busy) setDialog(null);
        }}
        title="Prepare your assets"
        eyebrow="STEP 01 / ASSETS"
      >
        <p className="muted modal-intro">
          {isPut
            ? 'Approve the USDG needed for this order. Funds remain in your account until you confirm the trade.'
            : 'Wrap the NVDAx needed into wNVDAx, then approve the Vault. Wrapping does not open a position.'}
        </p>
        <div className="receipt-list">
          <div>
            <span>{isPut ? 'Approval amount' : 'Wrapped token approval'}</span>
            <strong>
              {preview &&
                (isPut
                  ? `${amount(preview.strikeAmountUSDG)} USDG`
                  : `${amount(preview.wrappedQuantity, 18, 6)} wNVDAx`)}
            </strong>
          </div>
          <div>
            <span>New approval scope</span>
            <span>Exact required amount</span>
          </div>
        </div>
        {message && (
          <div role="alert" className="notice error">
            {message}
          </div>
        )}
        {config.mode === 'demo' ? (
          <>
            <div className="notice">
              Wrapping and approval are simulated. No wallet signature is requested.
            </div>
            <button className="button primary full" disabled={!!busy} onClick={() => void prepare()}>
              {busy || 'Simulate asset preparation'}
            </button>
          </>
        ) : (
          <>
            <p className="fine-print">
              Each required transaction opens your wallet for confirmation and uses test OKB for gas. Existing
              wrapped tokens and sufficient approvals are reused.
            </p>
            <button
              className="button primary full"
              disabled={!!busy || pending || wrongNetwork}
              onClick={() => void prepare()}
            >
              {busy || 'Prepare with wallet'}
            </button>
          </>
        )}
      </Modal>
      <Modal
        open={dialog === 'quote'}
        onClose={() => {
          if (!busy) setDialog(null);
        }}
        title="Confirm your quote"
        eyebrow="STEP 02 / YOUR QUOTE"
      >
        {terms && preview && (
          <>
            <div className="quote-countdown">
              <span>
                <span className={remaining > 0 ? 'teal-dot' : 'expired-dot'} />
                {quote?.kind === 'demo' ? 'Fixed demo quote' : 'Dealer quote'}
              </span>
              <strong className={remaining ? '' : 'danger-text'}>
                {remaining > 0 ? `Expires in ${remaining}s` : 'Quote expired'}
              </strong>
            </div>
            <div className="premium-display">
              <span>Paid upfront · Net premium</span>
              <strong>
                {amount(terms.netPremiumUSDG, 6, 4)} <small>USDG</small>
              </strong>
              <p>
                Term premium / settlement amount = {ratio(terms.netPremiumUSDG, terms.strikeAmountUSDG)}%
                <span>Not annualized</span>
              </p>
            </div>
            <div className="receipt-list">
              <div>
                <span>Strategy / series</span>
                <strong>
                  {isPut ? 'Buy Low' : 'Sell High'} · {series?.days} days
                </strong>
              </div>
              <div>
                <span>Settlement amount</span>
                <strong>{amount(terms.strikeAmountUSDG)} USDG</strong>
              </div>
              <div>
                <span>Delivery quantity</span>
                <strong>{amount(terms.wrappedQuantity, 18, 6)} wNVDAx</strong>
              </div>
              <div>
                <span>Gross premium</span>
                <span>{amount(terms.grossPremiumUSDG, 6, 4)} USDG</span>
              </div>
              <div>
                <span>Protocol fee</span>
                <span>− {amount(terms.protocolFeeUSDG, 6, 4)} USDG</span>
              </div>
              <div>
                <span>Quoted by</span>
                <span>{quote?.kind === 'demo' ? quote.dealerName : quote?.selection.dealerName}</span>
              </div>
            </div>
            <label className="consent">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>
                I understand that assets are locked until exercise or expiry. Settlement transfers a fixed
                quantity of wrapped stocks, together with their underlying rights.
              </span>
            </label>
            {message && (
              <div role="alert" className="notice error">
                {message}
              </div>
            )}
            {remaining > 0 ? (
              <button
                className="button primary full"
                disabled={!accepted || !!busy || pending || wrongNetwork || readOnly}
                onClick={() => void fill()}
              >
                {busy || (config.mode === 'demo' ? 'Confirm demo trade' : 'Confirm trade in wallet')}
              </button>
            ) : (
              <button className="button primary full" disabled={!!busy} onClick={() => void inquire()}>
                {busy || 'Get a new quote'}
              </button>
            )}
            <p className="fine-print">
              {config.mode === 'demo'
                ? 'Quotes must pass execution checks before they expire. Demo actions do not create onchain positions.'
                : 'Quotes must execute before expiry. Outside market hours, pricing can use the same option’s last valid market bid.'}
            </p>
          </>
        )}
      </Modal>
      <Modal
        open={dialog === 'success'}
        onClose={() => setDialog(null)}
        title="Your position is open."
        eyebrow={config.mode === 'demo' ? 'DEMO POSITION OPENED' : 'TESTNET POSITION OPENED'}
      >
        <div className="success-icon">
          <Icon name="check" size={32} />
        </div>
        <p className="success-copy">
          {config.mode === 'demo' ? 'Demo position created.' : 'Your transaction is confirmed.'}{' '}
          <strong>{completed && amount(completed.netPremiumUSDG, 6, 4)} USDG</strong> in net premium has been
          added to your {config.mode === 'demo' ? 'demo balance' : 'wallet'}.
        </p>
        <p className="muted center">
          {config.mode === 'demo'
            ? 'View the terms in My positions, or simulate both outcomes and claim your assets.'
            : 'Track your position and claim your assets after exercise or expiry.'}
        </p>
        <Link href="/positions" className="button primary full" onClick={() => setDialog(null)}>
          View my positions <Icon name="arrow" size={17} />
        </Link>
        {completed?.transactionHash ? (
          <a
            className="text-link"
            href={`${config.explorerUrl}/tx/${completed.transactionHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction <Icon name="external" size={14} />
          </a>
        ) : (
          <p className="fine-print center">Saved in this browser only. No onchain transaction was sent.</p>
        )}
      </Modal>
    </div>
  );
}
