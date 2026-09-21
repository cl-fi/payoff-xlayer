// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice Test-only stock substitute. Not issued by xStocks and not backed by securities.
contract TestnetStock is ERC20 {
    address public immutable minter;

    error Unauthorized();
    error InvalidMinter();

    constructor(address minter_) ERC20("Payoff Test NVDAx", "tNVDAx") {
        if (minter_ == address(0)) revert InvalidMinter();
        minter = minter_;
    }

    function mint(address receiver, uint256 amount) external {
        if (msg.sender != minter) revert Unauthorized();
        _mint(receiver, amount);
    }
}

/// @notice Backed ERC-4626 test wrapper. Does not emulate issuer rebases or corporate actions.
contract TestnetWrappedStock is ERC4626 {
    constructor(IERC20 stock) ERC20("Payoff Test Wrapped NVDAx", "twNVDAx") ERC4626(stock) {}
}
