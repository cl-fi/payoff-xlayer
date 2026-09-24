// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SystemFixture} from "./helpers/SystemFixture.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";

contract FeeConfigurationTest is SystemFixture {
    function testOnlyAdministratorCanChangeFeeAndEmitsPreviousAndNewRate() public {
        vm.prank(user);
        vm.expectRevert(RFQExchange.Unauthorized.selector);
        exchange.setFeeBps(1000);
        assertEq(exchange.feeBps(), 100);
        vm.expectEmit(address(exchange));
        emit RFQExchange.ProtocolFeeUpdated(100, 1000);
        exchange.setFeeBps(1000);
        assertEq(exchange.feeBps(), 1000);
        assertEq(exchange.protocolFee(2e6), 200_000);
    }

    function testFeeBoundsAndBaseUnitRounding() public {
        vm.expectRevert(RFQExchange.InvalidConfiguration.selector);
        exchange.setFeeBps(10_001);
        assertEq(exchange.feeBps(), 100);
        exchange.setFeeBps(1000);
        assertEq(exchange.protocolFee(19), 1);
        exchange.setFeeBps(0);
        assertEq(exchange.protocolFee(2e6), 0);
        exchange.setFeeBps(10_000);
        assertEq(exchange.protocolFee(2e6), 2e6);
    }

    function testChangedFeeRejectsOldQuoteWithoutConsumingNonceAndFreshQuoteFills() public {
        T.Quote memory q = _quote(vaultA, PUT, 17);
        bytes memory oldSignature = _signature(q);
        exchange.setFeeBps(1000);
        vm.expectRevert(RFQExchange.InvalidQuote.selector);
        vm.prank(user);
        exchange.fill(q, oldSignature, _limits());
        assertFalse(exchange.nonceUnavailable(dealer, 17));
        assertEq(vaultA.nextPositionId(), 1);
        q.protocolFeeUSDG = 200_000;
        q.netPremiumUSDG = 1_800_000;
        vm.expectRevert(RFQExchange.InvalidSignature.selector);
        vm.prank(user);
        exchange.fill(q, oldSignature, _limits());
        _fill(q);
        assertEq(usd.balanceOf(user), 9821.8e6);
        assertEq(usd.balanceOf(feeRecipient), 0.2e6);
        assertTrue(exchange.nonceUnavailable(dealer, 17));
    }

    function testFeeChangeDoesNotModifyOpenPositionsOrMoveAssets() public {
        uint256 id = _fill(_quote(vaultA, CALL, 0));
        bytes32 beforePosition = keccak256(abi.encode(vaultA.position(id)));
        uint256 userBalance = usd.balanceOf(user);
        uint256 dealerBalance = usd.balanceOf(dealer);
        uint256 feeBalance = usd.balanceOf(feeRecipient);
        exchange.setFeeBps(1000);
        assertEq(keccak256(abi.encode(vaultA.position(id))), beforePosition);
        assertEq(usd.balanceOf(user), userBalance);
        assertEq(usd.balanceOf(dealer), dealerBalance);
        assertEq(usd.balanceOf(feeRecipient), feeBalance);
        assertEq(vaultA.accountedWrapped(), 1e18);
    }
}
