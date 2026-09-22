# Payoff frontend

A Next.js App Router / React / TypeScript frontend for Buy Low and Sell High strategies. The default `gateway` mode connects to the deployed contracts on X Layer Testnet (1952) and `https://api.payoff.finance`, with desktop and mobile layouts. The browser calls the VPS directly and sends transactions through the connected wallet.

## Run locally

From the repository root:

```sh
npm ci
npm run dev:web
```

Open [localhost:3000](http://localhost:3000). Browse the fixed expiry dates and target prices, then connect a browser wallet. Buy Low approves the required test USDG; Sell High wraps only the missing stock quantity and approves wrapped collateral. Request a quote, review the terms and confirm the trade in your wallet. You need test OKB for gas and sufficient collateral.

The public [deployment catalog](../config/xlayer-testnet.json) supplies contract addresses and discovery IDs 5–20. Every series term, token binding, fee and wrapping rate is verified from the RPC at one block. The page excludes series whose trading cutoff has passed, and displays dates in New York time. Prices are contract strikes converted at the current wrapping rate, not live stock prices. Old sample series 1–4 remain onchain but are excluded from this catalog.

The assets tNVDAx and twNVDAx are deployment test tokens, not issuer-backed stocks. USDG is the test token distributed by the OKX faucet. **My positions** recovers positions from Exchange events and Vault state, including series no longer in the active catalog. Eligible positions can be claimed after dealer exercise or expiry. Clearing browser storage does not remove onchain positions. An RPC error clears unavailable data and never falls back to a simulated balance or quote.

## Optional local demo

Set `NEXT_PUBLIC_DATA_MODE=demo` in `web/.env.local` and restart (or rebuild) the app. Select **Connect to get started**, then **Use demo account**.

- Start with 10,000 demo USDG and 8 demo NVDAx.
- Choose a strategy, a 7- or 14-day series and a stock quantity. Prepare assets, then request a fixed quote.
- Review the net premium, protocol fee, fixed wrapped quantity, settlement amount and 90-second quote expiry.
- Confirm a demo trade. Open **My positions**, expand **Simulate an outcome**, then try dealer exercise or expiry without exercise and claim the resulting assets.
- Use **Demo settings** in the footer to try no quotes, expiry, cancellation, failure or an unavailable service, or reset local records.

Demo records live in browser localStorage, separately for each account. Clearing browser data removes them; they are not synchronized to a server. Simulated outcomes skip waiting without changing the original series schedule. Connecting a real browser wallet still uses demo assets: the app reads the approved account and network, but does not request transaction or message signatures.

## Code structure

| Path                                   | Responsibility                                               |
| -------------------------------------- | ------------------------------------------------------------ |
| `src/app/`                             | Routes, layout, metadata and styles                          |
| `src/components/provider.tsx`          | Account, adapter, balances and position state                |
| `src/components/product-page.tsx`      | Orders, asset preparation, quotes and confirmation           |
| `src/components/positions-page.tsx`    | Position details, outcomes and claims                        |
| `src/components/shell.tsx`             | Navigation, environment labels and demo controls             |
| `src/components/modal.tsx`, `icon.tsx` | Shared presentation components                               |
| `src/lib/types.ts`                     | Product models and adapter interface                         |
| `src/lib/amounts.ts`                   | BigInt conversions using the shared SDK                      |
| `src/lib/config.ts`                    | Build-time configuration validation                          |
| `src/lib/wallet.ts`                    | EIP-6963 discovery, wallet connection and network switching  |
| `src/lib/chain.ts`                     | Contract ABIs, balances and fill-calldata validation         |
| `src/lib/transactions.ts`              | Wallet guards, approvals, wrapping, fills and claims         |
| `src/lib/activity.ts`                  | Pending transaction journal and receipt recovery             |
| `src/lib/data/positions.ts`            | Paginated event discovery and authoritative Vault reads      |
| `src/lib/data/demo.ts`                 | Fixed quotes and local simulated balances                    |
| `src/lib/data/gateway.ts`              | Browser-to-VPS HTTP adapter                                  |
| `src/lib/data/testnet.ts`              | Public deployment discovery; quotes explicitly unavailable   |
| `src/lib/data/onchain.ts`              | Shared verified onchain market reads for testnet and gateway |
| `src/components/testnet-portfolio.tsx` | Real testnet wallet balances and position-history status     |

Pages access products through `ProductAdapter`. Quote types and Zod schemas reuse `gateway/src/types.ts`; amount calculations reuse `sdk/wrapped-assets.mjs`. The frontend contains no dealer pricing algorithm or private signing key.

`DemoQuote` and `GatewayQuote` are separate types. Demo quotes have `null` signatures and transactions, and the real gateway adapter and transaction encoder reject them. Only gateway mode can use the real wallet transaction sender. Explicit `testnet` mode remains read-only.

The gateway adapter implements market discovery, onchain series/balance reads, quote polling, preparation and receipt queries, with order, fee, target-contract and calldata validation. Before a fill, the adapter rechecks the selected quote; the wallet sender simulates the exact transaction and waits for two confirmations. Approvals request the needed amount when the existing allowance is insufficient. Submitted hashes survive a page reload; Check status reconciles them with chain receipts. A receipt-reporting outage does not erase a successful onchain fill.

## Amounts and settlement

- Stock input converts at the current wrapping rate into a fixed wrapped quantity W, rounded down.
- The USDG amount U uses the same rounding-up rule as the SDK and contracts. Expand the settlement details to view full precision.
- Buy Low locks U; Sell High locks W. Both pay the net premium upfront.
- On exercise, Buy Low receives W and Sell High receives U. Without exercise, each returns its original collateral.
- Exercise is a dealer decision, not a simulated market-price trigger.
- W and U stay fixed. The equivalent underlying stock quantity can change with dividends or splits, and those rights transfer with wrapped tokens.
- This frontend displays NVDAx. Gateway mode requires its Vault to be explicitly configured rather than treating the first listed stock as NVDAx.

## Deploy to Vercel

The repository includes [vercel.json](vercel.json):

1. Import the repository and set **Root Directory** to `web`, framework to **Next.js**, and Node.js to **24.x**.
2. Include source files outside the root directory in the build step: the app imports the root SDK and gateway schemas.
3. Use the install and build commands in `vercel.json`. They install the web workspace from the repository root and build inside `web`.
4. Set `NEXT_PUBLIC_DATA_MODE=gateway` and `NEXT_PUBLIC_GATEWAY_URL=https://api.payoff.finance`. The public RPC, explorer and Vault defaults come from the deployment catalog. If you previously configured another Vault, update it to the catalog address or remove the override. Redeploy after changing these settings.
5. Verify locally with `npm run build:web`; preview the production build with `npm run start:web`.

`NEXT_PUBLIC_*` values are embedded in the browser bundle at build time. Rebuild after changing them. Never place private keys, private RPC credentials, database URLs or dealer authentication tokens in those variables. Copy [the environment example](.env.example) to `web/.env.local` for local overrides.

## VPS integration

```text
Browser → Vercel / Next.js: load the website
Browser → VPS RFQ gateway: request and prepare quotes
Gateway → self-operated and other whitelisted dealers: collect offers
Browser → wallet → X Layer contracts: approve, wrap, fill and claim
Browser → X Layer RPC: read market, balances, positions and receipts
```

RFQ traffic goes directly to the gateway. There is no Next.js RFQ proxy or demo serverless function. Other independent web features can use Route Handlers when needed.

For another gateway deployment, set `NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_NVDA_VAULT` and `NEXT_PUBLIC_DEPLOYMENT_BLOCK` consistently with its deployed contracts. The default frontend network is X Layer testnet 1952. Chain IDs and contract bindings must match; errors never fall back to simulated success.

The gateway must allow the frontend origin and JSON/`Idempotency-Key` CORS preflights. An HTTPS website needs an HTTPS API. CORS is not user authentication or a restriction on non-browser API clients.

## Verification

From the repository root:

```sh
npm run test:web
npm run test:gateway:integration
npm run build:web
npm run typecheck --workspace @payoff/web
npm run format:check --workspace @payoff/web
npm run test:web:e2e
npm run test:e2e:testnet --workspace @payoff/web
npm run test:e2e:gateway --workspace @payoff/web
```

Local EVM integration also exercises the frontend wallet sender against actual contracts and gateway: exact approvals, stock wrapping, both fills, event-based position recovery, exercised Call claims and expired Put claims.

Unit tests cover wallet rejection, network/account guards, pending receipt recovery, demo isolation, deployment bindings, series discovery, unavailable quotes, fixed W/U accounting, all four settlement outcomes, duplicate fills/claims, precision, insufficient balances, account isolation, expired or changed orders and gateway transaction validation.

Playwright starts a development server on port 3100 and tests desktop and mobile sizes. On macOS it uses installed Google Chrome. On Linux, install Chromium first with `npx playwright install --with-deps chromium` from `web/`. Testnet browser tests run separately on port 3101 against deterministic RPC responses, exercising series and expiry selection, wallet balances, unavailable quotes, failed reads and closed series. Gateway browser tests run on port 3102 and verify real browser fetch behavior against routed HTTP/RPC responses, including a failed dealer funding check. The demo suite covers the full demo flow, expiry countdowns, no quotes, cancellations, wallet account changes, no-signature guarantees, layout overflow and keyboard dismissal.

## Remaining operational work

- Dealer exercise is not automated. Opening a quote only checks the premium budget; exercise needs the appropriate delivery assets and Vault allowances during the exercise window. Otherwise the position expires without exercise and the user reclaims collateral.
- The catalog currently ends on October 2, 2026. New series and dealer contract mappings need to be scheduled before existing batches close.
- New testers need OKB, USDG and/or owner-minted test stock. There is no integrated stock faucet or wrapped-stock redemption UI; claims deliver the contract-specified token, including wrapped stock.
- Position history currently scans paginated RPC logs from the deployment block. A backend index is needed as history grows. Pending transaction recovery handles observed receipts and replacements while the page is open; a replacement made while the page is closed may require manual wallet/explorer reconciliation.
- The quote notice explains use of the last valid bid, but the dealer market-data timestamp is not yet exposed per quote to the frontend.
- There is one admitted self-operated dealer. Quote checks do not reserve funds. No hedging, automatic market-maker competition guarantees or mainnet rollout is implied.
- Monitor dealer balances, provider health, quote failures and series expiry. Add alerts and verify logical database backup/restore.
- Gateway CORS must include each frontend origin. Production and localhost:3000 are allowed; arbitrary Vercel preview origins are not enabled automatically.

The optional demo ledger is a single-browser prototype; the gateway mode uses onchain assets and receipts.
