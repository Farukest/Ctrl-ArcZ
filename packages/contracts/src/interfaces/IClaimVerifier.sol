// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IClaimVerifier
/// @notice Pluggable claim authorisation for Ctrl+ArcZ protected transfers.
/// @dev A verifier answers exactly one question: "does this proof authorise the
///      release of this transfer?" It never moves funds and never learns the
///      recipient — CtrlArcZ always pays the `to` recorded at send time, whoever
///      submits the claim. That keeps a claim front-run-safe: a third party who
///      observes a valid proof in the mempool can only settle the transfer for
///      its intended recipient, never redirect it.
///
///      New claim modes (signature, registered-recipient, and the confidential
///      amount mode that Arc's opt-in privacy feature will enable) plug in here
///      without changing CtrlArcZ itself: an integrator deploys a verifier and
///      passes it to `createConfigWithVerifier`.
interface IClaimVerifier {
    /// @param transferId The transfer being claimed.
    /// @param claimHash  The commitment stored at send time.
    /// @param claimer    `msg.sender` of the claim call. Informational: a verifier
    ///                   may bind a claim to a caller, but it need not.
    /// @param proof      Mode-specific payload. For `CodeClaimVerifier` this is
    ///                   `abi.encode(bytes32 salt, string code)`.
    /// @return ok True when the proof authorises release.
    function verify(uint256 transferId, bytes32 claimHash, address claimer, bytes calldata proof)
        external
        view
        returns (bool ok);
}
