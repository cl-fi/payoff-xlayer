// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDG is ERC20 {
    address public blockedRecipient;
    bool public chargeTransferFee;

    constructor() ERC20("Mock USDG", "mUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlockedRecipient(address account) external {
        blockedRecipient = account;
    }

    function setTransferFee(bool enabled) external {
        chargeTransferFee = enabled;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(to == address(0) || to != blockedRecipient, "mock: blocked recipient");
        if (chargeTransferFee && from != address(0) && to != address(0) && amount > 0) {
            super._update(from, address(0), 1);
            --amount;
        }
        super._update(from, to, amount);
    }
}
