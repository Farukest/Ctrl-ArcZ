// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CtrlArcZ} from "../src/CtrlArcZ.sol";
import {CodeClaimVerifier} from "../src/verifiers/CodeClaimVerifier.sol";
import {IClaimVerifier} from "../src/interfaces/IClaimVerifier.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CtrlArcZTest is Test {
    CtrlArcZ internal arcz;
    CodeClaimVerifier internal verifier;
    MockUSDC internal usdc;

    address internal integrator = makeAddr("integrator");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal sender = makeAddr("sender");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    /// 1 USDC = 1e6 (6 decimals), as on Arc.
    uint256 internal constant ONE_USDC = 1e6;

    uint32 internal constant WINDOW = 1 hours;
    string internal constant CODE = "492817";
    bytes32 internal constant SALT = keccak256("salt-for-tests");

    bytes32 internal configId;
    bytes32 internal claimHash;

    event TransferCreated(
        uint256 indexed transferId,
        address indexed sender,
        address indexed to,
        uint256 amount,
        bytes32 configId,
        uint64 deadline,
        bytes32 claimHash
    );
    event TransferClaimed(
        uint256 indexed transferId, address indexed to, address caller, uint256 amountToRecipient, uint256 fee
    );
    event TransferCancelled(uint256 indexed transferId, address indexed sender, uint256 amount);
    event TransferReclaimed(uint256 indexed transferId, address indexed sender, address caller, uint256 amount);
    event TransferLocked(uint256 indexed transferId);

    function setUp() public {
        usdc = new MockUSDC();
        verifier = new CodeClaimVerifier();
        arcz = new CtrlArcZ(IERC20(address(usdc)), IClaimVerifier(address(verifier)));

        vm.prank(integrator);
        configId = arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.CODE, 0, address(0));

        claimHash = keccak256(abi.encodePacked(SALT, CODE));

        usdc.mint(sender, 10_000 * ONE_USDC);
        vm.prank(sender);
        usdc.approve(address(arcz), type(uint256).max);
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _send(uint256 amount) internal returns (uint256 transferId) {
        vm.prank(sender);
        return arcz.sendProtected(configId, recipient, amount, claimHash);
    }

    function _configWithFee(uint16 feeBps) internal returns (bytes32) {
        vm.prank(integrator);
        return arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.CODE, feeBps, feeRecipient);
    }

    // -----------------------------------------------------------------
    // happy path
    // -----------------------------------------------------------------

    function test_sendProtected_locksFundsInContract() public {
        uint256 amount = 5_000 * ONE_USDC;
        uint256 senderBefore = usdc.balanceOf(sender);

        uint256 transferId = _send(amount);

        assertEq(transferId, 1, "ids start at 1");
        assertEq(usdc.balanceOf(address(arcz)), amount, "contract holds the funds");
        assertEq(usdc.balanceOf(sender), senderBefore - amount, "sender debited");
        assertEq(usdc.balanceOf(recipient), 0, "recipient not paid before claim");

        CtrlArcZ.ProtectedTransfer memory t = arcz.getTransfer(transferId);
        assertEq(t.sender, sender);
        assertEq(t.to, recipient);
        assertEq(t.amount, amount);
        assertEq(uint8(t.status), uint8(CtrlArcZ.TransferStatus.PENDING));
        assertEq(t.deadline, uint40(block.timestamp + WINDOW));
        assertTrue(arcz.isClaimable(transferId));
    }

    function test_sendProtected_emitsCreatedWithClaimHash() public {
        uint256 amount = 5_000 * ONE_USDC;

        vm.expectEmit(true, true, true, true, address(arcz));
        emit TransferCreated(1, sender, recipient, amount, configId, uint64(block.timestamp + WINDOW), claimHash);

        _send(amount);
    }

    /// The headline scene: 5,000 USDC sent in one go, released by the code.
    function test_claim_withCorrectCode_paysRecipient() public {
        uint256 amount = 5_000 * ONE_USDC;
        uint256 transferId = _send(amount);

        vm.expectEmit(true, true, false, true, address(arcz));
        emit TransferClaimed(transferId, recipient, recipient, amount, 0);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        assertEq(usdc.balanceOf(recipient), amount, "recipient paid in full");
        assertEq(usdc.balanceOf(address(arcz)), 0, "contract empty");
        assertEq(uint8(arcz.getTransfer(transferId).status), uint8(CtrlArcZ.TransferStatus.CLAIMED));
        assertFalse(arcz.isClaimable(transferId));
    }

    /// Anyone may submit the proof, but the money can only go to `to`.
    /// This is what makes a claim front-run-safe, and lets a relayer settle for a
    /// recipient who holds no USDC for gas yet.
    function test_claim_bySomeoneElse_stillPaysTheRecipient() public {
        uint256 amount = 250 * ONE_USDC;
        uint256 transferId = _send(amount);

        vm.prank(stranger);
        arcz.claim(transferId, CODE, SALT);

        assertEq(usdc.balanceOf(recipient), amount, "funds went to the recorded recipient");
        assertEq(usdc.balanceOf(stranger), 0, "the submitter gets nothing");
    }

    // -----------------------------------------------------------------
    // wrong code / lockout
    // -----------------------------------------------------------------

    /// A wrong code must NOT revert — a revert would roll back the attempt counter
    /// and the lockout could never bind. It returns false and burns an attempt.
    function test_claim_wrongCode_returnsFalseAndCountsAttempt() public {
        uint256 transferId = _send(100 * ONE_USDC);

        vm.prank(recipient);
        bool ok = arcz.claim(transferId, "000000", SALT);

        assertFalse(ok, "claim reports failure");
        assertEq(arcz.attemptsRemaining(transferId), 4, "the attempt persisted");
        assertEq(usdc.balanceOf(recipient), 0, "no payout");
        assertEq(usdc.balanceOf(address(arcz)), 100 * ONE_USDC, "funds still locked");
    }

    /// The right code with the wrong salt must fail: the salt carries the entropy.
    function test_claim_correctCodeWrongSalt_fails() public {
        uint256 transferId = _send(100 * ONE_USDC);

        vm.prank(recipient);
        bool ok = arcz.claim(transferId, CODE, keccak256("wrong-salt"));

        assertFalse(ok);
        assertEq(usdc.balanceOf(recipient), 0);
    }

    function test_claim_fiveWrongCodes_locksTransfer() public {
        uint256 amount = 100 * ONE_USDC;
        uint256 transferId = _send(amount);

        for (uint8 i = 1; i <= 4; i++) {
            vm.prank(recipient);
            arcz.claim(transferId, "000000", SALT);
            assertEq(arcz.attemptsRemaining(transferId), 5 - i, "each guess costs an attempt");
        }

        vm.expectEmit(true, false, false, false, address(arcz));
        emit TransferLocked(transferId);
        vm.prank(recipient);
        arcz.claim(transferId, "000000", SALT);

        CtrlArcZ.ProtectedTransfer memory t = arcz.getTransfer(transferId);
        assertEq(uint8(t.status), uint8(CtrlArcZ.TransferStatus.LOCKED));
        assertEq(t.attempts, 5);
        assertFalse(arcz.isClaimable(transferId));
    }

    // -----------------------------------------------------------------
    // cancel
    // -----------------------------------------------------------------

    function test_cancel_bySender_refundsInFull() public {
        uint256 amount = 5_000 * ONE_USDC;
        uint256 before = usdc.balanceOf(sender);
        uint256 transferId = _send(amount);

        vm.expectEmit(true, true, false, true, address(arcz));
        emit TransferCancelled(transferId, sender, amount);

        vm.prank(sender);
        arcz.cancel(transferId);

        assertEq(usdc.balanceOf(sender), before, "sender made whole");
        assertEq(usdc.balanceOf(address(arcz)), 0);
        assertEq(uint8(arcz.getTransfer(transferId).status), uint8(CtrlArcZ.TransferStatus.CANCELLED));
    }

    function test_cancel_byNonSender_reverts() public {
        uint256 transferId = _send(100 * ONE_USDC);

        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.NotSender.selector, recipient, sender));
        vm.prank(recipient);
        arcz.cancel(transferId);
    }

    /// Unclaimed money belongs to the sender — the window does not take that away.
    function test_cancel_afterWindowExpired_stillWorks() public {
        uint256 amount = 100 * ONE_USDC;
        uint256 before = usdc.balanceOf(sender);
        uint256 transferId = _send(amount);

        vm.warp(block.timestamp + WINDOW + 1);

        vm.prank(sender);
        arcz.cancel(transferId);
        assertEq(usdc.balanceOf(sender), before);
    }

    function test_claim_afterCancel_reverts() public {
        uint256 transferId = _send(100 * ONE_USDC);

        vm.prank(sender);
        arcz.cancel(transferId);

        vm.expectRevert(
            abi.encodeWithSelector(CtrlArcZ.TransferNotPending.selector, transferId, CtrlArcZ.TransferStatus.CANCELLED)
        );
        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);
    }

    function test_cancel_afterClaim_reverts() public {
        uint256 transferId = _send(100 * ONE_USDC);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        vm.expectRevert(
            abi.encodeWithSelector(CtrlArcZ.TransferNotPending.selector, transferId, CtrlArcZ.TransferStatus.CLAIMED)
        );
        vm.prank(sender);
        arcz.cancel(transferId);
    }

    function test_doubleClaim_reverts() public {
        uint256 transferId = _send(100 * ONE_USDC);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        vm.expectRevert(
            abi.encodeWithSelector(CtrlArcZ.TransferNotPending.selector, transferId, CtrlArcZ.TransferStatus.CLAIMED)
        );
        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        assertEq(usdc.balanceOf(recipient), 100 * ONE_USDC, "paid exactly once");
    }

    // -----------------------------------------------------------------
    // expiry / automatic refund
    // -----------------------------------------------------------------

    function test_reclaimExpired_returnsFundsToSender_calledByAnyone() public {
        uint256 amount = 400 * ONE_USDC;
        uint256 before = usdc.balanceOf(sender);
        uint256 transferId = _send(amount);

        vm.warp(block.timestamp + WINDOW + 1);

        vm.expectEmit(true, true, false, true, address(arcz));
        emit TransferReclaimed(transferId, sender, stranger, amount);

        vm.prank(stranger); // no keeper needed; anyone can trigger the refund
        arcz.reclaimExpired(transferId);

        assertEq(usdc.balanceOf(sender), before, "sender refunded");
        assertEq(usdc.balanceOf(stranger), 0, "caller earns nothing");
        assertEq(uint8(arcz.getTransfer(transferId).status), uint8(CtrlArcZ.TransferStatus.RECLAIMED));
    }

    function test_reclaimExpired_beforeDeadline_reverts() public {
        uint256 transferId = _send(100 * ONE_USDC);
        uint40 deadline = arcz.getTransfer(transferId).deadline;

        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.TransferNotExpired.selector, transferId, deadline));
        arcz.reclaimExpired(transferId);
    }

    function test_claim_afterDeadline_reverts() public {
        uint256 transferId = _send(100 * ONE_USDC);
        uint40 deadline = arcz.getTransfer(transferId).deadline;

        vm.warp(uint256(deadline) + 1);

        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.TransferExpired.selector, transferId, deadline));
        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);
    }

    /// Arc's block timestamps are non-decreasing, not strictly increasing, so a
    /// claim landing exactly on the deadline second must still succeed.
    function test_claim_exactlyOnDeadline_succeeds() public {
        uint256 transferId = _send(100 * ONE_USDC);
        uint40 deadline = arcz.getTransfer(transferId).deadline;

        vm.warp(deadline);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);
        assertEq(usdc.balanceOf(recipient), 100 * ONE_USDC);
    }

    function test_reclaimExpired_afterClaim_reverts() public {
        uint256 transferId = _send(100 * ONE_USDC);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        vm.warp(block.timestamp + WINDOW + 1);

        vm.expectRevert(
            abi.encodeWithSelector(CtrlArcZ.TransferNotPending.selector, transferId, CtrlArcZ.TransferStatus.CLAIMED)
        );
        arcz.reclaimExpired(transferId);
    }

    // -----------------------------------------------------------------
    // fees
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // config
    // -----------------------------------------------------------------

    function test_createConfig_isIdempotent() public {
        vm.prank(integrator);
        bytes32 again = arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.CODE, 0, address(0));
        assertEq(again, configId, "same parameters, same id");
    }

    function test_createConfig_differentIntegrators_differentIds() public {
        vm.prank(stranger);
        bytes32 other = arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.CODE, 0, address(0));
        assertTrue(other != configId, "config is scoped to its integrator");
    }

    function test_createConfig_unsupportedMode_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.ClaimModeNotSupported.selector, CtrlArcZ.ClaimMode.SIGNATURE));
        vm.prank(integrator);
        arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.SIGNATURE, 0, address(0));

        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.ClaimModeNotSupported.selector, CtrlArcZ.ClaimMode.REGISTERED));
        vm.prank(integrator);
        arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.REGISTERED, 0, address(0));
    }

    function test_createConfig_windowTooLong_reverts() public {
        vm.expectRevert(CtrlArcZ.RecallWindowTooLong.selector);
        vm.prank(integrator);
        arcz.createConfig(7 days + 1, CtrlArcZ.ClaimMode.CODE, 0, address(0));
    }

    function test_sendProtected_unknownConfig_reverts() public {
        bytes32 bogus = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.UnknownConfig.selector, bogus));
        vm.prank(sender);
        arcz.sendProtected(bogus, recipient, ONE_USDC, claimHash);
    }

    // -----------------------------------------------------------------
    // input guards
    // -----------------------------------------------------------------

    function test_sendProtected_zeroAmount_reverts() public {
        vm.expectRevert(CtrlArcZ.ZeroAmount.selector);
        vm.prank(sender);
        arcz.sendProtected(configId, recipient, 0, claimHash);
    }

    function test_sendProtected_zeroRecipient_reverts() public {
        vm.expectRevert(CtrlArcZ.ZeroAddress.selector);
        vm.prank(sender);
        arcz.sendProtected(configId, address(0), ONE_USDC, claimHash);
    }

    function test_sendProtected_toSelf_reverts() public {
        vm.expectRevert(CtrlArcZ.SelfTransfer.selector);
        vm.prank(sender);
        arcz.sendProtected(configId, sender, ONE_USDC, claimHash);
    }

    function test_sendProtected_emptyClaimHash_reverts() public {
        vm.expectRevert(CtrlArcZ.EmptyClaimHash.selector);
        vm.prank(sender);
        arcz.sendProtected(configId, recipient, ONE_USDC, bytes32(0));
    }

    function test_getTransfer_unknownId_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.UnknownTransfer.selector, 999));
        arcz.getTransfer(999);
    }

    function test_cancel_unknownId_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.UnknownTransfer.selector, 999));
        vm.prank(sender);
        arcz.cancel(999);
    }

    function test_reclaimExpired_unknownId_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.UnknownTransfer.selector, 999));
        arcz.reclaimExpired(999);
    }

    function test_claim_unknownId_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(CtrlArcZ.UnknownTransfer.selector, 999));
        vm.prank(recipient);
        arcz.claim(999, CODE, SALT);
    }

    function test_sendProtected_amountAboveUint96_reverts() public {
        uint256 tooBig = uint256(type(uint96).max) + 1;
        vm.expectRevert(CtrlArcZ.AmountTooLarge.selector);
        vm.prank(sender);
        arcz.sendProtected(configId, recipient, tooBig, claimHash);
    }

    // -----------------------------------------------------------------
    // isolation between transfers
    // -----------------------------------------------------------------

    function test_transfersAreIndependent() public {
        uint256 first = _send(100 * ONE_USDC);
        uint256 second = _send(200 * ONE_USDC);
        assertEq(second, first + 1);

        vm.prank(recipient);
        arcz.claim(second, CODE, SALT);

        assertEq(usdc.balanceOf(recipient), 200 * ONE_USDC);
        assertEq(usdc.balanceOf(address(arcz)), 100 * ONE_USDC, "the first is untouched");
        assertTrue(arcz.isClaimable(first));

        vm.prank(sender);
        arcz.cancel(first);
        assertEq(usdc.balanceOf(address(arcz)), 0);
    }

    // -----------------------------------------------------------------
    // Permit2 send path
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // fuzz
    // -----------------------------------------------------------------
}
