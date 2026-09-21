// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {SystemFixture} from "./helpers/SystemFixture.sol";
import {PayoffTypes as T} from "../src/types/PayoffTypes.sol";
import {QuoteLib} from "../src/libraries/QuoteLib.sol";

contract QuoteVectorTest is SystemFixture {
    function testViemAndSolidityAgreeOnEveryFieldDomainDigestAndSignature() public view {
        string memory json = vm.readFile("test/fixtures/quote-vector.json");
        T.Quote memory q;
        q.requestId = vm.parseJsonBytes32(json, ".quote.requestId");
        q.vault = vm.parseJsonAddress(json, ".quote.vault");
        q.dealer = vm.parseJsonAddress(json, ".quote.dealer");
        q.taker = vm.parseJsonAddress(json, ".quote.taker");
        q.seriesId = _uint(json, ".quote.seriesId");
        q.wrappedQuantity = _uint(json, ".quote.wrappedQuantity");
        q.strikeAmountUSDG = _uint(json, ".quote.strikeAmountUSDG");
        q.grossPremiumUSDG = _uint(json, ".quote.grossPremiumUSDG");
        q.protocolFeeUSDG = _uint(json, ".quote.protocolFeeUSDG");
        q.netPremiumUSDG = _uint(json, ".quote.netPremiumUSDG");
        q.issuedAt = uint64(_uint(json, ".quote.issuedAt"));
        q.deadline = uint64(_uint(json, ".quote.deadline"));
        q.nonce = _uint(json, ".quote.nonce");
        bytes32 structHash = QuoteLib.structHash(q);
        assertEq(structHash, vm.parseJsonBytes32(json, ".structHash"));
        bytes32 expected = vm.parseJsonBytes32(json, ".digest");
        assertEq(
            _digest(structHash, vm.parseJsonUint(json, ".chainId"), vm.parseJsonAddress(json, ".exchange")),
            expected
        );
        assertTrue(QuoteLib.isValid(q.dealer, expected, vm.parseJsonBytes(json, ".signature")));
        assertEq(exchange.quoteDigest(q), _digest(structHash, block.chainid, address(exchange)));
    }

    function _uint(string memory json, string memory path) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, path));
    }

    function _digest(bytes32 structHash, uint256 chainId, address verifier) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Payoff RFQ"),
                keccak256("2"),
                chainId,
                verifier
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }
}
