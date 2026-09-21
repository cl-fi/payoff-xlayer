// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {PayoffTypes as T} from "../types/PayoffTypes.sol";

interface ISeriesVault {
    function usdg() external view returns (address);
    function stock() external view returns (address);
    function wrappedStock() external view returns (address);
    function administrator() external view returns (address);
    function exchange() external view returns (address);
    function RULES_VERSION() external view returns (uint256);
    function getSeries(uint256 seriesId) external view returns (T.Series memory);
    function openPosition(T.OpenParams calldata params) external returns (uint256 positionId);
}
