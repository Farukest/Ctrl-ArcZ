// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendPolicyFactory} from "../src/SpendPolicyFactory.sol";
import {Vault} from "../src/Vault.sol";

/// @notice Deploys the payer-side shield (SpendPolicyFactory + a demo Vault) to Arc Testnet.
/// @dev USDC is read from `addresses.arc-testnet.json` (the single source of truth).
///      The demo Vault is owned by `SENDER_ADDRESS` (the demo payer). The factory
///      deploys its own account implementation in its constructor.
contract DeployShield is Script {
    function run() external {
        string memory json = vm.readFile("addresses.arc-testnet.json");
        address usdc = vm.parseJsonAddress(json, ".USDC");
        uint256 expectedChainId = vm.parseJsonUint(json, ".chainId");

        require(block.chainid == expectedChainId, "wrong chain: expected Arc Testnet");
        require(usdc.code.length > 0, "USDC has no code at that address");

        address vaultOwner = vm.envAddress("SENDER_ADDRESS");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        SpendPolicyFactory factory = new SpendPolicyFactory();
        Vault vault = new Vault(IERC20(usdc), vaultOwner);

        vm.stopBroadcast();

        console.log("SpendPolicyFactory:", address(factory));
        console.log("AccountImplementation:", factory.implementation());
        console.log("Vault:", address(vault));
        console.log("VaultOwner:", vaultOwner);

        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;

        string memory out = string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "SpendPolicyFactory": "',
            vm.toString(address(factory)),
            '",\n  "AccountImplementation": "',
            vm.toString(factory.implementation()),
            '",\n  "Vault": "',
            vm.toString(address(vault)),
            '",\n  "VaultOwner": "',
            vm.toString(vaultOwner),
            '",\n  "USDC": "',
            vm.toString(usdc),
            '"\n}\n'
        );
        vm.writeFile("deployments/shield-arc-testnet.json", out);
    }
}
