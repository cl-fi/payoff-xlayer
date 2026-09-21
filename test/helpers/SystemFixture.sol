// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Test} from "forge-std/Test.sol";
import {SeriesVault} from "../../src/SeriesVault.sol";
import {RFQExchange} from "../../src/RFQExchange.sol";
import {PayoffTypes as T} from "../../src/types/PayoffTypes.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockXStock} from "../mocks/MockXStock.sol";
import {MockWrappedXStock} from "../mocks/MockWrappedXStock.sol";

abstract contract SystemFixture is Test {
    uint256 internal constant DEALER_KEY = 0xA11CE;
    MockUSDG internal usd;
    MockXStock internal stockA;
    MockXStock internal stockB;
    MockWrappedXStock internal wrappedA;
    MockWrappedXStock internal wrappedB;
    SeriesVault internal vaultA;
    SeriesVault internal vaultB;
    RFQExchange internal exchange;
    address internal user = makeAddr("user");
    address internal user2 = makeAddr("user2");
    address internal dealer = vm.addr(DEALER_KEY);
    address internal feeRecipient = makeAddr("protocol-fees");
    uint256 internal constant PUT = 1;
    uint256 internal constant CALL = 2;

    function setUp() public virtual {
        vm.warp(1000);
        usd = new MockUSDG();
        stockA = new MockXStock();
        stockB = new MockXStock();
        vm.label(address(stockA), "Mock stock A");
        vm.label(address(stockB), "Mock stock B");
        exchange = new RFQExchange(address(usd), address(this), feeRecipient, 100);
        vaultA = _newVault(stockA);
        vaultB = _newVault(stockB);
        wrappedA = MockWrappedXStock(address(vaultA.wrappedStock()));
        wrappedB = MockWrappedXStock(address(vaultB.wrappedStock()));
        exchange.setDealerAllowed(dealer, true);
        usd.mint(user, 10_000e6);
        usd.mint(user2, 10_000e6);
        usd.mint(dealer, 10_000e6);
        stockA.mint(user, 100e18);
        stockA.mint(user2, 100e18);
        stockA.mint(dealer, 100e18);
        stockB.mint(user, 100e18);
        stockB.mint(user2, 100e18);
        stockB.mint(dealer, 100e18);
        _approve(user);
        _approve(user2);
        _approve(dealer);
    }

    function _newVault(MockXStock stock) internal returns (SeriesVault vault) {
        MockWrappedXStock wrapped = new MockWrappedXStock(stock);
        vault = new SeriesVault(address(usd), address(wrapped), address(this), address(exchange));
        exchange.setVaultAllowed(address(vault), true);
        vault.createSeries(T.Side.Put, 180e6, 2000, 3000, 3300);
        vault.createSeries(T.Side.Call, 200e6, 2000, 3000, 3300);
    }

    function _approve(address actor) internal {
        vm.startPrank(actor);
        usd.approve(address(exchange), type(uint256).max);
        usd.approve(address(vaultA), type(uint256).max);
        usd.approve(address(vaultB), type(uint256).max);
        stockA.approve(address(wrappedA), type(uint256).max);
        stockB.approve(address(wrappedB), type(uint256).max);
        wrappedA.deposit(stockA.balanceOf(actor), actor);
        wrappedB.deposit(stockB.balanceOf(actor), actor);
        wrappedA.approve(address(vaultA), type(uint256).max);
        wrappedB.approve(address(vaultB), type(uint256).max);
        vm.stopPrank();
    }

    function _quote(SeriesVault vault, uint256 seriesId, uint256 nonce)
        internal
        view
        returns (T.Quote memory q)
    {
        T.Series memory terms = vault.getSeries(seriesId);
        q = T.Quote(
            bytes32(nonce + 1),
            address(vault),
            dealer,
            user,
            seriesId,
            1e18,
            terms.strikePricePerWrappedUSDG,
            2e6,
            20_000,
            1_980_000,
            uint64(block.timestamp),
            uint64(block.timestamp + 20),
            nonce
        );
    }

    function _signature(T.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEALER_KEY, exchange.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _limits() internal pure returns (T.FillLimits memory) {
        return T.FillLimits(0, type(uint256).max, type(uint256).max);
    }

    function _fill(T.Quote memory q) internal returns (uint256) {
        bytes memory signature = _signature(q);
        vm.prank(q.taker);
        return exchange.fill(q, signature, _limits());
    }

    function _rejected(T.Quote memory q, bytes4 error) internal {
        bytes memory signature = _signature(q);
        vm.expectRevert(error);
        vm.prank(q.taker);
        exchange.fill(q, signature, _limits());
    }
}
