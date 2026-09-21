// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {PayoffTypes as T} from "../types/PayoffTypes.sol";

library QuoteLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "Quote(bytes32 requestId,address vault,address dealer,address taker,uint256 seriesId,uint256 wrappedQuantity,uint256 strikeAmountUSDG,uint256 grossPremiumUSDG,uint256 protocolFeeUSDG,uint256 netPremiumUSDG,uint64 issuedAt,uint64 deadline,uint256 nonce)"
    );

    function structHash(T.Quote memory quote) internal pure returns (bytes32) {
        // All members are static: this tuple encoding matches the EIP-712 field encoding.
        return keccak256(abi.encode(TYPEHASH, quote));
    }

    function isValid(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }
        // Standard ERC-1271 static call. EOA cryptography uses OpenZeppelin ECDSA.
        try IERC1271(signer).isValidSignature(digest, signature) returns (bytes4 magic) {
            return magic == IERC1271.isValidSignature.selector;
        } catch {
            return false;
        }
    }
}
