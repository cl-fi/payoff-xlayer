// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PositionReceipts} from "./base/PositionReceipts.sol";
import {PayoffTypes as T} from "./types/PayoffTypes.sol";
import {PayoffMath} from "./libraries/PayoffMath.sol";
import {ExactERC20} from "./libraries/ExactERC20.sol";

/// @notice One wrapped stock/USDG pair; fixed wrapped quantities and fixed USDG exercise totals.
/// @dev Exits never call the Exchange. Series/position IDs are local to this Vault.
contract SeriesVault is PositionReceipts, ReentrancyGuard {
    using ExactERC20 for IERC20;
    uint256 public constant RULES_VERSION = 2;
    bytes32 public constant DELIVERY_POLICY = keccak256("FixedWrappedAmount");
    bytes32 public constant SETTLEMENT_MODE = keccak256("PhysicalExercise");
    IERC20 public immutable usdg;
    // Underlying identity is used for the one-Vault-per-stock registry only.
    address public immutable stock;
    IERC20 public immutable wrappedStock;
    address public immutable administrator;
    address public immutable exchange;
    uint256 public nextSeriesId = 1;
    uint256 public nextPositionId = 1;
    uint256 public accountedUSDG;
    uint256 public accountedWrapped;
    bool public newPositionsPaused;
    mapping(uint256 => T.Series) private _series;
    mapping(uint256 => T.Position) private _positions;

    error Unauthorized();
    error InvalidConfiguration();
    error UnknownSeries();
    error UnknownPosition();
    error NewPositionsPaused();
    error TradeClosed();
    error OutsideExerciseWindow();
    error InvalidState();
    error ClaimNotReady();
    error CollateralLimitExceeded();
    error StrikeAmountMismatch();
    event SeriesCreated(
        uint256 indexed seriesId,
        T.Side side,
        uint256 strikePricePerWrappedUSDG,
        uint64 tradeCutoff,
        uint64 exerciseStart,
        uint64 exerciseEnd
    );
    event PositionOpened(
        uint256 indexed positionId,
        uint256 indexed seriesId,
        bytes32 indexed requestId,
        address shortHolder,
        address longHolder,
        uint256 wrappedQuantity,
        uint256 strikeAmountUSDG,
        uint256 collateralWrapped
    );
    event Exercised(
        uint256 indexed positionId,
        address indexed longHolder,
        uint256 wrappedQuantity,
        uint256 strikeAmountUSDG
    );
    event Claimed(
        uint256 indexed positionId, address indexed shortHolder, uint256 usdgAmount, uint256 wrappedAmount
    );
    event NewPositionsPauseChanged(bool paused);

    constructor(address usdg_, address wrappedStock_, address administrator_, address exchange_) {
        if (
            usdg_ == wrappedStock_ || usdg_.code.length == 0 || wrappedStock_.code.length == 0
                || administrator_ == address(0) || exchange_.code.length == 0
                || IERC20Metadata(usdg_).decimals() != 6 || IERC20Metadata(wrappedStock_).decimals() != 18
        ) revert InvalidConfiguration();
        address underlying = IERC4626(wrappedStock_).asset();
        if (
            underlying == usdg_ || underlying == wrappedStock_ || underlying.code.length == 0
                || IERC20Metadata(underlying).decimals() != 18
        ) revert InvalidConfiguration();
        usdg = IERC20(usdg_);
        stock = underlying;
        wrappedStock = IERC20(wrappedStock_);
        administrator = administrator_;
        exchange = exchange_;
    }

    function createSeries(
        T.Side side,
        uint256 strikePricePerWrappedUSDG,
        uint64 tradeCutoff,
        uint64 exerciseStart,
        uint64 exerciseEnd
    ) external returns (uint256 id) {
        if (msg.sender != administrator) revert Unauthorized();
        if (
            strikePricePerWrappedUSDG == 0 || tradeCutoff <= block.timestamp || tradeCutoff > exerciseStart
                || exerciseStart >= exerciseEnd
        ) revert InvalidConfiguration();
        id = nextSeriesId++;
        _series[id] = T.Series(side, strikePricePerWrappedUSDG, tradeCutoff, exerciseStart, exerciseEnd);
        emit SeriesCreated(id, side, strikePricePerWrappedUSDG, tradeCutoff, exerciseStart, exerciseEnd);
    }

    function setNewPositionsPaused(bool paused) external {
        if (msg.sender != administrator) revert Unauthorized();
        newPositionsPaused = paused;
        emit NewPositionsPauseChanged(paused);
    }

    /// @dev Exchange verifies quotes and pays premium atomically; Vault rechecks quantity/funding.
    function openPosition(T.OpenParams calldata p) external nonReentrant returns (uint256 id) {
        if (msg.sender != exchange) revert Unauthorized();
        if (newPositionsPaused) revert NewPositionsPaused();
        T.Series memory terms = getSeries(p.seriesId);
        if (block.timestamp >= terms.tradeCutoff) revert TradeClosed();
        if (
            p.wrappedQuantity == 0 || p.shortHolder == address(0) || p.longHolder == address(0)
                || p.shortHolder == address(this) || p.longHolder == address(this)
        ) revert InvalidConfiguration();
        uint256 amount = PayoffMath.strikeAmount(p.wrappedQuantity, terms.strikePricePerWrappedUSDG);
        if (amount != p.strikeAmountUSDG) revert StrikeAmountMismatch();
        id = nextPositionId++;
        _positions[id] =
            T.Position(p.seriesId, p.shortHolder, p.longHolder, p.wrappedQuantity, amount, 0, T.State.Open);
        if (terms.side == T.Side.Put) {
            if (amount > p.maxCollateralUSDG) revert CollateralLimitExceeded();
            accountedUSDG += amount;
            usdg.pull(p.shortHolder, address(this), amount);
        } else {
            if (p.wrappedQuantity > p.maxCollateralWrapped) revert CollateralLimitExceeded();
            _positions[id].wrappedBalance = p.wrappedQuantity;
            accountedWrapped += p.wrappedQuantity;
            wrappedStock.pull(p.shortHolder, address(this), p.wrappedQuantity);
        }
        _mintReceipts(id, p.shortHolder, p.longHolder);
        emit PositionOpened(
            id,
            p.seriesId,
            p.requestId,
            p.shortHolder,
            p.longHolder,
            p.wrappedQuantity,
            amount,
            _positions[id].wrappedBalance
        );
    }

    function exercise(uint256 id) external nonReentrant {
        T.Position storage p = _position(id);
        if (msg.sender != p.longHolder) revert Unauthorized();
        if (p.state != T.State.Open) revert InvalidState();
        T.Series memory terms = _series[p.seriesId];
        if (block.timestamp < terms.exerciseStart || block.timestamp >= terms.exerciseEnd) {
            revert OutsideExerciseWindow();
        }
        p.state = T.State.Exercised;
        _consumeLong(id, p.longHolder);
        if (terms.side == T.Side.Put) {
            accountedUSDG -= p.strikeAmountUSDG;
            p.wrappedBalance = p.wrappedQuantity;
            accountedWrapped += p.wrappedQuantity;
            wrappedStock.pull(p.longHolder, address(this), p.wrappedQuantity);
            usdg.push(p.longHolder, p.strikeAmountUSDG);
        } else {
            // All locked wrapped units are delivered, including their accrued underlying rights.
            p.wrappedBalance = 0;
            accountedWrapped -= p.wrappedQuantity;
            accountedUSDG += p.strikeAmountUSDG;
            usdg.pull(p.longHolder, address(this), p.strikeAmountUSDG);
            wrappedStock.push(p.longHolder, p.wrappedQuantity);
        }
        emit Exercised(id, p.longHolder, p.wrappedQuantity, p.strikeAmountUSDG);
    }

    function claim(uint256 id) external nonReentrant {
        T.Position storage p = _position(id);
        if (msg.sender != p.shortHolder) revert Unauthorized();
        T.Series memory terms = _series[p.seriesId];
        uint256 usdAmount;
        uint256 wrappedAmount = p.wrappedBalance;
        if (p.state == T.State.Exercised) {
            if (terms.side == T.Side.Call) usdAmount = p.strikeAmountUSDG;
        } else if (p.state == T.State.Open) {
            if (block.timestamp < terms.exerciseEnd) revert ClaimNotReady();
            if (terms.side == T.Side.Put) usdAmount = p.strikeAmountUSDG;
            _consumeLong(id, p.longHolder);
        } else {
            revert InvalidState();
        }
        p.state = T.State.Claimed;
        p.wrappedBalance = 0;
        accountedUSDG -= usdAmount;
        accountedWrapped -= wrappedAmount;
        _consumeShort(id, p.shortHolder);
        usdg.push(p.shortHolder, usdAmount);
        wrappedStock.push(p.shortHolder, wrappedAmount);
        emit Claimed(id, p.shortHolder, usdAmount, wrappedAmount);
    }

    function getSeries(uint256 id) public view returns (T.Series memory terms) {
        terms = _series[id];
        if (terms.exerciseEnd == 0) revert UnknownSeries();
    }

    function position(uint256 id) external view returns (T.Position memory) {
        return _position(id);
    }

    function stateOf(uint256 id) external view returns (T.State) {
        T.Position storage p = _position(id);
        if (p.state == T.State.Open && block.timestamp >= _series[p.seriesId].exerciseEnd) {
            return T.State.Expired;
        }
        return p.state;
    }

    function _position(uint256 id) private view returns (T.Position storage p) {
        p = _positions[id];
        if (p.state == T.State.None) revert UnknownPosition();
    }
}
