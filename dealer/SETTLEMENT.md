# Manual settlement operations

Settlement is **manual by product choice**. The background monitor never signs,
approves, funds or exercises. It does not use the 50%-option-bid quote policy to
decide whether a position should exercise. An operator chooses each position.
No stock-price subscription or new on-chain oracle is required by this mode.

## Monitor

The existing self-dealer process scans every configured Vault every 60 seconds,
using a pinned block with two confirmations. It discovers all positions owned by
its wallet, irrespective of quote series allowlists, frontend catalog membership,
pauses or current dealer admission. Removing a Vault from dealer configuration
also removes its monitoring; retain old Vaults until their positions are settled.

The snapshot contains position IDs, fixed wrapped delivery quantity and USDG
total, UTC epoch exercise windows, status, inventory, gas, Vault allowances and
potential delivery requirements. Requirements assume exercising all still-open
positions; they are informational, never a cap on quotes or a reservation.
Shared USDG is counted once across Vaults. This scans all position IDs for MVP
volumes; a later event index can replace discovery without changing settlement.

Warnings cover insufficient delivery assets/allowances/gas, approaching windows
(24 hours by default), open windows and failed chain reads. Logs are emitted on
change and repeated every 15 minutes while unchanged. The authenticated internal
`GET /settlement` endpoint provides a snapshot; no email, SMS or chat notification
integration is configured. Quote readiness is independent of monitor health.
A failed scan retains its original observation marked unavailable; saved data is
also marked unavailable when stale. Recovery performs a fresh chain scan.

The existing persistent dealer volume stores:

- `DEALER_SETTLEMENT_PATH=/var/lib/payoff-dealer/settlement.json`
- `DEALER_SETTLEMENT_TX_PATH=/var/lib/payoff-dealer/settlement-transactions.json`

`settlementIntervalMs`, `settlementWarningSeconds`, `settlementConfirmations` and
`settlementMinGasWei` are deployment settings, not contract rules. Quote funding
only checks the premium budget and Exchange allowance; it cannot prove delivery
is funded or authorized to the Vault.

## Commands on the existing VPS

Run from `/opt/payoff/app` through AWS SSM. No public administration port is added.
Use this prefix with the existing container credentials, without printing them:

```sh
docker compose -f gateway/deploy/compose.yaml --env-file gateway/deploy/.env exec -T self-dealer node src/settlement-cli.mjs status
```

Replace `status` with the commands below. Copy the exact Vault address and
position ID from the fresh status snapshot.

```text
exercise --vault VAULT_ADDRESS --position POSITION_ID
exercise --vault VAULT_ADDRESS --position POSITION_ID --execute

approve --vault VAULT_ADDRESS --asset usdg --amount BASE_UNITS
approve --vault VAULT_ADDRESS --asset usdg --amount BASE_UNITS --execute

approve --vault VAULT_ADDRESS --asset wrapped --amount BASE_UNITS
approve --vault VAULT_ADDRESS --asset wrapped --amount BASE_UNITS --execute

reconcile
rebroadcast --execute
```

Without `--execute`, exercise/approval is a preview only. The preview describes
delivery/receipt assets or the exact new allowance. Approval amounts are base
units: USDG has 6 decimals, wrapped stock has 18. Zero revokes an allowance.
There is no default unlimited approval or automatic top-up.

Execution rechecks chain freshness/identity, Vault/asset bindings, ownership,
state, window, delivery balance/allowance, gas and EVM simulation. A transaction
must be included before the exclusive window end; do not wait for the final block.
Simulation is a precheck, not an inclusion guarantee. New-position pauses and
trading whitelist removal do not block existing exits, matching the contract.

Commands serialize per wallet journal, refuse unrelated pending transactions and
persist signed transactions before broadcasting. An RPC timeout returns
`broadcast_uncertain` or `pending`: **use `reconcile`, not a fresh nonce**.
Explicit `rebroadcast --execute` resends only the saved transaction after fresh
validation. An externally consumed/replaced nonce stays blocked for operator
review. Do not delete a journal to bypass it. Use one active signer host and one
journal per wallet. Keep the volume private: a pending signed transaction is an
execution capability. CLI output omits raw transactions, credentials and RPC errors.

## User outcomes

| Position | Dealer supplies on exercise | User later claims |
| --- | --- | --- |
| Put / Buy Low, exercised | Fixed wrapped stock quantity | Wrapped stock |
| Call / Sell High, exercised | Fixed USDG total | USDG |
| Put, expires without exercise | Nothing | Original USDG collateral |
| Call, expires without exercise | Nothing | Original wrapped collateral |

Expiry is a valid outcome requiring no keeper transaction. Claim remains an
explicit transaction by the user's own wallet; the monitor never claims for users.

## Verification

```sh
npm run test:dealer
npm run build
npm run test:integration --workspace @payoff/self-dealer
```

Tests cover warning transitions, shared inventory reporting, stale/error status,
private read-only access and recovery from ambiguous broadcasts. Local EVM tests
open four actual positions, prove monitoring sends nothing, execute manual Put/Call
exercise and approval, claim all four outcomes, check duplicate/ownership/window
guards and settle positions after trading admission is removed.
