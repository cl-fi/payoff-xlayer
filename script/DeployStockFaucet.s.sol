// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {TestnetStock} from "./assets/TestnetStock.sol";
import {TestnetStockFaucet} from "./assets/TestnetStockFaucet.sol";

contract DeployStockFaucet is Script {
    function run(address administrator, TestnetStock stock, uint256 inventory)
        external
        returns (TestnetStockFaucet dispenser)
    {
        require(block.chainid == 1952, "X Layer testnet only");
        require(stock.minter() == administrator && inventory > 0, "Invalid faucet setup");
        vm.startBroadcast(administrator);
        dispenser = new TestnetStockFaucet(stock);
        stock.mint(address(dispenser), inventory);
        vm.stopBroadcast();
    }
}
