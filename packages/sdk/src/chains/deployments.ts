import { CCTP_CHAINS, chainExplorerUrl, type CctpChainName } from '../bridge/cctp.js';
import {
  ADDRESSES,
  ARC_TESTNET_CHAIN_ID,
  CODE_CLAIM_VERIFIER_ADDRESS,
  CTRL_ARCZ_ADDRESS,
  CTRL_ARCZ_DEPLOY_BLOCK,
  EXPLORER_API_URL,
  EXPLORER_URL,
  MAX_LOG_RANGE,
  RPC_URLS,
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
   * The one-transaction Private Pay route on a chain with no CallFrom precompile.
   *
   * Creates the box, pulls the payer's tokens into it through Permit2, and pays the
   * merchant, atomically. Absent on Arc, which does the same job with its precompile
   * and needs no contract of ours in the middle.
   *
   * Absent also means "not deployed here yet", and the two are the same thing to a
   * caller: without it, a one-off payment on that chain is three transactions.
   */
  privatePayRouter?: `0x${string}`;

  /**
   * Arc's Multicall3 that preserves `msg.sender` through the CallFrom precompile.
   * Absent on every other chain, and the absence is the point: code that needs it
   * has to notice it is missing rather than fall back to something that looks alike.
   */
  multicall3From?: `0x${string}`;

  /**
   * Endpoints a server can reach this chain on, best first.
   *
   * For the server side only: the co-signer has to read a box's policy and the
   * relayer has to submit its deploy, and neither has a user's wallet to borrow.
   * The browser never uses these -- it reaches every chain but Arc through the
   * connected wallet's own provider, which is by definition on the chain the user
   * is on.
   *
   * More than one where more than one is published, so a single rate-limited
   * endpoint cannot stop the service.
   */
  rpcUrls: readonly string[];

  /** The explorer's front page. Undefined where the chain has no published one. */
  explorerUrl: string | undefined;
  /**
   * Blockscout v2 API base, for the poisoning check and clean-history lookups.
   *
   * Undefined where no Blockscout serves this chain, and that is a capability gap
   * rather than a missing string: without a history source the recipient firewall
   * has nothing to read, so it must say it cannot judge rather than judge on
   * nothing. Avalanche Fuji is in that position -- it has no Blockscout instance,
   * and Snowtrace answers a different API shape behind a key.
   */
  explorerApi?: string;
}

/**
 * One entry per chain we deployed on 2026-08-17, from that chain's own broadcast
 * record. None of these addresses was typed by hand; each was read back off the
 * chain afterwards (`CtrlArcZ.USDC()`, `factory.implementation()`,
 * `router.PERMIT2()`) before being written down.
 */
