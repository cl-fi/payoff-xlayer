'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dateOnly, dateTime } from '@/lib/amounts';
import { DAY_MS, chartWindow, fetchCandles, type Candle } from '@/lib/price-history';
import type { ReferenceSchedule } from './provider';

export type ChartTarget = { key: string; price: number; apr: string | null };

const HEIGHT = 280,
  AXIS = 64,
  TOP = 12,
  BOTTOM = 24;
// Targets further than this from the market are pinned to the edge instead of flattening the price line.
const TARGET_RANGE = 0.2;
// Used only when there is no reference poll to follow (demo and testnet modes).
const REFRESH_MS = 60_000;

const price2 = (n: number) => n.toFixed(2);
const signed = (n: number, digits = 2) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`;

function niceTicks(lo: number, hi: number, count = 6) {
  const raw = (hi - lo) / count,
    magnitude = 10 ** Math.floor(Math.log10(raw)),
    step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return ticks;
}

function usePriceHistory(
  coin: string,
  interval: string,
  intervalMs: number,
  lookbackDays: number,
  ready: boolean,
  // The reference poll round to follow; each new round refetches. Null polls on its own timer.
  round: number | null,
) {
  const [state, setState] = useState<{ key: string; candles: Candle[] | null; failed: boolean }>({
    key: '',
    candles: null,
    failed: false,
  });
  const key = `${coin}|${interval}|${lookbackDays}`;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const load = () =>
      fetchCandles(coin, { interval, intervalMs, lookbackDays }, Date.now(), controller.signal).then(
        (candles) => setState({ key, candles, failed: false }),
        () => {
          // A failed refresh keeps the last good history for this window.
          if (!controller.signal.aborted)
            setState((s) => (s.key === key && s.candles ? s : { key, candles: null, failed: true }));
        },
      );
    void load();
    const timer = round === null ? setInterval(load, REFRESH_MS) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [coin, interval, intervalMs, lookbackDays, key, ready, round]);
  return state.key === key ? state : { key, candles: null, failed: false };
}

// Drains over the poll interval; restarts whenever a new poll is scheduled. Click to refresh now.
function RefreshRing({
  schedule,
  nowMs,
  onRefresh,
}: {
  schedule: ReferenceSchedule;
  nowMs: number;
  onRefresh: () => void;
}) {
  const pending = schedule.nextAtMs === null;
  const left = pending ? 0 : Math.min(schedule.intervalMs, Math.max(0, schedule.nextAtMs! - nowMs)) / 1000;
  return (
    <button
      type="button"
      className={`refresh-ring${pending ? ' refreshing' : ''}`}
      onClick={onRefresh}
      disabled={pending}
      aria-label="Refresh price"
      title={pending ? 'Refreshing…' : `Refreshes in ${Math.ceil(left)}s · click to refresh now`}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle className="track" cx="10" cy="10" r="7.5" />
        <circle
          key={schedule.nextAtMs ?? 'pending'}
          className="progress"
          cx="10"
          cy="10"
          r="7.5"
          pathLength={100}
          transform="rotate(-90 10 10)"
          style={pending ? undefined : { animationDuration: `${schedule.intervalMs}ms` }}
        />
      </svg>
    </button>
  );
}

export function PriceChart({
  coin,
  side,
  nowMs,
  expiryMs,
  expiryLabel,
  targets,
  selected,
  highlighted,
  reference,
  onSelect,
  onHighlight,
}: {
  coin: string;
  side: 0 | 1;
  nowMs: number;
  expiryMs: number | null;
  expiryLabel: string | null;
  targets: ChartTarget[];
  selected: string | null;
  highlighted: string | null;
  // Gateway mode: the oracle reference that offers are selected against, shown as the headline price.
  reference: { price: number | null; schedule: ReferenceSchedule | null; onRefresh: () => void } | null;
  onSelect: (key: string) => void;
  onHighlight: (key: string | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pointerX, setPointerX] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { lookbackDays, interval, intervalMs } = chartWindow(nowMs, expiryMs);
  const history = usePriceHistory(
    coin,
    interval,
    intervalMs,
    lookbackDays,
    // In gateway mode wait for the first poll round, so the first history load is not fetched twice.
    nowMs > 0 && (!reference || !!reference.schedule),
    reference ? (reference.schedule?.round ?? 0) : null,
  );
  const startMs = nowMs - lookbackDays * DAY_MS;
  const candles = (history.candles ?? []).filter((c) => c.timeMs >= startMs && c.timeMs <= nowMs);
  const last = reference ? reference.price : (candles.at(-1)?.close ?? null);
  const first = candles[0]?.close ?? null;
  const active = targets.find((t) => t.key === (highlighted ?? selected)) ?? null;

  const header = (
    <div
      className={`price-chart-header${reference ? ' market-reference' : ''}`}
      role={reference ? 'status' : undefined}
    >
      <div className="price-chart-quote">
        <strong>{last === null ? (reference ? 'Temporarily unavailable' : '—') : price2(last)}</strong>
        {last !== null && <span className="price-chart-unit">USD</span>}
        {last !== null && first !== null && (
          <span className={last >= first ? 'price-chart-change up' : 'price-chart-change down'}>
            {signed(last - first)} {signed(((last - first) / first) * 100)}% <small>{lookbackDays}d</small>
          </span>
        )}
      </div>
      {reference?.schedule && (
        <RefreshRing schedule={reference.schedule} nowMs={nowMs} onRefresh={reference.onRefresh} />
      )}
    </div>
  );

  const plotWidth = Math.max(0, width - AXIS);
  const endMs = expiryMs !== null && expiryMs > nowMs ? expiryMs : nowMs;
  const x = (ms: number) => ((ms - startMs) / (endMs - startMs)) * plotWidth;
  const series =
    last !== null && reference ? [...candles.map((c) => c.close), last] : candles.map((c) => c.close);
  const ready = width > 0 && candles.length > 1 && nowMs > 0;

  let body = null,
    detachedNote: string | null = null;
  if (ready) {
    const anchor = last ?? candles.at(-1)!.close;
    const near = targets.filter((t) => Math.abs(t.price - anchor) / anchor <= TARGET_RANGE);
    let lo = Math.min(...series, ...near.map((t) => t.price)),
      hi = Math.max(...series, ...near.map((t) => t.price));
    const pad = Math.max((hi - lo) * 0.08, anchor * 0.005);
    lo -= pad;
    hi += pad;
    const y = (p: number) => TOP + ((hi - p) / (hi - lo)) * (HEIGHT - TOP - BOTTOM);
    const inRange = (p: number) => p >= lo && p <= hi;
    const bottom = HEIGHT - BOTTOM,
      nowX = x(nowMs),
      endX = x(endMs);
    const points = candles.map((c) => [x(c.timeMs), y(c.close)] as const);
    if (reference && last !== null) points.push([nowX, y(last)]);
    const line = points.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    const area = `${line}L${points.at(-1)![0].toFixed(1)},${bottom}L${points[0][0].toFixed(1)},${bottom}Z`;
    const activeY = active && inRange(active.price) ? y(active.price) : null;
    const distance = active ? ((active.price - anchor) / anchor) * 100 : 0;
    const activeNote = active
      ? `${active.apr ? `${active.apr} APR · ` : ''}${signed(distance, 1)}% from now`
      : '';
    // On narrow plots the note would run over the price line, so it moves above the chart.
    const noteWidth = activeNote.length * 6.8 + 12;
    const noteFits = activeY !== null ? endX - nowX >= noteWidth : plotWidth >= noteWidth + 48;
    if (active && !noteFits) detachedNote = `${price2(active.price)} target · ${activeNote}`;

    // Crosshair over the history: nearest candle to the pointer.
    let crosshair = null;
    if (pointerX !== null && pointerX <= nowX) {
      const ms = startMs + (pointerX / plotWidth) * (endMs - startMs);
      const c = candles.reduce((a, b) => (Math.abs(b.timeMs - ms) < Math.abs(a.timeMs - ms) ? b : a));
      const cx = x(c.timeMs),
        cy = y(c.close),
        label = `${price2(c.close)} · ${dateTime(c.timeMs / 1000)}`,
        boxWidth = label.length * 6.4 + 16,
        boxX = Math.min(Math.max(cx - boxWidth / 2, 0), plotWidth - boxWidth);
      crosshair = (
        <g className="price-chart-crosshair" aria-hidden="true">
          <line x1={cx} x2={cx} y1={TOP} y2={bottom} />
          <circle cx={cx} cy={cy} r={3.5} />
          <rect x={boxX} y={0} width={boxWidth} height={20} rx={4} />
          <text x={boxX + boxWidth / 2} y={14} textAnchor="middle">
            {label}
          </text>
        </g>
      );
    }

    const startLabel = dateOnly(startMs / 1000);
    const showNow = endX - nowX > 44 && nowX > 56;
    body = (
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`NVDAx price over the last ${lookbackDays} days with ${targets.length} target prices${
          active ? `; ${price2(active.price)} USDG target expiring ${expiryLabel}` : ''
        }`}
        onPointerMove={(e) => setPointerX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
        onPointerLeave={() => setPointerX(null)}
      >
        {endX > nowX && (
          <rect className="price-chart-future" x={nowX} y={TOP} width={endX - nowX} height={bottom - TOP} />
        )}
        {activeY !== null && endX > nowX && (
          <rect
            className="price-chart-zone"
            x={nowX}
            y={side === 0 ? activeY : TOP}
            width={endX - nowX}
            height={side === 0 ? bottom - activeY : activeY - TOP}
          />
        )}
        {niceTicks(lo, hi).map((t) => (
          <g key={t} className="price-chart-grid">
            <line x1={0} x2={plotWidth} y1={y(t)} y2={y(t)} />
            <text x={plotWidth + 8} y={y(t) + 4}>
              {t.toFixed(t % 1 ? 1 : 0)}
            </text>
          </g>
        ))}
        <path className="price-chart-area" d={area} />
        <path className="price-chart-line" d={line} />
        {near
          .filter((t) => inRange(t.price))
          .map((t) => {
            const on = t.key === active?.key,
              ty = y(t.price);
            return (
              <g
                key={t.key}
                className={`price-chart-target${on ? ' active' : ''}${t.key === selected ? ' selected' : ''}`}
                data-target={price2(t.price)}
                onPointerEnter={() => onHighlight(t.key)}
                onPointerLeave={() => onHighlight(null)}
                onClick={() => onSelect(t.key)}
              >
                <line x1={0} x2={endX} y1={ty} y2={ty} />
                <line className="hit" x1={0} x2={width} y1={ty} y2={ty} />
              </g>
            );
          })}
        {nowX > 0 && <line className="price-chart-now" x1={nowX} x2={nowX} y1={TOP} y2={bottom} />}
        {endX > nowX && <line className="price-chart-expiry" x1={endX} x2={endX} y1={TOP} y2={bottom} />}
        {last !== null && <circle className="price-chart-dot" cx={nowX} cy={y(last)} r={4} />}
        {active && activeY !== null && (
          <g className="price-chart-label" aria-hidden="true">
            <rect x={plotWidth + 2} y={activeY - 10} width={AXIS - 2} height={20} rx={4} />
            <text className="pill" x={plotWidth + AXIS / 2 + 1} y={activeY + 4} textAnchor="middle">
              {price2(active.price)}
            </text>
            {noteFits && (
              <text
                className="note"
                x={endX - 6}
                y={side === 0 ? activeY + 15 : activeY - 7}
                textAnchor="end"
              >
                {activeNote}
              </text>
            )}
          </g>
        )}
        {active && activeY === null && noteFits && (
          <text
            className="price-chart-offscale"
            x={plotWidth - 4}
            y={active.price < lo ? bottom - 6 : TOP + 14}
            textAnchor="end"
          >
            {`${active.price < lo ? '↓' : '↑'} ${price2(active.price)} · ${activeNote}`}
          </text>
        )}
        {crosshair}
        <g className="price-chart-axis">
          <text x={0} y={HEIGHT - 6}>
            {startLabel}
          </text>
          {showNow && (
            <text x={nowX} y={HEIGHT - 6} textAnchor="middle">
              Now
            </text>
          )}
          {endX > nowX && expiryLabel && (
            <text className="expiry" x={Math.min(endX, plotWidth - 4)} y={HEIGHT - 6} textAnchor="end">
              {expiryLabel}
            </text>
          )}
        </g>
      </svg>
    );
  }

  return (
    <figure className="nvda-chart price-chart" aria-label="NVDAx price chart">
      {header}
      {detachedNote && <p className="price-chart-note">{detachedNote}</p>}
      <div className="nvda-chart-frame" ref={frame}>
        {body}
        {!ready && (
          <div className="nvda-chart-status" role="status">
            {history.failed ? (
              <span>Price history is temporarily unavailable. Retrying…</span>
            ) : (
              <>
                <span className="spinner" aria-hidden="true" />
                Loading price history…
              </>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}
