// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SystemFixture} from "./helpers/SystemFixture.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {ExactERC20} from "../src/libraries/ExactERC20.sol";
import {QuoteLib} from "../src/libraries/QuoteLib.sol";
import {MockDealerWallet} from "./mocks/MockDealerWallet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RFQExchangeTest is SystemFixture {
    function testOldDomainCannotAuthorizeWrappedSettlement() public {
        T.Quote memory q = _quote(vaultA, CALL, 0);
        bytes32 oldDomain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Payoff RFQ"),
                keccak256("1"),
                block.chainid,
                address(exchange)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", oldDomain, QuoteLib.structHash(q)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEALER_KEY, digest);
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, abi.encodePacked(r, s, v), _limits());
        assertFalse(exchange.nonceUnavailable(dealer, 0));
        assertEq(vaultA.accountedWrapped(), 0);
    }

    function testSignedPutFillPaysNetAndFeeAndConsumesNonce() public {
        uint256 id = _fill(_quote(vaultA, PUT, 7));
        assertEq(id, 1);
        assertEq(usd.balanceOf(user), 9821.98e6);
        assertEq(usd.balanceOf(dealer), 9998e6);
        assertEq(usd.balanceOf(feeRecipient), 0.02e6);
        assertEq(vaultA.accountedUSDG(), 180e6);
        assertTrue(exchange.nonceUnavailable(dealer, 7));
        assertEq(exchange.netPremiumOf(address(vaultA), id), 1_980_000);
        assertEq(exchange.netPremiumOf(address(vaultB), id), 0);
    }

    function testNonceCannotReplayAcrossVaults() public {
        _fill(_quote(vaultA, PUT, 7));
        _rejected(_quote(vaultB, PUT, 7), RFQExchange.NonceUnavailable.selector);
        assertEq(vaultB.nextPositionId(), 1);
    }

    function testSignedVaultBindingPreventsSameSeriesIdSubstitution() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        bytes memory sig = _signature(q);
        q.vault = address(vaultB);
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, sig, _limits());
    }

    function testSignedQuantityAndPremiumCannotBeEdited() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        bytes memory sig = _signature(q);
        q.wrappedQuantity /= 2;
        q.strikeAmountUSDG /= 2;
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, sig, _limits());
        q = _quote(vaultA, PUT, 0);
        q.grossPremiumUSDG *= 2;
        q.protocolFeeUSDG *= 2;
        q.netPremiumUSDG *= 2;
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, sig, _limits());
    }

    function testSignatureCannotReplayOnAnotherChain() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        bytes memory sig = _signature(q);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, sig, _limits());
    }

    function testSignatureFromAnotherExchangeDomainIsRejected() public {
        RFQExchange other = new RFQExchange(address(usd), address(this), feeRecipient, 100);
        T.Quote memory q = _quote(vaultA, PUT, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEALER_KEY, other.quoteDigest(q));
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, abi.encodePacked(r, s, v), _limits());
    }

    function testEOABadSignatureRejected() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, hex"1234", _limits());
    }

    function testOnlySpecifiedTakerMayAccept() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        bytes memory sig = _signature(q);
        vm.expectRevert(RFQExchange.Unauthorized.selector);
        vm.prank(user2);
        exchange.fill(q, sig, _limits());
    }

    function testOnlyAdmittedVaultAndDealer() public {
        exchange.setVaultAllowed(address(vaultA), false);
        _rejected(_quote(vaultA, PUT, 0), RFQExchange.VaultNotAllowed.selector);
        exchange.setVaultAllowed(address(vaultA), true);
        exchange.setDealerAllowed(dealer, false);
        _rejected(_quote(vaultA, PUT, 0), RFQExchange.DealerNotAllowed.selector);
    }

    function testDealerCanCancelAfterRemovalAndPauseButOthersCannotCancelForIt() public {
        vm.prank(user);
        exchange.cancelNonce(3);
        assertFalse(exchange.nonceUnavailable(dealer, 3));
        exchange.setDealerAllowed(dealer, false);
        exchange.setNewPositionsPaused(true);
        vm.prank(dealer);
        exchange.cancelNonce(3);
        exchange.setNewPositionsPaused(false);
        exchange.setDealerAllowed(dealer, true);
        _rejected(_quote(vaultA, PUT, 3), RFQExchange.NonceUnavailable.selector);
        vm.expectRevert(RFQExchange.NonceUnavailable.selector);
        vm.prank(dealer);
        exchange.cancelNonce(3);
    }

    function testQuoteTimeChecksFutureExpiredAndInverted() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        q.issuedAt = 1001;
        _rejected(q, RFQExchange.InvalidQuoteTime.selector);
        q.issuedAt = 990;
        q.deadline = 999;
        _rejected(q, RFQExchange.InvalidQuoteTime.selector);
        q.issuedAt = 999;
        q.deadline = 998;
        _rejected(q, RFQExchange.InvalidQuoteTime.selector);
    }

    function testDeadlineIsInclusiveButTradeCutoffExclusive() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        vm.warp(q.deadline);
        _fill(q);
        vm.warp(1990);
        q = _quote(vaultA, PUT, 1);
        _rejected(q, RFQExchange.InvalidQuoteTime.selector); // Deadline crosses cutoff.
        q.deadline = 2000;
        vm.warp(2000);
        _rejected(q, RFQExchange.InvalidQuoteTime.selector);
    }

    function testQuoteMustMatchStrikeAmountAndPremiumArithmetic() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        ++q.strikeAmountUSDG;
        _rejected(q, RFQExchange.InvalidQuote.selector);
        q = _quote(vaultA, PUT, 0);
        ++q.netPremiumUSDG;
        _rejected(q, RFQExchange.InvalidQuote.selector);
        q = _quote(vaultA, PUT, 0);
        ++q.protocolFeeUSDG;
        --q.netPremiumUSDG;
        _rejected(q, RFQExchange.InvalidQuote.selector);
    }

    function testUserNetPremiumAndCashCollateralProtections() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        bytes memory sig = _signature(q);
        T.FillLimits memory limits = _limits();
        limits.minNetPremiumUSDG = q.netPremiumUSDG + 1;
        vm.expectRevert(RFQExchange.UserProtectionFailed.selector);
        vm.prank(user);
        exchange.fill(q, sig, limits);
        limits.minNetPremiumUSDG = 0;
        limits.maxCollateralUSDG = q.strikeAmountUSDG - 1;
        vm.expectRevert(RFQExchange.UserProtectionFailed.selector);
        vm.prank(user);
        exchange.fill(q, sig, limits);
    }

    function testCallRespectsUserWrappedCap() public {
        T.Quote memory q = _quote(vaultA, CALL, 0);
        bytes memory sig = _signature(q);
        T.FillLimits memory limits = _limits();
        limits.maxCollateralWrapped = 1e18 - 1;
        vm.expectRevert(SeriesVault.CollateralLimitExceeded.selector);
        vm.prank(user);
        exchange.fill(q, sig, limits);
        assertFalse(exchange.nonceUnavailable(dealer, 0));
    }

    function testBothSidesAcceptTinyAndLargeOrdersWithoutProtocolAmountBounds() public {
        for (uint256 side = PUT; side <= CALL; ++side) {
            T.Quote memory q = _quote(vaultA, side, side * 2);
            q.wrappedQuantity = 1;
            q.strikeAmountUSDG = 1; // ceil: smallest positive USDG unit.
            uint256 tinyId = _fill(q);
            assertEq(vaultA.position(tinyId).strikeAmountUSDG, 1);
            q = _quote(vaultA, side, side * 2 + 1);
            q.wrappedQuantity = 10e18;
            q.strikeAmountUSDG *= 10;
            uint256 largeId = _fill(q);
            assertEq(vaultA.position(largeId).strikeAmountUSDG, q.strikeAmountUSDG);
        }
        assertEq(vaultA.accountedUSDG(), 1800e6 + 1);
        assertEq(vaultA.accountedWrapped(), 10e18 + 1);
    }

    function testOneStocksOpenPositionsAndAdmissionDoNotLimitAnotherStock() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        q.wrappedQuantity = 10e18;
        q.strikeAmountUSDG = 1800e6;
        _fill(q);
        exchange.setVaultAllowed(address(vaultA), false);
        q = _quote(vaultB, CALL, 1);
        q.wrappedQuantity = 10e18;
        q.strikeAmountUSDG = 2000e6;
        _fill(q);
        assertEq(vaultA.accountedUSDG(), 1800e6);
        assertEq(vaultB.accountedWrapped(), 10e18);
    }

    function testFillDoesNotCallAnUnrelatedVaultEvenIfItReverts() public {
        // Every call to the unrelated registered Vault would revert.
        vm.etch(address(vaultB), hex"60006000fd");
        T.Quote memory q = _quote(vaultA, PUT, 0);
        vm.record();
        _fill(q);
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(vaultB));
        assertEq(reads.length, 0);
        assertEq(writes.length, 0);
        assertEq(vaultA.accountedUSDG(), 180e6);
    }

    function testDealerChoosesLongerValidityWithinSeriesCutoff() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        q.deadline = 1900;
        vm.warp(1500);
        _fill(q);
        assertTrue(exchange.nonceUnavailable(dealer, 0));
    }

    function testZeroQuantityStillRejectedWithoutOrderMinimum() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        q.wrappedQuantity = 0;
        q.strikeAmountUSDG = 0;
        _rejected(q, RFQExchange.InvalidQuote.selector);
    }

    function testNewSeriesDoesNotReuseExpiredUnclaimedCollateral() public {
        uint256 id = _fill(_quote(vaultA, PUT, 0));
        vm.warp(3300);

        assertEq(vaultA.accountedUSDG(), 180e6);
        uint256 next = vaultA.createSeries(T.Side.Put, 180e6, 4000, 4100, 4400);
        _fill(_quote(vaultA, next, 1));
        assertEq(vaultA.accountedUSDG(), 360e6);
        vm.prank(user);
        vaultA.claim(id);
        assertEq(vaultA.accountedUSDG(), 180e6);
    }

    function testPauseAndAdmissionCannotBlockEitherExit() public {
        uint256 putId = _fill(_quote(vaultA, PUT, 0));
        uint256 callId = _fill(_quote(vaultB, CALL, 1));
        exchange.setNewPositionsPaused(true);
        _rejected(_quote(vaultA, PUT, 2), RFQExchange.NewPositionsPaused.selector);
        vaultA.setNewPositionsPaused(true);
        vaultB.setNewPositionsPaused(true);
        exchange.setVaultAllowed(address(vaultA), false);
        exchange.setDealerAllowed(dealer, false);
        vm.warp(3000);
        vm.prank(dealer);
        vaultA.exercise(putId);
        vm.prank(dealer);
        vaultB.exercise(callId);

        assertEq(vaultB.accountedUSDG(), 200e6);
        vm.prank(user);
        vaultA.claim(putId);
        vm.prank(user);
        vaultB.claim(callId);
    }

    function testFeeLegFailureRollsBackBothSidesAndNonceThenCanRetry() public {
        for (uint256 side = PUT; side <= CALL; ++side) {
            T.Quote memory q = _quote(vaultA, side, side);
            bytes memory sig = _signature(q);
            uint256 beforeUSDG = usd.balanceOf(user);
            uint256 beforeWrapped = wrappedA.balanceOf(user);
            usd.setBlockedRecipient(feeRecipient);
            vm.expectRevert(bytes("mock: blocked recipient"));
            vm.prank(user);
            exchange.fill(q, sig, _limits());
            assertEq(usd.balanceOf(user), beforeUSDG);
            assertEq(wrappedA.balanceOf(user), beforeWrapped);
            assertFalse(exchange.nonceUnavailable(dealer, side));
            assertEq(vaultA.nextPositionId(), side);
            assertEq(vaultA.balanceOf(user, vaultA.shortTokenId(side)), 0);
            usd.setBlockedRecipient(address(0));
            assertEq(_fill(q), side);
        }
    }

    function testInsufficientPremiumAllowanceRollsBackStockLock() public {
        T.Quote memory q = _quote(vaultA, CALL, 0);
        bytes memory sig = _signature(q);
        vm.prank(dealer);
        usd.approve(address(exchange), 0);
        vm.expectRevert();
        vm.prank(user);
        exchange.fill(q, sig, _limits());
        assertEq(wrappedA.balanceOf(user), 100e18);
        assertEq(vaultA.accountedWrapped(), 0);
        assertFalse(exchange.nonceUnavailable(dealer, 0));
    }

    function testFeeOnTransferPremiumRollsBackStockAndNonce() public {
        usd.setTransferFee(true);
        _rejected(_quote(vaultA, CALL, 0), ExactERC20.UnexpectedTokenDelta.selector);
        assertEq(vaultA.accountedWrapped(), 0);
        assertEq(wrappedA.balanceOf(user), 100e18);
        assertFalse(exchange.nonceUnavailable(dealer, 0));
    }

    function testStockCallbackCannotReenterSharedExchange() public {
        T.Quote memory q = _quote(vaultA, CALL, 0);
        wrappedA.setHook(address(exchange), abi.encodeCall(exchange.fill, (q, _signature(q), _limits())));
        _fill(q);
        assertFalse(wrappedA.hookSucceeded());
        assertEq(wrappedA.hookResult(), abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        assertEq(vaultA.nextPositionId(), 2);
    }

    function testContractDealerSignatureRevocationAndDirectExercise() public {
        MockDealerWallet wallet = new MockDealerWallet();
        exchange.setDealerAllowed(address(wallet), true);
        usd.mint(address(wallet), 1000e6);
        wallet.execute(address(usd), abi.encodeCall(IERC20.approve, (address(exchange), type(uint256).max)));
        wallet.execute(address(usd), abi.encodeCall(IERC20.approve, (address(vaultA), type(uint256).max)));
        T.Quote memory q = _quote(vaultA, CALL, 0);
        q.dealer = address(wallet);
        bytes32 digest = exchange.quoteDigest(q);
        wallet.approveDigest(digest, true);
        wallet.approveDigest(digest, false);
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, "", _limits());
        wallet.approveDigest(digest, true);
        vm.prank(user);
        uint256 id = exchange.fill(q, "", _limits());
        vm.warp(3000);
        wallet.execute(address(vaultA), abi.encodeCall(SeriesVault.exercise, (id)));
        assertEq(wrappedA.balanceOf(address(wallet)), 1e18);
        vm.prank(user);
        vaultA.claim(id);
        assertEq(vaultA.accountedUSDG(), 0);
    }
}
