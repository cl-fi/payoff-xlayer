// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {PositionReceipts} from "../src/base/PositionReceipts.sol";
import {ExactERC20} from "../src/libraries/ExactERC20.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";

import {Test} from "forge-std/Test.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockWrappedXStock} from "./mocks/MockWrappedXStock.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockXStock} from "./mocks/MockXStock.sol";
import {TestExchange} from "./mocks/TestExchange.sol";

contract SeriesVaultTest is Test {
    MockUSDG internal usd;
    MockXStock internal nv;
    MockWrappedXStock internal wrapped;
    TestExchange internal exchange;
    SeriesVault internal vault;
    address internal user = makeAddr("user");
    address internal dealer = makeAddr("dealer");
    address internal stranger = makeAddr("stranger");
    uint256 internal seriesId;
    uint256 internal constant Q = 1e18;
    uint256 internal constant U = 180e6;
    uint256 internal constant PREMIUM = 1.5e6;

    function setUp() public {
        vm.warp(1000);
        usd = new MockUSDG();
        nv = new MockXStock();
        wrapped = new MockWrappedXStock(nv);
        exchange = new TestExchange(usd);
        vault = new SeriesVault(address(usd), address(wrapped), address(this), address(exchange));
        exchange.setVault(vault);
        seriesId = vault.createSeries(T.Side.Put, U, 2000, 3000, 3300);
        usd.mint(user, 10_000e6);
        usd.mint(dealer, 10_000e6);
        nv.mint(dealer, 100e18);
        vm.prank(user);
        usd.approve(address(vault), type(uint256).max);
        vm.startPrank(dealer);
        usd.approve(address(exchange), type(uint256).max);
        nv.approve(address(wrapped), type(uint256).max);
        wrapped.deposit(100e18, dealer);
        wrapped.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _open() internal returns (uint256) {
        vm.prank(user);
        return exchange.fillPut(seriesId, dealer, Q, PREMIUM, U);
    }

    function _exercise(uint256 id) internal {
        vm.prank(dealer);
        vault.exercise(id);
    }

    function _claim(uint256 id) internal {
        vm.prank(user);
        vault.claim(id);
    }

    function testOpenLocksFullCollateralAndPaysPremiumAtomically() public {
        uint256 id = _open();
        assertEq(usd.balanceOf(user), 10_000e6 - U + PREMIUM);
        assertEq(usd.balanceOf(address(vault)), U);
        assertEq(vault.accountedUSDG(), U);
        assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), 1);
        assertEq(vault.balanceOf(user, vault.shortTokenId(id)), 1);
    }

    function testRevertedPremiumRollsBackCollateralPositionAndReceipts() public {
        vm.prank(dealer);
        usd.approve(address(exchange), 0);
        vm.expectRevert();
        vm.prank(user);
        exchange.fillPut(seriesId, dealer, Q, PREMIUM, U);
        assertEq(vault.nextPositionId(), 1);
        assertEq(vault.accountedUSDG(), 0);
        assertEq(usd.balanceOf(user), 10_000e6);
        assertEq(vault.balanceOf(user, vault.shortTokenId(1)), 0);
    }

    function testOnlyExchangeMayOpenEvenWithUserAllowance() public {
        vm.expectRevert(SeriesVault.Unauthorized.selector);
        vm.prank(stranger);
        vault.openPosition(T.OpenParams(seriesId, user, stranger, Q, U, U, 0, bytes32(0)));
    }

    function testUserMaximumCollateralIsEnforced() public {
        vm.expectRevert(SeriesVault.CollateralLimitExceeded.selector);
        vm.prank(user);
        exchange.fillPut(seriesId, dealer, Q, PREMIUM, U - 1);
    }

    function testExerciseAtStartThenClaimImmediately() public {
        uint256 id = _open();
        vm.warp(3000);
        _exercise(id);
        assertEq(usd.balanceOf(dealer), 10_000e6 - PREMIUM + U);
        assertEq(vault.accountedUSDG(), 0);
        assertEq(vault.accountedWrapped(), Q);
        assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), 0);
        _claim(id);
        assertEq(wrapped.balanceOf(user), Q);
        assertEq(vault.accountedWrapped(), 0);
        assertEq(uint256(vault.stateOf(id)), uint256(T.State.Claimed));
    }

    function testExerciseBeforeWindowFails() public {
        uint256 id = _open();
        vm.warp(2999);
        vm.expectRevert(SeriesVault.OutsideExerciseWindow.selector);
        _exercise(id);
    }

    function testExerciseLastSecondSucceeds() public {
        uint256 id = _open();
        vm.warp(3299);
        _exercise(id);
        assertEq(uint256(vault.stateOf(id)), uint256(T.State.Exercised));
    }

    function testAtDeadlineExerciseFailsAndCollateralIsDirectlyClaimable() public {
        uint256 id = _open();
        vm.warp(3300);
        assertEq(uint256(vault.stateOf(id)), uint256(T.State.Expired));
        vm.expectRevert(SeriesVault.OutsideExerciseWindow.selector);
        _exercise(id);
        _claim(id);
        assertEq(usd.balanceOf(user), 10_000e6 + PREMIUM);
        assertEq(vault.accountedUSDG(), 0);
        assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), 0);
    }

    function testTradeCutoffIsExclusive() public {
        vm.warp(1999);
        _open();
        vm.warp(2000);
        vm.expectRevert(SeriesVault.TradeClosed.selector);
        vm.prank(user);
        exchange.fillPut(seriesId, dealer, Q, PREMIUM, U);
    }

    function testShortCannotWithdrawWhileLongStillHasRights() public {
        uint256 id = _open();
        vm.warp(3299);
        vm.expectRevert(SeriesVault.ClaimNotReady.selector);
        _claim(id);
    }

    function testOperatorApprovalDoesNotGrantExerciseOrClaimRights() public {
        uint256 id = _open();
        vm.prank(dealer);
        vault.setApprovalForAll(stranger, true);
        vm.prank(user);
        vault.setApprovalForAll(stranger, true);
        vm.warp(3000);
        vm.expectRevert(SeriesVault.Unauthorized.selector);
        vm.prank(stranger);
        vault.exercise(id);
        _exercise(id);
        vm.expectRevert(SeriesVault.Unauthorized.selector);
        vm.prank(stranger);
        vault.claim(id);
    }

    function testReceiptsCannotTransferOrBatchTransfer() public {
        uint256 id = _open();
        uint256 tokenId = vault.shortTokenId(id);
        vm.expectRevert(PositionReceipts.NonTransferable.selector);
        vm.prank(user);
        vault.safeTransferFrom(user, stranger, tokenId, 1, "");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = tokenId;
        amounts[0] = 1;
        vm.expectRevert(PositionReceipts.NonTransferable.selector);
        vm.prank(user);
        vault.safeBatchTransferFrom(user, stranger, ids, amounts, "");
    }

    function testPauseOnlyBlocksNewPositions() public {
        uint256 first = _open();
        uint256 second = _open();
        vault.setNewPositionsPaused(true);
        vm.expectRevert(SeriesVault.NewPositionsPaused.selector);
        vm.prank(user);
        exchange.fillPut(seriesId, dealer, Q, PREMIUM, U);
        vm.warp(3000);
        _exercise(first);
        _claim(first);
        vm.warp(3300);
        _claim(second);
        assertEq(vault.accountedUSDG(), 0);
        assertEq(vault.accountedWrapped(), 0);
    }

    function testExerciseAndClaimCannotBeRepeated() public {
        uint256 id = _open();
        vm.warp(3000);
        _exercise(id);
        vm.expectRevert(SeriesVault.InvalidState.selector);
        _exercise(id);
        _claim(id);
        vm.expectRevert(SeriesVault.InvalidState.selector);
        _claim(id);
    }

    function testRevertedSecondLegRollsBackWrappedStateAndLongRight() public {
        uint256 id = _open();
        usd.setBlockedRecipient(dealer);
        vm.warp(3000);
        vm.expectRevert("mock: blocked recipient");
        _exercise(id);
        assertEq(wrapped.balanceOf(dealer), 100e18);
        assertEq(wrapped.balanceOf(address(vault)), 0);
        assertEq(vault.accountedUSDG(), U);
        assertEq(uint256(vault.stateOf(id)), uint256(T.State.Open));
        assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), 1);
        usd.setBlockedRecipient(address(0));
        _exercise(id);
    }

    function testRevertedClaimKeepsEntireEntitlementForRetry() public {
        uint256 id = _open();
        vm.warp(3000);
        _exercise(id);
        wrapped.setPaused(true);
        vm.expectRevert("mock: paused");
        _claim(id);
        assertEq(vault.position(id).wrappedBalance, Q);
        assertEq(vault.accountedWrapped(), Q);
        assertEq(vault.balanceOf(user, vault.shortTokenId(id)), 1);
        wrapped.setPaused(false);
        _claim(id);
    }

    function testInsufficientNVDAxAllowanceDoesNotConsumeRight() public {
        uint256 id = _open();
        vm.prank(dealer);
        wrapped.approve(address(vault), 0);
        vm.warp(3000);
        vm.expectRevert();
        _exercise(id);
        assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), 1);
        assertEq(vault.accountedUSDG(), U);
    }

    function testFalseShareTransferIsRejected() public {
        uint256 id = _open();
        wrapped.setReturnFalse(true);
        vm.warp(3000);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(wrapped)));
        _exercise(id);
        assertEq(vault.accountedUSDG(), U);
    }

    function testShortShareTransferIsRejectedAndRolledBack() public {
        uint256 id = _open();
        wrapped.setShortTransfer(true);
        vm.warp(3000);
        vm.expectRevert(ExactERC20.UnexpectedTokenDelta.selector);
        _exercise(id);
        assertEq(wrapped.balanceOf(dealer), 100e18);
        assertEq(vault.accountedWrapped(), 0);
    }

    function testFeeOnTransferUSDGIsRejected() public {
        usd.setTransferFee(true);
        vm.expectRevert(ExactERC20.UnexpectedTokenDelta.selector);
        vm.prank(user);
        exchange.fillPut(seriesId, dealer, Q, PREMIUM, U);
        assertEq(vault.accountedUSDG(), 0);
        assertEq(usd.balanceOf(user), 10_000e6);
    }

    function testExternalTokenCallbackCannotReenter() public {
        uint256 id = _open();
        wrapped.setHook(address(vault), abi.encodeCall(vault.exercise, (id)));
        vm.warp(3000);
        _exercise(id);
        assertFalse(wrapped.hookSucceeded());
        assertEq(
            wrapped.hookResult(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
    }

    function testDelayedClaimKeepsWrappedUnitsAndUnderlyingGrowth() public {
        uint256 id = _open();
        vm.warp(3000);
        _exercise(id);
        nv.setMultiplier(1.02e18);
        vm.warp(5000);
        _claim(id);
        assertEq(wrapped.balanceOf(user), Q);
        assertEq(wrapped.convertToAssets(wrapped.balanceOf(user)), 1.02e18);
    }

    function testDifferentDeliveryTimesKeepSeparateShareEntitlements() public {
        uint256 first = _open();
        uint256 second = _open();
        vm.warp(3000);
        _exercise(first);
        nv.setMultiplier(1.3e18);
        _exercise(second);
        uint256 firstWrapped = vault.position(first).wrappedBalance;
        uint256 secondWrapped = vault.position(second).wrappedBalance;
        assertEq(firstWrapped, secondWrapped); // Delivery is fixed in wrapped units at both dates.
        _claim(second);
        assertEq(wrapped.balanceOf(address(vault)), firstWrapped);
        _claim(first);
        assertEq(wrapped.balanceOf(user), firstWrapped + secondWrapped);
    }

    function testAllowanceUsesWrappedUnitsAndIsIndependentOfMultiplier() public {
        nv.setMultiplier(4e18);
        uint256 id = _open();
        vm.prank(dealer);
        wrapped.approve(address(vault), Q);
        vm.warp(3000);
        _exercise(id);
        assertEq(wrapped.allowance(dealer, address(vault)), 0);
        assertEq(vault.position(id).wrappedBalance, Q);
        _claim(id);
        assertEq(wrapped.balanceOf(user), Q);
        assertEq(wrapped.convertToAssets(Q), 4e18);
    }

    function testOnlyAdministratorCanConfigureNewSeriesOrPause() public {
        vm.expectRevert(SeriesVault.Unauthorized.selector);
        vm.prank(stranger);
        vault.setNewPositionsPaused(true);
        vm.expectRevert(SeriesVault.Unauthorized.selector);
        vm.prank(stranger);
        vault.createSeries(T.Side.Put, U, 2000, 3000, 3300);
    }

    function testInvalidSeriesAndUnknownPositionAreRejected() public {
        vm.expectRevert(SeriesVault.InvalidConfiguration.selector);
        vault.createSeries(T.Side.Put, U, 3001, 3000, 3300);
        vm.expectRevert(SeriesVault.UnknownPosition.selector);
        vault.claim(0);
    }

    function testIndexesShortHolderPositionsInOpeningOrder() public {
        assertEq(vault.positionCountOf(user), 0);
        assertEq(vault.positionIdsOf(user, 0, 10).length, 0);
        uint256 first = _open();
        vm.warp(1500);
        uint256 second = _open();
        assertEq(vault.positionCountOf(user), 2);
        uint256[] memory ids = vault.positionIdsOf(user, 0, 10);
        assertEq(ids.length, 2);
        assertEq(ids[0], first);
        assertEq(ids[1], second);
        assertEq(vault.position(first).openedAt, 1000);
        assertEq(vault.position(second).openedAt, 1500);
        // Only the short side is indexed; the long dealer and outsiders see nothing.
        assertEq(vault.positionCountOf(dealer), 0);
        assertEq(vault.positionCountOf(stranger), 0);
        assertEq(vault.positionIdsOf(dealer, 0, 10).length, 0);
    }

    function testPositionIndexPaginatesAndSurvivesSettlement() public {
        uint256 first = _open();
        uint256 second = _open();
        uint256 third = _open();
        uint256[] memory page = vault.positionIdsOf(user, 1, 1);
        assertEq(page.length, 1);
        assertEq(page[0], second);
        page = vault.positionIdsOf(user, 2, 5);
        assertEq(page.length, 1);
        assertEq(page[0], third);
        assertEq(vault.positionIdsOf(user, 3, 5).length, 0);
        assertEq(vault.positionIdsOf(user, 50, 5).length, 0);
        assertEq(vault.positionIdsOf(user, 0, 0).length, 0);
        vm.warp(3000);
        _exercise(first);
        _claim(first);
        assertEq(uint8(vault.stateOf(first)), uint8(T.State.Claimed));
        // Settled and claimed positions remain listed as history.
        assertEq(vault.positionCountOf(user), 3);
        assertEq(vault.positionIdsOf(user, 0, 10)[0], first);
    }

    function testFuzzPutLifecycleConservesAssets(uint96 rawQuantity, uint96 rawMultiplier) public {
        uint256 quantity = bound(uint256(rawQuantity), 1e12, 10e18);
        uint256 multiplier = bound(uint256(rawMultiplier), 0.01e18, 100e18);
        nv.setMultiplier(multiplier);
        vm.prank(user);
        uint256 id = exchange.fillPut(seriesId, dealer, quantity, PREMIUM, type(uint256).max);
        uint256 fixedU = vault.position(id).strikeAmountUSDG;
        // Independently check ceiling rather than call the production math library.
        assertEq(fixedU, (quantity * U + 1e18 - 1) / 1e18);
        uint256 beforeDealerWrapped = wrapped.balanceOf(dealer);
        vm.warp(3000);
        _exercise(id);
        uint256 entitled = vault.position(id).wrappedBalance;
        assertEq(beforeDealerWrapped - wrapped.balanceOf(dealer), entitled);
        assertEq(entitled, quantity);
        nv.setMultiplier(multiplier + 0.01e18);
        _claim(id);
        assertEq(wrapped.balanceOf(user), entitled);
        assertEq(usd.balanceOf(user), 10_000e6 - fixedU + PREMIUM);
        assertEq(usd.balanceOf(dealer), 10_000e6 + fixedU - PREMIUM);
        assertEq(usd.balanceOf(address(vault)), 0);
        assertEq(wrapped.balanceOf(address(vault)), 0);
    }
}
