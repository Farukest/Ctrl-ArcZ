// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IClaimVerifier} from "../interfaces/IClaimVerifier.sol";

/// @title CodeClaimVerifier
/// @notice ClaimMode.CODE: the recipient releases the funds by proving knowledge
///         of `keccak256(abi.encodePacked(salt, code))`.
///
/// @dev SECURITY — why the salt carries the entropy, not the code.
///
///      The human-facing secret is a 6-digit code, which is only ~20 bits: a
///      million guesses. If the salt were public, anyone watching the chain could
///      brute-force the code offline in milliseconds and call `claim`. That would
///      defeat the entire point, because in an address-poisoning attack the
///      recipient recorded on-chain IS the attacker — a claim they trigger pays
///      them.
///
///      So the salt is a 32-byte secret, generated per transfer by the SDK and
///      handed to the recipient out-of-band (claim link / QR) alongside the
///      spoken code. The preimage therefore has 256 bits of entropy and cannot be
///      brute-forced offline. CtrlArcZ never emits the salt; only `claimHash`
///      goes on-chain.
///
///      The 5-attempt lockout in CtrlArcZ is the second line of defence: it caps
///      an ON-CHAIN guessing attack at 5 tries in 1,000,000 even if a salt leaks.
contract CodeClaimVerifier is IClaimVerifier {
    /// @inheritdoc IClaimVerifier
    /// @param proof `abi.encode(bytes32 salt, string code)`
    function verify(
        uint256,
        /* transferId */
        bytes32 claimHash,
        address,
        /* claimer */
        bytes calldata proof
    )
        external
        pure
        returns (bool ok)
    {
        (bytes32 salt, string memory code) = abi.decode(proof, (bytes32, string));
        return keccak256(abi.encodePacked(salt, code)) == claimHash;
    }

    /// @notice Helper so integrators and tests derive the commitment the same way.
    function hashCode(bytes32 salt, string calldata code) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt, code));
    }
}
