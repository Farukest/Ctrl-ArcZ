// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SpendPolicyAccount — a single-purpose, policy-bound payer wallet
/// @notice The "disposable card" of Ctrl+ArcZ's payer-side shield. Funded per
///         payment, it can only pay a locked `target`, only up to `maxAmount`,
///         only until `expiry`; every spend needs the enclave co-signer, and any
///         leftover can only ever return to the committed vault.
///
/// @dev Privacy note — the account stores NO payer identity. There is no `owner`
///      variable and no owner signature on a spend, so a merchant who is paid from
///      this address cannot read who funded it from the account itself. The vault
///      is stored only as a commitment (`vaultHash`); its address is revealed only
///      at the moment of a sweep, and only to whoever already knows it. The
///      residual on-chain link is the funding transaction (payer -> account),
///      which a transparent chain cannot hide without confidential transfers (Arc
///      Privacy Sector); the account surface itself leaks nothing.
///
///      Trust model — a spend needs only the co-signer's signature. The funds are
///      hard-locked to `target` and capped, so the co-signer can never steal or
///      redirect; it can only ever push the payment the payer set up when they
///      created and funded the account. The payer signs nothing blind: their only
///      action is a normal, readable USDC transfer to fund the account.
///
///      Signatures are EIP-712 typed data. The domain binds `address(this)` and
///      `chainid` and is computed on the fly, which is clone-safe.
contract SpendPolicyAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Mode {
        PUSH, // one-shot checkout: the co-signer authorizes each pay
        PULL // recurring/allowance: the co-signer authorizes each pull

    }

    uint8 private constant ACTION_PAY = 0;
    uint8 private constant ACTION_PULL = 1;

    // --- policy, set once at init (clone). No payer identity is stored. ---
    IERC20 public token;
    address public cosigner; // the enclave co-signer; not the payer's identity
    bytes32 public vaultHash; // keccak256(abi.encode(vault)); the return address, hidden until sweep
    address public target; // the locked payee; the payee already knows itself
    uint256 public maxAmount; // cumulative cap across all spends
    uint256 public perPullMax; // PULL: max per single pull (the real subscription guarantee)
    uint40 public expiry; // no spend after this
    uint40 public interval; // PULL: min seconds between pulls

    Mode public mode;

    // --- mutable state ---
    uint256 public spent;
    uint40 public lastPull;
    uint256 public nonce;
    bool private _initialized;

    // --- EIP-712 ---
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _SPEND_TYPEHASH =
        keccak256("Spend(address target,uint256 amount,uint256 nonce,uint8 action)");
    bytes32 private constant _NAME_HASH = keccak256(bytes("Ctrl+ArcZ SpendPolicy"));
    bytes32 private constant _VERSION_HASH = keccak256(bytes("1"));

    event Paid(address indexed target, uint256 amount, uint256 spent);
    event Pulled(address indexed target, uint256 amount, uint256 spent);
    event SweptToVault(uint256 amount);

    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroCommitment();
    error ZeroAmount();
    error WrongMode();
    error Expired();
    error OverLimit();
    error OverPerPull();
    error TooSoon();
    error BadCosignerSig();
    error NotExpiredYet();
    error WrongVault();
    error NotVault();

    /// @dev On Arc a USDC ERC-20 transfer moves native balance, so a contract must
    ///      accept native value to be fundable. Costs nothing on a plain EVM.
    receive() external payable {}

    /// @notice One-time setup for a freshly cloned account.
    function init(
        IERC20 token_,
        address cosigner_,
        bytes32 vaultHash_,
        address target_,
        uint256 maxAmount_,
        uint256 perPullMax_,
        uint40 expiry_,
        uint40 interval_,
        Mode mode_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (address(token_) == address(0) || cosigner_ == address(0) || target_ == address(0)) revert ZeroAddress();
        if (vaultHash_ == bytes32(0)) revert ZeroCommitment();
        if (maxAmount_ == 0) revert ZeroAmount();

        _initialized = true;
        token = token_;
        cosigner = cosigner_;
        vaultHash = vaultHash_;
        target = target_;
        maxAmount = maxAmount_;
        // 0 means "no tighter per-pull cap than the cumulative cap".
        perPullMax = perPullMax_ == 0 ? maxAmount_ : perPullMax_;
        expiry = expiry_;
        interval = interval_;
        mode = mode_;
    }

    // ------------------------------------------------------------------
    // Outbound to the locked target (co-signer authorized)
    // ------------------------------------------------------------------

    /// @notice PUSH: pay the locked target. Authorized by the co-signer alone; the
    ///         funds can only reach the pre-locked target within the cap, so this
    ///         cannot steal or redirect. Anyone may submit the transaction.
    function pay(uint256 amount, bytes calldata cosignerSig) external nonReentrant {
        if (mode != Mode.PUSH) revert WrongMode();
        _checkWindowAndLimit(amount);
        if (ECDSA.recover(_spendDigest(amount, ACTION_PAY), cosignerSig) != cosigner) revert BadCosignerSig();

        nonce++;
        spent += amount;
        token.safeTransfer(target, amount);
        emit Paid(target, amount, spent);
    }

    /// @notice PULL: the target (or a relayer) draws `amount`, gated by the
    ///         co-signer. Enforces the per-pull cap, the interval, the cumulative
    ///         cap and the expiry on-chain — the per-pull cap is the real
    ///         subscription guarantee against a misbehaving co-signer.
    function pull(uint256 amount, bytes calldata cosignerSig) external nonReentrant {
        if (mode != Mode.PULL) revert WrongMode();
        _checkWindowAndLimit(amount);
        if (amount > perPullMax) revert OverPerPull();
        if (lastPull != 0 && block.timestamp < uint256(lastPull) + interval) revert TooSoon();
        if (ECDSA.recover(_spendDigest(amount, ACTION_PULL), cosignerSig) != cosigner) revert BadCosignerSig();

        nonce++;
        spent += amount;
        lastPull = uint40(block.timestamp);
        token.safeTransfer(target, amount);
        emit Pulled(target, amount, spent);
    }

    // ------------------------------------------------------------------
    // Return home — the one-way valve to the vault
    // ------------------------------------------------------------------

    /// @notice Sweep the whole balance back to the vault. Only the vault itself may
    ///         call this. The vault address is observable on-chain (it is the
    ///         funding source), so its hash is NOT a secret capability; gating on
    ///         msg.sender stops an observer from front-running a pending pay with a
    ///         sweep to grief the payment. Doubles as revoke and refund-collection.
    function sweepToVault(address vault) external nonReentrant {
        if (msg.sender != vault) revert NotVault();
        if (keccak256(abi.encode(vault)) != vaultHash) revert WrongVault();
        _sweep(vault);
    }

    /// @notice Once expired, sweep home. Still gated by the vault commitment, so
    ///         only someone who knows the vault (the payer / their relayer) can
    ///         call it. Liveness escape hatch if the co-signer ever goes dark.
    function sweepExpired(address vault) external nonReentrant {
        if (block.timestamp <= expiry) revert NotExpiredYet();
        if (keccak256(abi.encode(vault)) != vaultHash) revert WrongVault();
        _sweep(vault);
    }

    function _sweep(address vault) private {
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) token.safeTransfer(vault, bal);
        emit SweptToVault(bal);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _checkWindowAndLimit(uint256 amount) private view {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > expiry) revert Expired();
        if (spent + amount > maxAmount) revert OverLimit();
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    function _spendDigest(uint256 amount, uint8 action) private view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(_SPEND_TYPEHASH, target, amount, nonce, action));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    // ------------------------------------------------------------------
    // Views (SDK + co-signer build/verify against these)
    // ------------------------------------------------------------------

    /// @notice The EIP-712 digest the co-signer signs to authorize a spend.
    ///         `action` is 0 for pay, 1 for pull.
    function spendDigest(uint256 amount, uint8 action) external view returns (bytes32) {
        return _spendDigest(amount, action);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    /// @notice Remaining spendable before the cumulative cap binds.
    function remaining() external view returns (uint256) {
        return spent >= maxAmount ? 0 : maxAmount - spent;
    }
}
