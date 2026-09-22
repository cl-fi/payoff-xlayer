// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TestnetStock, TestnetWrappedStock} from "../script/assets/TestnetStock.sol";
import {TestnetStockFaucet} from "../script/assets/TestnetStockFaucet.sol";

contract TestnetStockFaucetTest is Test {
    TestnetStock internal stock;
    TestnetStockFaucet internal dispenser;
    address internal user = address(0x1234);

    function setUp() public {
        stock = new TestnetStock(address(this));
        dispenser = new TestnetStockFaucet(stock);
        stock.mint(address(dispenser), 100e18);
    }

    function testRepeatedClaimsCanBeWrappedForSellHigh() public {
        TestnetWrappedStock wrapped = new TestnetWrappedStock(stock);
        vm.startPrank(user);
        dispenser.faucet(10e18);
        dispenser.faucet(5e18 + 1);
        assertEq(stock.balanceOf(user), 15e18 + 1);
        stock.approve(address(wrapped), 12e18);
        wrapped.deposit(12e18, user);
        vm.stopPrank();
        assertEq(wrapped.balanceOf(user), 12e18);
        assertEq(stock.balanceOf(user), 3e18 + 1);
        assertEq(stock.balanceOf(address(dispenser)), 85e18 - 1);
    }

    function testInsufficientInventoryRevertsAndMinterCanRefill() public {
        vm.prank(user);
        vm.expectRevert();
        dispenser.faucet(101e18);
        assertEq(stock.balanceOf(user), 0);
        stock.mint(address(dispenser), 1e18);
        vm.prank(user);
        dispenser.faucet(101e18);
        assertEq(stock.balanceOf(user), 101e18);
    }

    function testRejectsZeroAmount() public {
        vm.expectRevert(TestnetStockFaucet.InvalidAmount.selector);
        dispenser.faucet(0);
    }
}
