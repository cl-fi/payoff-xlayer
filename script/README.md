# X Layer testnet deployment

`DeployXLayerTestnet.s.sol` deploys the existing RFQExchange and SeriesVault contracts on **chain 1952**. It also deploys a test stock and an ERC-4626 test wrapper because the mainnet xStocks addresses cannot be reused on testnet. These assets are explicitly named `tNVDAx` and `twNVDAx`; they are not issuer-backed securities or replicas of the issuer's corporate-action implementation.

The script creates one Vault, admits it to the Exchange, admits an initial dealer, mints 100 test stock units to the administrator, and wraps 50 of them. It creates four sample series: Buy Low at 175 USDG and Sell High at 185 USDG per wrapped unit, each with 7-day and 14-day exercise starts. Trading closes one hour before exercise starts; the exercise window lasts 30 minutes. These are deployment samples, not protocol constraints or market quotes.

## Inputs and signing

Use an encrypted Foundry keystore outside the repository. Never put its private key or password in an environment file, command argument, source file, or committed configuration. `--password-file` takes the path to a private local file, not the password itself.

```sh
export TESTNET_DEPLOYER=0xYourTestWallet
export TESTNET_USDG=0xYourVerifiedTestnetUSDG
export TESTNET_DEALER=0xYourTestDealer
export TESTNET_FEE_BPS=100

# Simulate first; no transactions are sent without --broadcast.
node scripts/forge.mjs script script/DeployXLayerTestnet.s.sol:DeployXLayerTestnet \
  --rpc-url https://testrpc.xlayer.tech/terigon \
  --sender "$TESTNET_DEPLOYER" \
  --account your-testnet-keystore \
  --password-file /private/path/to/password-file \
  --slow
```

The dealer defaults to the deployer when omitted; use a separate funded dealer account when connecting a running dealer service. The deployer is also the administrator, fee recipient and test-stock minter. The initial fee defaults to 1000 basis points (10%) of gross premium. The Exchange administrator can update it with `setFeeBps`; administrator and fee recipient addresses remain immutable.

After checking the simulation, balances and target chain, repeat with `--broadcast`. This is a **fresh-deployment script**: rerunning it normally creates new contracts. If broadcasting stops partway through, inspect the transaction receipts and use Foundry's `--resume` for that same deployment rather than starting another deployment.

## USDG source

