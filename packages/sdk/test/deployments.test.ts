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
      expect(d.explorerApi.startsWith('https://')).toBe(true);
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
   * No address appears on two chains.
   *
   * Deployed from the same account with the same nonces, two chains would produce
   * identical addresses -- which is fine on its own and disastrous if a record is
   * copied from one entry to another and nobody notices because the address "looks
   * right". Distinctness is not the property that matters; having been written from
   * each chain's own broadcast is, and this is how a copy-paste shows up.
   */
  it('does not repeat a contract address across chains', () => {
    const seen = new Map<string, string>();
    for (const d of entries) {
      for (const a of [d.ctrlArcZ, d.codeClaimVerifier, d.spendPolicyFactory, d.stealthAnnouncer]) {
        const key = a.toLowerCase();
        expect(seen.has(key), `${a} appears on both ${seen.get(key)} and ${d.chain}`).toBe(false);
        seen.set(key, d.chain);
      }
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
   * Pinned against the file the broadcast wrote, not against numbers retyped here.
   *
   * `deployments/base-sepolia.json` is the receipt. If the registry and the receipt
   * ever disagree, one of them was edited by hand, and this says which.
   */
  it('matches the broadcast record for Base Sepolia', () => {
    const record = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../contracts/deployments/base-sepolia.json', import.meta.url)),
        'utf8',
      ),
    ) as Record<string, string | number>;
    const d = deploymentFor(CCTP_CHAINS.Base_Sepolia.chainId);
    expect(d).toBeDefined();
    expect(d?.chainId).toBe(record.chainId);
    expect(d?.usdc).toBe(record.USDC);
    expect(d?.ctrlArcZ).toBe(record.CtrlArcZ);
    expect(d?.codeClaimVerifier).toBe(record.CodeClaimVerifier);
    expect(d?.spendPolicyFactory).toBe(record.SpendPolicyFactory);
    expect(d?.spendPolicyAccountImpl).toBe(record.AccountImplementation);
    expect(d?.stealthAnnouncer).toBe(record.StealthAnnouncer);
    expect(d?.ctrlArcZDeployBlock).toBe(BigInt(record.deployBlock as number));
    // Gas is a separate coin here. Getting this wrong makes Max leave a USDC
    // reserve nobody owes, or spend one that is owed.
    expect(d?.gasToken).toBe('native');
    expect(d?.multicall3From).toBeUndefined();
  });

  it('lists exactly the chains it holds', () => {
    expect([...deployedChainIds()].sort()).toEqual(entries.map((d) => d.chainId).sort());
    expect(deploymentFor(undefined)).toBeUndefined();
    expect(deploymentFor(999_999)).toBeUndefined();
  });
});
