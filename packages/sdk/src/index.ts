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
export { VerifiedRecipientIndex } from './risk/recipientIndex.js';
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
export { generateClaimCode, hashClaim, type ClaimSecret } from './transfer/claimCode.js';
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
  type AuthorizeResult,
  type PrecheckRequest,
  type PrecheckResult,
  type LocalCoSignerOptions,
} from './shield/cosigner.js';
export {
  predictEphemeral,
  createEphemeral,
  fundFromVault,
  readAccount,
  submitPay,
  submitPull,
  sweepToVault,
  sweepExpired,
  settlePrivatePayment,
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
