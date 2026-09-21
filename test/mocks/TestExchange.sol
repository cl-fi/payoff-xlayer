// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {PayoffTypes as T} from "../../src/types/PayoffTypes.sol";

import {SeriesVault} from "../../src/SeriesVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev UNSAFE TEST FIXTURE: accepts unsigned dealer input. Never deploy outside local tests.
/// Used only to test atomic premium + collateral before implementing the real RFQExchange.
contract TestExchange {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdg;
    address private immutable _creator = msg.sender;
    SeriesVault public vault;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function setVault(SeriesVault vault_) external {
        require(msg.sender == _creator && address(vault) == address(0));
        vault = vault_;
    }

    function fillPut(
        uint256 seriesId,
        address dealer,
        uint256 quantity,
        uint256 premium,
        uint256 maxCollateral
    ) external returns (uint256 positionId) {
        positionId = vault.openPosition(
            T.OpenParams(
                seriesId,
                msg.sender,
                dealer,
                quantity,
                (quantity * vault.getSeries(seriesId).strikePricePerWrappedUSDG + 1e18 - 1) / 1e18,
                maxCollateral,
                0,
                bytes32(0)
            )
        );
        usdg.safeTransferFrom(dealer, msg.sender, premium);
    }
}
