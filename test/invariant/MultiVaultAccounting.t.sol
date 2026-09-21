// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {SystemFixture} from "../helpers/SystemFixture.sol";
import {SeriesVault} from "../../src/SeriesVault.sol";
import {RFQExchange} from "../../src/RFQExchange.sol";
import {PayoffTypes as T} from "../../src/types/PayoffTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockXStock} from "../mocks/MockXStock.sol";

interface ISeriesAdmin {
    function freshSeries(SeriesVault vault, T.Side side) external returns (uint256);
}

contract MultiVaultHandler is Test {
    ISeriesAdmin private immutable admin;
    RFQExchange private immutable exchange;
    SeriesVault[2] private vaults;
    address[2] private users;
    uint256 private constant DEALER_KEY = 0xA11CE;
    address private immutable dealer = vm.addr(DEALER_KEY);
    uint256 public fills;
    uint256 public exercises;
    uint256 public claims;

    constructor(RFQExchange e, SeriesVault a, SeriesVault b, address u, address u2) {
        admin = ISeriesAdmin(msg.sender);
        exchange = e;
        vaults = [a, b];
        users = [u, u2];
    }

    function open(uint256 seed, uint96 quantitySeed) external {
        SeriesVault vault = vaults[seed % 2];
        T.Side side = (seed / 2) % 2 == 0 ? T.Side.Put : T.Side.Call;
        uint256 quantity = bound(uint256(quantitySeed), 0.1e18, 1e18);
        uint256 strike = side == T.Side.Put ? 180e6 : 200e6;
        uint256 notional = (quantity * strike + 1e18 - 1) / 1e18;
        uint256 series = admin.freshSeries(vault, side);
        uint256 shares = side == T.Side.Call ? quantity : 0;
        address taker = users[(seed / 4) % 2];
        T.Quote memory q = T.Quote(
            bytes32(fills + 1),
            address(vault),
            dealer,
            taker,
            series,
            quantity,
            notional,
            2e6,
            20000,
            1980000,
            uint64(block.timestamp),
            uint64(block.timestamp + 1),
            fills
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEALER_KEY, exchange.quoteDigest(q));
        vm.prank(taker);
        exchange.fill(q, abi.encodePacked(r, s, v), T.FillLimits(1980000, notional, shares));
        ++fills;
    }

    function exercise(uint256 seed) external {
        SeriesVault vault = vaults[seed % 2];
        if (vault.nextPositionId() == 1) return;
        uint256 id = 1 + (seed / 2) % (vault.nextPositionId() - 1);
        T.Position memory p = vault.position(id);
        if (vault.stateOf(id) != T.State.Open || block.timestamp < vault.getSeries(p.seriesId).exerciseStart) return;
        vm.prank(dealer);
        vault.exercise(id);
        ++exercises;
    }

    function claim(uint256 seed) external {
        SeriesVault vault = vaults[seed % 2];
        if (vault.nextPositionId() == 1) return;
        uint256 id = 1 + (seed / 2) % (vault.nextPositionId() - 1);
        T.State state = vault.stateOf(id);
        if (state != T.State.Exercised && state != T.State.Expired) return;
        address shortHolder = vault.position(id).shortHolder;
        vm.prank(shortHolder);
        vault.claim(id);
        ++claims;
    }

    function advanceTime(uint16 seed) external {
        vm.warp(block.timestamp + bound(uint256(seed), 1, 150));
    }

    function rebase(uint256 seed) external {
        MockXStock token = MockXStock(address(vaults[seed % 2].stock()));
        token.setMultiplier(bound(seed / 2, 0.01e18, 100e18));
    }
}

contract MultiVaultAccountingInvariant is StdInvariant, SystemFixture {
    MultiVaultHandler internal handler;
    mapping(address => mapping(T.Side => uint256)) internal latestSeries;

    function setUp() public override {
        SystemFixture.setUp();
        // Fund every possible opening in a 64-step sequence; no artificial exposure cap in the handler.
        usd.mint(user, 10_000e6);
        usd.mint(user2, 10_000e6);
        usd.mint(dealer, 10_000e6);
        handler = new MultiVaultHandler(exchange, vaultA, vaultB, user, user2);
        // Start with all four combinations, so every randomized sequence covers both assets/sides.
        for (uint256 i; i < 4; ++i) {
            handler.open(i, 0.25e18);
        }
        handler.advanceTime(30);
        handler.exercise(0);
        handler.exercise(3);
        handler.claim(0);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.open.selector;
        selectors[1] = handler.exercise.selector;
        selectors[2] = handler.claim.selector;
        selectors[3] = handler.advanceTime.selector;
        selectors[4] = handler.rebase.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function freshSeries(SeriesVault vault, T.Side side) external returns (uint256 id) {
        require(msg.sender == address(handler));
        id = latestSeries[address(vault)][side];
        if (id != 0 && block.timestamp < vault.getSeries(id).tradeCutoff) return id;
        id = vault.createSeries(
            side,
            side == T.Side.Put ? 180e6 : 200e6,
            uint64(block.timestamp + 30),
            uint64(block.timestamp + 30),
            uint64(block.timestamp + 330)
        );
        latestSeries[address(vault)][side] = id;
    }

    function invariantMixedLiabilitiesReceiptsAndNoncesAgree() public view {
        uint256 totalUSDG =
            usd.balanceOf(user) + usd.balanceOf(user2) + usd.balanceOf(dealer) + usd.balanceOf(feeRecipient);
        SeriesVault[2] memory vaults = [vaultA, vaultB];
        uint256 positions;
        for (uint256 v; v < 2; ++v) {
            SeriesVault vault = vaults[v];
            uint256 liabilityUSDG;
            uint256 liabilityShares;
            for (uint256 id = 1; id < vault.nextPositionId(); ++id) {
                T.Position memory p = vault.position(id);
                T.Series memory terms = vault.getSeries(p.seriesId);
                if (
                    (p.state == T.State.Open && terms.side == T.Side.Put)
                        || (p.state == T.State.Exercised && terms.side == T.Side.Call)
                ) liabilityUSDG += p.strikeAmountUSDG;
                liabilityShares += p.wrappedBalance;
                assertEq(
                    vault.balanceOf(p.longHolder, vault.longTokenId(id)), p.state == T.State.Open ? 1 : 0
                );
                assertEq(
                    vault.balanceOf(p.shortHolder, vault.shortTokenId(id)), p.state == T.State.Claimed ? 0 : 1
                );
                ++positions;
            }
            assertEq(vault.accountedUSDG(), liabilityUSDG);
            assertEq(vault.accountedWrapped(), liabilityShares);
            assertEq(usd.balanceOf(address(vault)), liabilityUSDG);
            IERC20 wrapped = vault.wrappedStock();
            assertEq(wrapped.balanceOf(address(vault)), liabilityShares);
            assertEq(MockXStock(vault.stock()).sharesOf(address(wrapped)), wrapped.totalSupply());
            assertEq(
                wrapped.balanceOf(user) + wrapped.balanceOf(user2) + wrapped.balanceOf(dealer)
                    + liabilityShares,
                300e18
            );

            totalUSDG += liabilityUSDG;
        }
        assertEq(totalUSDG, 60_000e6);

        assertEq(positions, handler.fills());
        for (uint256 nonce; nonce < positions; ++nonce) {
            assertTrue(exchange.nonceUnavailable(dealer, nonce));
        }
        assertEq(usd.balanceOf(address(exchange)), 0);
    }
}
