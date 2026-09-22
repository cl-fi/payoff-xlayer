# Payoff self-operated dealer

A separate Node.js process implements the gateway's existing dealer HTTP protocol. It reads option NBBO from ThetaData, retains each contract's last valid bid for 24/7 pricing, and signs EIP-712 v2 quotes with the shared `sdk/quotes.mjs`. The gateway still owns collection, ranking, funding validation and fill simulation; it has no pricing key or market-data credential.

## Pricing rule

Buy Low sells a put; Sell High sells a call. Match the configured underlying symbol, the series expiry date in New York and the exact stock-equivalent strike. There is no nearest-strike or nearest-expiry fallback.

```text
stock quantity = wrapper.convertToAssets(requested wrapped quantity)
stock strike   = series wrapped strike / current assets per wrapped unit
target premium = floor(market bid per share × stock quantity × 50%, to 6 decimals)
```

The default `premiumBasis: "net"` makes the target the user's net USDG receipt. For a $1 bid and one stock-equivalent unit, the user receives 0.500000 USDG; with a 1% Exchange fee the dealer pays 0.505050 USDG, including 0.005050 USDG protocol fee. Set `premiumBasis: "gross"` if the target should be before fees instead: gross 0.500000, fee 0.005000, net 0.495000. All financial arithmetic uses integers; the fee matches Solidity's floor rounding. USD and USDG are assumed 1:1 for this initial pricing rule.

Option bid is quoted **per share**. Do not multiply by the standard listed-option contract size of 100. Fractional wrapped quantities are supported. The wrapper and its underlying must both use 18 decimals, matching the current protocol. A stock-equivalent strike that is not exactly representable on the option strike grid declines rather than silently rounding.

The current testnet uses test NVDA assets with a 1:1 wrapper. A listed NVDA option is a pricing reference: it does not have identical exercise, token/custody or corporate-action terms to this Vault product. This service does not model those differences, IV, Greeks, inventory, hedging, funding, splits or dividends. It does not trade at a broker, hedge or exercise positions automatically.

## 24/7 reference bids and failure behavior

- Query ThetaData's latest NBBO snapshot for the exact contract. A valid bid remains usable after market close, over weekends/holidays and after the freshness threshold. There is no age-based cutoff for reuse before the series trading cutoff.
- Persist the latest valid observation keyed by symbol, expiration, put/call and strike. Never substitute another contract or overwrite a valid observation with an older, zero-size, crossed, malformed or future-dated quote. Restarting or replacing the container preserves the cache.
- ThetaData clears snapshots at midnight ET. If its snapshot has no valid bid, query available history dates for the same contract, newest first. Search tick quotes backwards from the session's end and retain the latest valid bid with its original timestamp. This supports first requests on weekends without a pre-existing local cache. If the provider is unavailable or times out, reuse the persisted bid; if neither source contains a valid bid, return `NO_VALID_BID_HISTORY`.
- Use the vendor's exchange calendar in `America/New_York` to validate the observation's original session, including holidays and early closes. The series exercise end must still match the reference expiry day's market close.
- Require positive bid and bid size and a non-crossed quote. `maxQuoteAgeSeconds` (30 by default) now labels observations as `live` or `last_valid` in audit logs; it no longer rejects old bids. Logs preserve `marketTimestampMs`, `marketAgeMs`, `referenceSource` and any fallback reason. The existing gateway quote payload/signature schema is unchanged.
- Every RFQ creates a new signature. Its deadline is the earliest of the configured TTL (30 seconds), series trade cutoff or reference option expiry. The old market-data timestamp and daily market close do not shorten this TTL. Reject windows with at most three seconds remaining.
- Read chain terms, fee, wrapper conversion, whitelist and pause state independently; supplied request snapshots cannot change pricing terms. Check the dealer's premium balance and allowance before signing. The gateway rechecks them and simulates execution.
- No funds are reserved. Multiple outstanding quotes can still compete for the same dealer balance. Quote nonces are cryptographically random 256-bit values and checked/consumed by the Exchange.
- Expired/closed-to-new-position series, unavailable funds, mismatched terms or absence of any valid bid still return `no_quote`. Reusing a bid does not extend an expired RFQ signature or reopen an expired series.

## Service layout

| File | Purpose |
| --- | --- |
| `src/pricing.mjs` | Contract matching, integer premium/fee calculation and freshness |
| `src/market.mjs` | Durable last-valid-bid cache, exact-contract fallback and ordered updates |
| `src/chain.mjs` | Authoritative chain terms, wrapper conversion and premium funding |
| `src/app.mjs` | Authenticated `/quote`, shared EIP-712 signing and health routes |
| `src/theta.mjs` | Bounded requests, timeouts and restart of the data adapter |
| `theta/worker.py` | Official ThetaData Python client; calendar and quote snapshots |
| `theta/market_data.py` | Snapshot validation and historical tick lookup for 24/7 pricing |

The Python adapter is a private child process using newline-delimited JSON on stdin/stdout. It has no network listener and never receives the dealer signing key. The official Python library connects directly to ThetaData, so this path needs no Theta Terminal. Up to four market-data requests can run concurrently; these are operating limits, not asset or position caps. Auth/market-data SDK logs and raw upstream errors are suppressed to avoid disclosing session credentials.

`GET /healthz` reports process liveness. `GET /readyz` checks chain admission and availability of the data adapter or a saved reference; individual contracts may still have no valid history. The gateway's readiness is separate from the dealer's readiness. `POST /quote` requires `Authorization: Bearer <SELF_DEALER_API_TOKEN>`. Do not publish the dealer port; only the gateway is public.

`DEALER_BID_CACHE_PATH` selects the cache file (default `data/last-valid-bids.json` within the dealer working directory). Compose stores it in the `dealer_data` volume at `/var/lib/payoff-dealer/last-valid-bids.json`. Updates serialize writes and atomically replace a synced file before using the newer bid. One dealer process owns the file; do not share it between replicas. Keep this volume on restart/redeploy and include it in backups.

## Run and test

From the repository root:

```sh
npm ci
python3 -m venv dealer/.venv
dealer/.venv/bin/pip install -r dealer/requirements.txt
cp dealer/config.example.json dealer/config.local.json
cp dealer/.env.example dealer/.env
# Set the dedicated dealer key, ThetaData key, shared token and RPC in the local file.
node --env-file=dealer/.env dealer/src/main.mjs
npm run test:dealer
python3 -m unittest discover -s dealer/test -p '*_test.py'
npm run test:gateway:integration
```

The dependency requires Python 3.12 or newer. Keep the signing key separate from the administrator wallet. Fund the dealer with test USDG, whitelist its address and approve the Exchange before starting it. The example is explicitly X Layer testnet (1952); do not fund test wallets with real assets.

For the VPS, use [the shared Compose deployment](../gateway/deploy/compose.yaml). Copy `gateway/deploy/dealer.env.example` to `gateway/deploy/dealer.env` and set owner-only permissions. Only the dealer container receives this file. The gateway receives an explicit allowlist of environment variables. Use a ThetaData subscription/license appropriate for the intended use.

Official integration references: [Python client](https://docs.thetadata.us/Python-Library/Getting-Started.html), [quote snapshot](https://docs.thetadata.us/operations_python/option_snapshot_quote.html), [quote history](https://docs.thetadata.us/operations_python/option_history_quote.html), [available history dates](https://docs.thetadata.us/operations_python/option_list_dates.html), [exchange calendar](https://docs.thetadata.us/operations_python/calendar_on_date.html).
