// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Payoff's freely mintable test asset. No backing or redeemable monetary value.
contract TestnetUSDG is ERC20 {
    address public immutable minter;

    error Unauthorized();
    error InvalidMinter();

    constructor(address minter_) ERC20("Payoff Test USDG", "tUSDG") {
        if (minter_ == address(0)) revert InvalidMinter();
        minter = minter_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone may request any representable amount for their own test wallet.
    /// @dev No daily quota, cooldown, backend authorization or inventory dependency.
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /// @notice The project minter can also seed test wallets and the test dealer.
    function mint(address receiver, uint256 amount) external {
        if (msg.sender != minter) revert Unauthorized();
        _mint(receiver, amount);
    }
}
