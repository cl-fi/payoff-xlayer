// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {TestnetUSDG} from "./assets/TestnetUSDG.sol";

/// @notice Deploy a new settlement domain while reusing the existing test stock wrapper.
/// @dev After switching services, the administrator should pause the retired Exchange.
contract DeployOwnedUSDGTestnet is Script {
    function run(address administrator, address dealer, address wrapped, T.Series[] calldata series)
        external
        returns (TestnetUSDG usdg, RFQExchange exchange, SeriesVault vault)
    {
        require(block.chainid == 1952, "X Layer testnet only");
        require(administrator != address(0) && dealer != address(0), "Invalid account");
        vm.startBroadcast(administrator);
        usdg = new TestnetUSDG(administrator);
        exchange = new RFQExchange(address(usdg), administrator, administrator, 1000);
        vault = new SeriesVault(address(usdg), wrapped, administrator, address(exchange));
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
