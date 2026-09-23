'use client';

import { memo, useEffect, useRef, useState } from 'react';

const NVIDIA_URL = 'https://www.tradingview.com/symbols/NASDAQ-NVDA/';

export const NvidiaPriceChart = memo(function NvidiaPriceChart() {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!host.current) return;

    // Give each mount its own container so Strict Mode and route changes clean up safely.
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    container.appendChild(widget);
    host.current.appendChild(container);

    let frame: HTMLIFrameElement | null = null;
    const timeout = window.setTimeout(() => setStatus('error'), 25000);
    const onFrameLoad = () => {
      window.clearTimeout(timeout);
      setStatus('ready');
    };
    const observer = new MutationObserver(() => {
      frame = container.querySelector('iframe');
      if (!frame) return;
      frame.title = 'NVIDIA stock price chart by TradingView';
      frame.addEventListener('load', onFrameLoad, { once: true });
      observer.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true });

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js';
    script.type = 'text/javascript';
    script.async = true;
    script.textContent = JSON.stringify({
      symbols: [['NVIDIA', 'NASDAQ:NVDA|1D']],
      autosize: true,
      width: '100%',
      height: '100%',
      locale: 'en',
      colorTheme: 'light',
      isTransparent: true,
      chartOnly: false,
      chartType: 'area',
      lineColor: '#3a4552',
      topColor: 'rgba(20, 32, 42, 0.08)',
      bottomColor: 'rgba(20, 32, 42, 0)',
      lineWidth: 2,
      lineType: 0,
      fontColor: '#667080',
      widgetFontColor: '#14202a',
      gridLineColor: 'rgba(226, 229, 232, 0.6)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif',
      fontSize: '11',
      headerFontSize: 'medium',
      showVolume: false,
      showMA: false,
      hideDateRanges: false,
      hideMarketStatus: true,
      hideSymbolLogo: true,
      scalePosition: 'right',
      scaleMode: 'Normal',
      noTimeScale: false,
      valuesTracking: '1',
      changeMode: 'price-and-percent',
      dateRanges: ['1d|1', '1w|15', '1m|30', '3m|60', '12m|1D', 'all|1M'],
      dateFormat: 'MMM dd, yyyy',
      timeHoursFormat: '12-hours',
    });
    script.onerror = () => {
      window.clearTimeout(timeout);
      setStatus('error');
    };
    container.appendChild(script);

    return () => {
      window.clearTimeout(timeout);
      observer.disconnect();
      frame?.removeEventListener('load', onFrameLoad);
      script.onerror = null;
      container.remove();
    };
  }, []);

  return (
    <figure className="nvda-chart" aria-label="NVIDIA stock price chart">
      <div className="nvda-chart-frame">
        <div className="nvda-chart-host" ref={host} />
        {status !== 'ready' && (
          <div className="nvda-chart-status" role="status">
            {status === 'loading' ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Loading NVIDIA price chart…
              </>
            ) : (
              <>
                <span>The price chart could not load.</span>
                <a href={NVIDIA_URL} target="_blank" rel="noopener noreferrer">
                  View NVIDIA on TradingView
                </a>
              </>
            )}
          </div>
        )}
      </div>
      <figcaption className="nvda-chart-caption">
        <span className="tradingview-widget-copyright">
          <a href={NVIDIA_URL} target="_blank" rel="noopener nofollow">
            NVIDIA stock price
          </a>{' '}
          by TradingView
        </span>
        <span>May be delayed</span>
      </figcaption>
    </figure>
  );
});
