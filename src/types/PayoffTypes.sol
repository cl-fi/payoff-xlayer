// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Canonical data model. IDs are scoped to one Vault address.
library PayoffTypes {
    enum Side {
        Put,
        Call
    }
    enum State {
        None,
        Open,
        Exercised,
        Expired,
        Claimed
    }

    struct Series {
        Side side;
        // USDG base units per ONE whole wrapped token (18 decimals).
        uint256 strikePricePerWrappedUSDG;
        uint64 tradeCutoff;
        uint64 exerciseStart;
        uint64 exerciseEnd;
    }

    struct Position {
        uint256 seriesId;
        address shortHolder;
        address longHolder;
        uint256 wrappedQuantity;
        uint256 strikeAmountUSDG;
        // Wrapped ERC-20 units still owed to this position, not underlying xStock shares.
        uint256 wrappedBalance;
        State state;
        // Opening block time; shares the state slot so it adds no storage write.
        uint64 openedAt;
    }

    struct OpenParams {
        uint256 seriesId;
        address shortHolder;
        address longHolder;
        uint256 wrappedQuantity;
        uint256 strikeAmountUSDG;
        uint256 maxCollateralUSDG;
        uint256 maxCollateralWrapped;
        bytes32 requestId;
    }

    struct Quote {
        bytes32 requestId;
        address vault;
        address dealer;
        address taker;
        uint256 seriesId;
        uint256 wrappedQuantity;
        uint256 strikeAmountUSDG;
        uint256 grossPremiumUSDG;
        uint256 protocolFeeUSDG;
        uint256 netPremiumUSDG;
        uint64 issuedAt;
        uint64 deadline;
        uint256 nonce;
    }

    struct FillLimits {
        uint256 minNetPremiumUSDG;
        uint256 maxCollateralUSDG;
        uint256 maxCollateralWrapped;
    }
}
