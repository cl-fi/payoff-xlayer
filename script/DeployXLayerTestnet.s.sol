// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {TestnetStock, TestnetWrappedStock} from "./assets/TestnetStock.sol";

/// @notice Fresh X Layer testnet deployment; use Foundry's encrypted keystore to sign.
/// @dev Sample terms belong here, never in the production contracts. A rerun creates new contracts.
contract DeployXLayerTestnet is Script {
    function run()
        external
        returns (TestnetStock stock, TestnetWrappedStock wrapped, RFQExchange exchange, SeriesVault vault)
    {
        require(block.chainid == 1952, "X Layer testnet only");
        address deployer = vm.envAddress("TESTNET_DEPLOYER");
        address usdg = vm.envAddress("TESTNET_USDG");
        address dealer = vm.envOr("TESTNET_DEALER", deployer);
        uint256 feeBps = vm.envOr("TESTNET_FEE_BPS", uint256(1000));
        require(deployer != address(0) && dealer != address(0), "Invalid account");
        require(usdg.code.length != 0 && IERC20Metadata(usdg).decimals() == 6, "Invalid USDG");
        require(feeBps <= 10_000, "Invalid fee");

        uint64 firstExpiry = uint64(block.timestamp + 7 days);
        uint64 secondExpiry = uint64(block.timestamp + 14 days);

        vm.startBroadcast(deployer);
        stock = new TestnetStock(deployer);
        wrapped = new TestnetWrappedStock(stock);
        exchange = new RFQExchange(usdg, deployer, deployer, uint16(feeBps));
        vault = new SeriesVault(usdg, address(wrapped), deployer, address(exchange));
        exchange.setVaultAllowed(address(vault), true);
        exchange.setDealerAllowed(dealer, true);

        // Seed a backed wrapper at 1:1; retain native units for wrap/unwrap integration tests.
        stock.mint(deployer, 100e18);
        stock.approve(address(wrapped), 50e18);
        wrapped.deposit(50e18, deployer);

        _createPair(vault, firstExpiry);
        _createPair(vault, secondExpiry);
        vm.stopBroadcast();

        console2.log("Test stock:", address(stock));
        console2.log("Test wrapped stock:", address(wrapped));
        console2.log("RFQExchange:", address(exchange));
        console2.log("SeriesVault:", address(vault));
        console2.log("Initial whitelisted dealer:", dealer);
    }

    function _createPair(SeriesVault vault, uint64 expiry) private {
        vault.createSeries(T.Side.Put, 175e6, expiry - 1 hours, expiry, expiry + 30 minutes);
        vault.createSeries(T.Side.Call, 185e6, expiry - 1 hours, expiry, expiry + 30 minutes);
    }
}
