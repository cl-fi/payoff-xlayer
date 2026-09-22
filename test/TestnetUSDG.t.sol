// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TestnetUSDG} from "../script/assets/TestnetUSDG.sol";

contract TestnetUSDGTest is Test {
    TestnetUSDG internal token;
    address internal user = address(0x1234);

    function setUp() public {
        token = new TestnetUSDG(address(this));
    }

    function testAnyoneCanRepeatedlyClaimWithoutCooldown() public {
        assertEq(token.decimals(), 6);
        assertEq(token.symbol(), "tUSDG");
        vm.startPrank(user);
        token.faucet(10_000e6);
        token.faucet(50_000e6);
        token.approve(address(this), 15_000e6);
        vm.stopPrank();
        token.transferFrom(user, address(this), 15_000e6);
        assertEq(token.balanceOf(user), 45_000e6);
        assertEq(token.balanceOf(address(this)), 15_000e6);
        assertEq(token.totalSupply(), 60_000e6);
    }

    function testOnlyMinterCanMintToOtherWallets() public {
        vm.prank(user);
        vm.expectRevert(TestnetUSDG.Unauthorized.selector);
        token.mint(user, 1e6);
        token.mint(user, 1e6);
        assertEq(token.balanceOf(user), 1e6);
    }

    function testFuzzNoProductQuota(uint128 first, uint128 second) public {
        vm.startPrank(user);
        token.faucet(first);
        token.faucet(second);
        vm.stopPrank();
        assertEq(token.balanceOf(user), uint256(first) + uint256(second));
    }
}
