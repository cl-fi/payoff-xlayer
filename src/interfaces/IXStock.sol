// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice Interface checked against X Layer NVDAx; amounts and shares are distinct units.
/// @dev Used by asset integration tests; Payoff custody and settlement use wrapped ERC-20 units.
interface IXStock is IERC20Metadata {
    function sharesOf(address account) external view returns (uint256);
    function getCurrentMultiplier() external view returns (uint256, uint256, uint256);
    function getSharesByUnderlyingAmount(uint256 amount) external view returns (uint256);
    function getUnderlyingAmountByShares(uint256 shares) external view returns (uint256);
    function transferShares(address to, uint256 shares) external returns (bool);
    /// @dev Consumes allowance in visible token units, NOT shares.
    function transferSharesFrom(address from, address to, uint256 shares) external returns (bool);
}
