// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/// @dev Test-only contract wallet: owner explicitly authorizes a digest.
contract MockDealerWallet is IERC1271, ERC1155Holder {
    address public immutable owner = msg.sender;
    mapping(bytes32 => bool) public approved;

    function approveDigest(bytes32 digest, bool allowed) external {
        require(msg.sender == owner);
        approved[digest] = allowed;
    }

    function isValidSignature(bytes32 digest, bytes memory) external view returns (bytes4) {
        return approved[digest] ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == owner);
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
}
