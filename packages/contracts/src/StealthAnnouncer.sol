// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StealthAnnouncer — ERC-5564-style announcement registry
/// @notice A standalone log of stealth-address announcements. When a spend box is
///         created for a payer's stealth meta-address, whoever creates it emits the
///         ephemeral public key here so the payer can later scan with their viewing
///         key, recognise their own boxes, and derive the key that controls them.
///
/// @dev Deliberately trivial and self-contained: it only emits an event, holds no
///      state and no funds, and is entirely separate from the SpendPolicyFactory.
///      That means adding stealth discovery needs NO change to the deployed factory
///      or accounts. `caller` is recorded so a relayer submission is visible as such;
///      it carries no payer identity. Following ERC-5564, schemeId 1 == secp256k1.
contract StealthAnnouncer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    /// @param schemeId The stealth scheme (1 = secp256k1, per ERC-5564).
    /// @param stealthAddress The fresh address the box is owned/vaulted by.
    /// @param ephemeralPubKey The compressed ephemeral public key (33 bytes) the
    ///        payer needs to recompute the shared secret while scanning.
    /// @param metadata Opaque to this contract; Ctrl+ArcZ puts the box address (and a
    ///        view-tag byte) here so a matched announcement points straight at the box.
    function announce(
        uint256 schemeId,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata metadata
    ) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
