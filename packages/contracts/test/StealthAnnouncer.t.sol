// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StealthAnnouncer} from "../src/StealthAnnouncer.sol";

/**
 * The contract holds nothing and does nothing but emit, so what is worth testing is
 * not its behaviour but its shape. Both clients scan this log with a viewing key,
 * and they find a box by matching indexed topics: get the argument order or the
 * indexing wrong and every announcement is still emitted, still costs gas, and is
 * invisible to the payer it was meant for. That failure looks like lost money, and
 * nothing on this contract would revert to warn anyone.
 */
contract StealthAnnouncerTest is Test {
    StealthAnnouncer internal announcer;

    address internal stealthAddress = makeAddr("stealth");
    address internal relayer = makeAddr("relayer");

    /// Declared here rather than imported so a change to the event on the contract
    /// has to be made twice, deliberately, instead of silently agreeing with itself.
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function setUp() public {
        announcer = new StealthAnnouncer();
    }

    function test_announce_emitsEveryFieldAScannerNeeds() public {
        bytes memory ephemeralPubKey = hex"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        bytes memory metadata = hex"aabbccdd";

        // All three topics checked, plus the data. schemeId 1 is secp256k1 per ERC-5564.
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, stealthAddress, relayer, ephemeralPubKey, metadata);

        vm.prank(relayer);
        announcer.announce(1, stealthAddress, ephemeralPubKey, metadata);
    }

    /// The caller is recorded, not the payer. A relayer submitting on someone's
    /// behalf must show up as the relayer, because the whole point of the box is that
    /// the payer's address never appears.
    function test_announce_recordsTheSubmitter_notTheSubject() public {
        vm.expectEmit(true, true, true, true, address(announcer));
        emit Announcement(1, stealthAddress, relayer, hex"01", hex"");

        vm.prank(relayer);
        announcer.announce(1, stealthAddress, hex"01", hex"");
    }

    /// Anyone may announce, and the contract keeps no state, so two announcements for
    /// the same stealth address are both valid log entries rather than a conflict.
    function test_announce_isPermissionless_andHoldsNoState() public {
        vm.prank(relayer);
        announcer.announce(1, stealthAddress, hex"01", hex"");

        vm.prank(makeAddr("someone else"));
        announcer.announce(1, stealthAddress, hex"02", hex"");

        assertEq(address(announcer).balance, 0);
    }
}
