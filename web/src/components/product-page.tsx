'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProduct } from './provider';
import { Icon } from './icon';
import { Modal } from './modal';
import { DEMO_ACCOUNT, DemoAdapter, isPrepared } from '@/lib/data/demo';
import {
  amount,
  apr,
  aprBps,
  dateOnly,
  dateTime,
  precise,
  previewOrder,
  rounded,
  stockTarget,
} from '@/lib/amounts';
import { QUOTES_UNAVAILABLE } from '@/lib/data/testnet';
import { quoteTerms, type AppQuote, type Position, type QuantityUnit } from '@/lib/types';
import { friendlyError, switchNetwork } from '@/lib/wallet';
import { GatewayAdapter } from '@/lib/data/gateway';
import { TradingWallet } from '@/lib/transactions';
import { UserFacingError } from '@/lib/errors';
import { referenceEstimate, referenceQuote } from '@/lib/data/reference';
import { NvidiaPriceChart } from './nvidia-price-chart';
import { ScenarioPreview } from './scenario-preview';
import { TokenIcon } from './token-icon';

export function ProductPage({ initialSide = 0 }: { initialSide?: 0 | 1 }) {
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
  const [side, setSide] = useState<0 | 1>(initialSide),
    [selectedSeries, setSelectedSeries] = useState<string | null>(null),
    [selectedExpiry, setSelectedExpiry] = useState<string | null>(null),
    [quantity, setQuantity] = useState('1'),
    [quantityUnit, setQuantityUnit] = useState<QuantityUnit>('stock');
  const [quote, setQuote] = useState<AppQuote | null>(null),
    [dialog, setDialog] = useState<'assets' | 'quote' | 'success' | null>(null);
  const [busy, setBusy] = useState(''),
    [message, setMessage] = useState(''),
    [accepted, setAccepted] = useState(false),
    [completed, setCompleted] = useState<Position | null>(null);
  const [now, setNow] = useState(0),
    operation = useRef(0);
  const orderCard = useRef<HTMLElement>(null),
    [dock, setDock] = useState(false);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // On narrow screens the order card sits below the strategy panel; a compact dock offers a jump to it
  // while the card is still out of view below the fold.
  useEffect(() => {
    const card = orderCard.current;
    if (!card || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) =>
      setDock(!entry.isIntersecting && entry.boundingClientRect.top > 0),
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  const available = market?.series.filter((s) => s.side === side && Number(s.tradeCutoff) * 1000 > now) ?? [];
  const expiries = [...new Set(available.map((s) => s.exerciseEnd))].sort((a, b) => Number(a) - Number(b));
  const expiry = selectedExpiry && expiries.includes(selectedExpiry) ? selectedExpiry : expiries[0];
  // Distinct strikes across the open expiries, nearest the market first: descending for Buy Low,
  // ascending for Sell High. Each strike × expiry cell of the offer table is one series.
  const strikes = [...new Set(available.map((s) => s.strikePricePerWrappedUSDG))].sort((a, b) => {
    const comparison = BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
    return side === 0 ? -comparison : comparison;
  });
  const offer = (strike: string, end: string) =>
    available.find((s) => s.strikePricePerWrappedUSDG === strike && s.exerciseEnd === end);
  const series =
    available.find((s) => s.id === selectedSeries) ??
    (expiry ? strikes.map((strike) => offer(strike, expiry)).find(Boolean) : undefined);
  const calculation = useMemo(() => {
    if (!market || !series) return { preview: null, error: '' };
    try {
      return {
        preview: previewOrder(quantity, series, market, connection?.address ?? DEMO_ACCOUNT, quantityUnit),
        error: '',
      };
    } catch (e) {
      return { preview: null, error: friendlyError(e) };
    }
  }, [quantity, quantityUnit, series, market, connection?.address]);
  const preview = calculation.preview,
    prepared = !!(balances && preview && isPrepared(balances, preview));
  const estimate = referenceEstimate(references, preview, now);
  const terms = quote ? quoteTerms(quote) : null,
    remaining = terms ? Math.max(0, Math.ceil(Number(terms.deadline) - now / 1000)) : 0;
  const cutoff = !!series && now >= Number(series.tradeCutoff) * 1000;
  const secondsToExpiry = series ? Number(series.exerciseEnd) - now / 1000 : 0;
  const estimatedApr =
    estimate && preview ? apr(estimate.netPremiumUSDG, preview.strikeAmountUSDG, secondsToExpiry) : null;
  const quotedApr = terms ? apr(terms.netPremiumUSDG, terms.strikeAmountUSDG, secondsToExpiry) : null;
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
  }, [quantity, quantityUnit, side, series?.id, market?.rate, connection?.address, scenario, revision]);
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
  const wrappedInput = quantityUnit === 'wrapped';
  const displayTarget =
    series && market
      ? wrappedInput
        ? BigInt(series.strikePricePerWrappedUSDG)
        : stockTarget(series, market.rate)
      : null;
  const displayQuantity = preview ? (wrappedInput ? preview.wrappedQuantity : preview.stockEquivalent) : null;
  const settlementTotal =
    preview && estimate ? BigInt(preview.strikeAmountUSDG) + BigInt(estimate.netPremiumUSDG) : null;
  const expiryLabel = (s: { exerciseEnd: string; days: number }) =>
    config.mode === 'demo' ? `${s.days} days` : dateOnly(s.exerciseEnd, timeZone);
  return (
    <div className="page product-page">
      <section className="page-intro">
        <div>
          <h1>Dual Investment</h1>
          <p>Enjoy high rewards — Buy Low, Sell High</p>
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
      </section>
      <div className="product-grid">
        <section className="strategy-panel" aria-label="Market and offers">
          <div className="asset-header">
            <div className="asset-identity">
              <TokenIcon symbol="NVDAx" size={40} />
              <h2>
                NVDAx <span>· NVIDIA</span>
              </h2>
            </div>
          </div>
          <NvidiaPriceChart />
          <div className="offer-panel">
            {available.length ? (
              <table className="offer-table" aria-label="Target price and expiry">
                <thead>
                  <tr>
                    <th scope="col">
                      Target price<small>USDG per {wrappedInput ? 'wNVDAx' : 'NVDAx'}</small>
                    </th>
                    {expiries.map((end) => {
                      const s = available.find((s) => s.exerciseEnd === end)!;
                      const remainingDays = Math.ceil((Number(end) - now / 1000) / 86400);
                      return (
                        <th scope="col" key={end}>
                          {expiryLabel(s)}
                          <small>
                            {config.mode === 'demo'
                              ? dateTime(end)
                              : now
                                ? remainingDays < 2
                                  ? 'Less than 1 day left'
                                  : `${remainingDays} days left`
                                : '\u00a0'}
                          </small>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {strikes.map((strike) => {
                    const row = expiries.map((end) => offer(strike, end));
                    const sample = row.find((s) => !!s)!;
                    const target = market
                      ? amount(wrappedInput ? strike : stockTarget(sample, market.rate))
                      : '—';
                    return (
                      <tr key={strike}>
                        <th scope="row">{target}</th>
                        {row.map((s, index) => {
                          const end = expiries[index];
                          if (!s)
                            return (
                              <td key={end}>
                                <span className="offer-empty">—</span>
                              </td>
                            );
                          const reference =
                            config.mode === 'gateway' && market
                              ? referenceQuote(references, s, market.rate, now)
                              : null;
                          const strikeApr = reference
                            ? aprBps(
                                reference.netPremiumPerWrappedUSDG,
                                s.strikePricePerWrappedUSDG,
                                Number(s.exerciseEnd) - now / 1000,
                              )
                            : null;
                          const aprLabel = strikeApr === null ? null : `${rounded(strikeApr, 2, 1)}% APR`;
                          const selected = s.id === series?.id;
                          return (
                            <td key={end}>
                              <button
                                type="button"
                                className={`${selected ? 'selected' : ''}${aprLabel ? ' apr' : ''}`}
                                aria-pressed={selected}
                                aria-label={`${target} USDG · ${expiryLabel(s)}${aprLabel ? ` · ${aprLabel}` : ''}`}
                                onClick={() => {
                                  setSelectedSeries(s.id);
                                  setSelectedExpiry(end);
                                }}
                              >
                                {aprLabel ??
                                  (selected ? (
                                    <>
                                      <Icon name="check" size={14} />
                                      Selected
                                    </>
                                  ) : (
                                    'Select'
                                  ))}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : loading ? (
              <div className="skeleton" />
            ) : (
              <p className="muted">
                {error
                  ? 'Series could not be loaded. Please reload.'
                  : 'No series are open for new positions.'}
              </p>
            )}
          </div>
        </section>
        <section className="order-card" aria-label="Create order" ref={orderCard}>
          <div className="order-heading">
            <div>
              <h2>{isPut ? 'Buy Low' : 'Sell High'} order</h2>
              <span className="order-selection">
                {series && displayTarget !== null
                  ? `${amount(displayTarget)} USDG · ${expiryLabel(series)}`
                  : 'No open series'}
              </span>
            </div>
            {config.mode !== 'demo' && (
              <button
                className="icon-button"
                aria-label="Refresh onchain data"
                disabled={loading}
                onClick={() => void reload()}
              >
                <Icon name="refresh" size={16} />
              </button>
            )}
          </div>
          {readOnly && (
            <div className="notice availability-notice" role="status">
              <strong>Quotes are not available yet.</strong>
              <p>{QUOTES_UNAVAILABLE}</p>
            </div>
          )}
          <ScenarioPreview
            isPut={isPut}
            unit={wrappedInput ? 'wNVDAx' : 'NVDAx'}
            approximate={!wrappedInput}
            target={displayTarget === null ? null : amount(displayTarget)}
            quantity={
              displayQuantity === null
                ? null
                : wrappedInput
                  ? amount(displayQuantity, 18, 6)
                  : rounded(displayQuantity, 18, 4)
            }
            usdg={preview ? amount(preview.strikeAmountUSDG) : null}
            premium={estimate ? amount(estimate.netPremiumUSDG) : null}
            total={settlementTotal === null ? null : amount(settlementTotal)}
            expiry={series ? dateOnly(series.exerciseEnd, timeZone) : null}
          />
          <div className="field-label quantity-label">
            <label htmlFor="quantity">Quantity</label>
            {(balances || config.mode === 'gateway') && (
              <span className="field-aside">
                {balances && (
                  <span className="available-balance">
                    <Icon name="wallet" size={13} />
                    {isPut
                      ? `${amount(balances.usdg)} USDG`
                      : `${amount(balances.stock, 18, 4)} NVDAx · ${amount(balances.wrapped, 18, 4)} wNVDAx`}
                  </span>
                )}
                {config.mode === 'gateway' && (
                  <Link className="text-link" href={`/faucet#${isPut ? 'usdg' : 'stock'}`}>
                    {isPut ? 'Get test USDG' : 'Get test NVIDIA'}
                  </Link>
                )}
              </span>
            )}
          </div>
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
            <div className="unit-toggle" role="group" aria-label="Quantity unit">
              <button type="button" aria-pressed={!wrappedInput} onClick={() => setQuantityUnit('stock')}>
                <TokenIcon symbol="NVDAx" size={16} />
                NVDAx
              </button>
              <button type="button" aria-pressed={wrappedInput} onClick={() => setQuantityUnit('wrapped')}>
                <TokenIcon symbol="wNVDAx" size={16} />
                wNVDAx
              </button>
            </div>
          </div>
          {calculation.error ? (
            <p id="quantity-error" className="field-error">
              {calculation.error}
            </p>
          ) : (
            <p id="quantity-help" className="input-help">
              {wrappedInput
                ? `≈ ${preview ? amount(preview.stockEquivalent, 18, 6) : '—'} NVDAx at today's rate`
                : `≈ ${preview ? amount(preview.wrappedQuantity, 18, 6) : '—'} wNVDAx · fixed at settlement`}
            </p>
          )}
          {balancesError && (
            <div className="notice" role="status">
              {balancesError}
            </div>
          )}
          <div className="order-summary">
            <div>
              <span>You lock</span>
              <strong>
                {preview
                  ? isPut
                    ? `${amount(preview.strikeAmountUSDG)} USDG`
                    : `${amount(preview.wrappedQuantity, 18, 6)} wNVDAx`
                  : '—'}
              </strong>
            </div>
            <div>
              <span>{config.mode === 'gateway' ? 'Est. premium' : 'Premium'}</span>
              <strong>
                <span data-testid="reference-premium" className={estimate ? 'teal-text' : undefined}>
                  {config.mode !== 'gateway'
                    ? 'Available after quoting'
                    : estimate
                      ? `${amount(estimate.netPremiumUSDG, 6, 6)} USDG`
                      : !references && !referenceError
                        ? 'Loading reference…'
                        : 'Temporarily unavailable'}
                </span>
                {estimatedApr && (
                  <span className="summary-apr">
                    <span data-testid="reference-apr">{estimatedApr}%</span> APR
                  </span>
                )}
              </strong>
            </div>
          </div>
          {config.mode === 'gateway' && (
            <p className="reference-note" role="status">
              {estimate
                ? `${estimate.live ? 'Live market bid' : 'Last valid market bid'} · ${dateTime(
                    estimate.quote.marketTimestampMs / 1000,
                    'America/New_York',
                  )}${estimate.delayed || referenceError ? ' · Updates delayed' : ''} · Final premium confirmed in your quote`
                : referenceError || 'Final premium is confirmed in your quote'}
            </p>
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
          {preview && (
            <details className="technical-details">
              <summary>
                Details <Icon name="chevron" size={14} />
              </summary>
              <dl>
                <dt>Delivery quantity</dt>
                <dd>{precise(preview.wrappedQuantity)} wNVDAx</dd>
                <dt>Settlement amount</dt>
                <dd>{precise(preview.strikeAmountUSDG, 6)} USDG</dd>
                {config.mode !== 'demo' && (
                  <>
                    <dt>Price per wNVDAx</dt>
                    <dd>{precise(preview.series.strikePricePerWrappedUSDG, 6)} USDG</dd>
                  </>
                )}
                <dt>Wrapping rate</dt>
                <dd data-testid="wrapping-rate">1 wNVDAx = {market && precise(market.rate)} NVDAx</dd>
                <dt>Trading cutoff</dt>
                <dd>{dateTime(preview.series.tradeCutoff, timeZone)}</dd>
                <dt>Exercise window</dt>
                <dd>
                  {dateTime(preview.series.exerciseStart, timeZone)} ·{' '}
                  {(Number(preview.series.exerciseEnd) - Number(preview.series.exerciseStart)) / 60} min
                </dd>
                {config.mode !== 'demo' && (
                  <>
                    <dt>Onchain</dt>
                    <dd>
                      Series #{preview.series.id} ·{' '}
                      <a
                        href={`${config.explorerUrl}/address/${config.nvdaVault}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Vault <Icon name="external" size={11} />
                      </a>
                      {market && (
                        <>
                          {' · '}
                          <a
                            href={`${config.explorerUrl}/address/${market.exchange}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Exchange <Icon name="external" size={11} />
                          </a>
                        </>
                      )}
                    </dd>
                  </>
                )}
              </dl>
              <p>
                The dealer chooses whether to exercise; reaching the target does not settle automatically.
                Once the order opens, the wrapped quantity and settlement amount are fixed, while the NVDAx
                equivalent follows the wrapping rate. Underlying rights affected by dividends and splits
                transfer with the wrapped tokens.
                {config.mode === 'gateway' &&
                  ` APR is the net premium divided by the ${isPut ? 'USDG you lock' : 'sale proceeds'}, annualized over the time to expiry (simple, not compounded).`}
                {config.mode !== 'demo' && ' tNVDAx and twNVDAx are test tokens with no real value.'}
              </p>
            </details>
          )}
        </section>
      </div>
      <div className={`order-dock${dock ? ' visible' : ''}`}>
        <div>
          <strong>
            {isPut ? 'Buy Low' : 'Sell High'} · {displayTarget === null ? '—' : amount(displayTarget)} USDG
          </strong>
          <span>
            {estimate && estimatedApr
              ? `${amount(estimate.netPremiumUSDG)} USDG premium · ${estimatedApr}% APR`
              : series
                ? `Expires ${dateOnly(series.exerciseEnd, timeZone)}`
                : 'No open series'}
          </span>
        </div>
        <button
          type="button"
          className="button primary"
          onClick={() => orderCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          Review order
        </button>
      </div>
      <Modal
        open={dialog === 'assets'}
        onClose={() => {
          if (!busy) setDialog(null);
        }}
        title="Prepare your assets"
        eyebrow="Step 1 of 2 · Assets"
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
        eyebrow="Step 2 of 2 · Quote"
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
              <span>Premium · paid upfront</span>
              <strong>
                {amount(terms.netPremiumUSDG, 6, 4)} <small>USDG</small>
              </strong>
              <p>{quotedApr ? `${quotedApr}% APR` : '— APR'}</p>
            </div>
            <div className="receipt-list">
              <div>
                <span>Strategy</span>
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
        eyebrow={config.mode === 'demo' ? 'Demo position opened' : 'Testnet position opened'}
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
            ? 'View the terms in Portfolio, or simulate both outcomes and claim your assets.'
            : 'Track your position and claim your assets after exercise or expiry.'}
        </p>
        <Link href="/positions" className="button primary full" onClick={() => setDialog(null)}>
          View portfolio <Icon name="arrow" size={17} />
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
