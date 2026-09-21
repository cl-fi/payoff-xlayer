// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SystemFixture} from "./helpers/SystemFixture.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {PayoffMath} from "../src/libraries/PayoffMath.sol";

contract WrappedAccountingTest is SystemFixture {
    function testEntryAtNonUnitRateOnlyReceivesSubsequentGrowth() public {
        stockA.setMultiplier(1.003e18);
        // Transfer existing assets, then wrap exactly the received stock amount.
        address newcomer = makeAddr("newcomer");
        vm.prank(dealer);
        wrappedA.redeem(2e18, newcomer, dealer);
        vm.startPrank(newcomer);
        stockA.approve(address(wrappedA), 1e18);
        uint256 w = wrappedA.deposit(1e18, newcomer);
        wrappedA.approve(address(vaultA), w);
        vm.stopPrank();
        assertEq(w, uint256(1e36) / 1.003e18);
        T.Quote memory q = _quote(vaultA, CALL, 0);
        q.taker = newcomer;
        q.wrappedQuantity = w;
        q.strikeAmountUSDG = PayoffMath.strikeAmount(w, 200e6);
        uint256 id = _fill(q);
        assertEq(vaultA.position(id).wrappedBalance, w);
        stockA.setMultiplier(1.005e18);
        assertEq(wrappedA.convertToAssets(w), w * 1.005e18 / 1e18);
        assertLt(wrappedA.convertToAssets(w), 1.002e18);
        vm.warp(3300);
        vm.prank(newcomer);
        vaultA.claim(id);
        assertEq(wrappedA.balanceOf(newcomer), w);
        assertEq(vaultA.accountedWrapped(), 0);
    }

    function testNewDepositAfterSplitUsesSameFungibleWrappedUnit() public {
        stockA.setMultiplier(4e18);
        vm.startPrank(dealer);
        wrappedA.redeem(2e18, dealer, dealer);
        uint256 beforeWrapped = wrappedA.balanceOf(dealer);
        uint256 received = wrappedA.deposit(4e18, dealer);
        vm.stopPrank();
        assertEq(received, 1e18);
        assertEq(wrappedA.balanceOf(dealer), beforeWrapped + 1e18);
        assertEq(wrappedA.convertToAssets(received), 4e18);
        assertEq(stockA.sharesOf(address(wrappedA)), wrappedA.totalSupply());
        stockA.setMultiplier(0.25e18);
        assertEq(wrappedA.balanceOf(dealer), beforeWrapped + 1e18);
        assertEq(wrappedA.convertToAssets(received), 0.25e18);
    }

    function testDonationsDoNotChangePositionDeliveryOrCreateClaimRights() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        vm.prank(user2);
        wrappedA.transfer(address(vaultA), 3e18);
        vm.prank(user2);
        usd.transfer(address(vaultA), 5e6);
        assertEq(vaultA.accountedWrapped(), 1e18);
        assertEq(vaultA.accountedUSDG(), 0);
        vm.warp(3000);
        vm.prank(dealer);
        vaultA.exercise(id);
        assertEq(wrappedA.balanceOf(address(vaultA)), 3e18);
        vm.prank(user);
        vaultA.claim(id);
        assertEq(wrappedA.balanceOf(address(vaultA)), 3e18);
        assertEq(usd.balanceOf(address(vaultA)), 5e6);
        assertEq(vaultA.accountedUSDG(), 0);
        assertEq(vaultA.accountedWrapped(), 0);
    }
}
