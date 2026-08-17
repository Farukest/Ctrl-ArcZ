import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  CTRL_ARCZ_ADDRESS,
  DEPLOYMENTS,
  deployedChainIds,
  deploymentFor,
  SPEND_POLICY_FACTORY_ADDRESS,
  STEALTH_ANNOUNCER_ADDRESS,
  type ChainDeployment,
} from '../src/index.js';

const entries = Object.values(DEPLOYMENTS) as ChainDeployment[];
const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

describe('deployment registry', () => {
  /**
   * The failure this guards against is not a crash.
   *
   * A wrong address in here does not throw: the app reads a contract that is not
   * there and gets zeros, or sends USDC to an address that means something else on
   * that network. Nothing on screen says so. So every field is checked for shape,
   * and the ones that exist on chain are checked against the deployment record the
   * broadcast itself wrote.
   */
  it('has a well-formed entry for every chain, keyed by its own chain id', () => {
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const d of entries) {
      expect(DEPLOYMENTS[d.chainId]).toBe(d);
      expect(CCTP_CHAINS[d.chain].chainId).toBe(d.chainId);
      for (const field of [
        'usdc',
        'ctrlArcZ',
        'codeClaimVerifier',
        'spendPolicyFactory',
        'spendPolicyAccountImpl',
        'stealthAnnouncer',
      ] as const) {
        expect(isAddress(d[field]), `${d.chain}.${field}`).toBe(true);
      }
      expect(d.ctrlArcZDeployBlock).toBeGreaterThan(0n);
      expect(d.stealthAnnouncerDeployBlock).toBeGreaterThan(0n);
      expect(d.maxLogRange).toBeGreaterThan(0n);
      // Optional, because not every chain has a Blockscout. When it is there it has
      // to be a real base, because a wrong one is a firewall reading nothing and
      // reporting a clean history.
      if (d.explorerApi !== undefined) expect(d.explorerApi.startsWith('https://')).toBe(true);
    }
  });

  /** USDC is the chain's, not a symbol we assumed. Both tables were read off the
   *  chain, and a disagreement between them is money sent to the wrong token. */
  it('uses each chain’s own USDC', () => {
    for (const d of entries) {
      expect(d.usdc.toLowerCase()).toBe(CCTP_CHAINS[d.chain].usdc.toLowerCase());
    }
  });

  /**
   * Within one chain, no two roles share an address.
   *
   * Deliberately not checked across chains. The same deployer at the same nonce
   * produces the same address on every chain, so a collision between, say, Arc's
   * verifier and Fuji's router is ordinary CREATE arithmetic rather than a
   * copy-paste -- and one of those actually happened here. What catches a
   * copy-paste is the per-chain check against that chain's own broadcast record
   * below, not distinctness.
   */
  it('gives each role its own address within a chain', () => {
    for (const d of entries) {
      const roles = [
        d.ctrlArcZ,
        d.codeClaimVerifier,
        d.spendPolicyFactory,
        d.spendPolicyAccountImpl,
        d.stealthAnnouncer,
        ...(d.privatePayRouter ? [d.privatePayRouter] : []),
      ].map((a) => a.toLowerCase());
      expect(new Set(roles).size, `${d.chain} reuses an address across roles`).toBe(roles.length);
    }
  });

  it('keeps Arc exactly where it already was', () => {
    const arc = deploymentFor(ARC_TESTNET_CHAIN_ID);
    expect(arc).toBeDefined();
    expect(arc?.ctrlArcZ).toBe(CTRL_ARCZ_ADDRESS);
    expect(arc?.spendPolicyFactory).toBe(SPEND_POLICY_FACTORY_ADDRESS);
    expect(arc?.stealthAnnouncer).toBe(STEALTH_ANNOUNCER_ADDRESS);
    expect(arc?.gasToken).toBe('usdc');
    // The one Arc-only address, and the reason a portable funding route is a
    // separate piece of work rather than another registry line.
    expect(arc?.multicall3From).toBeDefined();
  });

  /**
   * Pinned against the file each broadcast wrote, not against numbers retyped here.
   *
   * `deployments/<slug>.json` is the receipt. If the registry and a receipt ever
   * disagree, one of them was edited by hand, and this says which chain.
   */
  it.each(['Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia', 'Avalanche_Fuji'] as const)(
    'matches the broadcast record for %s',
    (chain) => {
      const slug = chain.toLowerCase().replace(/_/g, '-');
      const record = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../contracts/deployments/${slug}.json`, import.meta.url)),
          'utf8',
        ),
      ) as Record<string, string | number>;
      const d = deploymentFor(CCTP_CHAINS[chain].chainId);
      expect(d).toBeDefined();
      expect(d?.chainId).toBe(record.chainId);
      expect(d?.usdc).toBe(record.USDC);
      expect(d?.ctrlArcZ).toBe(record.CtrlArcZ);
      expect(d?.codeClaimVerifier).toBe(record.CodeClaimVerifier);
      expect(d?.spendPolicyFactory).toBe(record.SpendPolicyFactory);
      expect(d?.spendPolicyAccountImpl).toBe(record.AccountImplementation);
      expect(d?.stealthAnnouncer).toBe(record.StealthAnnouncer);
      expect(d?.privatePayRouter).toBe(record.PrivatePayRouter);
      expect(d?.ctrlArcZDeployBlock).toBe(BigInt(record.deployBlock as number));
      // Gas is a separate coin on all of these. Getting it wrong makes Max leave a
      // USDC reserve nobody owes, or spend one that is owed.
      expect(d?.gasToken).toBe('native');
      // Arc's precompile-backed multicall exists nowhere else, and the router is
      // what stands in for it.
      expect(d?.multicall3From).toBeUndefined();
    },
  );

  it('lists exactly the chains it holds', () => {
    expect([...deployedChainIds()].sort()).toEqual(entries.map((d) => d.chainId).sort());
    expect(deploymentFor(undefined)).toBeUndefined();
    expect(deploymentFor(999_999)).toBeUndefined();
  });
});
