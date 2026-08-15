// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract VaultTest is Test {
    MockUSDC usdc;
    Vault vault;
    address owner = makeAddr("owner");
    address account = makeAddr("ephemeral");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSDC();
        vault = new Vault(IERC20(address(usdc)), owner);
        usdc.mint(address(vault), 1000e6); // seed the kasa
    }

    function test_fundAccount_ownerMovesFundsToEphemeral() public {
        vm.prank(owner);
        vault.fundAccount(account, 100e6);
        assertEq(usdc.balanceOf(account), 100e6);
        assertEq(vault.balance(), 900e6);
    }

    function test_fundAccount_notOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(Vault.NotOwner.selector);
        vault.fundAccount(account, 100e6);
    }

    function test_withdraw_ownerOnly() public {
        vm.prank(owner);
        vault.withdraw(owner, 250e6);
        assertEq(usdc.balanceOf(owner), 250e6);

        vm.prank(stranger);
        vm.expectRevert(Vault.NotOwner.selector);
        vault.withdraw(stranger, 1);
    }

    function test_deposit_pullsFromCaller() public {
        usdc.mint(stranger, 500e6);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 500e6);
        vault.deposit(500e6);
        vm.stopPrank();
        assertEq(vault.balance(), 1500e6);
    }

    function test_sweepFromAccount_landsInVault_noCallNeeded() public {
        // An ephemeral account sweeps by plain transfer; the vault just receives.
        usdc.mint(account, 40e6);
        vm.prank(account);
        usdc.transfer(address(vault), 40e6);
        assertEq(vault.balance(), 1040e6);
    }

    function test_zeroChecks() public {
        vm.startPrank(owner);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.fundAccount(account, 0);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vault.fundAccount(address(0), 1);
        vm.stopPrank();
    }

    /// `withdraw` had the same two guards as `fundAccount` and none of the coverage.
    /// It is the path that takes money out of the vault to an arbitrary address, so
    /// it is the one where a zero address burns the balance rather than moving it.
    function test_withdraw_zeroChecks() public {
        vm.startPrank(owner);
        vm.expectRevert(Vault.ZeroAddress.selector);
        vault.withdraw(address(0), 1);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.withdraw(owner, 0);
        vm.stopPrank();
    }

    function test_deposit_zeroAmount_reverts() public {
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.deposit(0);
    }

    /// Both immutables are set once and there is no setter, so a vault constructed
    /// with a zero token or a zero owner is a contract that can receive USDC and
    /// never let it out again.
    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(Vault.ZeroAddress.selector);
        new Vault(IERC20(address(0)), owner);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(Vault.ZeroAddress.selector);
        new Vault(IERC20(address(usdc)), address(0));
    }
}
