// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {PayoffTypes as T} from "../../src/types/PayoffTypes.sol";

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IXStock} from "../../src/interfaces/IXStock.sol";
import {SeriesVault} from "../../src/SeriesVault.sol";
import {RFQExchange} from "../../src/RFQExchange.sol";

interface IXStockIssuerControls {
    function pauser() external view returns (address);
    function setPause(bool paused) external;
    function multiplierUpdater() external view returns (address);
    function updateMultiplierValue(uint256 next, uint256 previous, uint256 activationTime) external;
}

/// @notice Real token bytecode/state; ALL transfers and deployments execute only on the LOCAL fork.
/// No vm.deal of token balances, storage patching, or mocked calls to the real assets.
contract XLayerAssetsTest is Test {
    IXStock internal nv;
    IERC20 internal usd;
    IERC4626 internal wrapped;
    SeriesVault internal vault;
    RFQExchange internal exchange;
    address internal user = makeAddr("fork-user");
    uint256 internal constant DEALER_KEY = 0xA11CE;
    address internal dealer = vm.addr(DEALER_KEY);
    address internal feeRecipient = makeAddr("fork-fees");
    uint256 internal seriesId;
    uint256 internal callSeriesId;
    uint64 internal start;
    uint64 internal end;

    function setUp() public {
        string memory config = vm.readFile("config/xlayer.json");
        nv = IXStock(vm.parseJsonAddress(config, ".tokens.NVDAx.address"));
        usd = IERC20(vm.parseJsonAddress(config, ".tokens.USDG.address"));
        wrapped = IERC4626(vm.parseJsonAddress(config, ".tokens.wNVDAx.address"));
        string memory fixture = vm.readFile("test/fixtures/fork-fixtures.json");
        uint256 blockNumber = vm.parseUint(vm.parseJsonString(fixture, ".blockNumber"));
        vm.createSelectFork(vm.envOr("XLAYER_RPC_URL", vm.parseJsonString(config, ".rpc")), blockNumber);
        assertEq(block.chainid, vm.parseJsonUint(config, ".chainId"), "wrong network");
        address usdHolder = vm.parseJsonAddress(fixture, ".holders.USDG.address");
        address nvHolder = vm.parseJsonAddress(fixture, ".holders.NVDAx.address");
        vm.startPrank(usdHolder);
        assertTrue(usd.transfer(user, 1000e6));
        assertTrue(usd.transfer(dealer, 1000e6));
        vm.stopPrank();
        vm.startPrank(nvHolder);
        assertTrue(nv.transfer(dealer, 10e18));
        assertTrue(nv.transfer(user, 10e18));
        vm.stopPrank();
        assertEq(wrapped.asset(), address(nv));
        vm.startPrank(user);
        nv.approve(address(wrapped), type(uint256).max);
        wrapped.deposit(5e18, user);
        vm.stopPrank();
        vm.startPrank(dealer);
        nv.approve(address(wrapped), type(uint256).max);
        wrapped.deposit(5e18, dealer);
        vm.stopPrank();
        exchange = new RFQExchange(address(usd), address(this), feeRecipient, 100);
        vault = new SeriesVault(address(usd), address(wrapped), address(this), address(exchange));
        exchange.setVaultAllowed(address(vault), true);
        exchange.setDealerAllowed(dealer, true);
        start = uint64(block.timestamp + 100);
        end = start + 300;
        seriesId = vault.createSeries(T.Side.Put, 180e6, start, start, end);
        callSeriesId = vault.createSeries(T.Side.Call, 200e6, start, start, end);
        vm.startPrank(user);
        usd.approve(address(vault), type(uint256).max);
        wrapped.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(dealer);
        usd.approve(address(exchange), type(uint256).max);
        usd.approve(address(vault), type(uint256).max);
        wrapped.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _open() internal returns (uint256) {
        return _openSide(seriesId);
    }

    function _openSide(uint256 series) internal returns (uint256) {
        T.Series memory terms = vault.getSeries(series);
        T.Quote memory q = T.Quote(
            bytes32(series),
            address(vault),
            dealer,
            user,
            series,
            1e18,
            terms.strikePricePerWrappedUSDG,
            1.5e6,
            0.015e6,
            1.485e6,
            uint64(block.timestamp),
            uint64(block.timestamp + 20),
            series
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEALER_KEY, exchange.quoteDigest(q));
        vm.prank(user);
        return exchange.fill(q, abi.encodePacked(r, s, v), T.FillLimits(1.485e6, 200e6, type(uint256).max));
    }

    function testMetadataAndShareConversions() public view {
        assertEq(IERC20Metadata(address(usd)).decimals(), 6);
        assertEq(nv.decimals(), 18);
        assertEq(wrapped.decimals(), 18);
        assertEq(wrapped.asset(), address(nv));
        (uint256 multiplier,,) = nv.getCurrentMultiplier();
        assertGt(multiplier, 0);
        assertEq(nv.balanceOf(dealer), nv.getUnderlyingAmountByShares(nv.sharesOf(dealer)));
        assertEq(nv.getSharesByUnderlyingAmount(1e18), 1e36 / multiplier);
    }

    function testStandardTransferFromUsesVisibleAllowanceAndFloorsShares() public {
        address spender = makeAddr("spender");
        uint256 expectedShares = nv.getSharesByUnderlyingAmount(1e18);
        uint256 beforeShares = nv.sharesOf(user);
        vm.prank(dealer);
        nv.approve(spender, 1e18);
        vm.prank(spender);
        assertTrue(nv.transferFrom(dealer, user, 1e18));
        assertEq(nv.sharesOf(user) - beforeShares, expectedShares);
        assertEq(nv.allowance(dealer, spender), 0);
        uint256 received = nv.getUnderlyingAmountByShares(expectedShares);
        assertLe(received, 1e18);
        assertLe(1e18 - received, 2);
    }

    function testTransferSharesFromConsumesVisibleAllowance() public {
        uint256 shares = nv.getSharesByUnderlyingAmount(1e18);
        uint256 visibleAmount = nv.getUnderlyingAmountByShares(shares);
        address spender = makeAddr("share-spender");
        uint256 beforeShares = nv.sharesOf(user);
        vm.prank(dealer);
        nv.approve(spender, visibleAmount);
        vm.prank(spender);
        assertTrue(nv.transferSharesFrom(dealer, user, shares));
        assertEq(nv.allowance(dealer, spender), 0);
        assertEq(nv.sharesOf(user) - beforeShares, shares);
        assertLe(visibleAmount, 1e18);
    }

    function testRealAssetPutExerciseAndExactWrappedClaim() public {
        uint256 id = _open();
        assertEq(usd.balanceOf(user), 821.485e6);
        assertEq(usd.balanceOf(feeRecipient), 0.015e6);
        vm.warp(start);
        vm.prank(dealer);
        vault.exercise(id);
        assertEq(usd.balanceOf(dealer), 1178.5e6);
        uint256 shares = vault.position(id).wrappedBalance;
        uint256 beforeShares = wrapped.balanceOf(user);
        vm.warp(end + 1 days);
        vm.prank(user);
        vault.claim(id);
        assertEq(wrapped.balanceOf(user) - beforeShares, shares);
        assertGe(wrapped.convertToAssets(shares), 1e18);
        assertEq(usd.balanceOf(address(vault)), 0);
        assertEq(wrapped.balanceOf(address(vault)), 0);
    }

    function testRealAssetExpiryReturnsCollateralWithoutKeeper() public {
        uint256 id = _open();
        vm.warp(end);
        vm.prank(user);
        vault.claim(id);
        assertEq(usd.balanceOf(user), 1001.485e6);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    function testRealAssetInsufficientAllowanceRollsBackAndCanRetry() public {
        uint256 id = _open();
        vm.prank(dealer);
        wrapped.approve(address(vault), 0);
        vm.warp(start);
        vm.expectRevert();
        vm.prank(dealer);
        vault.exercise(id);
        assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), 1);
        assertEq(vault.accountedUSDG(), 180e6);
        assertEq(wrapped.balanceOf(address(vault)), 0);
        uint256 visibleAmount = 1e18;
        vm.prank(dealer);
        wrapped.approve(address(vault), visibleAmount);
        vm.prank(dealer);
        vault.exercise(id);
        assertEq(wrapped.allowance(dealer, address(vault)), 0);
    }

    function testIssuerPauseCausesAtomicRevertOnLocalFork() public {
        uint256 id = _open();
        IXStockIssuerControls controls = IXStockIssuerControls(address(wrapped));
        address pauser = controls.pauser();
        vm.prank(pauser);
        controls.setPause(true);
        vm.warp(start);
        vm.expectRevert();
        vm.prank(dealer);
        vault.exercise(id);
        assertEq(vault.accountedUSDG(), 180e6);
        assertEq(vault.accountedWrapped(), 0);
        assertEq(vault.balanceOf(dealer, vault.longTokenId(id)), 1);
    }

    function _increaseMultiplier() internal {
        (uint256 previous,,) = nv.getCurrentMultiplier();
        uint256 next = previous * 102 / 100;
        IXStockIssuerControls controls = IXStockIssuerControls(address(nv));
        address updater = controls.multiplierUpdater();
        vm.prank(updater);
        controls.updateMultiplierValue(next, previous, 0);
        (uint256 actual,,) = nv.getCurrentMultiplier();
        assertEq(actual, next);
    }

    function testRealCallExerciseDeliversFixedWrapperIncludingDividendThenRedeems() public {
        uint256 id = _openSide(callSeriesId);
        _increaseMultiplier();
        vm.warp(start);
        uint256 dealerBefore = wrapped.balanceOf(dealer);
        vm.prank(dealer);
        vault.exercise(id);
        assertEq(wrapped.balanceOf(dealer) - dealerBefore, 1e18);
        assertEq(vault.position(id).wrappedBalance, 0);
        assertEq(vault.accountedWrapped(), 0);
        assertEq(vault.accountedUSDG(), 200e6);
        uint256 nativeBefore = nv.sharesOf(dealer);
        vm.prank(dealer);
        uint256 assets = wrapped.redeem(1e18, dealer, dealer);
        assertEq(nv.sharesOf(dealer) - nativeBefore, 1e18);
        assertEq(assets, nv.getUnderlyingAmountByShares(1e18));
        uint256 userBefore = wrapped.balanceOf(user);
        vm.prank(user);
        vault.claim(id);
        assertEq(wrapped.balanceOf(user), userBefore);
        assertEq(usd.balanceOf(user), 1201.485e6);
        assertEq(wrapped.balanceOf(address(vault)), 0);
    }

    function testRealForwardAndReverseSplitsPreserveBothSidesFixedDelivery() public {
        uint256 callId = _openSide(callSeriesId);
        uint256 putId = _open();
        (uint256 original,,) = nv.getCurrentMultiplier();
        IXStockIssuerControls controls = IXStockIssuerControls(address(nv));
        address updater = controls.multiplierUpdater();
        vm.prank(updater);
        controls.updateMultiplierValue(original * 4, original, 0);
        assertEq(wrapped.convertToAssets(1e18), original * 4);
        // A later depositor gets the same fungible unit at the new conversion rate.
        uint256 beforeDeposit = wrapped.balanceOf(dealer);
        vm.prank(dealer);
        assertEq(wrapped.deposit(original * 4, dealer), 1e18);
        assertEq(wrapped.balanceOf(dealer) - beforeDeposit, 1e18);
        vm.warp(start);
        uint256 dealerBefore = wrapped.balanceOf(dealer);
        vm.prank(dealer);
        vault.exercise(callId);
        assertEq(wrapped.balanceOf(dealer) - dealerBefore, 1e18);
        vm.prank(updater);
        controls.updateMultiplierValue(original / 4, original * 4, 0);
        assertEq(wrapped.convertToAssets(1e18), original / 4);
        vm.prank(dealer);
        vault.exercise(putId);
        assertEq(vault.position(putId).wrappedBalance, 1e18);
        assertEq(vault.position(callId).strikeAmountUSDG, 200e6);
        assertEq(vault.position(putId).strikeAmountUSDG, 180e6);
        vm.prank(user);
        vault.claim(callId);
        vm.prank(user);
        vault.claim(putId);
        assertEq(vault.accountedWrapped(), 0);
        assertEq(vault.accountedUSDG(), 0);
    }

    function testRealWrapperConversionIgnoresUnsolicitedUnderlyingDonations() public {
        uint256 rate = wrapped.convertToAssets(1e18);
        uint256 assets = wrapped.totalAssets();
        vm.prank(dealer);
        assertTrue(nv.transfer(address(wrapped), 1e18));
        assertEq(wrapped.convertToAssets(1e18), rate);
        assertEq(wrapped.totalAssets(), assets);
    }

    function testRealCallExpiryReturnsAllWrappedUnitsAndDividends() public {
        uint256 userWrappedBefore = wrapped.balanceOf(user);
        uint256 id = _openSide(callSeriesId);
        _increaseMultiplier();
        vm.warp(end);

        vm.prank(user);
        vault.claim(id);
        assertEq(wrapped.balanceOf(user), userWrappedBefore);
        assertEq(usd.balanceOf(user), 1001.485e6);
    }

    function testRealPutDelayedClaimKeepsWrappedUnitsThroughIssuerRebase() public {
        uint256 id = _open();
        vm.warp(start);
        vm.prank(dealer);
        vault.exercise(id);
        uint256 shares = vault.position(id).wrappedBalance;
        uint256 userBefore = wrapped.balanceOf(user);
        uint256 previousVisible = wrapped.convertToAssets(shares);
        _increaseMultiplier();
        vm.prank(user);
        vault.claim(id);
        assertEq(wrapped.balanceOf(user) - userBefore, shares);
        assertGt(wrapped.convertToAssets(shares), previousVisible);
    }
}
