// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IClaimVerifier} from "./interfaces/IClaimVerifier.sol";

/// @title CtrlArcZ — protected USDC transfers on Arc
/// @notice Locks a transfer until the recipient proves they hold the claim
///         secret, lets the sender cancel at any time before that, and refunds
///         automatically once the window lapses. This is layer 2 of Ctrl+ArcZ;
///         the pre-send risk firewall (layer 1) lives in the SDK.
///
/// @dev One deployment, many tenants. Every integrator — an exchange withdrawal
///      screen, a P2P wallet, a payments app — calls `createConfig` once and gets
///      a `configId` that encodes its own behaviour (recall window, claim mode,
///      optional fee). They all share this contract and the same SDK.
///
///      Custody: funds are either with the user or in this contract. No admin can
///      move them. There is no owner, no pause, no upgrade path and no way for
///      the deployer to touch a locked transfer — deliberately, because a
///      protected-transfer contract that an admin can drain protects nobody.
///
///      Arc notes:
///       - USDC is used strictly through its ERC-20 interface (6 decimals). The
///         native 18-decimal balance is never read or mixed in.
///       - Memo is NOT called from here: Arc's Memo predeploy only accepts a
///         direct EOA caller and reverts on a contract caller ("sender spoofing").
///         The SDK wraps `sendProtected` in `Memo.memo(...)` instead, and the
///         CallFrom precompile preserves the user's address as `msg.sender` here.
contract CtrlArcZ is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice How a transfer is released to its recipient.
    /// @dev v1 implements CODE. SIGNATURE and REGISTERED are reserved: creating a
    ///      config with them reverts, but the `IClaimVerifier` seam means they can
    ///      ship later without redeploying this contract.
    enum ClaimMode {
        CODE,
        SIGNATURE,
        REGISTERED
    }

    enum TransferStatus {
        NONE,
        PENDING,
        CLAIMED,
        CANCELLED
    }

    struct Config {
        address integrator;
        uint32 recallWindow; // seconds the recipient has to claim
        ClaimMode claimMode;
        uint16 feeBps; // integrator fee, taken only on a successful claim
        address feeRecipient;
        IClaimVerifier verifier;
        bool exists;
    }

    struct ProtectedTransfer {
        // slot 0
        address sender;
        uint96 amount;
        // slot 1
        address to;
        uint40 deadline;
        TransferStatus status;
        // slot 2, 3
        bytes32 claimHash;
        bytes32 configId;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Upper bound on the recall window: 7 days.
    uint32 public constant MAX_RECALL_WINDOW = 7 days;

    /// @notice Upper bound on an integrator fee: 1%.
    uint16 public constant MAX_FEE_BPS = 100;

    uint16 private constant BPS_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice The USDC ERC-20 interface. Immutable; supplied at deploy time from
    ///         `packages/sdk/src/chains/arcTestnet.ts`, the single source of truth.
    IERC20 public immutable USDC;

    /// @notice Built-in verifier for ClaimMode.CODE. Immutable: a swappable
    ///         verifier would be an admin key over every locked transfer.
    IClaimVerifier public immutable CODE_VERIFIER;

    mapping(bytes32 configId => Config) public configs;
    mapping(uint256 transferId => ProtectedTransfer) private _transfers;

    /// @notice Id of the next transfer. Starts at 1, so 0 always means "none".
    uint256 public nextTransferId = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ConfigCreated(
        bytes32 indexed configId,
        address indexed integrator,
        uint32 recallWindow,
        ClaimMode claimMode,
        uint16 feeBps,
        address feeRecipient,
        address verifier
    );

    /// @param claimHash Included so an indexer can join Arc `Memo` events to a
    ///        transfer: the SDK sets `memoId = claimHash`, which is known before
    ///        the call, whereas `transferId` is only assigned here.
    event TransferCreated(
        uint256 indexed transferId,
        address indexed sender,
        address indexed to,
        uint256 amount,
        bytes32 configId,
        uint64 deadline,
        bytes32 claimHash
    );

    event TransferClaimed(
        uint256 indexed transferId, address indexed to, address caller, uint256 amountToRecipient, uint256 fee
    );

    event TransferCancelled(uint256 indexed transferId, address indexed sender, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error AmountTooLarge();
    error RecallWindowTooLong();
    error FeeTooHigh();
    error FeeRecipientRequired();
    error ClaimModeNotSupported(ClaimMode mode);
    error UnknownConfig(bytes32 configId);
    error UnknownTransfer(uint256 transferId);
    error EmptyClaimHash();
    error WrongClaimCode();
    error SelfTransfer();
    error NotSender(address caller, address sender);
    error TransferNotPending(uint256 transferId, TransferStatus status);
    error TransferExpired(uint256 transferId, uint40 deadline);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(IERC20 usdc, IClaimVerifier codeVerifier) {
        if (address(usdc) == address(0) || address(codeVerifier) == address(0)) revert ZeroAddress();
        USDC = usdc;
        CODE_VERIFIER = codeVerifier;
    }

    // ---------------------------------------------------------------------
    // Config — one per integrator behaviour
    // ---------------------------------------------------------------------

    /// @notice Register an integrator behaviour and get its `configId`.
    /// @dev Content-addressed and idempotent: the same parameters from the same
    ///      integrator always yield the same id, so an app can call this on every
    ///      boot without bookkeeping.
    /// @param recallWindow Seconds the recipient has to claim before the transfer
    ///        becomes refundable by anyone. 0 to `MAX_RECALL_WINDOW` (7 days).
    /// @param claimMode Only `CODE` is implemented in v1.
    /// @param feeBps Integrator fee in basis points, taken from the claimed amount
    ///        only on success. 0 to `MAX_FEE_BPS` (1%).
    function createConfig(uint32 recallWindow, ClaimMode claimMode, uint16 feeBps, address feeRecipient)
        external
        returns (bytes32 configId)
    {
        IClaimVerifier verifier = _builtInVerifier(claimMode);
        return _createConfig(recallWindow, claimMode, feeBps, feeRecipient, verifier);
    }

    function _createConfig(
        uint32 recallWindow,
        ClaimMode claimMode,
        uint16 feeBps,
        address feeRecipient,
        IClaimVerifier verifier
    ) private returns (bytes32 configId) {
        if (recallWindow > MAX_RECALL_WINDOW) revert RecallWindowTooLong();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeBps > 0 && feeRecipient == address(0)) revert FeeRecipientRequired();

        configId = keccak256(abi.encode(msg.sender, recallWindow, claimMode, feeBps, feeRecipient, verifier));

        if (!configs[configId].exists) {
            configs[configId] = Config({
                integrator: msg.sender,
                recallWindow: recallWindow,
                claimMode: claimMode,
                feeBps: feeBps,
                feeRecipient: feeRecipient,
                verifier: verifier,
                exists: true
            });

            emit ConfigCreated(configId, msg.sender, recallWindow, claimMode, feeBps, feeRecipient, address(verifier));
        }
    }

    function _builtInVerifier(ClaimMode claimMode) private view returns (IClaimVerifier) {
        if (claimMode == ClaimMode.CODE) return CODE_VERIFIER;
        // SIGNATURE and REGISTERED are reserved for a future verifier.
        revert ClaimModeNotSupported(claimMode);
    }

    // ---------------------------------------------------------------------
    // Send
    // ---------------------------------------------------------------------

    /// @notice Lock `amount` USDC for `to`, releasable only with the claim secret.
    /// @dev Requires a prior USDC approval to this contract. The caller keeps the
    ///      right to `cancel` until the moment a claim lands.
    /// @param claimHash `keccak256(abi.encodePacked(salt, code))`. The SDK derives
    ///        it; the salt is a 32-byte secret that must never be published (see
    ///        `CodeClaimVerifier`).
    function sendProtected(bytes32 configId, address to, uint256 amount, bytes32 claimHash)
        external
        nonReentrant
        returns (uint256 transferId)
    {
        Config memory config = configs[configId];
        if (!config.exists) revert UnknownConfig(configId);
        if (to == address(0)) revert ZeroAddress();
        if (to == msg.sender) revert SelfTransfer();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint96).max) revert AmountTooLarge();
        if (claimHash == bytes32(0)) revert EmptyClaimHash();

        transferId = nextTransferId++;

        // Safe: recallWindow <= 7 days, so the sum overflows uint40 only past year 36812.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint40 deadline = uint40(block.timestamp + config.recallWindow);

        _transfers[transferId] = ProtectedTransfer({
            sender: msg.sender,
            // Safe: `amount > type(uint96).max` reverted above.
            // forge-lint: disable-next-line(unsafe-typecast)
            amount: uint96(amount),
            to: to,
            deadline: deadline,
            status: TransferStatus.PENDING,
            claimHash: claimHash,
            configId: configId
        });

        emit TransferCreated(transferId, msg.sender, to, amount, configId, deadline, claimHash);

        // Interaction last: state is already consistent. Requires a prior USDC
        // approval to this contract.
        USDC.safeTransferFrom(msg.sender, address(this), amount);
    }


    // ---------------------------------------------------------------------
    // Claim
    // ---------------------------------------------------------------------

    /// @notice Release a transfer with the 6-digit code and its salt.
    /// @dev Anyone may submit — the funds always go to the `to` recorded at send
    ///      time, never to `msg.sender`. That makes a claim front-run-safe and
    ///      lets a sender or relayer settle on behalf of a recipient who has no
    ///      USDC for gas yet (on Arc, gas is USDC).
    function claim(uint256 transferId, string calldata code, bytes32 salt) external {
        claimWithProof(transferId, abi.encode(salt, code));
    }

    /// @notice Mode-agnostic claim: the proof is interpreted by the config's verifier.
    function claimWithProof(uint256 transferId, bytes memory proof) public nonReentrant {
        ProtectedTransfer storage t = _transfers[transferId];
        if (t.status == TransferStatus.NONE) revert UnknownTransfer(transferId);
        if (t.status != TransferStatus.PENDING) revert TransferNotPending(transferId, t.status);
        if (block.timestamp > t.deadline) revert TransferExpired(transferId, t.deadline);

        Config memory config = configs[t.configId];

        if (!config.verifier.verify(transferId, t.claimHash, msg.sender, proof)) revert WrongClaimCode();

        address to = t.to;
        uint256 amount = t.amount;

        // Effects before interactions.
        t.status = TransferStatus.CLAIMED;

        uint256 fee = (amount * config.feeBps) / BPS_DENOMINATOR;
        uint256 amountToRecipient = amount - fee;

        if (fee > 0) USDC.safeTransfer(config.feeRecipient, fee);
        USDC.safeTransfer(to, amountToRecipient);

        emit TransferClaimed(transferId, to, msg.sender, amountToRecipient, fee);
    }

    // ---------------------------------------------------------------------
    // Cancel and refund
    // ---------------------------------------------------------------------

    /// @notice Take the money back. Sender only, allowed until a claim lands,
    ///         inside or outside the window.
    /// @dev Unclaimed money belongs to the sender. That is the whole promise, so
    ///      there is no deadline on this.
    function cancel(uint256 transferId) external nonReentrant {
        ProtectedTransfer storage t = _transfers[transferId];
        if (t.status == TransferStatus.NONE) revert UnknownTransfer(transferId);
        if (t.status != TransferStatus.PENDING) revert TransferNotPending(transferId, t.status);
        if (msg.sender != t.sender) revert NotSender(msg.sender, t.sender);

        uint256 amount = t.amount;
        t.status = TransferStatus.CANCELLED;

        USDC.safeTransfer(t.sender, amount);

        emit TransferCancelled(transferId, t.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getTransfer(uint256 transferId) external view returns (ProtectedTransfer memory) {
        ProtectedTransfer memory t = _transfers[transferId];
        if (t.status == TransferStatus.NONE) revert UnknownTransfer(transferId);
        return t;
    }

    /// @notice True while the transfer can still be claimed with the right proof.
    function isClaimable(uint256 transferId) external view returns (bool) {
        ProtectedTransfer memory t = _transfers[transferId];
        return t.status == TransferStatus.PENDING && block.timestamp <= t.deadline;
    }
}
