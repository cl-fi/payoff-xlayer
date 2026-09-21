// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SystemFixture} from "./helpers/SystemFixture.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {MockXStock} from "./mocks/MockXStock.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockWrappedXStock} from "./mocks/MockWrappedXStock.sol";

contract SeriesRegistryTest is SystemFixture {
    function testDifferentWrappersCannotCreateTwoVaultsForOneUnderlying() public {
        MockWrappedXStock second = new MockWrappedXStock(stockA);
        SeriesVault duplicate =
            new SeriesVault(address(usd), address(second), address(this), address(exchange));
        assertEq(duplicate.stock(), address(stockA));
        assertEq(address(duplicate.wrappedStock()), address(second));
        vm.expectRevert(RFQExchange.DuplicateStockVault.selector);
        exchange.setVaultAllowed(address(duplicate), true);
    }

    function testLegacyRulesCannotBeRegistered() public {
        SeriesVault legacy =
            new SeriesVault(address(usd), address(wrappedA), address(this), address(exchange));
        vm.mockCall(address(legacy), abi.encodeWithSignature("RULES_VERSION()"), abi.encode(uint256(1)));
        vm.expectRevert(RFQExchange.InvalidConfiguration.selector);
        exchange.setVaultAllowed(address(legacy), true);
    }

    function testRawStockAndInvalidWrapperBindingCannotBeConfigured() public {
        vm.expectRevert(); // Native xStock has no ERC-4626 asset() identity.
        new SeriesVault(address(usd), address(stockA), address(this), address(exchange));
        vm.mockCall(address(wrappedA), abi.encodeWithSignature("asset()"), abi.encode(address(usd)));
        vm.expectRevert(SeriesVault.InvalidConfiguration.selector);
        new SeriesVault(address(usd), address(wrappedA), address(this), address(exchange));
    }

    function testExchangeConfigurationRequiresAdministrator() public {
        vm.startPrank(user);
        vm.expectRevert(RFQExchange.Unauthorized.selector);
        exchange.setVaultAllowed(address(vaultA), false);
        vm.expectRevert(RFQExchange.Unauthorized.selector);
        exchange.setDealerAllowed(user, true);
        vm.expectRevert(RFQExchange.Unauthorized.selector);
        exchange.setNewPositionsPaused(true);
        vm.stopPrank();
    }

    function testRejectsInconsistentRegistryConfigurationAndDuplicateStock() public {
        SeriesVault duplicate =
            new SeriesVault(address(usd), address(wrappedA), address(this), address(exchange));
        vm.expectRevert(RFQExchange.DuplicateStockVault.selector);
        exchange.setVaultAllowed(address(duplicate), true);
        SeriesVault wrongAdmin = new SeriesVault(address(usd), address(wrappedA), user, address(exchange));
        vm.expectRevert(RFQExchange.InvalidConfiguration.selector);
        exchange.setVaultAllowed(address(wrongAdmin), true);
        SeriesVault wrongExchange =
            new SeriesVault(address(usd), address(wrappedA), address(this), address(vaultA));
        vm.expectRevert(RFQExchange.InvalidConfiguration.selector);
        exchange.setVaultAllowed(address(wrongExchange), true);
        SeriesVault wrongCash =
            new SeriesVault(address(new MockUSDG()), address(wrappedA), address(this), address(exchange));
        vm.expectRevert(RFQExchange.InvalidConfiguration.selector);
        exchange.setVaultAllowed(address(wrongCash), true);
        vm.expectRevert(RFQExchange.InvalidConfiguration.selector);
        exchange.setVaultAllowed(user, true);
        vm.expectRevert(RFQExchange.InvalidConfiguration.selector);
        exchange.setVaultAllowed(user, false);
    }

    function testMoreThan32LiveSeriesKeepIndependentTermsAndClaims() public {
        uint256 old = _fill(_quote(vaultA, CALL, 0));
        for (uint256 i = 2; i < 80; ++i) {
            vaultA.createSeries(T.Side.Put, 180e6, 2000, 3000, 3300);
        }
        assertEq(vaultA.nextSeriesId(), 81);
        _fill(_quote(vaultA, 80, 1));
        assertEq(vaultA.accountedUSDG(), 180e6);
        vm.warp(3300);
        uint256 next = vaultA.createSeries(T.Side.Call, 200e6, 4000, 4100, 4400);
        assertEq(next, 81);
        assertEq(vaultA.getSeries(CALL).exerciseEnd, 3300);
        _fill(_quote(vaultA, next, 2));
        vm.prank(user);
        vaultA.claim(old);
        assertEq(vaultA.accountedWrapped(), 1e18);
        assertEq(vaultA.accountedUSDG(), 180e6);
    }

    function testMoreThan16VaultsCanRegisterAndTradeAtTheNewAddress() public {
        SeriesVault last;
        MockXStock lastStock;
        for (uint256 i = 2; i < 20; ++i) {
            lastStock = new MockXStock();
            last = _newVault(lastStock);
            assertEq(exchange.registeredVaultAt(i), address(last));
        }
        assertEq(exchange.registeredVaultCount(), 20);
        MockWrappedXStock lastWrapped = MockWrappedXStock(address(last.wrappedStock()));
        lastStock.mint(user, 2e18);
        vm.startPrank(user);
        usd.approve(address(last), type(uint256).max);
        lastStock.approve(address(lastWrapped), type(uint256).max);
        lastWrapped.deposit(2e18, user);
        lastWrapped.approve(address(last), type(uint256).max);
        vm.stopPrank();
        _fill(_quote(last, PUT, 0));
        _fill(_quote(last, CALL, 1));
        assertEq(last.accountedUSDG(), 180e6);
        assertEq(last.accountedWrapped(), 1e18);
        exchange.setVaultAllowed(address(vaultA), false);
        exchange.setVaultAllowed(address(vaultA), true);
        assertEq(exchange.registeredVaultCount(), 20); // Re-enabling does not duplicate the entry.
        assertEq(exchange.registeredVaultAt(0), address(vaultA));
        assertEq(exchange.vaultForStock(address(stockA)), address(vaultA));
    }

    function testFillCostDoesNotGrowWithUnrelatedVaultsAndSeries() public {
        T.Quote memory q = _quote(vaultA, PUT, 0);
        uint256 snapshot = vm.snapshotState();
        uint256 baseline = _fillGas(q);
        vm.revertToState(snapshot);
        for (uint256 i = 2; i < 20; ++i) {
            _newVault(new MockXStock());
        }
        for (uint256 i = 2; i < 80; ++i) {
            vaultA.createSeries(T.Side.Call, 200e6, 2000, 3000, 3300);
        }
        uint256 expanded = _fillGas(q);
        emit log_named_uint("Fill gas before adding markets and series", baseline);
        emit log_named_uint("Fill gas after 20 Vaults and 80 live series", expanded);
        assertLe(expanded, baseline, "fill cost grows with unrelated markets/series");
    }

    function _fillGas(T.Quote memory q) private returns (uint256) {
        bytes memory signature = _signature(q);
        vm.cool(address(exchange));
        vm.cool(address(vaultA));
        vm.cool(address(usd));
        vm.cool(user);
        vm.cool(dealer);
        vm.cool(feeRecipient);
        vm.prank(user);
        exchange.fill(q, signature, _limits());
        return vm.lastCallGas().gasTotalUsed;
    }
}
