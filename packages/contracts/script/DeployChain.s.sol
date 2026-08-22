// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CtrlArcZ} from "../src/CtrlArcZ.sol";
import {CodeClaimVerifier} from "../src/verifiers/CodeClaimVerifier.sol";
import {SpendPolicyFactory} from "../src/SpendPolicyFactory.sol";
import {StealthAnnouncer} from "../src/StealthAnnouncer.sol";
import {PrivatePayRouter} from "../src/PrivatePayRouter.sol";
import {IClaimVerifier} from "../src/interfaces/IClaimVerifier.sol";
import {IPermit2} from "../src/interfaces/IPermit2.sol";

/// @notice Deploys the whole of Ctrl+ArcZ to one chain, in one broadcast.
///
/// @dev Arc keeps `Deploy.s.sol` and `DeployShield.s.sol`. Those ran months apart,
///      in that order, and rerunning them would move addresses that are live. This
///      script is for every chain after the first, where there is no history to
///      preserve and every reason to want one record instead of three.
///
///      It is deliberately not Arc-specific. Nothing in these contracts is: the
///      `receive() payable` that Arc needs (a USDC transfer there moves native
///      balance) is a no-op on a plain EVM, and the EIP-712 domain reads
///      `block.chainid`, so an account signs for the chain it is actually on. What
///      does not travel is the *client's* funding path, which uses Arc's CallFrom
///      precompile -- that is a decision above this file, not a contract change.
///
///      `StealthAnnouncer` had no deploy script at all until now. It was deployed to
///      Arc by hand, which is why subscriptions could not have been stood up on a
///      second chain even with everything else in place.
///
///      The addresses it needs come from `addresses/<chain>.json`, generated from
///      the SDK by `scripts/gen-contract-addresses.mjs`. No address is typed twice.
contract DeployChain is Script {
    function run() external {
        string memory slug = vm.envString("CHAIN_SLUG");
        string memory json = vm.readFile(string.concat("addresses/", slug, ".json"));

        address usdc = vm.parseJsonAddress(json, ".USDC");
        address permit2 = vm.parseJsonAddress(json, ".PERMIT2");
        uint256 expectedChainId = vm.parseJsonUint(json, ".chainId");

        // The file names the chain; this catches a `--rpc-url` pointing somewhere
        // else, which would otherwise deploy a working system onto the wrong
        // network and record it under this one's name.
        require(block.chainid == expectedChainId, "wrong chain for this addresses file");
        // A USDC address with no code is the failure that produces a deployment
        // which looks fine and cannot move money.
        require(usdc.code.length > 0, "USDC has no code on this chain");
        require(permit2.code.length > 0, "Permit2 has no code on this chain");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        // Read before broadcasting, so it is the block the first deploy lands at or
        // just before it. Event scans start here; early is harmless, late loses logs.
        uint256 startBlock = currentBlock();

        vm.startBroadcast(deployerKey);

        CodeClaimVerifier verifier = new CodeClaimVerifier();
        CtrlArcZ arcz = new CtrlArcZ(IERC20(usdc), IClaimVerifier(address(verifier)), IPermit2(permit2));
        SpendPolicyFactory factory = new SpendPolicyFactory();
        StealthAnnouncer announcer = new StealthAnnouncer();
        // The one-transaction Private Pay route. Arc does this through its CallFrom
        // precompile and needs no router; every other chain needs this, or the flow
        // becomes three separate wallet confirmations.
        PrivatePayRouter router = new PrivatePayRouter(IPermit2(permit2));

        vm.stopBroadcast();

        console.log("chainId:              ", block.chainid);
        console.log("USDC:                 ", usdc);
        console.log("CodeClaimVerifier:    ", address(verifier));
        console.log("CtrlArcZ:             ", address(arcz));
        console.log("SpendPolicyFactory:   ", address(factory));
        console.log("AccountImplementation:", factory.implementation());
        console.log("StealthAnnouncer:     ", address(announcer));
        console.log("PrivatePayRouter:     ", address(router));
        console.log("deployBlock:          ", startBlock);

        // Only on a real broadcast. A dry run executes run() too, and would
        // otherwise write simulated, never-deployed addresses over a real record.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) return;

        string memory out = string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "deployBlock": ',
            vm.toString(startBlock),
            ',\n  "USDC": "',
            vm.toString(usdc),
            '",\n  "CodeClaimVerifier": "',
            vm.toString(address(verifier)),
            '",\n  "CtrlArcZ": "',
            vm.toString(address(arcz)),
            '",\n  "SpendPolicyFactory": "',
            vm.toString(address(factory)),
            '",\n  "AccountImplementation": "',
            vm.toString(factory.implementation()),
            '",\n  "StealthAnnouncer": "',
            vm.toString(address(announcer)),
            '",\n  "PrivatePayRouter": "',
            vm.toString(address(router)),
            '"\n}\n'
        );
        vm.writeFile(string.concat("deployments/", slug, ".json"), out);
    }

    /**
     * The block number an `eth_getLogs` on this chain is counted in.
     *
     * Not `block.number`, because on Arbitrum that is the L1 block: the Arbitrum
     * Sepolia deployment recorded 11509330 (where Ethereum Sepolia stood at the
     * time) while the chain itself was at 299143893, and the scan built from it
     * started 289 million blocks early, which at 10k per request never finished.
     *
     * ArbSys answers with the L2 number. Address 0x64 holds no code anywhere else,
     * and a staticcall to a codeless address succeeds with empty returndata, so the
     * length check is what distinguishes an Arbitrum chain from every other one --
     * no chain id list to keep current.
     */
    function currentBlock() internal view returns (uint256) {
        (bool ok, bytes memory data) = address(0x64).staticcall(
            abi.encodeWithSignature("arbBlockNumber()")
        );
        if (ok && data.length == 32) return abi.decode(data, (uint256));
        return block.number;
    }
}
