// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @dev Inherited into the Vault, not deployed separately. Position is the canonical rights record.
abstract contract PositionReceipts is ERC1155 {
    error NonTransferable();
    constructor() ERC1155("") {}

    function longTokenId(uint256 id) public pure returns (uint256) {
        return id * 2;
    }

    function shortTokenId(uint256 id) public pure returns (uint256) {
        return id * 2 + 1;
    }

    function _mintReceipts(uint256 id, address shortHolder, address longHolder) internal {
        _mint(longHolder, longTokenId(id), 1, "");
        _mint(shortHolder, shortTokenId(id), 1, "");
    }

    function _consumeLong(uint256 id, address holder) internal {
        _burn(holder, longTokenId(id), 1);
    }

    function _consumeShort(uint256 id, address holder) internal {
        _burn(holder, shortTokenId(id), 1);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
    {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, ids, values);
    }
}
