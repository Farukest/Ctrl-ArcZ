// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SpendPolicyAccount} from "../src/SpendPolicyAccount.sol";
import {SpendPolicyFactory} from "../src/SpendPolicyFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SpendPolicyAccountTest is Test {
    MockUSDC usdc;
    SpendPolicyFactory factory;

    address owner;
    uint256 ownerPk;
    address cosigner;
    uint256 cosignerPk;
    address stranger;
    uint256 strangerPk;

    address vault;
    address target; // "merchant"
    bytes32 ownerHash;
    bytes32 vaultHash;

    uint256 constant MAX = 100e6; // 100 USDC
    uint256 constant PER_PULL = 20e6; // 20 USDC per pull
    uint40 expiry;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new SpendPolicyFactory();
        (owner, ownerPk) = makeAddrAndKey("owner");
        (cosigner, cosignerPk) = makeAddrAndKey("cosigner");
        (stranger, strangerPk) = makeAddrAndKey("stranger");
        vault = makeAddr("vault");
        target = makeAddr("merchant");
        ownerHash = keccak256(abi.encode(owner));
        vaultHash = keccak256(abi.encode(vault));
        expiry = uint40(block.timestamp + 1 hours);
    }

    // ---- helpers ----

    function _create(SpendPolicyAccount.Mode mode, uint256 perPullMax, uint40 interval)
        internal
        returns (SpendPolicyAccount acct)
    {
        SpendPolicyFactory.InitParams memory p = SpendPolicyFactory.InitParams({
            token: IERC20(address(usdc)),
            cosigner: cosigner,
            vaultHash: vaultHash,
            target: target,
            maxAmount: MAX,
            perPullMax: perPullMax,
            expiry: expiry,
            interval: interval,
            mode: mode
        });
        address a = factory.createAccount(ownerHash, bytes32(uint256(1)), p);
        acct = SpendPolicyAccount(payable(a));
    }

    function _push() internal returns (SpendPolicyAccount) {
        return _create(SpendPolicyAccount.Mode.PUSH, 0, 0);
    }

    function _fund(SpendPolicyAccount acct, uint256 amount) internal {
        usdc.mint(address(acct), amount);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // Note: this makes an external call (spendDigest). Callers that use
    // vm.expectRevert MUST compute the signature BEFORE arming expectRevert, or the
    // cheat would catch this call instead of the reverting one.
    function _cosign(SpendPolicyAccount acct, uint256 amount, uint8 action) internal view returns (bytes memory) {
        return _sign(cosignerPk, acct.spendDigest(amount, action));
    }

    // ------------------------------------------------------------------
    // init + factory
    // ------------------------------------------------------------------

    function test_factory_deploysAtPredictedAddress_andInitializes() public {
        address predicted = factory.predictAddress(ownerHash, bytes32(uint256(1)));
        SpendPolicyAccount acct = _push();
        assertEq(address(acct), predicted, "predicted != actual");
        assertEq(acct.cosigner(), cosigner);
        assertEq(acct.vaultHash(), vaultHash);
        assertEq(acct.target(), target);
        assertEq(acct.maxAmount(), MAX);
        assertEq(uint256(acct.mode()), uint256(SpendPolicyAccount.Mode.PUSH));
    }

    function test_init_secondCall_reverts() public {
        SpendPolicyAccount acct = _push();
        vm.expectRevert(SpendPolicyAccount.AlreadyInitialized.selector);
        acct.init(
            IERC20(address(usdc)), cosigner, vaultHash, target, MAX, 0, expiry, 0, SpendPolicyAccount.Mode.PUSH
        );
    }

    function test_predict_boundToOwnerHash() public view {
        address a = factory.predictAddress(ownerHash, bytes32(uint256(1)));
        address b = factory.predictAddress(keccak256(abi.encode(stranger)), bytes32(uint256(1)));
        assertTrue(a != b, "same salt different owner must differ");
    }

    // ------------------------------------------------------------------
    // PRIVACY — the account surface leaks no payer identity
    // ------------------------------------------------------------------

    /// The vault is stored only as a commitment: the raw address is not the value,
    /// and it cannot be derived from the hash. (There is no `owner`/`vault` getter
    /// on the account at all — enforced at compile time by this file building
    /// without ever referencing them.)
    function test_privacy_vaultStoredOnlyAsCommitment() public {
        SpendPolicyAccount acct = _push();
        assertEq(acct.vaultHash(), keccak256(abi.encode(vault)));
        assertTrue(acct.vaultHash() != bytes32(uint256(uint160(vault))), "vault must not be stored raw");
    }

    /// Emits an authoritative EIP-712 digest vector so the TS SDK test can assert
    /// its `spendDigest` matches Solidity byte-for-byte. Run with -vv to read it.
    function test_LOG_eip712Vector() public {
        SpendPolicyAccount acct = _push();
        emit log_named_address("account", address(acct));
        emit log_named_address("target", acct.target());
        emit log_named_uint("chainId", block.chainid);
        emit log_named_bytes32("spendDigest(1e6, PAY)", acct.spendDigest(1e6, 0));
        emit log_named_bytes32("domainSeparator", acct.domainSeparator());
    }

    // ------------------------------------------------------------------
    // PUSH pay — co-signer authorized, funds locked to target
    // ------------------------------------------------------------------

    function test_pay_happyPath_movesFundsToTarget() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 50e6);
        acct.pay(50e6, _cosign(acct, 50e6, 0));
        assertEq(usdc.balanceOf(target), 50e6, "target not paid");
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(acct.spent(), 50e6);
        assertEq(acct.nonce(), 1);
    }

    function test_pay_anyoneCanSubmit_fundsStillGoToTarget() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 50e6);
        bytes memory cSig = _cosign(acct, 50e6, 0);
        vm.prank(stranger); // a relayer submits; nothing about the payer is on the tx
        acct.pay(50e6, cSig);
        assertEq(usdc.balanceOf(target), 50e6);
    }

    function test_pay_missingCosigner_isTheVeto() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 50e6);
        // The Machine refuses to sign -> no valid co-signer signature -> no spend.
        bytes memory badSig = _sign(strangerPk, acct.spendDigest(50e6, 0));
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        acct.pay(50e6, badSig);
    }

    function test_pay_overLimit_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 200e6);
        bytes memory cSig = _cosign(acct, MAX + 1, 0);
        vm.expectRevert(SpendPolicyAccount.OverLimit.selector);
        acct.pay(MAX + 1, cSig);
    }

    function test_pay_afterExpiry_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 50e6);
        bytes memory cSig = _cosign(acct, 50e6, 0);
        vm.warp(expiry + 1);
        vm.expectRevert(SpendPolicyAccount.Expired.selector);
        acct.pay(50e6, cSig);
    }

    function test_pay_zeroAmount_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 50e6);
        bytes memory cSig = _cosign(acct, 0, 0);
        vm.expectRevert(SpendPolicyAccount.ZeroAmount.selector);
        acct.pay(0, cSig);
    }

    function test_pay_replaySameSig_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 100e6);
        bytes memory cSig = _cosign(acct, 30e6, 0);
        acct.pay(30e6, cSig);
        // nonce advanced, so the same signature no longer matches the new digest
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        acct.pay(30e6, cSig);
    }

    function test_pay_cumulativeAcrossTwoPays_respectsCap() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 200e6);
        acct.pay(60e6, _cosign(acct, 60e6, 0));
        // 60 + 50 > 100 cap
        bytes memory cSig2 = _cosign(acct, 50e6, 0);
        vm.expectRevert(SpendPolicyAccount.OverLimit.selector);
        acct.pay(50e6, cSig2);
    }

    function test_pay_inPullMode_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, PER_PULL, 1 days);
        _fund(acct, 50e6);
        bytes memory cSig = _cosign(acct, 20e6, 0);
        vm.expectRevert(SpendPolicyAccount.WrongMode.selector);
        acct.pay(20e6, cSig);
    }

    /// A co-signer signature carries the action tag, so a pay authorization can
    /// never be replayed as a pull (defence-in-depth if modes are ever mixed).
    function test_pay_sigWithPullAction_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 50e6);
        // signed for action=PULL(1) but submitted to pay (expects action=PAY(0))
        bytes memory cSig = _cosign(acct, 50e6, 1);
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        acct.pay(50e6, cSig);
    }

    /// The EIP-712 domain binds address(this): a co-signer sig for one account
    /// cannot be replayed on another account with the same parameters.
    function test_pay_sigFromAnotherAccount_reverts() public {
        SpendPolicyAccount a1 = _create(SpendPolicyAccount.Mode.PUSH, 0, 0);
        SpendPolicyFactory.InitParams memory p = SpendPolicyFactory.InitParams({
            token: IERC20(address(usdc)),
            cosigner: cosigner,
            vaultHash: vaultHash,
            target: target,
            maxAmount: MAX,
            perPullMax: 0,
            expiry: expiry,
            interval: 0,
            mode: SpendPolicyAccount.Mode.PUSH
        });
        SpendPolicyAccount a2 = SpendPolicyAccount(payable(factory.createAccount(ownerHash, bytes32(uint256(2)), p)));
        _fund(a2, 50e6);
        // sig built against a1's digest, replayed on a2
        bytes memory sigForA1 = _sign(cosignerPk, a1.spendDigest(50e6, 0));
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        a2.pay(50e6, sigForA1);
    }

    // ------------------------------------------------------------------
    // PULL — co-signer-gated recurring, with a real per-pull cap
    // ------------------------------------------------------------------

    function test_pull_happyPath_cosignerOnly() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, PER_PULL, 1 days);
        _fund(acct, 100e6);
        bytes memory cSig = _cosign(acct, 20e6, 1);
        vm.prank(target); // merchant pulls
        acct.pull(20e6, cSig);
        assertEq(usdc.balanceOf(target), 20e6);
        assertEq(acct.spent(), 20e6);
    }

    function test_pull_badCosigner_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, PER_PULL, 1 days);
        _fund(acct, 100e6);
        bytes memory badSig = _sign(strangerPk, acct.spendDigest(20e6, 1));
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        acct.pull(20e6, badSig);
    }

    /// The core subscription guarantee: even a colluding co-signer cannot drain the
    /// whole cumulative cap in one pull. Without perPullMax this would succeed.
    function test_pull_overPerPullMax_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, PER_PULL, 1 days);
        _fund(acct, 100e6);
        bytes memory cSig = _cosign(acct, PER_PULL + 1, 1);
        vm.expectRevert(SpendPolicyAccount.OverPerPull.selector);
        acct.pull(PER_PULL + 1, cSig);
    }

    function test_pull_atPerPullMax_succeeds() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, PER_PULL, 1 days);
        _fund(acct, 100e6);
        acct.pull(PER_PULL, _cosign(acct, PER_PULL, 1));
        assertEq(acct.spent(), PER_PULL);
    }

    function test_perPullMax_zeroDefaultsToCumulativeCap() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, 0, 1 days);
        assertEq(acct.perPullMax(), MAX);
        _fund(acct, 200e6);
        acct.pull(MAX, _cosign(acct, MAX, 1)); // allowed: no tighter per-pull cap
        assertEq(acct.spent(), MAX);
    }

    function test_pull_tooSoon_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, PER_PULL, 1 days);
        _fund(acct, 100e6);
        acct.pull(20e6, _cosign(acct, 20e6, 1));
        bytes memory cSig2 = _cosign(acct, 20e6, 1);
        vm.expectRevert(SpendPolicyAccount.TooSoon.selector);
        acct.pull(20e6, cSig2);
    }

    function test_pull_afterInterval_succeeds_andCapBinds() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, 60e6, 10 minutes);
        _fund(acct, 100e6);
        acct.pull(60e6, _cosign(acct, 60e6, 1));
        vm.warp(block.timestamp + 10 minutes + 1);
        // 60 + 50 > 100 cap
        bytes memory cSig2 = _cosign(acct, 50e6, 1);
        vm.expectRevert(SpendPolicyAccount.OverLimit.selector);
        acct.pull(50e6, cSig2);
    }

    function test_pull_inPushMode_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 50e6);
        bytes memory cSig = _cosign(acct, 20e6, 1);
        vm.expectRevert(SpendPolicyAccount.WrongMode.selector);
        acct.pull(20e6, cSig);
    }

    // ------------------------------------------------------------------
    // sweep — one-way valve to the committed vault, gated by the preimage
    // ------------------------------------------------------------------

    function test_sweepToVault_correctVault_returnsEverything() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 77e6);
        acct.sweepToVault(vault);
        assertEq(usdc.balanceOf(vault), 77e6, "not returned to vault");
        assertEq(usdc.balanceOf(address(acct)), 0);
    }

    function test_sweepToVault_wrongVault_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 10e6);
        vm.expectRevert(SpendPolicyAccount.WrongVault.selector);
        acct.sweepToVault(stranger); // does not match the commitment
    }

    function test_sweepToVault_anyoneWithThePreimageCanSubmit() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 33e6);
        vm.prank(stranger); // a relayer that knows the vault submits; funds still go home
        acct.sweepToVault(vault);
        assertEq(usdc.balanceOf(vault), 33e6);
    }

    function test_sweepExpired_beforeExpiry_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 10e6);
        vm.expectRevert(SpendPolicyAccount.NotExpiredYet.selector);
        acct.sweepExpired(vault);
    }

    function test_sweepExpired_wrongVault_reverts() public {
        SpendPolicyAccount acct = _push();
        _fund(acct, 10e6);
        vm.warp(expiry + 1);
        vm.expectRevert(SpendPolicyAccount.WrongVault.selector);
        acct.sweepExpired(stranger);
    }

    function test_sweepExpired_isTheEnclaveDownEscapeHatch() public {
        // Enclave gone: no co-signer sig will ever come. Funds still go home.
        SpendPolicyAccount acct = _push();
        _fund(acct, 25e6);
        vm.warp(expiry + 1);
        acct.sweepExpired(vault);
        assertEq(usdc.balanceOf(vault), 25e6);
    }
}
