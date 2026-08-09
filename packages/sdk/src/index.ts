/**
 * Ctrl+ArcZ SDK — protected USDC transfers on Arc.
 *
 * Three layers, in the order that matters:
 *   1. risk/     — the pre-send firewall. The actual poisoning protection: a
 *                  victim sends to a lookalike address *on purpose*, so locking
 *                  the funds afterwards does not save them. Only refusing does.
 *   2. transfer/ — code-gated claim, sender cancel, automatic refund. This is
 *                  what replaces the "send $1 first and wait" ritual.
 *   3. history/  — a spam-free history, so the fake address is never sitting
 *                  there waiting to be copied.
 */

export * from './chains/arcTestnet.js';
export { ctrlArcZAbi, codeClaimVerifierAbi, memoAbi } from './abi/ctrlArcZ.js';
export { getLogsChunked, type ChunkedEventsParams } from './events.js';

// Layer 1
export { check, type CheckOptions } from './risk/check.js';
export {
  acknowledgementCovers,
  MAX_ACKNOWLEDGEMENT_AGE_MS,
  type RiskAcknowledgement,
} from './risk/acknowledge.js';
export { VerifiedRecipientIndex } from './risk/recipientIndex.js';
export { CachingDataProvider, type CachingProviderOptions } from './risk/cachingProvider.js';
export {
  buildDossier,
  clampVerdict,
  findNearMisses,
  type Advisory,
  type BuildDossierOptions,
  type Dossier,
} from './risk/dossier.js';
export {
  evaluateRisk,
  isLookalike,
  craftLookalike,
  AFFIX_LENGTH,
  FRESH_ADDRESS_MAX_AGE_MS,
} from './risk/rules.js';
export {
  BlockscoutDataProvider,
  type BlockscoutProviderOptions,
} from './risk/blockscoutProvider.js';
export type {
  AddressActivity,
  Counterparty,
  IDataProvider,
  RiskInput,
  RiskLevel,
  RiskReason,
  RiskReport,
  RiskRuleCode,
  ZeroValueBait,
} from './risk/types.js';

// Layer 2
export {
  approveUsdc,
  cancel,
  claim,
  encodeClaimCall,
  interpretClaimReceipt,
  getAllowance,
  getTransfer,
  reclaimExpired,
  sendProtected,
  sendProtectedWithPermit,
  watchTransfer,
  type ClientPair,
  type ProtectedTransfer,
  type SendProtectedParams,
  type SendProtectedResult,
  MAX_REPORT_AGE_MS,
  type SendProtectedOptions,
  type TransferStatus,
  type WatchTransferOptions,
} from './transfer/transfer.js';
export {
  TERMINAL_STATUSES,
  isClaimable,
  isOpen,
  isReturnable,
  isTerminal,
  statusBucket,
  type StatusBucket,
} from './transfer/status.js';
export {
  generateClaimCode,
  fromSecret,
  normaliseSecret,
  formatSecret,
  saltFromSecret,
  hashClaim,
  CLAIM_SECRET_BITS,
  type ClaimSecret,
} from './transfer/claimCode.js';
export {
  approvePermit2,
  getPermit2Allowance,
  signPermit2Transfer,
  type Permit2Signature,
} from './transfer/permit2.js';
export {
  ClaimOutcomeUnknownError,
  CtrlArcZError,
  RiskBlockedError,
  TransferLockedError,
  TransferUnavailableError,
  WrongClaimCodeError,
  type TransferUnavailableReason,
} from './transfer/errors.js';

// Layer 3
export {
  getCleanHistory,
  type CleanHistory,
  type FilteredEntry,
  type GetCleanHistoryOptions,
  type HistoryEntry,
} from './history/history.js';

// Integrator setup
export {
  defineConfig,
  recommendTransferMode,
  registerConfig,
  shouldBlockSend,
  MAX_FEE_BPS,
  MAX_RECALL_WINDOW_SECONDS,
  type ClaimMode,
  type DefineConfigInput,
  type IntegratorConfig,
  type RegisterConfigResult,
} from './config/config.js';

