// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TestnetStock, TestnetWrappedStock} from "../script/assets/TestnetStock.sol";

contract TestnetAssetsTest is Test {
    TestnetStock private stock;
    TestnetWrappedStock private wrapped;
    address private user = makeAddr("user");

    function setUp() public {
        stock = new TestnetStock(address(this));
        wrapped = new TestnetWrappedStock(stock);
    }

    function testOnlyMinterCanIssueTestStock() public {
        vm.prank(user);
        vm.expectRevert(TestnetStock.Unauthorized.selector);
        stock.mint(user, 1e18);
        stock.mint(user, 10e18);
        assertEq(stock.balanceOf(user), 10e18);
    }

    function testWrapperRequiresBackingAndRedeemsExactly() public {
        assertEq(wrapped.asset(), address(stock));
        assertEq(stock.decimals(), 18);
        assertEq(wrapped.decimals(), 18);
        stock.mint(user, 10e18);
        vm.startPrank(user);
        vm.expectRevert();
        wrapped.deposit(10e18, user);
        stock.approve(address(wrapped), 10e18);
        assertEq(wrapped.deposit(10e18, user), 10e18);
        assertEq(stock.balanceOf(address(wrapped)), wrapped.totalAssets());
        assertEq(wrapped.redeem(10e18, user, user), 10e18);
        vm.stopPrank();
        assertEq(stock.balanceOf(user), 10e18);
        assertEq(wrapped.totalSupply(), 0);
    }

    function testAssetGrowthChangesConversionWithoutChangingWrappedBalance() public {
        stock.mint(user, 10e18);
        vm.startPrank(user);
        stock.approve(address(wrapped), 10e18);
        wrapped.deposit(10e18, user);
        vm.stopPrank();
        // A donation models asset growth, not xStocks' native share accounting.
        stock.mint(address(wrapped), 1e18);
        assertEq(wrapped.balanceOf(user), 10e18);
        assertGt(wrapped.convertToAssets(10e18), 10e18);
    }

    function testMainnetRateSnapshotWithVirtualSharesStillMintsAndRedeems() public {
        uint256 rate = 1_001_701_196_801_074_000;
        uint256 supply = 153_002_200_000_000_000_000;
        stock.mint(user, supply);
        vm.startPrank(user);
        stock.approve(address(wrapped), supply);
        wrapped.deposit(supply, user);
        vm.stopPrank();
        uint256 assets = Math.mulDiv(rate, supply + 1, 1e18, Math.Rounding.Ceil) - 1;
        stock.mint(address(wrapped), assets - wrapped.totalAssets());
        assertEq(wrapped.convertToAssets(1e18), rate);
        assertEq(wrapped.balanceOf(user), supply);
        assertEq(wrapped.totalSupply(), supply);
        uint256 cost = wrapped.previewMint(1e18);
        stock.mint(user, cost);
        vm.startPrank(user);
        stock.approve(address(wrapped), cost);
        assertEq(wrapped.mint(1e18, user), cost);
        assertEq(wrapped.balanceOf(user), supply + 1e18);
        uint256 redeemable = wrapped.previewRedeem(1e18);
        assertEq(wrapped.redeem(1e18, user, user), redeemable);
        vm.stopPrank();
        assertGe(cost, redeemable);
        assertLe(cost - redeemable, 1);
    }
}
