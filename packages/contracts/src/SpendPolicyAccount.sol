// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title SpendPolicyAccount — a single-purpose, policy-bound payer wallet
/// @notice The "disposable card" of Ctrl+ArcZ's payer-side shield. Funded from a
///         vault, it can only pay a locked `target`, only up to `maxAmount`, only
///         until `expiry`, and every outbound payment needs a co-signer (the
///         enclave "veto") in addition to the owner. Anything left over can only
///         ever return to the `vault`, so the account is a one-way valve, never a
///         black hole.
///
/// @dev Deployed as an EIP-1167 minimal-proxy clone per intent (see
///      `SpendPolicyFactory`), so `init` runs once instead of a constructor. The
///      signature domain binds `address(this)` and `chainid`, which is clone-safe
///      (no cached domain separator that a clone would inherit wrong).
///
///      Trust model:
///       - Outbound to the third-party `target`: 2-of-2 (owner + cosigner). The
///         cosigner is the enclave; it refuses to sign a spend that fails policy
///         or the risk firewall, so a bad payment is physically impossible, not
///         merely warned about.
///       - Return to the owner's own `vault`: owner alone, any time; and by anyone
///         once expired. This is the liveness escape hatch: if the enclave ever
///         goes dark, funds are never stranded — they sweep home.
contract SpendPolicyAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Mode {
        PUSH, // one-shot checkout: owner + cosigner authorize each pay
        PULL // recurring/allowance: cosigner authorizes each pull, owner pre-authorized at creation

    }

    // --- policy, set once at init (clone) ---
    IERC20 public token;
    address public owner; // the payer / vault owner
    address public cosigner; // the enclave co-signer
    address public vault; // the only address funds may return to
    address public target; // the locked payee; funds can go nowhere else
    uint256 public maxAmount; // cumulative cap across all pays/pulls
    uint40 public expiry; // no outbound payment after this timestamp
    uint40 public interval; // PULL: min seconds between pulls (0 for PUSH)
    Mode public mode;

    // --- mutable state ---
    uint256 public spent; // cumulative sent to target
    uint40 public lastPull;
    uint256 public nonce; // replay guard for signed actions
    bool private _initialized;

    event Initialized(address indexed owner, address indexed target, uint256 maxAmount, uint40 expiry, Mode mode);
    event Paid(address indexed target, uint256 amount, uint256 spent);
    event Pulled(address indexed target, uint256 amount, uint256 spent);
    event SweptToVault(address indexed vault, uint256 amount);

    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error WrongMode();
    error Expired();
    error OverLimit();
    error TooSoon();
    error BadOwnerSig();
    error BadCosignerSig();
    error NotExpiredYet();

    /// @dev On Arc, a USDC ERC-20 transfer moves the recipient's native balance, so
    ///      a contract must accept native value to be fundable. Without this, funding
    ///      an ephemeral account (or a sweep into it) would revert on Arc. Costs
    ///      nothing on a standard EVM. The clone forwards value-only calls here.
    receive() external payable {}

    /// @notice One-time setup for a freshly cloned account.
    function init(
        IERC20 token_,
        address owner_,
        address cosigner_,
        address vault_,
        address target_,
        uint256 maxAmount_,
        uint40 expiry_,
        uint40 interval_,
        Mode mode_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (
            address(token_) == address(0) || owner_ == address(0) || cosigner_ == address(0) || vault_ == address(0)
                || target_ == address(0)
        ) revert ZeroAddress();
        if (maxAmount_ == 0) revert ZeroAmount();

        _initialized = true;
        token = token_;
        owner = owner_;
        cosigner = cosigner_;
        vault = vault_;
        target = target_;
        maxAmount = maxAmount_;
        expiry = expiry_;
        interval = interval_;
        mode = mode_;

        emit Initialized(owner_, target_, maxAmount_, expiry_, mode_);
    }

    // ------------------------------------------------------------------
    // Outbound to the locked target (2-of-2 or cosigner-gated)
    // ------------------------------------------------------------------

    /// @notice PUSH: pay the locked target. Needs BOTH the owner and the cosigner
    ///         signature over `(this, target, amount, nonce, chainid)`. Anyone may
    ///         submit the transaction (a relayer), since the money can only reach
    ///         the pre-locked target regardless of who sends it.
    function pay(uint256 amount, bytes calldata ownerSig, bytes calldata cosignerSig) external nonReentrant {
        if (mode != Mode.PUSH) revert WrongMode();
        _checkWindowAndLimit(amount);

        bytes32 digest = _actionDigest(amount);
        if (ECDSA.recover(digest, ownerSig) != owner) revert BadOwnerSig();
        if (ECDSA.recover(digest, cosignerSig) != cosigner) revert BadCosignerSig();

        nonce++;
        spent += amount;
        token.safeTransfer(target, amount);
        emit Paid(target, amount, spent);
    }

    /// @notice PULL: the target (or a relayer) draws `amount`, gated by the
    ///         cosigner's signature only — the owner pre-authorized this account
    ///         when it was created and funded. Enforces the interval, the cumulative
    ///         cap and the expiry on-chain, so a merchant cannot over-pull even if
    ///         the cosigner misbehaves.
    function pull(uint256 amount, bytes calldata cosignerSig) external nonReentrant {
        if (mode != Mode.PULL) revert WrongMode();
        _checkWindowAndLimit(amount);
        // First pull (lastPull == 0) is always allowed; the interval only spaces
        // out subsequent pulls.
        if (lastPull != 0 && block.timestamp < uint256(lastPull) + interval) revert TooSoon();

        bytes32 digest = _actionDigest(amount);
        if (ECDSA.recover(digest, cosignerSig) != cosigner) revert BadCosignerSig();

        nonce++;
        spent += amount;
        lastPull = uint40(block.timestamp);
        token.safeTransfer(target, amount);
        emit Pulled(target, amount, spent);
    }

    // ------------------------------------------------------------------
    // Return home — the one-way valve to the vault
    // ------------------------------------------------------------------

    /// @notice Sweep the whole balance back to the vault. Owner-authorized (by
    ///         signature so a relayer can submit), allowed any time. Because the
    ///         destination is the hard-locked `vault`, this is safe to expose: it
    ///         can never move funds anywhere else. Doubles as revoke (kill a
    ///         subscription) and refund-collection.
    function sweepToVault(bytes calldata ownerSig) external nonReentrant {
        bytes32 digest = _sweepDigest();
        if (ECDSA.recover(digest, ownerSig) != owner) revert BadOwnerSig();
        nonce++;
        _sweep();
    }

    /// @notice Once expired, anyone may sweep the account home. This is the
    ///         keeper/refund path: a refund that lands after expiry, or leftover
    ///         funds from an abandoned checkout, are returned to the vault without
    ///         the owner or the enclave having to act.
    function sweepExpired() external nonReentrant {
        if (block.timestamp <= expiry) revert NotExpiredYet();
        _sweep();
    }

    function _sweep() private {
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) token.safeTransfer(vault, bal);
        emit SweptToVault(vault, bal);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _checkWindowAndLimit(uint256 amount) private view {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > expiry) revert Expired();
        if (spent + amount > maxAmount) revert OverLimit();
    }

    bytes32 private constant _ACTION_TYPEHASH =
        keccak256("SpendPolicyAction(address account,address target,uint256 amount,uint256 nonce,uint256 chainId)");
    bytes32 private constant _SWEEP_TYPEHASH =
        keccak256("SpendPolicySweep(address account,address vault,uint256 nonce,uint256 chainId)");

    function _actionDigest(uint256 amount) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_ACTION_TYPEHASH, address(this), target, amount, nonce, block.chainid));
        return MessageHashUtils.toEthSignedMessageHash(structHash);
    }

    function _sweepDigest() private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_SWEEP_TYPEHASH, address(this), vault, nonce, block.chainid));
        return MessageHashUtils.toEthSignedMessageHash(structHash);
    }

    /// @notice The digest a wallet/enclave must sign to authorize paying `amount`.
    ///         Exposed so the SDK and the co-signer service build the exact bytes.
    function actionDigest(uint256 amount) external view returns (bytes32) {
        return _actionDigest(amount);
    }

    function sweepDigest() external view returns (bytes32) {
        return _sweepDigest();
    }

    /// @notice Remaining spendable before the cumulative cap binds.
    function remaining() external view returns (uint256) {
        return spent >= maxAmount ? 0 : maxAmount - spent;
    }
}
