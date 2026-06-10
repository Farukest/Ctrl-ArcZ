// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Permit2 stand-in for Foundry unit tests.
/// @dev Foundry runs a stock EVM, so the real Permit2 predeploy is not present.
///      This mock skips EIP-712 signature verification and simply pulls tokens
///      via a normal `transferFrom` (so the owner must have approved this mock).
///      It verifies that CtrlArcZ calls Permit2 with the correct arguments and
///      records the transfer; the REAL signature path is exercised against Arc's
///      actual Permit2 in the SDK integration test.
///
///      For a negative test it can be told to reject: `setReject(true)` makes
///      `permitTransferFrom` revert, standing in for a bad/expired signature.
contract MockPermit2 is IPermit2 {
    error MockPermitRejected();

    bool public reject;

    /// Records the last call so tests can assert the arguments CtrlArcZ passed.
    address public lastToken;
    uint256 public lastAmount;
    address public lastTo;
    address public lastOwner;
    uint256 public lastNonce;

    function setReject(bool value) external {
        reject = value;
    }

    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata /* signature */
    ) external {
        if (reject) revert MockPermitRejected();

        lastToken = permit.permitted.token;
        lastAmount = permit.permitted.amount;
        lastTo = transferDetails.to;
        lastOwner = owner;
        lastNonce = permit.nonce;

        IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }
}