function deployed(
  chain: CctpChainName,
  a: {
    ctrlArcZ: `0x${string}`;
    codeClaimVerifier: `0x${string}`;
    spendPolicyFactory: `0x${string}`;
    spendPolicyAccountImpl: `0x${string}`;
    stealthAnnouncer: `0x${string}`;
    privatePayRouter: `0x${string}`;
    deployBlock: bigint;
    rpcUrls: readonly string[];
    explorerApi?: string;
  },
): ChainDeployment {
  return {
    chain,
    chainId: CCTP_CHAINS[chain].chainId,
    usdc: CCTP_CHAINS[chain].usdc,
    ctrlArcZ: a.ctrlArcZ,
    codeClaimVerifier: a.codeClaimVerifier,
    spendPolicyFactory: a.spendPolicyFactory,
    spendPolicyAccountImpl: a.spendPolicyAccountImpl,
    stealthAnnouncer: a.stealthAnnouncer,
    privatePayRouter: a.privatePayRouter,
    ctrlArcZDeployBlock: a.deployBlock,
    // One broadcast, so both event sources start at the same block.
    stealthAnnouncerDeployBlock: a.deployBlock,
    // These RPCs answer far wider ranges than Arc's 10k cap, but the chunker only
    // ever asks for less than it is allowed, so a conservative figure costs a few
    // extra calls and never earns a range error.
    maxLogRange: 10000n,
    // Gas is the chain's own coin here, not USDC. Getting this backwards makes Max
    // either leave a reserve nobody owes or spend one that is owed.
    gasToken: 'native',
    rpcUrls: a.rpcUrls,
    explorerUrl: chainExplorerUrl(chain),
    ...(a.explorerApi ? { explorerApi: a.explorerApi } : {}),
  };
}

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
    rpcUrls: RPC_URLS,
    multicall3From: ADDRESSES.MULTICALL3_FROM,
    explorerUrl: EXPLORER_URL,
    explorerApi: EXPLORER_API_URL,
  },

  /**
   * Deployed 2026-08-17. Base first, then the other three in one pass once the
   * script had been proven on it. Base's router came later than its other five
   * contracts, which is why it has its own `DeployRouter.s.sol`: rerunning the full
   * script to add one contract would have moved five addresses that were already
   * recorded, and orphaned every announcement made against the old announcer.
   */
  [CCTP_CHAINS.Base_Sepolia.chainId]: deployed('Base_Sepolia', {
    ctrlArcZ: '0x1C70d0c9A093fA7F27B0F6473D5Ca3bd3Ec50312',
    codeClaimVerifier: '0xfEb8397a85dbBbc298e9025B0Ae5fF9fAcd8e184',
    spendPolicyFactory: '0x2ce48fE79CaE15B2B05BF5d16C0CA649b15C76a0',
    spendPolicyAccountImpl: '0x9f958A530fF44325E056B03A55A101a1cA6829fD',
    stealthAnnouncer: '0xc69ab232410722E38A00474D8A4F2c743D51Df1B',
    privatePayRouter: '0xCe219028FC4a9D0AC4DBfa7436106f31c654E707',
    deployBlock: 45603570n,
    rpcUrls: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
    explorerApi: 'https://base-sepolia.blockscout.com/api/v2',
  }),

  [CCTP_CHAINS.Ethereum_Sepolia.chainId]: deployed('Ethereum_Sepolia', {
    ctrlArcZ: '0xe75f950c20fe30Fd5c55431D42F0863f1f79b359',
    codeClaimVerifier: '0xde55794622f466CC64Ea576f172d176991949Dac',
    spendPolicyFactory: '0x90DAe3231356B3f805DE6A72EFb4AaE104E6ee0b',
    spendPolicyAccountImpl: '0xb54B709CB094F115F7a7f7276572ddCdB84a469c',
    stealthAnnouncer: '0x8914bd04a8E753356bBC7087ac97F3434D32eCa2',
    privatePayRouter: '0x71f47955b810e126b9FA832d51DB60FE4cB3d701',
    deployBlock: 11509328n,
    rpcUrls: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
    ],
    explorerApi: 'https://eth-sepolia.blockscout.com/api/v2',
  }),

  [CCTP_CHAINS.Arbitrum_Sepolia.chainId]: deployed('Arbitrum_Sepolia', {
    ctrlArcZ: '0xf313096e7e37d7B91B6dB8d960C073D35098e410',
    codeClaimVerifier: '0x464fD4f004856ede0D6f7f04708eE380A16fbBB3',
    spendPolicyFactory: '0xD3fafeAD88C6684Ee701FaC818278Fed95A513bC',
    spendPolicyAccountImpl: '0xd7A601f80ae9ec10906601e3F315fD2fcC2FF220',
    stealthAnnouncer: '0xC9a80F08bED30B6CBfB94ee33D0Aeb9F38e67D22',
    privatePayRouter: '0x0cD8d125036f805EE34B5092C51Cb01Beb3DB8A6',
    deployBlock: 11509330n,
    rpcUrls: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia-rpc.publicnode.com',
    ],
    explorerApi: 'https://arbitrum-sepolia.blockscout.com/api/v2',
  }),

  /** No `explorerApi`: Fuji has no Blockscout instance and Snowtrace answers a
   *  different API behind a key. The firewall has no history source here. */
  [CCTP_CHAINS.Avalanche_Fuji.chainId]: deployed('Avalanche_Fuji', {
    ctrlArcZ: '0x42Fb208A045051CC3ae681C797DDcDaB6E5FFb80',
    codeClaimVerifier: '0x8b4eEE1ca335892a921726DB5C5e043071aA57B1',
    spendPolicyFactory: '0x9C5fbf3e13582B635C5af82c2Aa7c1dCe0fDA607',
    spendPolicyAccountImpl: '0x29209D78EA29F716b4d05a8FDfB9D38815cB930F',
    stealthAnnouncer: '0x693E2B03AD97Bcd3Ac74ECeE321081ccBBa42bE3',
    privatePayRouter: '0x2C0f268DE2Aa8BB2ab27F2Ea5Ae8a0f9a0E068c4',
    deployBlock: 57807450n,
    rpcUrls: [
      'https://api.avax-test.network/ext/bc/C/rpc',
      'https://avalanche-fuji-c-chain-rpc.publicnode.com',
    ],
  }),
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
