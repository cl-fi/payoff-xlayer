// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SystemFixture} from "./helpers/SystemFixture.sol";
import {RedeployTestnetMarket} from "../script/RedeployTestnetMarket.s.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";

contract RedeployTestnetMarketTest is SystemFixture {
    function _terms() internal view returns (T.Series[] memory terms) {
        terms = new T.Series[](2);
        terms[0] = vaultA.getSeries(PUT);
        terms[1] = vaultA.getSeries(CALL);
    }

    function testReplacementKeepsTokensBalancesAndTermsAndChargesTenPercentOnBothSides() public {
        vm.chainId(1952);
        RFQExchange previousExchange = exchange;
        SeriesVault previousVault = vaultA;
        T.Series[] memory terms = _terms();
        (exchange, vaultA) = new RedeployTestnetMarket().run(address(vaultA), dealer, 1000, 1e18, terms);
        assertEq(exchange.feeBps(), 1000);
        assertEq(exchange.feeRecipient(), feeRecipient);
        assertEq(address(vaultA.usdg()), address(usd));
        assertEq(address(vaultA.wrappedStock()), address(wrappedA));
        assertEq(address(vaultA.stock()), address(stockA));
        assertEq(usd.balanceOf(dealer), 10_000e6);
        assertEq(wrappedA.balanceOf(dealer), 100e18);
        assertEq(previousExchange.feeBps(), 100);
        assertEq(previousVault.nextPositionId(), 1);
        for (uint256 i = 1; i <= 2; ++i) {
            assertEq(keccak256(abi.encode(vaultA.getSeries(i))), keccak256(abi.encode(terms[i - 1])));
        }
        vm.prank(dealer);
        usd.approve(address(exchange), 4e6);
        vm.startPrank(user);
        usd.approve(address(vaultA), 180e6);
        wrappedA.approve(address(vaultA), 1e18);
        vm.stopPrank();
        for (uint256 i = 1; i <= 2; ++i) {
            T.Quote memory q = _quote(vaultA, i, i);
            _rejected(q, RFQExchange.InvalidQuote.selector); // The former 1% split cannot execute.
            q.protocolFeeUSDG = 200_000;
            q.netPremiumUSDG = 1_800_000;
            _fill(q);
        }
        assertEq(usd.balanceOf(dealer), 9996e6);
        assertEq(usd.balanceOf(feeRecipient), 0.4e6);
        assertEq(usd.balanceOf(user), 9823.6e6);
        assertEq(vaultA.accountedUSDG(), 180e6);
        assertEq(vaultA.accountedWrapped(), 1e18);
    }

    function testReplacementRejectsWrongNetworkAndStaleRate() public {
        RedeployTestnetMarket deployer = new RedeployTestnetMarket();
        T.Series[] memory terms = _terms();
        vm.chainId(196);
        vm.expectRevert("X Layer testnet only");
        deployer.run(address(vaultA), dealer, 1000, 1e18, terms);
        vm.chainId(1952);
        vm.expectRevert("Wrapper rate changed; refresh plan");
        deployer.run(address(vaultA), dealer, 1000, 2e18, terms);
    }
}
