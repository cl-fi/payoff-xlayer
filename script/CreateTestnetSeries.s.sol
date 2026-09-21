// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";

/// @notice Add explicit series to an existing testnet Vault without duplicating identical terms.
/// @dev Calendar, price grid and stock-to-wrapped conversion belong in the off-chain input plan.
contract CreateTestnetSeries is Script {
    function run(
        address vaultAddress,
        address administrator,
        uint256 expectedAssetsPerWrapped,
        T.Series[] memory requested
    ) external returns (uint256[] memory ids) {
        require(block.chainid == 1952, "X Layer testnet only");
        SeriesVault vault = SeriesVault(vaultAddress);
        require(vault.administrator() == administrator, "Wrong administrator");
        require(
            IERC4626(address(vault.wrappedStock())).convertToAssets(1e18) == expectedAssetsPerWrapped,
            "Wrapper rate changed; refresh plan"
        );
        ids = new uint256[](requested.length);
        vm.startBroadcast(administrator);
        for (uint256 i; i < requested.length; ++i) {
            T.Series memory terms = requested[i];
            uint256 id = _find(vault, terms);
            if (id == 0) {
                id = vault.createSeries(
                    terms.side,
                    terms.strikePricePerWrappedUSDG,
                    terms.tradeCutoff,
                    terms.exerciseStart,
                    terms.exerciseEnd
                );
                console2.log("Created series:", id);
            } else {
                console2.log("Reused series:", id);
            }
            ids[i] = id;
        }
        vm.stopBroadcast();
    }

    /// @dev This scan runs in the local administrator script, never inside a user transaction.
    function _find(SeriesVault vault, T.Series memory terms) private view returns (uint256) {
        bytes32 target = keccak256(abi.encode(terms));
        uint256 next = vault.nextSeriesId();
        for (uint256 id = 1; id < next; ++id) {
            if (keccak256(abi.encode(vault.getSeries(id))) == target) return id;
        }
        return 0;
    }
}
