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

    uint256 constant MAX = 100e6; // 100 USDC
    uint40 expiry;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new SpendPolicyFactory();
        (owner, ownerPk) = makeAddrAndKey("owner");
        (cosigner, cosignerPk) = makeAddrAndKey("cosigner");
        (stranger, strangerPk) = makeAddrAndKey("stranger");
        vault = makeAddr("vault");
        target = makeAddr("merchant");
        expiry = uint40(block.timestamp + 1 hours);
    }

    // ---- helpers ----

    function _create(SpendPolicyAccount.Mode mode, uint40 interval) internal returns (SpendPolicyAccount acct) {
        SpendPolicyFactory.InitParams memory p = SpendPolicyFactory.InitParams({
            token: IERC20(address(usdc)),
            owner: owner,
            cosigner: cosigner,
            vault: vault,
            target: target,
            maxAmount: MAX,
            expiry: expiry,
            interval: interval,
            mode: mode
        });
        address a = factory.createAccount(bytes32(uint256(1)), p);
        acct = SpendPolicyAccount(payable(a));
    }

    function _fund(SpendPolicyAccount acct, uint256 amount) internal {
        usdc.mint(address(acct), amount);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------
    // init
    // ------------------------------------------------------------------

    function test_factory_deploysAtPredictedAddress_andInitializes() public {
        address predicted = factory.predictAddress(owner, bytes32(uint256(1)));
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        assertEq(address(acct), predicted, "predicted != actual");
        assertEq(acct.owner(), owner);
        assertEq(acct.cosigner(), cosigner);
        assertEq(acct.vault(), vault);
        assertEq(acct.target(), target);
        assertEq(acct.maxAmount(), MAX);
        assertEq(uint256(acct.mode()), uint256(SpendPolicyAccount.Mode.PUSH));
    }

    function test_init_secondCall_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        vm.expectRevert(SpendPolicyAccount.AlreadyInitialized.selector);
        acct.init(IERC20(address(usdc)), owner, cosigner, vault, target, MAX, expiry, 0, SpendPolicyAccount.Mode.PUSH);
    }

    function test_predict_boundToOwner() public view {
        address a = factory.predictAddress(owner, bytes32(uint256(1)));
        address b = factory.predictAddress(stranger, bytes32(uint256(1)));
        assertTrue(a != b, "same salt different owner must differ");
    }

    // ------------------------------------------------------------------
    // PUSH pay — happy path + 2-of-2
    // ------------------------------------------------------------------

    function test_pay_happyPath_movesFundsToTarget() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 50e6);

        bytes32 d = acct.actionDigest(50e6);
        acct.pay(50e6, _sign(ownerPk, d), _sign(cosignerPk, d));

        assertEq(usdc.balanceOf(target), 50e6, "target not paid");
        assertEq(usdc.balanceOf(address(acct)), 0);
        assertEq(acct.spent(), 50e6);
        assertEq(acct.nonce(), 1);
    }

    function test_pay_anyoneCanSubmit_fundsStillGoToTarget() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 50e6);
        bytes32 d = acct.actionDigest(50e6);
        bytes memory oSig = _sign(ownerPk, d);
        bytes memory cSig = _sign(cosignerPk, d);
        vm.prank(stranger); // a relayer submits
        acct.pay(50e6, oSig, cSig);
        assertEq(usdc.balanceOf(target), 50e6);
    }

    function test_pay_missingCosigner_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 50e6);
        bytes32 d = acct.actionDigest(50e6);
        // cosigner slot signed by the owner (the "veto refused to sign" case)
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        acct.pay(50e6, _sign(ownerPk, d), _sign(ownerPk, d));
    }

    function test_pay_wrongOwnerSig_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 50e6);
        bytes32 d = acct.actionDigest(50e6);
        vm.expectRevert(SpendPolicyAccount.BadOwnerSig.selector);
        acct.pay(50e6, _sign(strangerPk, d), _sign(cosignerPk, d));
    }

    function test_pay_overLimit_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 200e6);
        bytes32 d = acct.actionDigest(MAX + 1);
        vm.expectRevert(SpendPolicyAccount.OverLimit.selector);
        acct.pay(MAX + 1, _sign(ownerPk, d), _sign(cosignerPk, d));
    }

    function test_pay_afterExpiry_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 50e6);
        vm.warp(expiry + 1);
        bytes32 d = acct.actionDigest(50e6);
        vm.expectRevert(SpendPolicyAccount.Expired.selector);
        acct.pay(50e6, _sign(ownerPk, d), _sign(cosignerPk, d));
    }

    function test_pay_zeroAmount_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 50e6);
        bytes32 d = acct.actionDigest(0);
        vm.expectRevert(SpendPolicyAccount.ZeroAmount.selector);
        acct.pay(0, _sign(ownerPk, d), _sign(cosignerPk, d));
    }

    function test_pay_replaySameSig_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 100e6);
        bytes32 d = acct.actionDigest(30e6);
        bytes memory oSig = _sign(ownerPk, d);
        bytes memory cSig = _sign(cosignerPk, d);
        acct.pay(30e6, oSig, cSig);
        // nonce advanced, so the same signatures no longer match the new digest
        vm.expectRevert(SpendPolicyAccount.BadOwnerSig.selector);
        acct.pay(30e6, oSig, cSig);
    }

    function test_pay_cumulativeAcrossTwoPays_respectsCap() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 200e6);
        bytes32 d1 = acct.actionDigest(60e6);
        acct.pay(60e6, _sign(ownerPk, d1), _sign(cosignerPk, d1));
        // 60 + 50 > 100 cap
        bytes32 d2 = acct.actionDigest(50e6);
        vm.expectRevert(SpendPolicyAccount.OverLimit.selector);
        acct.pay(50e6, _sign(ownerPk, d2), _sign(cosignerPk, d2));
    }

    function test_pay_inPullMode_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, 1 days);
        _fund(acct, 50e6);
        bytes32 d = acct.actionDigest(50e6);
        vm.expectRevert(SpendPolicyAccount.WrongMode.selector);
        acct.pay(50e6, _sign(ownerPk, d), _sign(cosignerPk, d));
    }

    // ------------------------------------------------------------------
    // PULL — cosigner-gated recurring
    // ------------------------------------------------------------------

    function test_pull_happyPath_cosignerOnly() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, 1 days);
        _fund(acct, 100e6);
        bytes32 d = acct.actionDigest(20e6);
        vm.prank(target); // merchant pulls
        acct.pull(20e6, _sign(cosignerPk, d));
        assertEq(usdc.balanceOf(target), 20e6);
        assertEq(acct.spent(), 20e6);
    }

    function test_pull_badCosigner_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, 1 days);
        _fund(acct, 100e6);
        bytes32 d = acct.actionDigest(20e6);
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        acct.pull(20e6, _sign(strangerPk, d));
    }

    function test_pull_tooSoon_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, 1 days);
        _fund(acct, 100e6);
        bytes32 d1 = acct.actionDigest(20e6);
        acct.pull(20e6, _sign(cosignerPk, d1));
        bytes32 d2 = acct.actionDigest(20e6);
        vm.expectRevert(SpendPolicyAccount.TooSoon.selector);
        acct.pull(20e6, _sign(cosignerPk, d2));
    }

    function test_pull_afterInterval_succeeds_andCapBinds() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PULL, 10 minutes);
        _fund(acct, 100e6);
        bytes32 d1 = acct.actionDigest(60e6);
        acct.pull(60e6, _sign(cosignerPk, d1));
        vm.warp(block.timestamp + 10 minutes + 1); // interval elapsed, still before expiry
        // 60 + 50 > 100 cap
        bytes32 d2 = acct.actionDigest(50e6);
        vm.expectRevert(SpendPolicyAccount.OverLimit.selector);
        acct.pull(50e6, _sign(cosignerPk, d2));
    }

    function test_pull_inPushMode_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 50e6);
        bytes32 d = acct.actionDigest(20e6);
        vm.expectRevert(SpendPolicyAccount.WrongMode.selector);
        acct.pull(20e6, _sign(cosignerPk, d));
    }

    // ------------------------------------------------------------------
    // sweep — one-way valve to the vault
    // ------------------------------------------------------------------

    function test_sweepToVault_ownerSig_returnsEverythingToVault() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 77e6);
        bytes32 d = acct.sweepDigest();
        acct.sweepToVault(_sign(ownerPk, d));
        assertEq(usdc.balanceOf(vault), 77e6, "not returned to vault");
        assertEq(usdc.balanceOf(address(acct)), 0);
    }

    function test_sweepToVault_wrongSig_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 10e6);
        bytes32 d = acct.sweepDigest();
        vm.expectRevert(SpendPolicyAccount.BadOwnerSig.selector);
        acct.sweepToVault(_sign(strangerPk, d));
    }

    function test_sweepExpired_beforeExpiry_reverts() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 10e6);
        vm.expectRevert(SpendPolicyAccount.NotExpiredYet.selector);
        acct.sweepExpired();
    }

    function test_sweepExpired_afterExpiry_anyoneCanReturnToVault() public {
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 40e6); // e.g. a refund that landed after expiry
        vm.warp(expiry + 1);
        vm.prank(stranger); // a keeper/watcher
        acct.sweepExpired();
        assertEq(usdc.balanceOf(vault), 40e6);
    }

    function test_sweepExpired_isTheEnclaveDownEscapeHatch() public {
        // Enclave gone: no cosigner sig will ever come. Funds still go home.
        SpendPolicyAccount acct = _create(SpendPolicyAccount.Mode.PUSH, 0);
        _fund(acct, 25e6);
        vm.warp(expiry + 1);
        acct.sweepExpired();
        assertEq(usdc.balanceOf(vault), 25e6);
    }
}
