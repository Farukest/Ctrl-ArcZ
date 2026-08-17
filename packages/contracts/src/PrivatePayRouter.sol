// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SpendPolicyAccount} from "./SpendPolicyAccount.sol";
import {SpendPolicyFactory} from "./SpendPolicyFactory.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";

/// @title PrivatePayRouter — one-off Private Pay in a single transaction, on any chain
///
/// @notice Creates the policy box, moves the payer's tokens into it, and pays the
///         merchant from it. One transaction, one wallet confirmation.
///
/// @dev Why this exists.
///
///      A one-off Private Pay is three steps that have to be one transaction: the
///      box is created at a CREATE2 address, funded, and paid from. The co-signer
///      authorises the box's counterfactual address, so it cannot be split across
///      transactions without the payer approving each one.
///
///      The hard step is funding. A `transfer` batched through a generic
///      multicall moves the *multicall's* balance, because it is the `msg.sender`
///      of the inner call. Arc gets around this with `Multicall3From`, backed by
///      its `CallFrom` precompile, which preserves the original sender. No other
///      chain has that precompile, and standard Multicall3 is not a substitute:
///      routing a `transfer` through it moves its own tokens, and giving it an
///      allowance instead would be catastrophic, since anyone may call it with any
///      calldata and would then be able to drain every wallet that had approved it.
///
///      So the pull happens here, through Permit2, which is the pattern
///      `CtrlArcZ.sendProtected` already uses in this repo. The payer's one-time
///      prerequisite is `token.approve(PERMIT2, ...)`; after that each payment is an
///      off-chain signature for an exact amount with a deadline, and this contract
///      never holds a standing allowance of its own.
///
///      Nothing here is Arc-specific, and nothing here is Base-specific.
///
/// @dev Why the payer must be the sender.
///
///      `permitTransferFrom` binds the signature to `msg.sender` as the spender, so
///      only this contract can consume it. It does not bind *what* this contract
///      does with it: the destination lives in `transferDetails`, which the caller
///      chooses. If anyone could call this with someone else's permit signature,
///      they could name their own policy, whose `target` is their own address, and
///      the signed tokens would land in a box that pays them.
///
///      Requiring the caller to be the permit's owner removes that entirely, and
///      removes it structurally rather than by a check that has to stay correct:
///      the owner is not a parameter, it is `msg.sender`.
///
///      The cost is that a relayer cannot submit this on the payer's behalf. Making
///      that safe needs `permitWitnessTransferFrom`, with the policy hashed into the
///      signed struct, so the signature commits to the box it is funding. That is a
///      strictly larger surface and it is not needed while the payer is the one
///      paying gas, so it is deliberately not built yet.
contract PrivatePayRouter {
    /// @notice Uniswap's Permit2, at its canonical address on every chain that has it.
    IPermit2 public immutable PERMIT2;

    error NothingToPay();
    error BoxAlreadyExists();

    constructor(IPermit2 permit2) {
        if (address(permit2) == address(0)) revert ZeroAddress();
        PERMIT2 = permit2;
    }

    error ZeroAddress();

    /// @notice Create the box, fund it from the caller, and pay the merchant.
    ///
    /// @param factory   The `SpendPolicyFactory` on this chain.
    /// @param ownerHash `keccak256(abi.encode(owner))`. The payer's address never
    ///                  appears on chain; this is what the CREATE2 salt binds to.
    /// @param userSalt  Varies the address per payment.
    /// @param p         The full policy. The address commits to it, so a substituted
    ///                  target or co-signer produces a different box.
    /// @param amount    Funded and paid. For a one-off these are the same number.
    /// @param cosignerSig The co-signer's authorisation for the counterfactual box.
    /// @param permit    The payer's Permit2 permission: token, amount, nonce, deadline.
    /// @param permitSig EIP-712 signature over `permit`, bound to this contract.
    ///
    /// @return account The box that was created and paid from.
    function createFundAndPay(
        SpendPolicyFactory factory,
        bytes32 ownerHash,
        bytes32 userSalt,
        SpendPolicyFactory.InitParams calldata p,
        uint256 amount,
        bytes calldata cosignerSig,
        IPermit2.PermitTransferFrom calldata permit,
        bytes calldata permitSig
    ) external returns (address account) {
        if (amount == 0) revert NothingToPay();

        // Where the box will be. Read from the factory rather than recomputed here,
        // so this contract cannot drift from the factory's own salt derivation and
        // start funding an address that `createAccount` will not occupy.
        account = factory.predictAddress(ownerHash, userSalt, p);

        // The box must not already exist. It would mean this salt has been used, so
        // its nonce is no longer zero and the co-signer's authorisation -- which is
        // for nonce 0 -- would be refused after the money had already moved. Better
        // to stop before the pull than to leave funds in a box this call cannot pay
        // from.
        if (account.code.length != 0) revert BoxAlreadyExists();

        factory.createAccount(ownerHash, userSalt, p);

        // Straight into the box. This contract is never the recipient, so a failure
        // anywhere after this point reverts the whole transaction rather than
        // stranding tokens here.
        PERMIT2.permitTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails({to: account, requestedAmount: amount}),
            msg.sender,
            permitSig
        );

        // Permissionless by design: `pay` authorises on the co-signer's signature,
        // not on who submits it.
        SpendPolicyAccount(payable(account)).pay(amount, cosignerSig);
    }
}
