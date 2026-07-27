// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IClaimVerifier} from "../interfaces/IClaimVerifier.sol";

/// @title CodeClaimVerifier
/// @notice ClaimMode.CODE: the recipient releases the funds by proving knowledge
///         of `keccak256(abi.encodePacked(salt, code))`.
///
/// @dev SECURITY — the preimage must survive an OFFLINE brute force.
///
///      In an address-poisoning attack the recipient recorded on-chain IS the
///      attacker: a claim they trigger pays them. They hold `claimHash` and can
///      grind it for as long as they like, so the preimage cannot be small. A
///      6-digit code is ~20 bits, a million guesses, milliseconds of work.
///
///      The SDK therefore mints ONE 80-bit secret (16 Crockford base32 characters,
///      grouped as A4K7-9QMX-2PR6-TH8D) and derives the salt from it, so the whole
///      proof is a single string a person carries. This contract puts no constraint
///      on the format; it only checks the hash.
///
///      Why one string and not two halves: any channel that delivers a second half
///      BY ADDRESS (on-chain ciphertext, a backend, a push) delivers it to the
///      attacker too, because the address is theirs. The secret has to reach a
///      human through a channel the attacker is not in.
///
///      The 5-attempt lockout in CtrlArcZ is the second line of defence, capping
///      an ON-CHAIN guessing attack regardless of the preimage size.
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
