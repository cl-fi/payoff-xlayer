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

The dealer defaults to the deployer when omitted; use a separate funded dealer account when connecting a running dealer service. The deployer is also the administrator, fee recipient and test-stock minter. The fee defaults to 100 basis points of the gross premium. Exchange administrator and fee settings are immutable.

After checking the simulation, balances and target chain, repeat with `--broadcast`. This is a **fresh-deployment script**: rerunning it normally creates new contracts. If broadcasting stops partway through, inspect the transaction receipts and use Foundry's `--resume` for that same deployment rather than starting another deployment.

## USDG source

Verify the token received from the [official OKX test faucet](https://web3.okx.com/xlayer/faucet/xlayerfaucet) using its Transfer receipt and `decimals()` before setting `TESTNET_USDG`. On September 21, 2026, the faucet paid USDG at `0xa78e2baabaf5c4f36b7fc394725deb68d332eec1` with 6 decimals. This differs from the X Layer testnet address listed in Paxos documentation at that time. Treat faucet assets as test assets, and do not substitute the addresses in `config/xlayer.json`, which describe mainnet.

## Deployment records

Foundry stores transaction receipts under `broadcast/`. Store the actual deployed addresses, series timestamps, wallet paths, transaction hashes and verification results under the ignored `infra/` directory. Keep those records and the keystore backed up separately. Public contract source and this generic procedure belong in Git; local credentials and operational records do not.

After deployment, read back chain ID, deployed code, asset bindings, administrator, fee settings, Vault and dealer admission, wrapper backing, and all four series. Deploying contracts does not enable the frontend's live mode or start the gateway/dealer service.

## Add series to an existing testnet Vault

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
