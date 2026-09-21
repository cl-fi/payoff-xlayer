// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SystemFixture} from "./helpers/SystemFixture.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CallLifecycleTest is SystemFixture {
    function testCallFillLocksStockAndPaysNetPremiumAndFee() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        assertEq(wrappedA.balanceOf(user), 99e18);
        assertEq(vaultA.position(id).wrappedBalance, 1e18);
        assertEq(vaultA.accountedWrapped(), 1e18);
        assertEq(usd.balanceOf(user), 10_001_980_000);
        assertEq(usd.balanceOf(feeRecipient), 20_000);
    }

    function testCallExerciseDeliversAllWrappedUnitsIncludingDividendRights() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        stockA.setMultiplier(1.02e18);
        vm.warp(3000);
        uint256 dealerBefore = wrappedA.balanceOf(dealer);
        vm.prank(dealer);
        vaultA.exercise(id);
        assertEq(wrappedA.balanceOf(dealer) - dealerBefore, 1e18);
        assertEq(wrappedA.convertToAssets(1e18), 1.02e18);
        assertEq(vaultA.position(id).wrappedBalance, 0);
        assertEq(vaultA.accountedWrapped(), 0);
        assertEq(vaultA.accountedUSDG(), 200e6);
        stockA.setMultiplier(1.03e18);
        uint256 userBefore = wrappedA.balanceOf(user);
        vm.prank(user);
        vaultA.claim(id);
        assertEq(wrappedA.balanceOf(user), userBefore); // No dividend residual is carved out.
        assertEq(usd.balanceOf(user), 10_201_980_000);
        assertEq(vaultA.accountedUSDG(), 0);
    }

    function testCallExpiryReturnsAllWrappedUnitsAfterRebase() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        stockA.setMultiplier(1.05e18);
        vm.warp(3300);

        assertEq(vaultA.accountedWrapped(), 1e18);
        vm.prank(user);
        vaultA.claim(id);
        assertEq(wrappedA.balanceOf(user), 100e18);
        assertEq(wrappedA.convertToAssets(wrappedA.balanceOf(user)), 105e18);
    }

    function testReverseSplitDoesNotBlockExerciseOrConsumeOtherPosition() public {
        uint256 first = _fill(_quote(vaultA, CALL, 0));
        T.Quote memory q = _quote(vaultA, CALL, 1);
        q.taker = user2;
        uint256 second = _fill(q);
        stockA.setMultiplier(0.25e18);
        vm.warp(3000);
        uint256 dealerBefore = wrappedA.balanceOf(dealer);
        vm.prank(dealer);
        vaultA.exercise(first);
        assertEq(wrappedA.balanceOf(dealer) - dealerBefore, 1e18);
        assertEq(wrappedA.convertToAssets(1e18), 0.25e18);
        assertEq(vaultA.accountedWrapped(), 1e18);
        assertEq(vaultA.position(second).wrappedBalance, 1e18);
        vm.prank(user);
        vaultA.claim(first);
        vm.warp(3300);
        vm.prank(user2);
        vaultA.claim(second);
        assertEq(vaultA.accountedWrapped(), 0);
    }

    function testCallTransferFailureRollsBackUSDGAndRights() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        wrappedA.setReturnFalse(true);
        vm.warp(3000);
        uint256 before = usd.balanceOf(dealer);
        vm.expectRevert(
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(wrappedA))
        );
        vm.prank(dealer);
        vaultA.exercise(id);
        assertEq(usd.balanceOf(dealer), before);
        assertEq(vaultA.accountedUSDG(), 0);
        assertEq(vaultA.accountedWrapped(), 1e18);
        assertEq(uint256(vaultA.position(id).state), uint256(T.State.Open));
    }

    function testCallUSDGApprovalRequiredAtExercise() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        vm.prank(dealer);
        usd.approve(address(vaultA), 0);
        vm.warp(3000);
        vm.expectRevert();
        vm.prank(dealer);
        vaultA.exercise(id);
        assertEq(uint256(vaultA.position(id).state), uint256(T.State.Open));
    }

    function testCallClaimOnlyRequiresUSDGEvenIfWrapperTransfersPaused() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        vm.warp(3000);
        vm.prank(dealer);
        vaultA.exercise(id);
        wrappedA.setPaused(true);
        vm.prank(user);
        vaultA.claim(id);
        assertEq(vaultA.accountedUSDG(), 0);
        assertEq(vaultA.accountedWrapped(), 0);
    }

    function testNoConversionOrUnderlyingCallsAreNeededAfterOpening() public {
        uint256 callId = _fill(_quote(vaultA, CALL, 0));
        uint256 putId = _fill(_quote(vaultA, PUT, 1));
        wrappedA.setConversionUnavailable(true);
        vm.etch(address(stockA), hex"60006000fd");
        vm.warp(3000);
        vm.prank(dealer);
        vaultA.exercise(callId);
        vm.prank(dealer);
        vaultA.exercise(putId);
        vm.prank(user);
        vaultA.claim(callId);
        vm.prank(user);
        vaultA.claim(putId);
        assertEq(vaultA.accountedUSDG(), 0);
        assertEq(vaultA.accountedWrapped(), 0);
    }

    function testTwoStocksAndBothSidesSettleIndependently() public {
        uint256 aPut = _fill(_quote(vaultA, PUT, 0));
        uint256 aCall = _fill(_quote(vaultA, CALL, 1));
        uint256 bPut = _fill(_quote(vaultB, PUT, 2));
        uint256 bCall = _fill(_quote(vaultB, CALL, 3));
        assertEq(aPut, bPut); // IDs deliberately collide across Vaults.
        assertEq(aCall, bCall);

        vm.warp(3000);
        vm.prank(dealer);
        vaultA.exercise(aCall);
        vm.prank(dealer);
        vaultB.exercise(bPut);
        vm.prank(user);
        vaultA.claim(aCall);
        vm.prank(user);
        vaultB.claim(bPut);
        assertEq(vaultA.accountedUSDG(), 180e6);
        assertEq(vaultB.accountedWrapped(), 1e18);
        vm.warp(3300);
        vm.prank(user);
        vaultA.claim(aPut);
        vm.prank(user);
        vaultB.claim(bCall);
        assertEq(vaultA.accountedUSDG() + vaultB.accountedUSDG(), 0);
        assertEq(vaultA.accountedWrapped() + vaultB.accountedWrapped(), 0);
    }

    function testFuzzCallRebaseConservesPerPositionWrappedUnits(uint96 rawQty, uint96 rawRebase) public {
        T.Quote memory q = _quote(vaultA, CALL, 0);
        q.wrappedQuantity = bound(uint256(rawQty), 0.05e18, 1e18);
        q.strikeAmountUSDG = (q.wrappedQuantity * 200e6 + 1e18 - 1) / 1e18;
        uint256 id = _fill(q);
        uint256 multiplier = bound(uint256(rawRebase), 0.01e18, 100e18);
        stockA.setMultiplier(multiplier);
        vm.warp(3000);
        uint256 dealerBefore = wrappedA.balanceOf(dealer);
        vm.prank(dealer);
        vaultA.exercise(id);
        uint256 received = wrappedA.balanceOf(dealer) - dealerBefore;
        uint256 residual = vaultA.position(id).wrappedBalance;
        assertEq(received + residual, q.wrappedQuantity);
        assertEq(received, q.wrappedQuantity);
        assertEq(residual, 0);
        vm.prank(user);
        vaultA.claim(id);
        assertEq(wrappedA.balanceOf(user) + received, 100e18);
        assertEq(usd.balanceOf(address(vaultA)), 0);
        assertEq(wrappedA.balanceOf(address(vaultA)), 0);
    }
}
