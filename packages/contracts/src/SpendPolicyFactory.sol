// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendPolicyAccount} from "./SpendPolicyAccount.sol";

/// @title SpendPolicyFactory — deploys disposable, policy-bound payer accounts
/// @notice One deployment; each payment/subscription/agent-grant clones a fresh
///         `SpendPolicyAccount` at a deterministic address. The payer can predict
///         the address off-chain (to fund it before it exists on-chain).
///
/// @dev Privacy note — the payer's address never appears here. The CREATE2 salt is
///      bound to `ownerHash = keccak256(abi.encode(owner))`, not the owner address,
///      so the deployment calldata and the emitted event carry only the hash. A
///      relayer can submit `createAccount` (it takes no msg.sender-dependent path),
///      so the deployment transaction need not come from the payer either. The only
///      party that can recompute `ownerHash` — and thus find these accounts in the
///      event log — is whoever already knows the owner address.
contract SpendPolicyFactory {
    /// @notice The clone target. Deployed once; every account is a minimal proxy to it.
    address public immutable implementation;

    struct InitParams {
        IERC20 token;
        address cosigner;
        bytes32 vaultHash;
        address target;
        uint256 maxAmount;
        uint256 perPullMax;
        uint40 expiry;
        uint40 interval;
        SpendPolicyAccount.Mode mode;
    }

    /// @dev `ownerHash` is indexed so the payer can enumerate their own accounts by
    ///      filtering on their own hash; it is not reversible to the address.
    event AccountCreated(
        address indexed account, bytes32 indexed ownerHash, address indexed target, uint256 maxAmount, bytes32 salt
    );

    constructor() {
        implementation = address(new SpendPolicyAccount());
    }

    /// @notice Clone and initialize a policy account bound to `ownerHash`.
    /// @param ownerHash keccak256(abi.encode(owner)); binds the deterministic slot
    ///        to the payer without revealing the payer, and stops a griefer from
    ///        front-running the address.
    /// @param userSalt Any payer-chosen value that varies the address per payment.
    function createAccount(bytes32 ownerHash, bytes32 userSalt, InitParams calldata p)
        external
        returns (address account)
    {
        bytes32 salt = _salt(ownerHash, userSalt);
        account = Clones.cloneDeterministic(implementation, salt);
        SpendPolicyAccount(payable(account)).init(
            p.token, p.cosigner, p.vaultHash, p.target, p.maxAmount, p.perPullMax, p.expiry, p.interval, p.mode
        );
        emit AccountCreated(account, ownerHash, p.target, p.maxAmount, userSalt);
    }

    /// @notice The address `createAccount(ownerHash, userSalt, ...)` will occupy.
    ///         Lets the payer fund the ephemeral address before it is deployed.
    function predictAddress(bytes32 ownerHash, bytes32 userSalt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(ownerHash, userSalt), address(this));
    }

    function _salt(bytes32 ownerHash, bytes32 userSalt) private pure returns (bytes32) {
        return keccak256(abi.encode(ownerHash, userSalt));
    }
}
