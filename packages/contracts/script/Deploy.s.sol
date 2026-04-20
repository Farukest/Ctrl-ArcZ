// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CtrlArcZ} from "../src/CtrlArcZ.sol";
import {CodeClaimVerifier} from "../src/verifiers/CodeClaimVerifier.sol";
import {IClaimVerifier} from "../src/interfaces/IClaimVerifier.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";

/// @notice Deploys CodeClaimVerifier + CtrlArcZ to Arc Testnet.
/// @dev The USDC address is not written here. It is read from
///      `addresses.arc-testnet.json`, which is generated from
///      `packages/sdk/src/chains/arcTestnet.ts` — the one place addresses live.
///      Run `pnpm deploy:testnet`, which regenerates that file first.
contract Deploy is Script {
    function run() external {
        string memory json = vm.readFile("addresses.arc-testnet.json");
        address usdc = vm.parseJsonAddress(json, ".USDC");
        address permit2 = vm.parseJsonAddress(json, ".PERMIT2");
        uint256 expectedChainId = vm.parseJsonUint(json, ".chainId");

        require(block.chainid == expectedChainId, "wrong chain: expected Arc Testnet");
        require(usdc.code.length > 0, "USDC has no code at that address");
        require(permit2.code.length > 0, "Permit2 has no code at that address");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        CodeClaimVerifier verifier = new CodeClaimVerifier();
        CtrlArcZ arcz = new CtrlArcZ(IERC20(usdc), IClaimVerifier(address(verifier)), IPermit2(permit2));

        vm.stopBroadcast();

        console.log("CodeClaimVerifier:", address(verifier));
        console.log("CtrlArcZ:", address(arcz));
        console.log("USDC:", usdc);

        // Only persist the deployment record on a real broadcast. A dry run
        // (`forge script` without --broadcast) still executes run() and would
        // otherwise overwrite deployments/arc-testnet.json with simulated,
        // never-deployed addresses.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;

        string memory out = string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "CtrlArcZ": "',
            vm.toString(address(arcz)),
            '",\n  "CodeClaimVerifier": "',
            vm.toString(address(verifier)),
            '",\n  "USDC": "',
            vm.toString(usdc),
            '"\n}\n'
        );
        vm.writeFile("deployments/arc-testnet.json", out);
    }
}
