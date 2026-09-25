// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISeriesVault} from "./interfaces/ISeriesVault.sol";
import {PayoffTypes as T} from "./types/PayoffTypes.sol";
import {PayoffMath} from "./libraries/PayoffMath.sol";
import {QuoteLib} from "./libraries/QuoteLib.sol";
import {ExactERC20} from "./libraries/ExactERC20.sol";

/// @notice One signed-quote execution gateway for multiple stock/USDG Vaults.
contract RFQExchange is EIP712, ReentrancyGuard {
    using ExactERC20 for IERC20;
    IERC20 public immutable usdg;
    address public immutable administrator;
    address public immutable feeRecipient;
    uint16 public feeBps;
    bool public newPositionsPaused;
    address[] private _vaults;
    mapping(address => bool) public registeredVault;
    mapping(address => bool) public vaultAllowed;
    mapping(address => address) public vaultForStock;
    mapping(address => bool) public dealerAllowed;
    mapping(address => mapping(uint256 => bool)) public nonceUnavailable;
    // Net premium paid to the short side, keyed by Vault and position, readable without event logs.
    mapping(address => mapping(uint256 => uint256)) public netPremiumOf;
    error Unauthorized();
    error InvalidConfiguration();
    error VaultNotAllowed();
    error DealerNotAllowed();
    error NewPositionsPaused();
    error InvalidQuote();
    error InvalidSignature();
    error InvalidQuoteTime();
    error NonceUnavailable();
    error UserProtectionFailed();
    error DuplicateStockVault();
    event VaultAdmissionChanged(address indexed vault, address indexed stock, bool allowed);
    event DealerAdmissionChanged(address indexed dealer, bool allowed);
    event QuoteCancelled(address indexed dealer, uint256 indexed nonce);
    event QuoteFilled(
        bytes32 indexed requestId,
        address indexed vault,
        uint256 indexed positionId,
        bytes32 quoteHash,
        address dealer,
        address taker,
        uint256 nonce,
        uint256 grossPremiumUSDG,
        uint256 protocolFeeUSDG,
        uint256 netPremiumUSDG
    );
    event NewPositionsPauseChanged(bool paused);
    event ProtocolFeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);

    constructor(address usdg_, address administrator_, address feeRecipient_, uint16 feeBps_)
        EIP712("Payoff RFQ", "2")
    {
        if (
            usdg_.code.length == 0 || IERC20Metadata(usdg_).decimals() != 6 || administrator_ == address(0)
                || feeRecipient_ == address(0) || feeBps_ > 10000
        ) revert InvalidConfiguration();
        usdg = IERC20(usdg_);
        administrator = administrator_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    function setVaultAllowed(address vault, bool allowed) external {
        _onlyAdmin();
        if (!registeredVault[vault]) {
            if (!allowed || vault.code.length == 0) revert InvalidConfiguration();
            ISeriesVault target = ISeriesVault(vault);
            if (
                target.exchange() != address(this) || target.usdg() != address(usdg)
                    || target.administrator() != administrator || target.RULES_VERSION() != 2
            ) revert InvalidConfiguration();
            address stock = target.stock();
            if (vaultForStock[stock] != address(0)) revert DuplicateStockVault();
            vaultForStock[stock] = vault;
            registeredVault[vault] = true;
            _vaults.push(vault);
        }
        vaultAllowed[vault] = allowed;
        emit VaultAdmissionChanged(vault, ISeriesVault(vault).stock(), allowed);
    }

    function setDealerAllowed(address dealer, bool allowed) external {
        _onlyAdmin();
        if (dealer == address(0)) revert InvalidConfiguration();
        dealerAllowed[dealer] = allowed;
        emit DealerAdmissionChanged(dealer, allowed);
    }

    function setNewPositionsPaused(bool paused) external {
        _onlyAdmin();
        newPositionsPaused = paused;
        emit NewPositionsPauseChanged(paused);
    }

    /// @notice Set the fee on future fills. Existing positions and paid premiums are unaffected.
    /// @dev Quotes with a fee split that no longer matches must be signed again, never rewritten.
    function setFeeBps(uint16 newFeeBps) external {
        _onlyAdmin();
        if (newFeeBps > 10_000) revert InvalidConfiguration();
        uint16 previousFeeBps = feeBps;
        feeBps = newFeeBps;
        emit ProtocolFeeUpdated(previousFeeBps, newFeeBps);
    }

    function cancelNonce(uint256 nonce) external {
        // Remains available after dealer removal or pause. Nonces are dealer-scoped across Vaults.
        if (nonceUnavailable[msg.sender][nonce]) revert NonceUnavailable();
        nonceUnavailable[msg.sender][nonce] = true;
        emit QuoteCancelled(msg.sender, nonce);
    }

    function quoteDigest(T.Quote memory quote) public view returns (bytes32) {
        return _hashTypedDataV4(QuoteLib.structHash(quote));
    }

    function quoteTypehash() external pure returns (bytes32) {
        return QuoteLib.TYPEHASH;
    }

    function protocolFee(uint256 grossPremiumUSDG) public view returns (uint256) {
        return Math.mulDiv(grossPremiumUSDG, feeBps, 10000);
    }

    function registeredVaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    /// @notice Read one registry entry; callers choose their own off-chain batch/page size.
    function registeredVaultAt(uint256 index) external view returns (address) {
        return _vaults[index];
    }

    function fill(T.Quote calldata quote, bytes calldata signature, T.FillLimits calldata limits)
        external
        nonReentrant
        returns (uint256 positionId)
    {
        if (newPositionsPaused) revert NewPositionsPaused();
        if (!vaultAllowed[quote.vault]) revert VaultNotAllowed();
        if (!dealerAllowed[quote.dealer]) revert DealerNotAllowed();
        if (msg.sender != quote.taker) revert Unauthorized();
        if (nonceUnavailable[quote.dealer][quote.nonce]) revert NonceUnavailable();
        T.Series memory terms = ISeriesVault(quote.vault).getSeries(quote.seriesId);
        _validateQuote(quote, terms, limits);
        bytes32 digest = quoteDigest(quote);
        if (!QuoteLib.isValid(quote.dealer, digest, signature)) revert InvalidSignature();
        // Only the selected Vault participates. Other markets cannot block this fill.
        nonceUnavailable[quote.dealer][quote.nonce] = true;
        T.OpenParams memory params = T.OpenParams(
            quote.seriesId,
            quote.taker,
            quote.dealer,
            quote.wrappedQuantity,
            quote.strikeAmountUSDG,
            limits.maxCollateralUSDG,
            limits.maxCollateralWrapped,
            quote.requestId
        );
        positionId = ISeriesVault(quote.vault).openPosition(params);
        netPremiumOf[quote.vault][positionId] = quote.netPremiumUSDG;
        usdg.pull(quote.dealer, quote.taker, quote.netPremiumUSDG);
        usdg.pull(quote.dealer, feeRecipient, quote.protocolFeeUSDG);
        _emitFill(quote, positionId, digest);
    }

    function _emitFill(T.Quote calldata q, uint256 positionId, bytes32 digest) private {
        emit QuoteFilled(
            q.requestId,
            q.vault,
            positionId,
            digest,
            q.dealer,
            q.taker,
            q.nonce,
            q.grossPremiumUSDG,
            q.protocolFeeUSDG,
            q.netPremiumUSDG
        );
    }

    function _validateQuote(T.Quote calldata q, T.Series memory terms, T.FillLimits calldata limits)
        private
        view
    {
        if (
            q.issuedAt > block.timestamp || q.deadline < q.issuedAt || block.timestamp > q.deadline
                || q.deadline > terms.tradeCutoff || block.timestamp >= terms.tradeCutoff
        ) revert InvalidQuoteTime();
        if (
            q.wrappedQuantity == 0
                || q.strikeAmountUSDG
                    != PayoffMath.strikeAmount(q.wrappedQuantity, terms.strikePricePerWrappedUSDG)
                || q.protocolFeeUSDG != protocolFee(q.grossPremiumUSDG)
                || q.grossPremiumUSDG != q.netPremiumUSDG + q.protocolFeeUSDG
        ) revert InvalidQuote();
        if (
            q.netPremiumUSDG < limits.minNetPremiumUSDG
                || (terms.side == T.Side.Put && q.strikeAmountUSDG > limits.maxCollateralUSDG)
        ) revert UserProtectionFailed();
    }

    function _onlyAdmin() private view {
        if (msg.sender != administrator) revert Unauthorized();
    }
}
