# Payoff frontend

A Next.js App Router / React / TypeScript frontend for Buy Low and Sell High strategies. The default `gateway` mode connects to the deployed contracts on X Layer Testnet (1952) and `https://api.payoff.finance`, with desktop and mobile layouts. The browser calls the VPS directly and sends transactions through the connected wallet.

## Run locally

From the repository root:

```sh
npm ci
npm run dev:web
```

Open [localhost:3000](http://localhost:3000). Browse the fixed expiry dates and target prices, then connect a browser wallet. Buy Low approves the required test USDG; Sell High wraps only the missing stock quantity and approves wrapped collateral. Request a quote, review the terms and confirm the trade in your wallet. You need test OKB for gas and sufficient collateral.

The [deployment configuration](../config/xlayer-testnet.json) supplies addresses and discovery IDs. Run `npm run catalog:generate` after creating series to read and verify their chain terms and asset bindings, then commit [public/catalog.json](public/catalog.json) and deploy the frontend. Gateway mode imports this static catalog into its initial page; browsing products needs no browser RPC or directory Function. `/catalog.json` serves the same file for the VPS reference service. Ordinary builds need no RPC. Updating the catalog requires a frontend deployment.

The catalog records a wrapping-rate/fee snapshot for initial display. Public references refresh those mutable values; formal inquiries verify the selected Series, current rate and fee from the chain again. The page excludes series whose cutoff has passed and displays dates in New York time. Target prices are contract strikes converted to native-stock equivalents, not live stock prices. Explicit read-only `testnet` mode retains direct chain discovery for diagnostics.

## Public reference prices

Browsers call `GET https://api.payoff.finance/v1/reference-quotes` immediately and poll every 30 seconds without a wallet. The VPS reference module generates estimates independently of those requests, using the self-dealer's market-data provider and pricing functions. The gateway distributes the snapshot; Vercel does not relay RFQs or reference requests.

Each reference is normalized to one wrapped token, net of protocol fees. The browser scales by the user's wrapped quantity using integer arithmetic. Small rounding differences and quantity-dependent maker pricing can make formal quotes differ. Estimated APR is net premium divided by USDG collateral for Buy Low, or the agreed sale proceeds for Sell High, annualized over the time remaining until the exercise window closes (simple rate, not compounded). It is not a return based on the stock's live market value. The product page also previews either settlement outcome for the current order, chosen with a toggle (Buy Low: at or above the target keeps the USDG, below it buys the stock; Sell High: above the target sells, at or below it keeps the stock), using the same fixed terms, the reference premium and its APR; its price path is illustrative only. The offer table under the stock chart lists every open target price against every expiry and shows the same reference APR in each cell, so alternatives can be compared before selecting one; on narrow screens a compact dock summarizes the current order and jumps to the order card.

Listing targets originate in native NVDAx units (`config/nvda-products.testnet.json`). Publication
converts those targets using the current wrapper rate, then lists only the selected generation
of onchain Series in `catalog.json`. Replacement series keep the same expiry. Do not relabel an
old wrapped strike as a new native price, and do not add old test-series compatibility branches.
Removing a listing does not revoke signed quotes or delete chain records. See the
[publication policy](../design/fixed-token-settlement.md#批次发布与切换).

The UI labels the reference as an estimate; the final premium is confirmed in the quote. A calculation timestamp never makes an old observation fresh. Unavailable contracts are isolated; provider outages can use the persisted last valid bid for the exact option. Reference-service failures keep showing the last received estimate. Catalog, references, balances, receipt recovery and history load independently; connecting a wallet never clears products.

The assets tNVDAx and twNVDAx are deployment test tokens, not issuer-backed stocks. USDG amounts in this deployment use Payoff Test USDG (`tUSDG`), a project-owned token with 6 decimals. The **Get test tokens** page (`/faucet`) offers both tUSDG for Buy Low and 18-decimal tNVDAx for Sell High. Both are claimed with a direct wallet transaction and use the normal receipt/recovery flow, with no per-wallet quota or cooldown; test OKB gas is needed. USDG is minted by `TestnetUSDG.faucet(amount)`. The existing stock has an immutable administrator-only minter, so `TestnetStockFaucet.faucet(amount)` dispenses a pre-funded inventory of that same stock; its address is in `config/xlayer-testnet.json`. The administrator can replenish it with `TestnetStock.mint(faucetAddress, amount)`. An oversized claim or depleted inventory produces an explicit error, not a false success. These tokens have no monetary value.

The NVIDIA faucet links directly to `/sell-high`, which renders the same product component with Sell High selected. Strategy tabs sit in the page heading, the target price and expiry are chosen from the offer table under the stock chart, and the faucet is reached from the navigation. Sell High asset preparation wraps only the missing tNVDAx amount into twNVDAx and asks the wallet for the required approvals; claiming tokens does not open a position. **Portfolio** reads positions from the Vault's onchain holder index (`positionIdsOf`) and the Exchange's premium record in a few batched calls, including series no longer in the active catalog. Eligible positions can be claimed after dealer exercise or expiry. Clearing browser storage does not remove onchain positions. An RPC error clears unavailable data and never falls back to a simulated balance or quote.

## Optional local demo

Set `NEXT_PUBLIC_DATA_MODE=demo` in `web/.env.local` and restart (or rebuild) the app. Select **Connect to get started**, then **Use demo account**.

- Start with 10,000 demo USDG and 8 demo NVDAx.
- Choose a strategy, a 7- or 14-day series and a stock quantity. Prepare assets, then request a fixed quote.
- Review the net premium, protocol fee, fixed wrapped quantity, settlement amount and 90-second quote expiry.
- Confirm a demo trade. Open **Portfolio**, expand **Simulate an outcome**, then try dealer exercise or expiry without exercise and claim the resulting assets.
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
| `src/lib/data/gateway.ts`              | Browser-to-VPS adapter and selected-series verification      |
| `src/lib/data/catalog.ts`              | Static published product directory                           |
| `src/lib/data/reference.ts`            | Reference estimates and observation freshness                |
| `src/lib/data/testnet.ts`              | Public deployment discovery; quotes explicitly unavailable   |
| `src/lib/data/onchain.ts`              | Shared verified onchain market reads for testnet and gateway |
| `src/components/testnet-portfolio.tsx` | Real testnet wallet balances and position-history status     |

Pages access products through `ProductAdapter`. Quote types and Zod schemas reuse `gateway/src/types.ts`; amount calculations reuse `sdk/wrapped-assets.mjs`. The frontend contains no dealer pricing algorithm or private signing key.

`DemoQuote` and `GatewayQuote` are separate types. Demo quotes have `null` signatures and transactions, and the real gateway adapter and transaction encoder reject them. Only gateway mode can use the real wallet transaction sender. Explicit `testnet` mode remains read-only.

The gateway adapter uses the static directory for browsing, and verifies only the selected Series before a formal inquiry. Quote polling, preparation and receipt queries validate the order, fee, target contract and calldata. Before a fill, the adapter rechecks the selected quote; the wallet sender simulates the exact transaction and waits for two confirmations. Approvals request the needed amount when the existing allowance is insufficient. Submitted hashes survive a page reload; Check status reconciles them with chain receipts. A receipt-reporting outage does not erase a successful onchain fill.

## Amounts and settlement

- The quantity selector accepts NVDAx or wNVDAx. NVDAx input converts at the current wrapping rate into a fixed wrapped quantity W, rounded down; wNVDAx input is W directly, with full 18-decimal precision. Switching units retains the typed number and invalidates any quote, including in-flight responses.
- Target prices follow the chosen unit: current NVDAx-equivalent reference price, or fixed USDG per wNVDAx. Both modes show the wrapping rate and the other price unit. The native-equivalent target can change without changing Series or Position settlement terms; see the [design decision](../design/fixed-token-settlement.md).
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
Browser → VPS RFQ gateway: read public references; request and prepare formal quotes
Gateway → self-operated and other whitelisted dealers: collect offers
Browser → wallet → X Layer contracts: approve, wrap, fill and claim
Browser → X Layer RPC: verify selected trade; read balances, positions and receipts
VPS reference module → Vercel /catalog.json: periodically read published products
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

- Dealer exercise is deliberately manual. A VPS monitor checks all owned positions, windows, delivery inventory and Vault allowances; an operator previews and executes individual transactions with the [settlement CLI](../dealer/SETTLEMENT.md). Quotes only check the premium budget. Expiry without exercise remains a valid outcome; users claim their own collateral.
- The catalog currently ends on October 2, 2026. New series and dealer contract mappings need to be scheduled before existing batches close.
- New testers need test OKB for gas and can obtain both tUSDG and tNVDAx from `/faucet`. The stock faucet inventory needs replenishing if depleted. There is no wrapped-stock redemption UI; position claims deliver the contract-specified token, including wrapped stock.
- Position history is read from the Vault's onchain holder index through Multicall3 batches, so load time does not grow with chain height; the transaction hash of a position opened in another browser is not shown. Pending transaction recovery handles observed receipts and replacements while the page is open; a replacement made while the page is closed may require manual wallet/explorer reconciliation.
- Public references expose the original market observation time. Formal signed RFQ records do not yet include separate market-data metadata; they remain independent of the display estimate.
- There is one admitted self-operated dealer. Quote checks do not reserve funds. No hedging, automatic market-maker competition guarantees or mainnet rollout is implied.
- Monitor dealer balances, provider health, quote failures and series expiry. Add alerts and verify logical database backup/restore.
- Gateway CORS must include each frontend origin. Production and localhost:3000 are allowed; arbitrary Vercel preview origins are not enabled automatically.

The optional demo ledger is a single-browser prototype; the gateway mode uses onchain assets and receipts.
