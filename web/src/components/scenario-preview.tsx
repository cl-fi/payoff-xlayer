'use client';
import { useState, type ReactNode } from 'react';
import { amount } from '@/lib/amounts';
import { TokenIcon } from './token-icon';

// One settlement outcome at a time for the current order, chosen with the toggle above an illustrative
// price path. The figures are the order's fixed terms; the path is a drawing, not a forecast. Exercise is
// the dealer's decision (see Details); at exactly the target the order is shown as settling in USDG.
const START_X = 60,
  END_X = 660,
  TARGET_Y = 150,
  ABOVE_Y = 105,
  BELOW_Y = 180;

type Outcome = 'above' | 'below';

export function ScenarioPreview({
  isPut,
  unit,
  approximate,
  target,
  quantity,
  usdg,
  premium,
  premiumLabel,
  premiumStatus,
  apr,
  start,
  settle,
}: {
  isPut: boolean;
  unit: string;
  approximate: boolean;
  target: string | null;
  quantity: string | null;
  /** USDG collateral (Buy Low) or sale proceeds (Sell High), in USDG base units. */
  usdg: string | null;
  /** Net premium in USDG base units, or null while it is unknown. */
  premium: string | null;
  premiumLabel: string;
  /** Shown in place of the premium while it is unknown. */
  premiumStatus: string;
  apr: string | null;
  start: string | null;
  settle: string | null;
}) {
  const [scenario, setScenario] = useState<Outcome>('above');
  const above = scenario === 'above';
  const startY = isPut ? 118 : 182;
  const endY = above ? ABOVE_Y : BELOW_Y;
  const path = `M${START_X},${startY} C170,${startY - 60} 250,${startY + 70} 350,${TARGET_Y} S560,${endY + (above ? 30 : -30)} ${END_X},${endY}`;
  const q = quantity ? `${approximate ? '≈ ' : ''}${quantity} ${unit}` : '—';
  // USDG figures are shown to two decimals; the exact settlement amount stays in Details.
  const moneyText = (value: string | null) => (value ? `${amount(value)} USDG` : '—');
  // Asset rows carry the token logo; prices and figures stay plain text.
  const money = (value: string | null) =>
    value ? (
      <span className="asset-amount">
        <TokenIcon symbol="USDG" size={14} />
        {moneyText(value)}
      </span>
    ) : (
      '—'
    );
  const stock = (
    <span className="asset-amount">
      <TokenIcon symbol={unit} size={14} />
      {q}
    </span>
  );
  const price = target ? `${target} USDG` : '—';
  const total = usdg && premium ? (BigInt(usdg) + BigInt(premium)).toString() : null;
  // Settlement in USDG (unexercised Buy Low, exercised Sell High) or in stock plus the premium.
  const cashText = total ? moneyText(total) : `${moneyText(usdg)} + premium`;
  const stockText = `${q} + ${premium ? moneyText(premium) : 'premium'}`;
  const cash = total ? money(total) : <>{money(usdg)} + premium</>;
  const stockAndPremium = (
    <>
      {stock} + {premium ? money(premium) : 'premium'}
    </>
  );
  // The unexercised side includes the target itself: "At or above" for Buy Low, "At or below" for Sell High.
  const label = (key: Outcome) => {
    const held = isPut === (key === 'above');
    const word = key === 'above' ? (held ? 'At or above' : 'Above') : held ? 'At or below' : 'Below';
    return `${word} ${target ?? '—'}`;
  };
  const rows: { label: string; value: ReactNode }[] = isPut
    ? above
      ? [{ label: 'Deposit', value: money(usdg) }]
      : [
          { label: 'Deposit', value: money(usdg) },
          { label: '÷ Target price', value: price },
        ]
    : above
      ? [
          { label: 'Deposit', value: stock },
          { label: '× Target price', value: price },
          { label: 'Sale proceeds', value: moneyText(usdg) },
        ]
      : [{ label: 'Deposit', value: stock }];
  return (
    <figure className="scenario-panel" aria-label="Settlement scenarios">
      <div className="scenario-toggle" role="group" aria-label="Settlement outcome">
        {(['above', 'below'] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={scenario === key}
            data-testid={`scenario-${key}`}
            onClick={() => setScenario(key)}
          >
            {label(key)}
          </button>
        ))}
      </div>
      <div className={`scenario-plot ${isPut ? 'put' : 'call'}`}>
        <svg viewBox="0 0 720 300" preserveAspectRatio="none" aria-hidden="true">
          <line className="scenario-grid" x1={START_X} x2={START_X} y1="0" y2="300" />
          <line className="scenario-grid" x1={END_X} x2={END_X} y1="0" y2="300" />
          <line className="scenario-target-line" x1="0" x2="720" y1={TARGET_Y} y2={TARGET_Y} />
          <path className="scenario-area" d={`${path} L${END_X},300 L${START_X},300 Z`} />
          <path className="scenario-path" d={path} />
        </svg>
        <span className="scenario-target" style={{ top: `${(TARGET_Y / 300) * 100}%` }}>
          Target price <b>{target ?? '—'}</b>
        </span>
        <span
          className="scenario-dot start"
          style={{ left: `${(START_X / 720) * 100}%`, top: `${(startY / 300) * 100}%` }}
        />
        <span
          className="scenario-dot end"
          style={{ left: `${(END_X / 720) * 100}%`, top: `${(endY / 300) * 100}%` }}
        />
        <p className="scenario-note">Illustrative only</p>
        <span className={`scenario-bubble${above ? '' : ' below'}`} style={{ top: `${(endY / 300) * 100}%` }}>
          <small>You receive</small>
          <b>{above ? cashText : stockText}</b>
        </span>
      </div>
      <div className="scenario-axis">
        <span>
          Start<b>{start ?? '—'}</b>
        </span>
        <span>
          Settle<b>{settle ?? '—'}</b>
        </span>
      </div>
      <div className="scenario-result" data-testid="scenario-outcome" aria-live="polite">
        <div className="scenario-receipt">
          {rows.map((row) => (
            <span key={row.label}>
              <span>{row.label}</span>
              <span>{row.value}</span>
            </span>
          ))}
          <span className={premium ? undefined : 'muted'}>
            <span>{premiumLabel} · paid upfront</span>
            <span>
              <span
                data-testid="reference-premium"
                className={premium ? 'scenario-premium teal-text' : undefined}
              >
                {premium ? moneyText(premium) : premiumStatus}
              </span>
              {apr && (
                <span className="scenario-apr">
                  <span data-testid="reference-apr">{apr}%</span> APR
                </span>
              )}
            </span>
          </span>
          <span className="strong">
            <span>You receive</span>
            {/* Above the target settles in USDG on both sides (Buy Low unexercised, Sell High sold). */}
            <span>{above ? cash : stockAndPremium}</span>
          </span>
        </div>
      </div>
    </figure>
  );
}
