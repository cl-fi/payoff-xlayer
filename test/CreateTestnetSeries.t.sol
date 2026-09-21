// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CreateTestnetSeries} from "../script/CreateTestnetSeries.s.sol";
import {TestnetStock, TestnetWrappedStock} from "../script/assets/TestnetStock.sol";
import {RFQExchange} from "../src/RFQExchange.sol";
import {SeriesVault} from "../src/SeriesVault.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

contract CreateTestnetSeriesTest is Test {
    CreateTestnetSeries private creator;
    SeriesVault private vault;
    address private administrator = makeAddr("administrator");

    function setUp() public {
        vm.chainId(1952);
        vm.warp(1000);
        MockUSDG usdg = new MockUSDG();
        TestnetStock stock = new TestnetStock(administrator);
        TestnetWrappedStock wrapped = new TestnetWrappedStock(stock);
        RFQExchange exchange = new RFQExchange(address(usdg), administrator, administrator, 100);
        vault = new SeriesVault(address(usdg), address(wrapped), administrator, address(exchange));
        creator = new CreateTestnetSeries();
    }

    function testReusesExistingAndDuplicateTermsAcrossReruns() public {
        vm.prank(administrator);
        vault.createSeries(T.Side.Put, 175e6, 2000, 2000, 3800);
        T.Series[] memory requested = new T.Series[](4);
        requested[0] = T.Series(T.Side.Put, 175e6, 2000, 2000, 3800);
        requested[1] = T.Series(T.Side.Call, 235e6, 2000, 2000, 3800);
        requested[2] = T.Series(T.Side.Put, 220e6, 2000, 2000, 3800);
        requested[3] = requested[1];
        uint256[] memory ids = creator.run(address(vault), administrator, 1e18, requested);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
        assertEq(ids[2], 3);
        assertEq(ids[3], 2);
        assertEq(vault.nextSeriesId(), 4);
        uint256[] memory again = creator.run(address(vault), administrator, 1e18, requested);
        assertEq(again, ids);
        assertEq(vault.nextSeriesId(), 4);
        assertEq(vault.getSeries(1).strikePricePerWrappedUSDG, 175e6);
        assertEq(vault.nextPositionId(), 1);
    }

    function testMatchingIncludesCutoffAndExerciseWindow() public {
        T.Series[] memory requested = new T.Series[](3);
        requested[0] = T.Series(T.Side.Call, 245e6, 2000, 2000, 3800);
        requested[1] = T.Series(T.Side.Call, 245e6, 2100, 2100, 3900);
        requested[2] = T.Series(T.Side.Call, 245e6, 1900, 2000, 3800);
        uint256[] memory ids = creator.run(address(vault), administrator, 1e18, requested);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
        assertEq(ids[2], 3);
        assertEq(vault.getSeries(ids[0]).tradeCutoff, vault.getSeries(ids[0]).exerciseStart);
    }

    function testRejectsWrongNetworkAdministratorOrConversionRate() public {
        T.Series[] memory requested = new T.Series[](1);
        requested[0] = T.Series(T.Side.Put, 220e6, 2000, 2000, 3800);
        vm.chainId(196);
        vm.expectRevert("X Layer testnet only");
        creator.run(address(vault), administrator, 1e18, requested);
        vm.chainId(1952);
        vm.expectRevert("Wrong administrator");
        creator.run(address(vault), address(this), 1e18, requested);
        vm.expectRevert("Wrapper rate changed; refresh plan");
        creator.run(address(vault), administrator, 2e18, requested);
        assertEq(vault.nextSeriesId(), 1);
    }
}
