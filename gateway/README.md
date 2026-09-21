# Payoff RFQ gateway

An independent TypeScript / Fastify / viem / PostgreSQL service for the EIP-712 v2 `RFQExchange`. Self-operated and external whitelisted dealers use the same HTTP protocol and selection rules. Pricing, market data, signing keys, fund reservations, hedging and automatic exercise belong to separate dealer services.

## Request lifecycle

1. The browser submits a taker, Vault, series and wrapped quantity with an idempotency key.
2. The gateway reads the listed terms and checks user collateral and allowances before requesting signed quotes.
3. It contacts configured dealers concurrently with a common collection deadline.
4. It verifies the order, fees, onchain admission, nonce, deadline, EOA/ERC-1271 signature, and both parties' funding and allowances, then simulates the full `fill` transaction.
5. It selects the highest net premium. Ties use the lowercase dealer address in lexicographic order.
6. The browser receives the selected quote and exact transaction calldata. Preparation revalidates that quote without substituting a worse offer.
7. After the user submits a transaction, the receipt endpoint verifies its sender, target, calldata, successful receipt, `QuoteFilled` event, block hash and confirmation count.

All exact amounts are decimal integer strings: wrapped stocks use 18 decimals and USDG uses 6. The returned minimum net premium equals the displayed net premium; collateral limits match the order.

Checks reflect a moment in time. They **do not lock dealer funds or guarantee execution**. Dealer nonces enforce onchain replay protection. Request idempotency survives gateway restarts, but it is not an onchain single-winner mechanism. Requesting a new quote does not cancel an older signature.

## Public HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Process liveness |
| GET | `/readyz` | Database, chain, Exchange and block-freshness checks |
| GET | `/v1/markets` | Listed Vaults, series IDs, chain and asset configuration |
| POST | `/v1/rfqs` | Create or resume an idempotent quote request |
| GET | `/v1/rfqs/:requestId` | Read the request and selected quote |
| POST | `/v1/rfqs/:requestId/prepare` | Revalidate the selected quote and return transaction parameters |
| POST | `/v1/rfqs/:requestId/transactions` | Verify a submitted transaction hash |

`POST /v1/rfqs` requires an `Idempotency-Key` header of 16–128 characters using letters, digits, `_`, `.`, `:` or `-`. Its JSON body contains `taker`, `vault`, `seriesId` and `wrappedQuantity`. Reuse the key only for the same order. A pending request may return `202`; poll its request URL. Transaction verification accepts `{ "transactionHash": "0x..." }`.

The authoritative request, quote, selection and settlement schemas are in [src/types.ts](src/types.ts); routes and validation are in [src/app.ts](src/app.ts). Errors use `{ "error": { "code": "...", "message": "..." } }`. Responses disable caching.

### Dealer protocol

The gateway sends a JSON `POST` to each configured dealer URL, optionally with a Bearer token. `DealerRequest` includes:

- `version: "1"`, `requestId`, `chainId`, and `exchange`;
- `order`: the user, Vault, series and wrapped quantity;
- `snapshot`: block reference, asset addresses, fee, series terms and settlement amount;
- `collectUntil`: the common collection deadline.

A dealer returns either `{ "status": "quote", "quote": { ... }, "signature": "0x..." }` or `{ "status": "no_quote", "reason": "..." }`. Use [the shared quote SDK](../sdk/quotes.mjs) for EIP-712 signing and [the schemas](src/types.ts) for exact field types. The transport protocol version `1` is separate from the Exchange signing-domain version `2`.

The transport requires successful JSON responses, rejects redirects, bounds response size and cancels timed-out requests. Dealer endpoints come from operator configuration, not user input. Production rejects enabled dealers marked `source: test`.

## Code map

| File | Responsibility |
| --- | --- |
| `src/app.ts` | HTTP validation, CORS, rate limiting and public errors |
| `src/gateway.ts` | Collection, selection, idempotency and quote preparation |
| `src/dealer.ts` | Dealer HTTP transport |
| `src/chain.ts` | Contract reads, signature/funding checks, simulation and receipt verification |
| `src/store.ts` | PostgreSQL schema and parameterized queries |
| `src/config.ts` | Listed markets, dealers and service configuration |
| `src/types.ts` | Shared request and response schemas |
| `src/main.ts`, `src/migrate.ts` | Server and explicit database initialization |
| `deploy/` | Compose, environment and HTTPS proxy examples |

Amount conversion and signing reuse the root `sdk/` modules.

## Build and test

From the repository root with Node.js 24:

```sh
npm ci
npm run build:gateway
npm run test:gateway
npm run build
npm run test:gateway:integration
npm run test:sdk
```

Database tests run the same SQL on PGlite by default. Set `TEST_DATABASE_URL` to use a dedicated PostgreSQL test database; tests create and delete isolated schemas. CI uses PostgreSQL 17.

EVM integration starts the pinned Anvil binary locally and deploys the repository contracts with test assets. HTTP test dealers sign with public test keys. These keys must never hold real funds, and the test dealer is not a production service.

## Connect local services

```sh
cp gateway/config.example.json gateway/config.local.json
cp gateway/.env.example gateway/.env
# Fill in the local files, then build and start from the repository root.
npm run build:gateway
node --env-file=gateway/.env gateway/dist/migrate.js
node --env-file=gateway/.env gateway/dist/main.js
```

Supply a reachable PostgreSQL database, RPC, deployed Exchange/Vault/series, admitted dealer addresses and dealer API endpoints. `REPLACE_...` values are placeholders. The example uses X Layer mainnet chain ID 196 and its USDG address; for testnet, replace the chain, RPC and all deployed addresses together.

`SELF_DEALER_API_TOKEN` authenticates the gateway to the dealer; it is not a wallet key. Remote dealer URLs require HTTPS unless `allowHttp` is explicitly set for a trusted private network. The gateway validates the RPC chain ID and Exchange USDG binding on startup and does not fall back to mock execution when dependencies fail. Restart after changing configuration.

## Single-VPS deployment

```sh
cp gateway/config.example.json gateway/config.local.json
cp gateway/deploy/.env.example gateway/deploy/.env
# Fill both files. Generate a URL-safe database password, for example with openssl rand -hex 24.
docker compose -f gateway/deploy/compose.yaml --env-file gateway/deploy/.env up -d --build
```

Compose waits for PostgreSQL, initializes the tables and starts the gateway. Database data lives in a named volume. Back up before upgrades; `down -v` deletes that data.

- The gateway binds to `127.0.0.1:8080` on the host. Use a host HTTPS reverse proxy such as [the Caddy example](deploy/Caddyfile.example) to expose your API domain.
- Put the frontend origin in `allowedOrigins` and use the HTTPS API URL in the frontend configuration. CORS governs browser access; it is not authentication.
- PostgreSQL has no published host port and does not join the dealer network.
- Run the self-operated dealer as a separate service on `payoff_dealers`, with the `self-dealer` network alias for the sample URL. The dealer can call external data/RPC services without publishing its own port.
- Configure external dealers with their own HTTPS URLs. Configure only actual trusted proxy IPs/CIDRs in `trustedProxies` for accurate client rate limits.
- Monitor liveness and readiness separately. The service shuts down gracefully and persists requests, quotes, selection and receipt observations in PostgreSQL.

Collection windows, timeouts, rate limits and confirmation counts are configurable operating defaults, not measured production guarantees. Rate and concurrency counters are currently local to one process; horizontal scaling needs shared limits.

Receipt verification runs when explicitly requested. It is not a background index of every user transaction. Each new check reads current chain evidence; historical database observations do not override the chain.
