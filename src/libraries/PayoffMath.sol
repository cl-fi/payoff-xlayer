// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library PayoffMath {
    /// @notice W is wrapped ERC-20 units (18 decimals); Kw is USDG units per whole wrapped token.
    /// @dev Round U up once when opening; never recompute an existing position's U.
    function strikeAmount(uint256 wrappedQuantity, uint256 strikePricePerWrappedUSDG)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(wrappedQuantity, strikePricePerWrappedUSDG, 1e18, Math.Rounding.Ceil);
    }
}
