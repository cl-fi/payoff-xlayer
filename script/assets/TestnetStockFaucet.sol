// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Public dispenser for the existing, non-upgradeable Payoff test stock.
/// @dev The stock minter seeds/refills this contract. No per-wallet quota or cooldown.
///      Test tokens have no monetary value; this contract is not a production faucet.
contract TestnetStockFaucet {
    using SafeERC20 for IERC20;

    IERC20 public immutable stock;

    error InvalidStock();
    error InvalidAmount();

    event Claimed(address indexed receiver, uint256 amount);

    constructor(IERC20 stock_) {
        if (address(stock_) == address(0)) revert InvalidStock();
        stock = stock_;
    }

    function faucet(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        stock.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}