// Layer 4 — payer-side shield (disposable policy accounts + enclave co-signer)
export {
  spendDigest,
  spendTypedData,
  ownerHash,
  vaultHash,
  ACTION_PAY,
  ACTION_PULL,
  SPEND_TYPES,
  SPEND_DOMAIN_NAME,
  SPEND_DOMAIN_VERSION,
  type SpendDigestParams,
  type SpendAction,
} from './shield/digest.js';
export {
  LocalCoSigner,
  RemoteCoSigner,
  cosignAuthMessage,
  type CosignAuthScope,
  type RemoteCoSignerAuth,
  type CoSigner,
  type RiskCheck,
  type RiskVerdict,
  type SpendRequest,
  type AuthorizeRequest,
  type CounterfactualRequest,
  type CounterfactualPolicy,
  type AuthorizeResult,
  type PrecheckRequest,
  type PrecheckResult,
  type LocalCoSignerOptions,
} from './shield/cosigner.js';
export {
  predictEphemeral,
  createEphemeral,
  fundEphemeral,
  fundFromVault,
  readAccount,
  submitPay,
  submitPull,
  sweepToVault,
  sweepExpired,
  settlePrivatePayment,
  settlePrivatePaymentBatched,
  MODE_PUSH,
  MODE_PULL,
  type ShieldClients,
  type EphemeralPolicy,
  type AccountState,
  type SpendMode,
  type PrivatePayResult,
  type PrivatePayOutcome,
} from './shield/shield.js';
export { spendPolicyFactoryAbi, spendPolicyAccountAbi, vaultAbi } from './shield/abi.js';
export {
  STEALTH_SCHEME_ID,
  STEALTH_KEY_MESSAGE,
  deriveStealthKeys,
  generateStealthAddress,
  checkStealthAddress,
  computeStealthPrivateKey,
  type StealthMetaAddress,
  type StealthKeys,
  type StealthAnnouncement,
} from './shield/stealth.js';
export { stealthAnnouncerAbi } from './shield/abi.js';
export {
  AnnouncementIndex,
  type IndexedAnnouncement,
} from './shield/announcementIndex.js';
export {
  assertBoxFundable,
  fundBoxFromGateway,
  awaitBoxFunded,
  isBoxFunding,
  type FundBoxParams,
} from './shield/boxFunding.js';
export {
  explorerAnnouncements,
  explorerAccountsCreated,
  explorerLogs,
  explorerUsable,
  clearExplorerState,
  EXPLORER_MAX_LAG_BLOCKS,
  type CreatedAccount,
  type ExplorerHealth,
  type ExplorerOptions,
} from './shield/explorer.js';
export {
  newStealthOwner,
  announceArgsFor,
  recognizeAnnouncements,
  announceStealthBox,
  discoverStealthBoxes,
  encodeStealthMetadata,
  decodeStealthMetadata,
  type StealthMetadata,
  type StealthBox,
  type RawAnnouncement,
} from './shield/stealthBox.js';

// Non-custodial CCTP: the sender's own USDC is burned and minted back to them, so
// no relayer has to hold liquidity for anyone else's transfer.
export {
  bridgeFromWallet,
  quoteBridge,
  waitForForwardedMint,
  findForwardedMint,
  chainLabel,
  chainExplorerTxUrl,
  CCTP_CHAINS,
  CCTP_TOKEN_MESSENGER,
  IRIS_TESTNET,
  FORWARDING_HOOK,
  type CctpChain,
  type CctpChainName,
  type CctpStep,
  type BridgeQuote,
  type BridgeResult as CctpBridgeResult,
} from './bridge/cctp.js';

// Circle Gateway, also non-custodial: the user deposits their own USDC and signs
// each spend, so no operator balance stands behind anyone else's transfer.
export {
  depositToGateway,
  spendFromGateway,
  quoteGatewaySpend,
  gatewayBalance,
  waitForGatewayMint,
  findGatewayMint,
  isGatewayChain,
  isGatewayWithdrawal,
  GATEWAY_WALLET,
  GATEWAY_MINTER,
  GATEWAY_API_TESTNET,
  GATEWAY_CHAIN_NAMES,
  DEPOSIT_CONFIRMATION_SECONDS,
  type GatewayChain,
  type GatewayStep,
  type GatewayQuote,
  type GatewayBalance,
  type GatewaySpendResult,
  type GatewayTransferStatus,
} from './bridge/gateway.js';
export {
  usdc,
  maxGatewaySpendable,
  maxDepositable,
  gatewayShortfall,
  cctpShortfall,
  percentOf,
  type Refusal,
  type RefusalFix,
} from './bridge/refusal.js';
