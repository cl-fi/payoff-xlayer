// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";

/// @notice Replace a disposable test market while retaining all existing token contracts and balances.
/// @dev Replaces legacy bytecode once. Later fee changes use setFeeBps; no migration or old-market pause occurs here.
contract RedeployTestnetMarket is Script {
    function run(
        address previousVault,
        address dealer,
        uint16 feeBps,
        uint256 expectedAssetsPerWrapped,
        T.Series[] calldata series
    ) external returns (RFQExchange exchange, SeriesVault vault) {
        require(block.chainid == 1952, "X Layer testnet only");
        require(dealer != address(0) && feeBps <= 10_000, "Invalid configuration");
        SeriesVault previous = SeriesVault(previousVault);
        address administrator = previous.administrator();
        address wrapped = address(previous.wrappedStock());
        address usdg = address(previous.usdg());
        require(
            IERC4626(wrapped).convertToAssets(1e18) == expectedAssetsPerWrapped,
            "Wrapper rate changed; refresh plan"
        );
        address feeRecipient = RFQExchange(previous.exchange()).feeRecipient();
        vm.startBroadcast(administrator);
        exchange = new RFQExchange(usdg, administrator, feeRecipient, feeBps);
        vault = new SeriesVault(usdg, wrapped, administrator, address(exchange));
        exchange.setVaultAllowed(address(vault), true);
        exchange.setDealerAllowed(dealer, true);
        for (uint256 i; i < series.length; ++i) {
            T.Series calldata s = series[i];
            vault.createSeries(
                s.side, s.strikePricePerWrappedUSDG, s.tradeCutoff, s.exerciseStart, s.exerciseEnd
            );
        }
        vm.stopBroadcast();
    }
}
