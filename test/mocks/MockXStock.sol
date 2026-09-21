// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IXStock} from "../../src/interfaces/IXStock.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Test model only; models share conversion/allowance, not all issuer controls.
contract MockXStock is IXStock {
    string public constant name = "Mock NVDAx";
    string public constant symbol = "mNVDAx";
    uint8 public constant decimals = 18;
    uint256 public multiplier = 1e18;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public paused;
    bool public returnFalse;
    bool public shortTransfer;
    address public hookTarget;
    bytes public hookData;
    bytes public hookResult;
    bool public hookSucceeded;

    function setMultiplier(uint256 value) external {
        require(value > 0);
        multiplier = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setReturnFalse(bool value) external {
        returnFalse = value;
    }

    function setShortTransfer(bool value) external {
        shortTransfer = value;
    }

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function mint(address to, uint256 amount) external {
        uint256 shares = getSharesByUnderlyingAmount(amount);
        sharesOf[to] += shares;
        totalShares += shares;
    }

    function totalSupply() external view returns (uint256) {
        return getUnderlyingAmountByShares(totalShares);
    }

    function balanceOf(address account) external view returns (uint256) {
        return getUnderlyingAmountByShares(sharesOf[account]);
    }

    function getCurrentMultiplier() external view returns (uint256, uint256, uint256) {
        return (multiplier, 0, 0);
    }

    function getSharesByUnderlyingAmount(uint256 amount) public view returns (uint256) {
        return Math.mulDiv(amount, 1e18, multiplier);
    }

    function getUnderlyingAmountByShares(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, multiplier, 1e18);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, getSharesByUnderlyingAmount(amount));
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spend(from, amount);
        return _move(from, to, getSharesByUnderlyingAmount(amount));
    }

    function transferShares(address to, uint256 shares) external returns (bool) {
        return _move(msg.sender, to, shares);
    }

    function transferSharesFrom(address from, address to, uint256 shares) external returns (bool) {
        _spend(from, getUnderlyingAmountByShares(shares));
        return _move(from, to, shares);
    }

    function _spend(address from, uint256 amount) private {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) {
            require(permitted >= amount, "mock: allowance");
            allowance[from][msg.sender] = permitted - amount;
        }
    }

    function _move(address from, address to, uint256 shares) private returns (bool) {
        require(!paused, "mock: paused");
        if (returnFalse) return false;
        if (hookTarget != address(0)) (hookSucceeded, hookResult) = hookTarget.call(hookData);
        require(to != address(0) && sharesOf[from] >= shares, "mock: balance/address");
        if (shortTransfer && shares > 0) --shares;
        sharesOf[from] -= shares;
        sharesOf[to] += shares;
        emit Transfer(from, to, getUnderlyingAmountByShares(shares));
        return true;
    }
}
