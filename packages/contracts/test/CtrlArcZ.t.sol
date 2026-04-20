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
    event RecipientVerified(address indexed sender, address indexed recipient, uint256 transferId);
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

    /// Layer 3: the first successful claim promotes the recipient to "verified".
    function test_claim_registersVerifiedRecipient() public {
        assertFalse(arcz.isVerifiedRecipient(sender, recipient));

        uint256 transferId = _send(100 * ONE_USDC);

        vm.expectEmit(true, true, false, true, address(arcz));
        emit RecipientVerified(sender, recipient, transferId);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        assertTrue(arcz.isVerifiedRecipient(sender, recipient), "recipient now verified");
        assertFalse(arcz.isVerifiedRecipient(recipient, sender), "verification is directional");
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

    /// The property the lockout exists for: a 6-digit code is only ~20 bits, so an
    /// attacker sitting on a poisoned recipient address must not be able to grind
    /// it on-chain. After 5 guesses the transfer is frozen, whoever is guessing.
    function test_bruteForce_isCappedAtFiveGuesses_evenAcrossAddresses() public {
        uint256 transferId = _send(5_000 * ONE_USDC);

        address[5] memory attackers = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3"), makeAddr("a4"), makeAddr("a5")];
        for (uint256 i = 0; i < attackers.length; i++) {
            vm.prank(attackers[i]);
            arcz.claim(transferId, "111111", SALT);
        }

        // Sixth guess cannot even be made: the transfer is frozen.
        vm.expectRevert(
            abi.encodeWithSelector(CtrlArcZ.TransferNotPending.selector, transferId, CtrlArcZ.TransferStatus.LOCKED)
        );
        vm.prank(stranger);
        arcz.claim(transferId, "222222", SALT);

        assertEq(usdc.balanceOf(address(arcz)), 5_000 * ONE_USDC, "money never moved");
    }

    /// Once locked, even the correct code is dead — only the sender can recover.
    function test_claim_afterLock_evenCorrectCodeFails() public {
        uint256 amount = 100 * ONE_USDC;
        uint256 transferId = _send(amount);

        for (uint8 i = 1; i <= 5; i++) {
            vm.prank(recipient);
            arcz.claim(transferId, "000000", SALT);
        }

        vm.expectRevert(
            abi.encodeWithSelector(CtrlArcZ.TransferNotPending.selector, transferId, CtrlArcZ.TransferStatus.LOCKED)
        );
        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        // The sender's money is not stranded.
        vm.prank(sender);
        arcz.cancel(transferId);
        assertEq(usdc.balanceOf(address(arcz)), 0, "funds returned");
        assertEq(usdc.balanceOf(recipient), 0);
    }

    /// A locked transfer is still refundable once its window lapses.
    function test_reclaimExpired_worksOnLockedTransfer() public {
        uint256 amount = 100 * ONE_USDC;
        uint256 before = usdc.balanceOf(sender);
        uint256 transferId = _send(amount);

        for (uint8 i = 1; i <= 5; i++) {
            vm.prank(recipient);
            arcz.claim(transferId, "000000", SALT);
        }

        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(stranger);
        arcz.reclaimExpired(transferId);

        assertEq(usdc.balanceOf(sender), before, "sender refunded");
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

    function test_claim_withFee_splitsCorrectly() public {
        bytes32 feeConfig = _configWithFee(100); // 1%, the maximum
        uint256 amount = 5_000 * ONE_USDC;

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(feeConfig, recipient, amount, claimHash);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        uint256 expectedFee = (amount * 100) / 10_000; // 50 USDC
        assertEq(expectedFee, 50 * ONE_USDC);
        assertEq(usdc.balanceOf(feeRecipient), expectedFee, "integrator fee paid");
        assertEq(usdc.balanceOf(recipient), amount - expectedFee, "recipient gets the rest");
        assertEq(usdc.balanceOf(address(arcz)), 0, "nothing left behind");
    }

    /// A fee is only earned on settlement: a cancelled transfer refunds in full.
    function test_cancel_withFeeConfig_refundsFullAmount_noFee() public {
        bytes32 feeConfig = _configWithFee(100);
        uint256 amount = 1_000 * ONE_USDC;
        uint256 before = usdc.balanceOf(sender);

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(feeConfig, recipient, amount, claimHash);

        vm.prank(sender);
        arcz.cancel(transferId);

        assertEq(usdc.balanceOf(sender), before, "no fee on a cancel");
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_createConfig_feeAboveMax_reverts() public {
        vm.expectRevert(CtrlArcZ.FeeTooHigh.selector);
        vm.prank(integrator);
        arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.CODE, 101, feeRecipient);
    }

    /// 6-decimal precision: a 1% fee on the smallest unit rounds down to zero and
    /// the recipient still receives the full micro-amount. Nothing is lost.
    function test_feeRounding_atOneMicroUsdc() public {
        bytes32 feeConfig = _configWithFee(100);

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(feeConfig, recipient, 1, claimHash); // 0.000001 USDC

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        assertEq(usdc.balanceOf(feeRecipient), 0, "fee rounds down");
        assertEq(usdc.balanceOf(recipient), 1, "recipient gets the full unit");
        assertEq(usdc.balanceOf(address(arcz)), 0, "no dust stranded");
    }

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

    /// An integrator can plug in its own verifier without CtrlArcZ changing.
    function test_createConfigWithVerifier_worksWithCustomVerifier() public {
        CodeClaimVerifier custom = new CodeClaimVerifier();

        vm.prank(integrator);
        bytes32 customConfig = arcz.createConfigWithVerifier(WINDOW, IClaimVerifier(address(custom)), 0, address(0));

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(customConfig, recipient, 10 * ONE_USDC, claimHash);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);
        assertEq(usdc.balanceOf(recipient), 10 * ONE_USDC);
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

    function test_createConfig_feeWithoutRecipient_reverts() public {
        vm.expectRevert(CtrlArcZ.FeeRecipientRequired.selector);
        vm.prank(integrator);
        arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.CODE, 50, address(0));
    }

    function test_createConfigWithVerifier_zeroVerifier_reverts() public {
        vm.expectRevert(CtrlArcZ.ZeroAddress.selector);
        vm.prank(integrator);
        arcz.createConfigWithVerifier(WINDOW, IClaimVerifier(address(0)), 0, address(0));
    }

    function test_constructor_zeroUsdc_reverts() public {
        vm.expectRevert(CtrlArcZ.ZeroAddress.selector);
        new CtrlArcZ(IERC20(address(0)), IClaimVerifier(address(verifier)), IPermit2(address(permit2)));
    }

    function test_constructor_zeroVerifier_reverts() public {
        vm.expectRevert(CtrlArcZ.ZeroAddress.selector);
        new CtrlArcZ(IERC20(address(usdc)), IClaimVerifier(address(0)), IPermit2(address(permit2)));
    }

    /// A zero window means the transfer is refundable immediately — allowed, but it
    /// leaves no room to claim in a later block. Integrators pick a real window.
    function test_zeroWindow_isAllowed_andExpiresImmediately() public {
        vm.prank(integrator);
        bytes32 cfg = arcz.createConfig(0, CtrlArcZ.ClaimMode.CODE, 0, address(0));

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(cfg, recipient, ONE_USDC, claimHash);
        assertEq(arcz.getTransfer(transferId).deadline, uint40(block.timestamp));

        vm.warp(block.timestamp + 1);
        assertFalse(arcz.isClaimable(transferId));

        arcz.reclaimExpired(transferId);
        assertEq(uint8(arcz.getTransfer(transferId).status), uint8(CtrlArcZ.TransferStatus.RECLAIMED));
    }

    function test_attemptsRemaining_isZeroOnceSettled() public {
        uint256 transferId = _send(ONE_USDC);
        assertEq(arcz.attemptsRemaining(transferId), 5);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        assertEq(arcz.attemptsRemaining(transferId), 0, "no attempts left on a settled transfer");
    }

    function test_hashCode_matchesTheCommitmentFormat() public view {
        assertEq(verifier.hashCode(SALT, CODE), claimHash, "SDK and contract derive the same hash");
    }

    /// The contract accepts native value: on Arc a USDC ERC-20 transfer moves the
    /// account's native balance, so a USDC-holding contract holds native value.
    function test_receive_acceptsNativeValue() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(arcz).call{value: 1 ether}("");
        assertTrue(ok, "contract must be able to hold native value");
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

    function testFuzz_sendAndClaim_conservesValue(uint96 amount, uint32 window) public {
        amount = uint96(bound(amount, 1, 10_000 * ONE_USDC));
        window = uint32(bound(window, 1, arcz.MAX_RECALL_WINDOW()));

        vm.prank(integrator);
        bytes32 cfg = arcz.createConfig(window, CtrlArcZ.ClaimMode.CODE, 0, address(0));

        uint256 senderBefore = usdc.balanceOf(sender);

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(cfg, recipient, amount, claimHash);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(sender), senderBefore - amount);
        assertEq(usdc.balanceOf(address(arcz)), 0, "contract never keeps a remainder");
    }

    function testFuzz_feeSplitNeverLosesValue(uint96 amount, uint16 feeBps) public {
        amount = uint96(bound(amount, 1, 10_000 * ONE_USDC));
        feeBps = uint16(bound(feeBps, 0, arcz.MAX_FEE_BPS()));

        vm.prank(integrator);
        bytes32 cfg = arcz.createConfig(WINDOW, CtrlArcZ.ClaimMode.CODE, feeBps, feeRecipient);

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(cfg, recipient, amount, claimHash);

        vm.prank(recipient);
        arcz.claim(transferId, CODE, SALT);

        // Every unit is accounted for: recipient + fee == amount, nothing stuck.
        assertEq(usdc.balanceOf(recipient) + usdc.balanceOf(feeRecipient), amount);
        assertEq(usdc.balanceOf(address(arcz)), 0);
    }

    function testFuzz_cancelAlwaysRefundsExactly(uint96 amount) public {
        amount = uint96(bound(amount, 1, 10_000 * ONE_USDC));
        uint256 before = usdc.balanceOf(sender);

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(configId, recipient, amount, claimHash);

        vm.prank(sender);
        arcz.cancel(transferId);

        assertEq(usdc.balanceOf(sender), before, "refund is exact, no fee, no dust");
    }

    /// A wrong code never releases funds, whatever the guess.
    function testFuzz_wrongCodeNeverPays(string calldata guess) public {
        vm.assume(keccak256(abi.encodePacked(SALT, guess)) != claimHash);

        uint256 transferId = _send(100 * ONE_USDC);

        vm.prank(recipient);
        bool ok = arcz.claim(transferId, guess, SALT);

        assertFalse(ok, "a wrong proof never reports success");
        assertEq(usdc.balanceOf(recipient), 0, "no payout without the real proof");
        assertEq(usdc.balanceOf(address(arcz)), 100 * ONE_USDC, "funds stay locked");
    }

    /// Any salt/code pair that hashes to the commitment releases the funds — and it
    /// can only ever pay the recorded recipient. Confirms the verifier is the only
    /// gate and that the payout target is not attacker-controllable.
    function testFuzz_anyValidProofPaysOnlyTheRecipient(bytes32 salt, string calldata code, address caller) public {
        vm.assume(caller != address(0) && caller != address(arcz));
        bytes32 h = keccak256(abi.encodePacked(salt, code));
        vm.assume(h != bytes32(0));

        vm.prank(sender);
        uint256 transferId = arcz.sendProtected(configId, recipient, 100 * ONE_USDC, h);

        vm.prank(caller);
        bool ok = arcz.claim(transferId, code, salt);

        assertTrue(ok);
        assertEq(usdc.balanceOf(recipient), 100 * ONE_USDC, "always the recorded recipient");
    }
}
