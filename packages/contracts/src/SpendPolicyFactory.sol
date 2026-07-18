// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendPolicyAccount} from "./SpendPolicyAccount.sol";

/// @title SpendPolicyFactory — deploys disposable, policy-bound payer accounts
/// @notice One deployment; each payment/subscription/agent-grant clones a fresh
///         `SpendPolicyAccount` at a deterministic address. The owner can predict
///         the address off-chain (to fund it before it exists on-chain), and the
///         salt is bound to the owner so a griefer cannot front-run the address.
contract SpendPolicyFactory {
    /// @notice The clone target. Deployed once; every account is a minimal proxy to it.
    address public immutable implementation;

    struct InitParams {
        IERC20 token;
        address owner;
        address cosigner;
        address vault;
        address target;
        uint256 maxAmount;
        uint40 expiry;
        uint40 interval;
        SpendPolicyAccount.Mode mode;
    }

    event AccountCreated(
        address indexed account, address indexed owner, address indexed target, uint256 maxAmount, bytes32 salt
    );

    constructor() {
        implementation = address(new SpendPolicyAccount());
    }

    /// @notice Clone and initialize a policy account for `p.owner`.
    /// @param userSalt Any owner-chosen value; the real CREATE2 salt is bound to
    ///        the owner so only accounts for this owner can ever land at this
    ///        address (no front-run/grief on the deterministic slot).
    function createAccount(bytes32 userSalt, InitParams calldata p) external returns (address account) {
        bytes32 salt = _salt(p.owner, userSalt);
        account = Clones.cloneDeterministic(implementation, salt);
        SpendPolicyAccount(payable(account)).init(
            p.token, p.owner, p.cosigner, p.vault, p.target, p.maxAmount, p.expiry, p.interval, p.mode
        );
        emit AccountCreated(account, p.owner, p.target, p.maxAmount, userSalt);
    }

    /// @notice The address `createAccount(userSalt, {owner, ...})` will occupy.
    ///         Lets the owner fund the ephemeral address before it is deployed.
    function predictAddress(address owner, bytes32 userSalt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(owner, userSalt), address(this));
    }

    function _salt(address owner, bytes32 userSalt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, userSalt));
    }
}
