import { CCTP_CHAINS, type CctpChainName } from '../bridge/cctp.js';
import {
  ADDRESSES,
  ARC_TESTNET_CHAIN_ID,
  CODE_CLAIM_VERIFIER_ADDRESS,
  CTRL_ARCZ_ADDRESS,
  CTRL_ARCZ_DEPLOY_BLOCK,
  EXPLORER_API_URL,
  EXPLORER_URL,
  MAX_LOG_RANGE,
  SHIELD_VAULT_ADDRESS,
  SPEND_POLICY_ACCOUNT_IMPL_ADDRESS,
  SPEND_POLICY_FACTORY_ADDRESS,
  STEALTH_ANNOUNCER_ADDRESS,
  STEALTH_ANNOUNCER_DEPLOY_BLOCK,
} from './arcTestnet.js';

/**
 * Where Ctrl+ArcZ is deployed, per chain.
 *
 * Until now there was one deployment and its addresses were top-level constants, so
 * every one of the hundred-odd places that reads one is pinned to Arc by import
 * rather than by argument. That was honest while Arc was the only chain. It stops
 * being honest the moment a second one exists, because the failure it produces is
 * not an error: the app reads a contract that is not there, or worse, sends money to
 * an address that means something else on this network.
 *
 * So the deployment becomes data, keyed by the number the wallet actually reports.
 * Adding a chain is an entry here and nothing else -- the screens already ask
 * `supportsChain`, which now derives its answer from this table.
 *
 * The Arc entry is built from the existing constants rather than restating them.
 * They are still the source: `sync-deployment.mjs` writes them after a deploy, and a
 * second copy here would be a second thing to forget.
 *
 * What is NOT in here, deliberately: nothing about how a payment is funded. Arc's
 * one-transaction Private Pay goes through its `CallFrom` precompile, which no other
 * chain has, and standard Multicall3 will not stand in for it (it does not preserve
 * `msg.sender`, so a `transfer` inside it moves Multicall3's own tokens). That is a
 * route to be chosen, not an address to be looked up, and pretending otherwise here
 * would make an absent capability look like a missing config line.
 */
export interface ChainDeployment {
  /** The chain, in the one vocabulary this codebase uses for chains. */
  chain: CctpChainName;
  chainId: number;
  /** USDC on this chain. Read off the chain, not assumed from the symbol. */
  usdc: `0x${string}`;

  ctrlArcZ: `0x${string}`;
  codeClaimVerifier: `0x${string}`;
  spendPolicyFactory: `0x${string}`;
  spendPolicyAccountImpl: `0x${string}`;
  stealthAnnouncer: `0x${string}`;
  /** The demo vault. Only Arc has one; it is a demo payee, not infrastructure. */
  shieldVault?: `0x${string}`;

  /**
   * Blocks the event sources were deployed at.
   *
   * Scans start here rather than at genesis: an `eth_getLogs` from 0 is refused by
   * most public RPCs and is a full-history walk on the rest.
   */
  ctrlArcZDeployBlock: bigint;
  stealthAnnouncerDeployBlock: bigint;
  /** This RPC's cap on an `eth_getLogs` range, for chunking. */
  maxLogRange: bigint;

  /**
   * What gas is billed in.
   *
   * Arc bills it in USDC, which is why a Max there has to leave a reserve out of the
   * same balance the user is spending. Everywhere else gas is a separate coin and
   * none of the USDC balance is owed to it. Getting this backwards produces either a
   * Max that reverts or one that silently underspends.
   */
  gasToken: 'usdc' | 'native';

  /**
   * Arc's Multicall3 that preserves `msg.sender` through the CallFrom precompile.
   * Absent on every other chain, and the absence is the point: code that needs it
   * has to notice it is missing rather than fall back to something that looks alike.
   */
  multicall3From?: `0x${string}`;

  explorerUrl: string;
  /** Blockscout v2 API base, for the poisoning check and clean-history lookups. */
  explorerApi: string;
}

