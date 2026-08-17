// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {PrivatePayRouter} from "../src/PrivatePayRouter.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";

/// @notice Adds the `PrivatePayRouter` to a chain that is already deployed.
///
/// @dev `DeployChain.s.sol` includes the router now, so a new chain needs only that
///      one. This exists for the chains that were stood up before the router did:
///      rerunning the full script on them would deploy a second CtrlArcZ, a second
///      factory and a second announcer, moving addresses that are already recorded
///      and, for the announcer, orphaning every announcement made against the old one.
///
///      Writes the address into the existing `deployments/<slug>.json` rather than a
///      file of its own, so one chain still has one record.
contract DeployRouter is Script {
    function run() external {
        string memory slug = vm.envString("CHAIN_SLUG");
        string memory addressesPath = string.concat("addresses/", slug, ".json");
        string memory json = vm.readFile(addressesPath);

        address permit2 = vm.parseJsonAddress(json, ".PERMIT2");
        uint256 expectedChainId = vm.parseJsonUint(json, ".chainId");

        require(block.chainid == expectedChainId, "wrong chain for this addresses file");
        // Without Permit2 the router has no way to pull the payer's tokens, and it
        // would deploy fine and revert on every payment.
        require(permit2.code.length > 0, "Permit2 has no code on this chain");

        string memory deploymentPath = string.concat("deployments/", slug, ".json");
        // Fails loudly if the chain has not been deployed yet, which is the case
        // where `DeployChain` is the right script and this one is not.
        string memory existing = vm.readFile(deploymentPath);
        require(vm.parseJsonUint(existing, ".chainId") == block.chainid, "deployment record is for another chain");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        PrivatePayRouter router = new PrivatePayRouter(IPermit2(permit2));
        vm.stopBroadcast();

        console.log("PrivatePayRouter:", address(router));
        console.log("PERMIT2:         ", permit2);

        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;
        vm.writeJson(vm.toString(address(router)), deploymentPath, ".PrivatePayRouter");
    }
}
