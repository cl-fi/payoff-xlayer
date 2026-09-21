// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {PayoffTypes as T} from "../../src/types/PayoffTypes.sol";

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {SeriesVault} from "../../src/SeriesVault.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockWrappedXStock} from "../mocks/MockWrappedXStock.sol";
import {MockXStock} from "../mocks/MockXStock.sol";
import {TestExchange} from "../mocks/TestExchange.sol";

contract PutHandler is Test {
    SeriesVault public immutable vault;
    MockUSDG private immutable usd;
    MockXStock private immutable nv;
    TestExchange private immutable exchange;
    address public immutable user;
    address public immutable dealer;
    uint256[] private positions;

    constructor(
        SeriesVault vault_,
        MockUSDG usd_,
        MockXStock nv_,
        TestExchange exchange_,
        address user_,
        address dealer_
    ) {
        vault = vault_;
        usd = usd_;
        nv = nv_;
        exchange = exchange_;
        user = user_;
        dealer = dealer_;
    }

    function open(uint96 seed) external {
        uint256 quantity = bound(uint256(seed), 1e12, 1e18);
        // The invariant test retains admin authority; this handler asks it to create a fresh series.
        uint256 seriesId = PutAccountingInvariant(vault.administrator()).newSeries();
        vm.prank(user);
        positions.push(exchange.fillPut(seriesId, dealer, quantity, 1e6, type(uint256).max));
    }

    function exercise(uint256 seed) external {
        if (positions.length == 0) return;
        uint256 id = positions[seed % positions.length];
        if (vault.stateOf(id) != T.State.Open) return;
        uint64 start = vault.getSeries(vault.position(id).seriesId).exerciseStart;
        if (block.timestamp < start) return;
        vm.prank(dealer);
        vault.exercise(id);
    }

    function claim(uint256 seed) external {
        if (positions.length == 0) return;
        uint256 id = positions[seed % positions.length];
        T.State state = vault.stateOf(id);
        if (state != T.State.Exercised && state != T.State.Expired) return;
        vm.prank(user);
        vault.claim(id);
    }

    function advanceTime(uint16 secondsForward) external {
        vm.warp(block.timestamp + bound(uint256(secondsForward), 1, 200));
    }

    function rebase(uint96 seed) external {
        nv.setMultiplier(bound(uint256(seed), 0.01e18, 100e18));
    }
}

contract PutAccountingInvariant is StdInvariant, Test {
    SeriesVault internal vault;
    MockUSDG internal usd;
    MockXStock internal nv;
    TestExchange internal exchange;
    MockWrappedXStock internal wrapped;
    PutHandler internal handler;
    address internal user = makeAddr("invariant-user");
    address internal dealer = makeAddr("invariant-dealer");

    function setUp() public {
        vm.warp(1000);
        usd = new MockUSDG();
        nv = new MockXStock();
        wrapped = new MockWrappedXStock(nv);
        exchange = new TestExchange(usd);
        vault = new SeriesVault(address(usd), address(wrapped), address(this), address(exchange));
        exchange.setVault(vault);
        usd.mint(user, 1e18);
        usd.mint(dealer, 1e18);
        nv.mint(dealer, 1e30);
        vm.prank(user);
        usd.approve(address(vault), type(uint256).max);
        vm.startPrank(dealer);
        usd.approve(address(exchange), type(uint256).max);
        nv.approve(address(wrapped), type(uint256).max);
        wrapped.deposit(1e30, dealer);
        wrapped.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        handler = new PutHandler(vault, usd, nv, exchange, user, dealer);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.open.selector;
        selectors[1] = handler.exercise.selector;
        selectors[2] = handler.claim.selector;
        selectors[3] = handler.advanceTime.selector;
        selectors[4] = handler.rebase.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function newSeries() external returns (uint256) {
        require(msg.sender == address(handler));
        return vault.createSeries(
            T.Side.Put,
            180e6,
            uint64(block.timestamp + 30),
            uint64(block.timestamp + 30),
            uint64(block.timestamp + 330)
        );
    }

    function invariantAllLiabilitiesAreBackedAndPositionOwned() public view {
        uint256 usdgLiability;
        uint256 sharesLiability;
        for (uint256 id = 1; id < vault.nextPositionId(); ++id) {
            T.Position memory p = vault.position(id);
            if (p.state == T.State.Open) usdgLiability += p.strikeAmountUSDG;
            if (p.state == T.State.Exercised) sharesLiability += p.wrappedBalance;
        }
        assertEq(vault.accountedUSDG(), usdgLiability);
        assertEq(vault.accountedWrapped(), sharesLiability);
        assertEq(usd.balanceOf(address(vault)), usdgLiability);
        assertEq(wrapped.balanceOf(address(vault)), sharesLiability);
        assertEq(usd.balanceOf(user) + usd.balanceOf(dealer) + usdgLiability, 2e18);
        assertEq(wrapped.balanceOf(user) + wrapped.balanceOf(dealer) + sharesLiability, 1e30);
    }

    function invariantReceiptsMatchUnconsumedRights() public view {
        for (uint256 id = 1; id < vault.nextPositionId(); ++id) {
            T.Position memory p = vault.position(id);
            // An expired unclaimed position retains its receipt until claim burns both; time gates exercise.
            uint256 longExpected = p.state == T.State.Open ? 1 : 0;
            uint256 shortExpected = p.state == T.State.Claimed ? 0 : 1;
            assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), longExpected);
            assertEq(vault.balanceOf(user, vault.shortTokenId(id)), shortExpected);
        }
    }
}
