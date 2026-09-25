# Settlement operations

Settlement is **manual by default**. The background monitor never signs,
approves, funds or exercises. It does not use the 50%-option-bid quote policy to
decide whether a position should exercise. An operator chooses each position.
No stock-price subscription or new on-chain oracle is required by this mode.
An opt-in automatic mode (below) exercises on the Hyperliquid NVDA perpetual
oracle price near the end of each window; see `AUTO-EXERCISE.md` for the design.

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

## Automatic exercise

`autoExercise` in the dealer configuration turns the rule on. Absent, or with
`enabled: false`, nothing changes. With `dryRun: true` (the default) the runner
evaluates and logs every decision but signs nothing; `dryRun: false` executes.

```json
"autoExercise": { "enabled": true, "dryRun": true, "coins": { "NVDA": "xyz:NVDA" } }
```

The runner lives inside the self-dealer process and uses the same transaction
journal and PID lock as the CLI, so an operator command and the runner can never
sign concurrently. It reads the `oraclePx` of the configured Hyperliquid
perpetual (`POST /info`, `metaAndAssetCtxs`, dex `xyz`) and, for each open
position in the window, computes the long side's intrinsic value at that price:

```text
shares    = wrappedQuantity × convertToAssets(1e18) / 1e18   (rate read at decision time)
notional  = shares × oraclePx                                 (USDG micros)
put       = strikeAmountUSDG − notional
call      = notional − strikeAmountUSDG
exercise  ⇔ intrinsic > 0 and intrinsic / notional ≥ minEdgeBps (default 0)
```

Timing per window `[exerciseStart, exerciseEnd)`: sampling starts shortly before
`exerciseEnd − decideBeforeEndSeconds` (default 5 minutes), decisions repeat every
`pollMs` (10 s) until `exerciseEnd − submitCutoffSeconds` (60 s), most valuable
position first, one transaction at a time with two confirmations. A pending or
uncertain broadcast is reconciled before anything else is sent; an unresolved
previous transaction halts the window. Positions still open at the cutoff expire.

Guards that skip a poll: oracle more than `oracleMidBandBps` (100) away from the
book mid, oracle unchanged for `oracleUnchangedPolls` (6) consecutive polls,
empty book, fetch failure. Windows on Saturday, Sunday or a date in `skipDates`
(early-close sessions) are refused outright. Only the Hyperliquid oracle is used;
ThetaData is not consulted.

Operations:

- `settlement-cli.mjs evaluate` prints the live oracle price and the would-be
  decision for every open position without signing.
- `GET /settlement` includes `autoExercise` (phase, next window, last window).
- Log events: `auto_exercise_armed`, `auto_exercise_poll`, `auto_exercise_dry_run`,
  `auto_exercise_executed`, `auto_exercise_window`; alerts carry an `alert` code
  (`AUTO_EXERCISE_BLOCKED`, `AUTO_EXERCISE_HALTED`, `AUTO_EXERCISE_REVERTED`,
  `MARKET_CLOSED_IN_WINDOW`, `NO_PRICE_SOURCE`, `PRICE_UNAVAILABLE`).
- `DEALER_AUTO_EXERCISE_PATH=/var/lib/payoff-dealer/auto-exercise.json` keeps
  the last 30 window records (decisions, prices, hashes, skip reasons).

Exercise windows are absolute timestamps set at series creation. Generate them
in `America/New_York` (daylight saving changes the UTC offset) and avoid
half-day sessions, when both the perpetual oracle and the stock market are
outside regular hours by 15:30 ET.

## Commands on the existing VPS

Run from `/opt/payoff/app` through AWS SSM. No public administration port is added.
Use this prefix with the existing container credentials, without printing them:

```sh
docker compose -f gateway/deploy/compose.yaml --env-file gateway/deploy/.env exec -T self-dealer node src/settlement-cli.mjs status
```

Replace `status` with the commands below. Copy the exact Vault address and
position ID from the fresh status snapshot.

```text
evaluate

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
private read-only access, recovery from ambiguous broadcasts, and the automatic
rule (price parsing and guards, put/call intrinsic at a drifted wrapper rate,
dry-run signing nothing, edge ordering, pending reconciliation, halts, cutoff,
weekend refusal, daemon scheduling). Local EVM tests
open four actual positions, prove monitoring sends nothing, execute manual Put/Call
exercise and approval, claim all four outcomes, check duplicate/ownership/window
guards and settle positions after trading admission is removed.
