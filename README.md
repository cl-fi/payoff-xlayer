# Payoff · X Layer

Buy Low and Sell High strategies for tokenized stocks, with an upfront premium and fixed settlement terms.

Payoff combines Solidity contracts, a shared signing and amount-conversion SDK, an independent RFQ gateway, and a Next.js frontend. The default frontend connects to the **deployed X Layer Testnet contracts and HTTPS RFQ gateway**. It supports stock wrapping, collateral approvals, real quotes, wallet fills, chain-recovered positions and claims. An explicit demo mode remains available for simulated end-to-end flows.

## Try the product

Requirements: Node.js 24, npm, and Git.

```sh
git clone --recurse-submodules https://github.com/cl-fi/payoff-xlayer.git
cd payoff-xlayer
npm ci
npm run dev:web
```

Open [localhost:3000](http://localhost:3000) to browse deployed series by expiry and target price. Connect a browser wallet on X Layer Testnet, fund it with test OKB and the relevant test collateral, prepare assets and request a quote. Wallet confirmations authorize real testnet transactions. For the isolated simulated trade flow, set `NEXT_PUBLIC_DATA_MODE=demo` in `web/.env.local` and restart the app.

See the [frontend guide](web/README.md) for deployment settings and demo controls.

## How the product works

Each position fixes a wrapped-stock quantity **W** and a USDG settlement amount **U**. The user receives the net premium when the position opens; the dealer buys the right to exercise during the series exercise window.

| Strategy | User locks | If the dealer exercises | If the position expires without exercise |
| --- | --- | --- | --- |
| Buy Low | U USDG | Dealer delivers W wrapped stocks and receives U; user claims W | User reclaims U |
| Sell High | W wrapped stocks | Dealer pays U and receives W; user claims U | User reclaims W |

The user keeps the premium in either outcome. Exercise is a dealer action, not an automatic response to a stock price reaching a target.

Settlement uses wrapped stock units. Dividends, splits and reverse splits can change the underlying stock quantity represented by those units; their underlying rights transfer with the wrapped tokens. The Vault does not separate dividends or adjust positions for corporate actions. A fixed wrapped quantity is not a fixed native stock-token quantity.

See the [fixed-token settlement design decision](design/fixed-token-settlement.md) for the product rationale, accepted price drift, NVDAx/wNVDAx input units, pricing-reference limitations, and testnet rate simulation. Maintain these semantics when changing pricing, UI, or asset integrations.

Product targets are specified per native NVDAx. A publication converts them to fixed wrapped strikes at the observed rate. After a rate change, replacement series retain the original expiry and become the frontend listings. Previous series and their positions remain valid; hiding an old listing does not revoke its outstanding quotes or block onchain entry.

The protocol fee is **10% of gross premium** (`feeBps = 1000`), rounded down to USDG base units; the user receives the remaining premium. This is not a fee on collateral or exercise proceeds. The administrator can update the rate through `setFeeBps`, with a `ProtocolFeeUpdated` event; existing positions are unaffected and incompatible pending quotes must be requoted. The self-dealer currently targets net premium at 50% of the reference option bid, so it grosses up its payment to cover the fee.

## Architecture

```text
Browser / Next.js frontend
  ├── direct HTTP requests → RFQ gateway → whitelisted dealer services
  └── wallet transactions → RFQExchange
                              ├── SeriesVault: stock A → series → positions
                              └── SeriesVault: stock B → series → positions
```

The browser sends wallet transactions directly to the deployed contracts. Pending transaction hashes are kept locally; positions are read from the Vault's onchain holder index and the Exchange's premium record, so no event-log scan is needed.

- **One shared RFQExchange** verifies EIP-712 v2 or ERC-1271 signatures, dealer and Vault admission, fees, deadlines, nonces, and user execution limits. Quotes bind the user, Vault and series.
- **One SeriesVault per stock** holds collateral and records series and positions. Exercise and claims go directly to that Vault. Trades only inspect their selected market; there is no cross-stock aggregate collateral cap.
- **Position receipts** are nontransferable ERC-1155 long and short receipts inherited into each Vault. Transfers and accounting happen atomically. Pausing new trades or disabling a dealer/Vault does not block existing position exits.
- **The gateway** collects quotes concurrently, validates signatures and funding, simulates execution, and recommends the highest net premium. It has no pricing algorithm or dealer signing keys. A funding check is an observation, not a reservation or execution guarantee.
- **The frontend** runs on Next.js and can be hosted on Vercel. RFQ requests go directly from the browser to the VPS gateway. A dealer service may run alongside the gateway as a separate process.

## Repository map

| Path | Responsibility |
| --- | --- |
| [src/RFQExchange.sol](src/RFQExchange.sol) | Shared execution entry point and admission controls |
| [src/SeriesVault.sol](src/SeriesVault.sol) | Stock-specific series, positions, collateral, exercise and claims |
| [src/types/PayoffTypes.sol](src/types/PayoffTypes.sol) | Shared contract data structures |
| [src/base/PositionReceipts.sol](src/base/PositionReceipts.sol) | Nontransferable position receipts |
| [src/libraries/ExactERC20.sol](src/libraries/ExactERC20.sol) | Exact balance-delta transfers for wrapped stocks and USDG |
| [sdk/](sdk/) | Quote signing, typed data and wrapped-asset conversions |
| [gateway/](gateway/README.md) | TypeScript / Fastify / viem / PostgreSQL RFQ service |
| [dealer/](dealer/README.md) | Separate self-operated dealer: ThetaData bid × 50%, wrapped-unit conversion and signed quotes |
| [web/](web/README.md) | Next.js / React / TypeScript frontend |
| [test/](test/) | Contract lifecycle, fuzz, invariant, SDK and asset fork tests |
| [test/fixtures/](test/fixtures/) | Public deterministic quote vector and pinned fork data |
| [config/xlayer.json](config/xlayer.json) | Public X Layer mainnet asset addresses and RPC defaults |
| [config/xlayer-testnet.json](config/xlayer-testnet.json) | Public testnet deployment addresses and active catalog IDs |
| [script/](script/README.md) | X Layer testnet deployment procedure and explicit test assets |

## Build and verify

Run from the repository root:

```sh
git submodule update --init --recursive
npm ci
npm run fmt:check
npm run build
npm test
npm run test:sdk
npm run build:gateway
npm run test:gateway
npm run test:dealer
npm run test:gateway:integration
npm run test:integration --workspace @payoff/self-dealer
npm run test:web
npm run build:web
npm run test:web:e2e
```

Foundry is pinned through npm; no global installation is needed. Contracts use Solidity 0.8.30 with the Paris EVM target. The Foundry launcher preserves nonzero exit codes on failures. Dependencies are pinned by the lockfile and the forge-std submodule.

- Contract tests cover both strategies, quote validation, lifecycle transitions, fuzz cases and multi-market accounting invariants.
- SDK checks compare a committed EIP-712 vector with Solidity and exercise integer rounding and wrapped-asset conversions.
- Gateway tests cover dealer transport, selection, persistent idempotency and receipt verification. Local EVM integration deploys the actual Exchange and Vault with test assets on Anvil. Database tests use PGlite locally unless `TEST_DATABASE_URL` is set; CI uses PostgreSQL 17.
- Dealer settlement tests cover manual exercise, inventory/allowance checks, transaction recovery, all four claim outcomes and the automatic exercise rule. The VPS runs a read-only monitor by default; an opt-in automatic mode exercises on the Hyperliquid NVDA perpetual oracle price near the end of each window. See [settlement operations](dealer/SETTLEMENT.md) and the [automatic exercise design](dealer/AUTO-EXERCISE.md).
- Frontend tests cover both strategies and settlement outcomes, quote expiry, account changes, demo isolation, and desktop/mobile layouts. See the [frontend guide](web/README.md#verification) for browser prerequisites.

Optional checks requiring an X Layer RPC:

```sh
npm run test:fork
npm run probe:assets
```

Fork tests use block **70,938,201** and the real NVDAx, wNVDAx and USDG contracts in a local fork. They fail if the RPC is unavailable rather than replacing it with mocks. They do not broadcast transactions or establish mainnet deployment evidence. Override the public RPC with the shell variable `XLAYER_RPC_URL`; the root `.env.example` is not loaded automatically.

## Deployment and current scope

The [frontend guide](web/README.md) covers Vercel. The [gateway guide](gateway/README.md) includes a single-VPS Docker Compose setup, HTTPS proxy example and dealer API contract. Copy the example configuration files and supply your own deployment values. Internal notes, actual infrastructure configuration, local credentials and historical logs are excluded from this repository.

The [testnet deployment guide](script/README.md) covers chain 1952, encrypted-keystore signing, sample series, and test stock/wrapper assets. Gateway-mode product browsing uses a verified static [catalog](web/public/catalog.json), generated with `npm run catalog:generate` and deployed with the frontend. Public reference premiums come directly from the VPS; wallet data and selected-trade checks read the chain independently. The test stock and wrapper are not issuer-backed assets. Contract addresses and discovery IDs are public; operational notes and credentials remain excluded.

The self-operated dealer now supports live ThetaData option snapshots and a simple 50%-of-bid pricing rule, with a shared VPS deployment for the gateway and dealer. The frontend is connected to the gateway. Automatic dealer exercise exists as an opt-in, dry-run-first dealer mode. Hedging, future-series scheduling, public test-asset distribution, a scalable server-side position index and mainnet deployment remain separate work. Demo prices, premiums and fees are test data. Contracts have no proxy upgrade path, administrator withdrawal, price oracle or corporate-action cash adjustment. This is an MVP implementation, not an audited production release.

### Current X Layer testnet assets

The active deployment in [config/xlayer-testnet.json](config/xlayer-testnet.json) uses project-owned **Payoff Test USDG (tUSDG)**, with 6 decimals and unrestricted repeated self-minting via the web [faucet](https://www.payoff.finance/faucet). Test OKB still pays gas. These tokens have no monetary value. The stock and wrapped stock are also test assets.

[DeployOwnedUSDGTestnet.s.sol](script/DeployOwnedUSDGTestnet.s.sol) deploys the test token, a new Exchange and a new Vault bound to it; settlement asset addresses are immutable. All current services use this single deployment. Old test deployments are retired, with no migration or compatibility layer. The core trading and manual settlement rules are unchanged.
