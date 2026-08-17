// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PrivatePayRouter} from "../src/PrivatePayRouter.sol";
import {SpendPolicyAccount} from "../src/SpendPolicyAccount.sol";
import {SpendPolicyFactory} from "../src/SpendPolicyFactory.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice The router's own logic. The real Permit2 signature path is exercised on a
///         live chain after deploy, the same split `CtrlArcZ.t.sol` already uses.
contract PrivatePayRouterTest is Test {
    MockUSDC usdc;
    MockPermit2 permit2;
    SpendPolicyFactory factory;
    PrivatePayRouter router;

    address payer;
    uint256 payerPk;
    address cosigner;
    uint256 cosignerPk;
    address attacker;
    address target;
    address vault;

    bytes32 ownerHash;
    bytes32 vaultHash;
    bytes32 constant SALT = bytes32(uint256(7));
    uint256 constant AMOUNT = 25e6;
    uint40 expiry;

    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _SPEND_TYPEHASH =
        keccak256("Spend(address target,uint256 amount,uint256 nonce,uint8 action)");
    /// Matches `SpendPolicyAccount`'s private constant. PULL is 1; signing a pay
    /// with 1 produces a signature the box rejects, which is how this was found.
    uint8 constant ACTION_PAY = 0;

    function setUp() public {
        usdc = new MockUSDC();
        permit2 = new MockPermit2();
        factory = new SpendPolicyFactory();
        router = new PrivatePayRouter(IPermit2(address(permit2)));

        (payer, payerPk) = makeAddrAndKey("payer");
        (cosigner, cosignerPk) = makeAddrAndKey("cosigner");
        attacker = makeAddr("attacker");
        target = makeAddr("merchant");
        vault = makeAddr("vault");
        ownerHash = keccak256(abi.encode(payer));
        vaultHash = keccak256(abi.encode(vault));
        expiry = uint40(block.timestamp + 1 hours);

        usdc.mint(payer, 1_000e6);
        // The one-time prerequisite a real payer does once per token.
        vm.prank(payer);
        usdc.approve(address(permit2), type(uint256).max);
    }

    function _params() internal view returns (SpendPolicyFactory.InitParams memory) {
        return SpendPolicyFactory.InitParams({
            token: IERC20(address(usdc)),
            cosigner: cosigner,
            vaultHash: vaultHash,
            target: target,
            maxAmount: AMOUNT,
            perPullMax: 0,
            expiry: expiry,
            interval: 0,
            mode: SpendPolicyAccount.Mode.PUSH
        });
    }

    /**
     * The co-signer signs for an address that does not exist yet.
     *
     * Computed here rather than read off the box, because at signing time there is
     * no box to ask. Nonce is zero for the same reason. This is what makes the whole
     * flow one transaction, and what makes a reused salt dangerous enough to reject
     * outright in the router.
     */
    function _cosignCounterfactual(address box, uint256 amount) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                _DOMAIN_TYPEHASH,
                keccak256(bytes("Ctrl+ArcZ SpendPolicy")),
                keccak256(bytes("1")),
                block.chainid,
                box
            )
        );
        bytes32 structHash = keccak256(abi.encode(_SPEND_TYPEHASH, target, amount, uint256(0), ACTION_PAY));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosignerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _permit(uint256 amount) internal view returns (IPermit2.PermitTransferFrom memory) {
        return IPermit2.PermitTransferFrom({
            permitted: IPermit2.TokenPermissions({token: address(usdc), amount: amount}),
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
    }

    function _pay(address sender, uint256 amount) internal returns (address box) {
        SpendPolicyFactory.InitParams memory p = _params();
        box = factory.predictAddress(ownerHash, SALT, p);
        bytes memory sig = _cosignCounterfactual(box, amount);
        vm.prank(sender);
        router.createFundAndPay(factory, ownerHash, SALT, p, amount, sig, _permit(amount), hex"");
    }

    // ------------------------------------------------------------------

    /// The whole point: one call, and the merchant has been paid out of a box that
    /// did not exist when the call started.
    function test_createFundAndPay_paysMerchantInOneCall() public {
        SpendPolicyFactory.InitParams memory p = _params();
        address predicted = factory.predictAddress(ownerHash, SALT, p);
        assertEq(predicted.code.length, 0, "box should not exist yet");

        uint256 payerBefore = usdc.balanceOf(payer);
        address box = _pay(payer, AMOUNT);

        assertEq(box, predicted, "box is not at the address the co-signer signed for");
        assertGt(box.code.length, 0, "box was not created");
        assertEq(usdc.balanceOf(target), AMOUNT, "merchant was not paid");
        assertEq(usdc.balanceOf(payer), payerBefore - AMOUNT, "payer was not debited");
        assertEq(usdc.balanceOf(box), 0, "box should be empty after paying");
        assertEq(usdc.balanceOf(address(router)), 0, "router must never hold funds");
    }

    /// The router pulls from whoever called it. This is the check that makes a
    /// stolen permit signature useless: an attacker submitting it moves their own
    /// tokens, not the signer's.
    function test_pullsFromTheCaller_notFromAParameter() public {
        _pay(payer, AMOUNT);
        assertEq(permit2.lastOwner(), payer, "permit owner must be msg.sender");
        assertEq(permit2.lastTo(), factory.predictAddress(ownerHash, SALT, _params()), "funds must go to the box");
    }

    /// An attacker replaying the payer's signed permit gets nowhere: the pull names
    /// the attacker as owner, and the attacker holds nothing.
    function test_attackerCannotRedirectSomeoneElsesPermit() public {
        SpendPolicyFactory.InitParams memory p = _params();
        address box = factory.predictAddress(ownerHash, SALT, p);
        bytes memory sig = _cosignCounterfactual(box, AMOUNT);

        vm.prank(attacker);
        vm.expectRevert(); // attacker has no balance and no approval
        router.createFundAndPay(factory, ownerHash, SALT, p, AMOUNT, sig, _permit(AMOUNT), hex"");

        assertEq(usdc.balanceOf(target), 0, "nothing should have been paid");
        assertEq(usdc.balanceOf(payer), 1_000e6, "payer must be untouched");
    }

    /**
     * A reused salt is refused before any money moves.
     *
     * The co-signer authorises nonce zero. A box that already exists has spent that
     * nonce, so `pay` would reject the signature -- after the pull had already put
     * the payer's tokens into it. Reverting up front is the difference between a
     * failed payment and funds sitting in a box this call cannot pay from.
     */
    function test_existingBox_revertsBeforePulling() public {
        SpendPolicyFactory.InitParams memory p = _params();
        factory.createAccount(ownerHash, SALT, p);
        address box = factory.predictAddress(ownerHash, SALT, p);
        bytes memory sig = _cosignCounterfactual(box, AMOUNT);
        uint256 before = usdc.balanceOf(payer);

        vm.prank(payer);
        vm.expectRevert(PrivatePayRouter.BoxAlreadyExists.selector);
        router.createFundAndPay(factory, ownerHash, SALT, p, AMOUNT, sig, _permit(AMOUNT), hex"");

        assertEq(usdc.balanceOf(payer), before, "payer must not be debited");
        assertEq(usdc.balanceOf(box), 0, "box must not be funded");
    }

    function test_zeroAmount_reverts() public {
        SpendPolicyFactory.InitParams memory p = _params();
        address box = factory.predictAddress(ownerHash, SALT, p);
        bytes memory sig = _cosignCounterfactual(box, 0);
        vm.prank(payer);
        vm.expectRevert(PrivatePayRouter.NothingToPay.selector);
        router.createFundAndPay(factory, ownerHash, SALT, p, 0, sig, _permit(0), hex"");
    }

    /// A co-signature for a different amount than the one being paid is refused by
    /// the box, so the whole transaction unwinds and the payer keeps their money.
    function test_wrongCosignerAmount_revertsWholeCall() public {
        SpendPolicyFactory.InitParams memory p = _params();
        address box = factory.predictAddress(ownerHash, SALT, p);
        bytes memory sig = _cosignCounterfactual(box, AMOUNT - 1);
        uint256 before = usdc.balanceOf(payer);

        vm.prank(payer);
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        router.createFundAndPay(factory, ownerHash, SALT, p, AMOUNT, sig, _permit(AMOUNT), hex"");

        assertEq(usdc.balanceOf(payer), before, "payer must not be debited");
        assertEq(usdc.balanceOf(target), 0, "merchant must not be paid");
    }

    /// A permit that Permit2 rejects (expired, bad signature, spent nonce) takes the
    /// whole payment down with it rather than leaving a created, unfunded box paid.
    function test_rejectedPermit_revertsWholeCall() public {
        permit2.setReject(true);
        SpendPolicyFactory.InitParams memory p = _params();
        address box = factory.predictAddress(ownerHash, SALT, p);
        bytes memory sig = _cosignCounterfactual(box, AMOUNT);

        vm.prank(payer);
        vm.expectRevert(MockPermit2.MockPermitRejected.selector);
        router.createFundAndPay(factory, ownerHash, SALT, p, AMOUNT, sig, _permit(AMOUNT), hex"");

        assertEq(usdc.balanceOf(target), 0, "merchant must not be paid");
    }

    /// The box's address commits to the policy, so a substituted merchant is a
    /// different box, which the co-signer never authorised.
    function test_substitutedTarget_producesADifferentBox() public {
        SpendPolicyFactory.InitParams memory honest = _params();
        SpendPolicyFactory.InitParams memory swapped = _params();
        swapped.target = attacker;

        address a = factory.predictAddress(ownerHash, SALT, honest);
        address b = factory.predictAddress(ownerHash, SALT, swapped);
        assertTrue(a != b, "a substituted target must not land on the same address");

        // The co-signature is for the honest box; used against the swapped one it is
        // a signature over a different domain and does not recover to the co-signer.
        bytes memory sig = _cosignCounterfactual(a, AMOUNT);
        vm.prank(payer);
        vm.expectRevert(SpendPolicyAccount.BadCosignerSig.selector);
        router.createFundAndPay(factory, ownerHash, SALT, swapped, AMOUNT, sig, _permit(AMOUNT), hex"");
    }

    function test_routerHoldsNothing_afterManyPayments() public {
        for (uint256 i = 0; i < 5; i++) {
            SpendPolicyFactory.InitParams memory p = _params();
            bytes32 salt = bytes32(i + 100);
            address box = factory.predictAddress(ownerHash, salt, p);
            bytes memory sig = _cosignCounterfactual(box, AMOUNT);
            vm.prank(payer);
            router.createFundAndPay(factory, ownerHash, salt, p, AMOUNT, sig, _permit(AMOUNT), hex"");
        }
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(target), AMOUNT * 5);
    }
}
