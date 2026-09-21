// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IXStock} from "../../src/interfaces/IXStock.sol";

/// @dev TEST ONLY. Models a 1:1 wrapper of native xStock shares, with adversarial ERC-20 controls.
/// Not a production wrapper or a substitute for verifying a deployed issuer wrapper.
contract MockWrappedXStock is ERC4626 {
    bool public paused;
    bool public returnFalse;
    bool public shortTransfer;
    bool public conversionUnavailable;
    address public hookTarget;
    bytes public hookData;
    bytes public hookResult;
    bool public hookSucceeded;

    constructor(IXStock stock) ERC20("Mock Wrapped xStock", "mwSTOCK") ERC4626(IERC20(address(stock))) {}

    function setPaused(bool value) external {
        paused = value;
    }

    function setReturnFalse(bool value) external {
        returnFalse = value;
    }

    function setShortTransfer(bool value) external {
        shortTransfer = value;
    }

    function setConversionUnavailable(bool value) external {
        conversionUnavailable = value;
    }

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function totalAssets() public view override returns (uint256) {
        return _convertToAssets(totalSupply(), Math.Rounding.Floor);
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        require(!conversionUnavailable, "mock: conversion unavailable");
        (uint256 multiplier,,) = IXStock(asset()).getCurrentMultiplier();
        return Math.mulDiv(assets, 1e18, multiplier, rounding);
    }

    function _convertToAssets(uint256 shares, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        require(!conversionUnavailable, "mock: conversion unavailable");
        (uint256 multiplier,,) = IXStock(asset()).getCurrentMultiplier();
        return Math.mulDiv(shares, multiplier, 1e18, rounding);
    }

    function _deposit(address caller, address receiver, uint256, uint256 shares) internal override {
        IXStock token = IXStock(asset());
        uint256 beforeBalance = token.sharesOf(address(this));
        require(token.transferSharesFrom(caller, address(this), shares), "mock: underlying transfer");
        require(token.sharesOf(address(this)) - beforeBalance == shares, "mock: underlying delta");
        _mint(receiver, shares);
        emit Deposit(caller, receiver, convertToAssets(shares), shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256, uint256 shares)
        internal
        override
    {
        if (caller != owner) _spendAllowance(owner, caller, shares);
        _burn(owner, shares);
        require(IXStock(asset()).transferShares(receiver, shares), "mock: underlying transfer");
        emit Withdraw(caller, receiver, owner, convertToAssets(shares), shares);
    }

    function transfer(address to, uint256 value) public override(ERC20, IERC20) returns (bool) {
        if (returnFalse) return false;
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override(ERC20, IERC20)
        returns (bool)
    {
        if (returnFalse) return false;
        return super.transferFrom(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "mock: paused");
        if (from != address(0) && to != address(0)) {
            if (hookTarget != address(0)) (hookSucceeded, hookResult) = hookTarget.call(hookData);
            if (shortTransfer && value > 0) {
                super._update(from, address(0), 1);
                --value;
            }
        }
        super._update(from, to, value);
    }
}
