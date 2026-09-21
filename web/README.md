# Payoff frontend

A Next.js App Router / React / TypeScript frontend for Buy Low and Sell High strategies. The default mode reads deployed contracts on X Layer Testnet (1952), with desktop and mobile layouts. It needs no VPS to display onchain data. Quotes and trading remain unavailable until the gateway and wallet transaction flow are connected.

## Run locally

From the repository root:

```sh
npm ci
npm run dev:web
```

Open [localhost:3000](http://localhost:3000). Browse the two fixed expiry dates and target prices, then connect a browser wallet to read its testnet balances. No transaction or message signature is requested.

The public [deployment catalog](../config/xlayer-testnet.json) supplies contract addresses and discovery IDs 5–20. Every series term, token binding, fee and wrapping rate is verified from the RPC at one block. The page excludes series whose trading cutoff has passed, and displays dates in New York time. Prices are contract strikes converted at the current wrapping rate, not live stock prices. Old sample series 1–4 remain onchain but are excluded from this catalog.

The assets tNVDAx and twNVDAx are deployment test tokens, not issuer-backed stocks. USDG is the test token distributed by the OKX faucet. **My positions** shows real OKB and token balances, with an explicit notice that position history is not connected. An RPC error clears unavailable data and never falls back to a simulated balance or quote.

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
| `src/lib/chain.ts`                     | Read-only contract access and fill-calldata validation       |
| `src/lib/data/demo.ts`                 | Fixed quotes and local simulated balances                    |
| `src/lib/data/gateway.ts`              | Browser-to-VPS HTTP adapter                                  |
| `src/lib/data/testnet.ts`              | Public deployment discovery; quotes explicitly unavailable   |
| `src/lib/data/onchain.ts`              | Shared verified onchain market reads for testnet and gateway |
| `src/components/testnet-portfolio.tsx` | Real testnet wallet balances and position-history status     |

Pages access products through `ProductAdapter`. Quote types and Zod schemas reuse `gateway/src/types.ts`; amount calculations reuse `sdk/wrapped-assets.mjs`. The frontend contains no dealer pricing algorithm or private signing key.

`DemoQuote` and `GatewayQuote` are separate types. Demo quotes have `null` signatures and transactions, and the real gateway adapter and transaction encoder reject them. This version has no wallet transaction sender.

The gateway adapter implements market discovery, onchain series/balance reads, quote polling, preparation and receipt queries, with order, fee, target-contract and calldata validation. Testnet reads are connected directly to the public deployment; the VPS quote service is not connected. Real wrapping, approvals, transaction submission, receipt recovery and complete position indexing remain pending. Changing the configuration alone does not enable trading.

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
4. Set `NEXT_PUBLIC_DATA_MODE=testnet`, or remove an old `demo` override to use the default. Leave `NEXT_PUBLIC_GATEWAY_URL` empty. The public RPC, explorer and Vault defaults come from the deployment catalog. If you previously configured another Vault, update it to the catalog address or remove the override. Redeploy after changing these settings.
5. Verify locally with `npm run build:web`; preview the production build with `npm run start:web`.

`NEXT_PUBLIC_*` values are embedded in the browser bundle at build time. Rebuild after changing them. Never place private keys, private RPC credentials, database URLs or dealer authentication tokens in those variables. Copy [the environment example](.env.example) to `web/.env.local` for local overrides.

## VPS integration

```text
Browser → Vercel / Next.js: load the website
Browser → VPS RFQ gateway: request and prepare quotes
Gateway → self-operated and other whitelisted dealers: collect offers
Browser → X Layer RPC: read chain state
```

RFQ traffic goes directly to the gateway. There is no Next.js RFQ proxy or demo serverless function. Other independent web features can use Route Handlers when needed.

For future integration, set `NEXT_PUBLIC_DATA_MODE=gateway`, `NEXT_PUBLIC_GATEWAY_URL=https://api.example.com` and `NEXT_PUBLIC_NVDA_VAULT` to the deployed NVDAx Vault. The default frontend network is X Layer testnet 1952. Chain IDs and contract bindings must match; errors never fall back to simulated success.

The gateway must allow the frontend origin and JSON/`Idempotency-Key` CORS preflights. An HTTPS website needs an HTTPS API. CORS is not user authentication or a restriction on non-browser API clients.

## Verification

From the repository root:

```sh
npm run test:web
npm run build:web
npm run typecheck --workspace @payoff/web
npm run format:check --workspace @payoff/web
npm run test:web:e2e
npm run test:e2e:testnet --workspace @payoff/web
```

Unit tests cover deployment bindings, series discovery, unavailable quotes, fixed W/U accounting, all four settlement outcomes, duplicate fills/claims, precision, insufficient balances, account isolation, expired or changed orders and gateway transaction validation.

Playwright starts a development server on port 3100 and tests desktop and mobile sizes. On macOS it uses installed Google Chrome. On Linux, install Chromium first with `npx playwright install --with-deps chromium` from `web/`. Testnet browser tests run separately on port 3101 against deterministic RPC responses, exercising series and expiry selection, wallet balances, unavailable quotes, failed reads and closed series. The demo suite covers the full demo flow, expiry countdowns, no quotes, cancellations, wallet account changes, no-signature guarantees, layout overflow and keyboard dismissal.

The demo ledger is a single-browser prototype and does not provide transaction guarantees across concurrent tabs. Trading integration must use onchain balances, allowances, signatures and receipts.