const BASE_SEPOLIA_CHAIN_ID = CCTP_CHAINS.Base_Sepolia.chainId;

export const DEPLOYMENTS: Readonly<Record<number, ChainDeployment>> = {
  [ARC_TESTNET_CHAIN_ID]: {
    chain: 'Arc_Testnet',
    chainId: ARC_TESTNET_CHAIN_ID,
    usdc: ADDRESSES.USDC,
    ctrlArcZ: CTRL_ARCZ_ADDRESS,
    codeClaimVerifier: CODE_CLAIM_VERIFIER_ADDRESS,
    spendPolicyFactory: SPEND_POLICY_FACTORY_ADDRESS,
    spendPolicyAccountImpl: SPEND_POLICY_ACCOUNT_IMPL_ADDRESS,
    stealthAnnouncer: STEALTH_ANNOUNCER_ADDRESS,
    shieldVault: SHIELD_VAULT_ADDRESS,
    ctrlArcZDeployBlock: CTRL_ARCZ_DEPLOY_BLOCK,
    stealthAnnouncerDeployBlock: STEALTH_ANNOUNCER_DEPLOY_BLOCK,
    maxLogRange: MAX_LOG_RANGE,
    gasToken: 'usdc',
    multicall3From: ADDRESSES.MULTICALL3_FROM,
    explorerUrl: EXPLORER_URL,
    explorerApi: EXPLORER_API_URL,
  },

  /**
   * Deployed 2026-08-17 by `script/DeployChain.s.sol`, one broadcast, block
   * 45603570. Verified after the fact by reading the chain back rather than by
   * trusting the script's own log: `CtrlArcZ.USDC()` is Circle's Base Sepolia USDC,
   * `PERMIT2()` is the canonical singleton, `CODE_VERIFIER()` is the verifier
   * deployed alongside it, and the factory's `implementation()` is the account
   * implementation recorded here. A mistyped address does not fail, it sends money
   * somewhere else, so none of these were copied by hand.
   */
  [BASE_SEPOLIA_CHAIN_ID]: {
    chain: 'Base_Sepolia',
    chainId: BASE_SEPOLIA_CHAIN_ID,
    usdc: CCTP_CHAINS.Base_Sepolia.usdc,
    ctrlArcZ: '0x1C70d0c9A093fA7F27B0F6473D5Ca3bd3Ec50312',
    codeClaimVerifier: '0xfEb8397a85dbBbc298e9025B0Ae5fF9fAcd8e184',
    spendPolicyFactory: '0x2ce48fE79CaE15B2B05BF5d16C0CA649b15C76a0',
    spendPolicyAccountImpl: '0x9f958A530fF44325E056B03A55A101a1cA6829fD',
    stealthAnnouncer: '0xc69ab232410722E38A00474D8A4F2c743D51Df1B',
    ctrlArcZDeployBlock: 45603570n,
    stealthAnnouncerDeployBlock: 45603570n,
    // Base's RPCs answer far wider ranges than Arc's 10k cap, but the chunker only
    // ever asks for less than it is allowed, so a conservative figure costs a few
    // extra calls and never earns a -32614.
    maxLogRange: 10000n,
    gasToken: 'native',
    explorerUrl: 'https://sepolia.basescan.org',
    explorerApi: 'https://base-sepolia.blockscout.com/api/v2',
  },
};

/**
 * The deployment on this chain, or undefined where there is none.
 *
 * Undefined is a real answer and the only honest one: the wallet can be on any
 * network at all. Callers turn it into "this screen cannot work here", which is
 * what the user needs to be told, rather than into a zero address that fails later
 * and further away.
 */
export function deploymentFor(chainId: number | undefined): ChainDeployment | undefined {
  return chainId === undefined ? undefined : DEPLOYMENTS[chainId];
}

/** Every chain with a deployment. The screens' chain guards are built from this. */
export function deployedChainIds(): readonly number[] {
  return Object.values(DEPLOYMENTS).map((d) => d.chainId);
}
