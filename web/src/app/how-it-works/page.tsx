import Link from 'next/link';
import { Icon, Mark } from '@/components/icon';

export default function HowItWorks() {
  return (
    <div className="page guide-page">
      <section className="page-intro">
        <div>
          <div className="eyebrow">
            <span className="teal-line" /> THE PAYOFF GUIDE
          </div>
          <h1>Know the terms before you start.</h1>
          <p>One premium. Fixed terms. Two possible outcomes.</p>
        </div>
        <Mark size={58} />
      </section>
      <div className="guide-lead">
        <span className="eyebrow">THE IDEA</span>
        <h2>
          You choose your trading terms.
          <br />A dealer pays for the option.
        </h2>
        <p>
          Payoff turns Buy Low and Sell High strategies into clear orders. You deposit full collateral and
          receive a premium when the trade opens. The dealer gets the right to exercise during a defined
          window. The dealer decides whether to exercise; reaching the target price does not trigger an
          automatic trade.
        </p>
      </div>
      <div className="guide-cards">
        <article>
          <span className="guide-number">01 / BUY LOWER</span>
          <Icon name="down" size={28} />
          <h2>Buy Low: put your USDG to work</h2>
          <p>Lock the agreed USDG amount and receive a net premium when the trade opens.</p>
          <div>
            <strong>Dealer exercises</strong>
            <p>The dealer receives your USDG. You can claim the agreed quantity of wrapped stocks.</p>
          </div>
          <div>
            <strong>Expires without exercise</strong>
            <p>Reclaim the USDG you locked and keep the premium.</p>
          </div>
        </article>
        <article>
          <span className="guide-number">02 / SELL HIGHER</span>
          <Icon name="up" size={28} />
          <h2>Sell High: set a price for your holdings</h2>
          <p>Lock the agreed quantity of wrapped stocks and receive a net premium when the trade opens.</p>
          <div>
            <strong>Dealer exercises</strong>
            <p>The dealer receives your wrapped stocks. You can claim the agreed USDG amount.</p>
          </div>
          <div>
            <strong>Expires without exercise</strong>
            <p>Reclaim the wrapped stocks you locked and keep the premium.</p>
          </div>
        </article>
      </div>
      <section className="guide-rules">
        <div>
          <div className="eyebrow">BEFORE YOU START</div>
          <h2>Three details to understand.</h2>
        </div>
        <div>
          <article>
            <span>01</span>
            <div>
              <h3>Enter stock units. Settle in wrapped units.</h3>
              <p>
                The app converts NVDAx into wNVDAx at the current exchange rate. Once opened, the wrapped
                quantity and USDG settlement amount are fixed. The reference target is a stock-unit view at
                that moment, not a permanently fixed price per native stock token.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <h3>Wrapped tokens carry their underlying rights.</h3>
              <p>
                Dividends, splits and reverse splits may change the stock quantity behind each wrapped token.
                The product does not settle those changes separately: the underlying rights transfer with the
                wrapped tokens. Your final assets may differ from simply holding stocks.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <h3>Understand the premium and the outcome.</h3>
              <p>
                Premiums are paid when the trade opens, and the app shows the amount after protocol fees. They
                do not guarantee a positive total return: stock price changes affect the outcome. Assets stay
                locked until exercise or expiry. Quotes can expire or become unexecutable before a trade
                completes.
              </p>
            </div>
          </article>
        </div>
      </section>
      <div className="guide-end">
        <div>
          <h2>Try the full flow with a small order.</h2>
          <p>The demo includes local assets, fixed quotes and simulated settlement outcomes.</p>
        </div>
        <Link href="/" className="button primary">
          Try the demo <Icon name="arrow" size={17} />
        </Link>
      </div>
    </div>
  );
}
