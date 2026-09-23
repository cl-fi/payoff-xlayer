'use client';
import { useState } from 'react';

// Two settlement scenarios for the current order, with an illustrative price path. The figures are the
// order's fixed terms; the path is a drawing, not a forecast. The dealer decides whether to exercise.
const START_X = 60,
  END_X = 660,
  TARGET_Y = 150,
  ABOVE_Y = 84,
  BELOW_Y = 222;

type Outcome = 'above' | 'below';

export function ScenarioPreview({
  isPut,
  unit,
  approximate,
  target,
  quantity,
  usdg,
  premium,
  total,
  expiry,
}: {
  isPut: boolean;
  unit: string;
  approximate: boolean;
  target: string | null;
  quantity: string | null;
  usdg: string | null;
  premium: string | null;
  total: string | null;
  expiry: string | null;
}) {
  const [scenario, setScenario] = useState<Outcome>('above');
  const above = scenario === 'above';
  const startY = isPut ? 118 : 182;
  const endY = above ? ABOVE_Y : BELOW_Y;
  const path = `M${START_X},${startY} C170,${startY - 60} 250,${startY + 70} 350,${TARGET_Y} S560,${endY + (above ? 30 : -30)} ${END_X},${endY}`;
  const q = quantity ? `${approximate ? '≈ ' : ''}${quantity} ${unit}` : '—';
  const money = (value: string | null) => (value ? `${value} USDG` : '—');
  const premiumRow = {
    label: 'Premium · paid upfront',
    value: premium ? `+${premium} USDG` : 'Set by dealer quote',
    muted: !premium,
  };
  const cards: {
    key: Outcome;
    title: string;
    verdict: string;
    rows: { label: string; value: string; muted?: boolean; strong?: boolean }[];
  }[] = [
    {
      key: 'above',
      title: `Above ${target ?? '—'}`,
      verdict: isPut
        ? 'Expires unexercised · you keep your USDG'
        : 'Dealer may exercise · you sell at the target',
      rows: isPut
        ? [
            { label: 'USDG returned', value: money(usdg) },
            premiumRow,
            { label: 'Total', value: total ? `${total} USDG` : `${money(usdg)} + premium`, strong: true },
          ]
        : [
            { label: `${unit} sold`, value: q },
            { label: '× Target price', value: money(target) },
            { label: 'Sale proceeds', value: money(usdg) },
            premiumRow,
            { label: 'Total', value: total ? `${total} USDG` : `${money(usdg)} + premium`, strong: true },
          ],
    },
    {
      key: 'below',
      title: `At or below ${target ?? '—'}`,
      verdict: isPut
        ? 'Dealer may exercise · you buy at the target'
        : 'Expires unexercised · you keep your stock',
      rows: isPut
        ? [
            { label: 'USDG locked', value: money(usdg) },
            { label: '÷ Target price', value: money(target) },
            { label: 'You buy', value: q },
            premiumRow,
            { label: 'You hold', value: `${q} + ${premium ? `${premium} USDG` : 'premium'}`, strong: true },
          ]
        : [
            { label: `${unit} returned`, value: q },
            premiumRow,
            { label: 'You hold', value: `${q} + ${premium ? `${premium} USDG` : 'premium'}`, strong: true },
          ],
    },
  ];
  const chip = isPut
    ? above
      ? `Keep ${money(usdg)}`
      : `Buy ${q} at ${target ?? '—'}`
    : above
      ? `Sell for ${money(usdg)}`
      : `Keep ${q}`;
  return (
    <figure className="scenario-panel" aria-label="Settlement scenarios">
      <div className="chart-heading">
        <span>At expiry{expiry ? ` · ${expiry}` : ''}</span>
        <span>Illustrative</span>
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
          Target <b>{target ?? '—'}</b>
        </span>
        <span
          className="scenario-dot start"
          style={{ left: `${(START_X / 720) * 100}%`, top: `${(startY / 300) * 100}%` }}
        />
        <span
          className="scenario-dot end"
          style={{ left: `${(END_X / 720) * 100}%`, top: `${(endY / 300) * 100}%` }}
        />
        <span className="scenario-chip" style={{ top: `${(endY / 300) * 100}%` }}>
          {chip}
        </span>
      </div>
      <div className="scenario-axis">
        <span>Today</span>
        <span>Expiry</span>
      </div>
      <div className="scenario-outcomes">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            className={`scenario-outcome ${scenario === card.key ? 'selected' : ''}`}
            aria-pressed={scenario === card.key}
            data-testid={`scenario-${card.key}`}
            onClick={() => setScenario(card.key)}
          >
            <span className="scenario-outcome-head">
              <strong>{card.title}</strong>
              <small>{card.verdict}</small>
            </span>
            <span className="scenario-receipt">
              {card.rows.map((row) => (
                <span key={row.label} className={row.strong ? 'strong' : row.muted ? 'muted' : undefined}>
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </figure>
  );
}