Verify the token received from the [official OKX test faucet](https://web3.okx.com/xlayer/faucet/xlayerfaucet) using its Transfer receipt and `decimals()` before setting `TESTNET_USDG`. On September 21, 2026, the faucet paid USDG at `0xa78e2baabaf5c4f36b7fc394725deb68d332eec1` with 6 decimals. This differs from the X Layer testnet address listed in Paxos documentation at that time. Treat faucet assets as test assets, and do not substitute the addresses in `config/xlayer.json`, which describe mainnet.

## Deployment records

Foundry stores transaction receipts under `broadcast/`. Store the actual deployed addresses, series timestamps, wallet paths, transaction hashes and verification results under the ignored `infra/` directory. Keep those records and the keystore backed up separately. Public contract source and this generic procedure belong in Git; local credentials and operational records do not.

After deployment, read back chain ID, deployed code, asset bindings, administrator, fee settings, Vault and dealer admission, wrapper backing, and all four series. Deploying contracts does not enable the frontend's live mode or start the gateway/dealer service.

## Add series to an existing testnet Vault

The native NVDAx target grid and fixed timestamps live in `config/nvda-products.testnet.json`.
Run `node scripts/plan-testnet-series.mjs --output <local-plan.json>` to read one chain snapshot,
convert native targets to wrapped strikes, and find reusable series. The output includes
`forgeSignature` for `CreateTestnetSeries.run`. The plan does not sign transactions or modify
the published catalog. Reuse the same fixed expiry when replacing a series after a rate change.
After creation, verify receipts and the current rate, configure gateway/dealer admission,
and update the frontend's `config/xlayer-testnet.json` active IDs. Then generate and publish
the catalog. Keep the new series' real option reference strikes aligned to the native targets.
The current publication policy does not cancel old quotes or disable old series onchain.
Pre-public-test batches are disposable: keep only the new IDs in quoting configuration and
do not add migration or compatibility branches for old test positions.

To simulate the mainnet wrapping rate on the existing test wrapper, use
`node scripts/align-testnet-wrapper.mjs` from the repository root for a read-only plan.
After reviewing the plan, add `--broadcast --account <encrypted-foundry-account>
--password-file <local-password-file> --cast <cast-executable>`. This reads mainnet only
and sends a backing-token mint on chain 1952. It does not redeploy contracts or alter
fixed position terms. Build the contracts first (`npm run build`) for the position ABI.
The script rejects a rate decrease or an unrepresentable rate, records the source
block and testnet receipt in `config/testnet-wrapper-rate.json`, and reads back the result.
On interruption, inspect the printed transaction hash before retrying. Concurrent
wrapper activity can change the resulting rate; a readback mismatch requires review,
not an automatic retry. Deploy dealer reference-strike mappings first, then align
the rate, run `npm run catalog:generate`, and publish the frontend.
See the [design decision](../design/fixed-token-settlement.md) for the simulation's limits.

Use `CreateTestnetSeries.s.sol` to add a reviewed batch without redeploying the Vault or Exchange. Its entry point is:

```text
run(address vault, address administrator, uint256 expectedAssetsPerWrapped,
    (uint8 side, uint256 strikePricePerWrappedUSDG, uint64 tradeCutoff,
     uint64 exerciseStart, uint64 exerciseEnd)[] requested)
```

Pass the arguments with Forge's `--sig` option (a function signature plus arguments, or encoded calldata), using the same RPC and encrypted-keystore options as above. Simulate first; `--broadcast --slow` sends the transactions. Keep the reviewed batch and resulting transaction/series IDs in the ignored `infra/` directory.

Prepare calendar timestamps off-chain using `America/New_York`, including daylight-saving changes and the current exchange holiday/early-close calendar. Price spacing, number of dates and number of strikes are operational choices, not contract limits. Convert stock-equivalent target prices to USDG base units per whole wrapped token using one observed wrapper rate; pass that rate as `expectedAssetsPerWrapped`. The script rejects a changed rate so the operator can refresh the plan before sending it.

The script reuses a series only if all five terms match, including the cutoff and exercise window. It never modifies existing series. The search runs locally in the administrator script and adds no cross-series work to user transactions. Trading cutoff can equal exercise start, allowing a direct transition from accepting new positions to exercising them.

If a broadcast is interrupted, inspect its receipts before using `--resume`; do not start a concurrent batch from the same signing account. Record the intended series IDs in the gateway market catalog. Omitting old samples from that catalog only changes discovery and quoting through that gateway; it does not disable on-chain series or affect existing position exits.

## Replace a legacy disposable test deployment

The original deployed Exchange had an immutable fee; the current source supports
`setFeeBps(uint16)`. Because legacy bytecode cannot acquire this function, use
`RedeployTestnetMarket.s.sol` to create a replacement Exchange/Vault with the
existing USDG and wrapped-stock contracts, fee recipient, and reviewed Series
terms. It accepts the former Vault, dealer, fee in basis points, expected wrapper
rate, and Series list. The current product fee is 1000 basis points (10% of gross
premium). No token minting or position migration occurs.

Verify the new deployment before switching gateway/dealer configuration and the
static frontend catalog. Existing allowances name a spender address: reauthorize
the new Exchange/Vault with finite working limits, and have frontend users approve
the new Vault through the normal preparation flow. Change any explicit Vercel
Vault/deployment-block settings before rebuilding. Rebind the native-product and
generation records to the new Vault. Keep cached bids, but replace the cached
catalog and restart settlement monitoring in the new settlement domain.

This procedure is for pre-public-test data the product owner has agreed to discard.
It does not pause or alter the old deployment; its historical positions still exist
onchain. Once the adjustable Exchange is deployed, later fee changes use the
administrator's `setFeeBps` transaction and do not replace contracts or allowances.

## Adjust the current protocol fee

Call `RFQExchange.setFeeBps(newFeeBps)` from its administrator. Values are basis
points of gross premium: 1000 = 10%, 800 = 8%, and the percentage bound is 0–10000.
`ProtocolFeeUpdated(previousFeeBps, newFeeBps)` records the change. Existing
positions and previously paid premiums are untouched. Pending signed quotes whose
fee split no longer matches the current rate must be requoted; amounts are never
rewritten under an existing signature.

The dealer reads the current rate for every formal inquiry and reference cycle;
the gateway checks it again before execution. The frontend clears pending quotes
when a rate update arrives, and the contract remains the final check. No service
restart or web redeployment is required to enforce a fee change. Regenerate the
static catalog when publishing to update its initial page-load snapshot.
