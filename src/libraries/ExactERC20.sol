// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library ExactERC20 {
    using SafeERC20 for IERC20;
    error UnexpectedTokenDelta();

    function pull(IERC20 token, address from, address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 senderBefore = token.balanceOf(from);
        uint256 receiverBefore = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        _check(token, from, to, amount, senderBefore, receiverBefore);
    }

    function push(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 receiverBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        _check(token, address(this), to, amount, senderBefore, receiverBefore);
    }

    function _check(
        IERC20 token,
        address from,
        address to,
        uint256 amount,
        uint256 senderBefore,
        uint256 receiverBefore
    ) private view {
        uint256 senderAfter = token.balanceOf(from);
        uint256 receiverAfter = token.balanceOf(to);
        if (from == to) {
            if (senderAfter != senderBefore) revert UnexpectedTokenDelta();
        } else if (
            senderAfter > senderBefore || senderBefore - senderAfter != amount
                || receiverAfter < receiverBefore || receiverAfter - receiverBefore != amount
        ) {
            revert UnexpectedTokenDelta();
        }
    }
}
