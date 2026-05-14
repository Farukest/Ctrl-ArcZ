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
  watchTransfer,
  type ClientPair,
  type ProtectedTransfer,
  type SendProtectedParams,
  type SendProtectedResult,
  type TransferStatus,
  type WatchTransferOptions,
} from './transfer/transfer.js';
export { generateClaimCode, hashClaim, type ClaimSecret } from './transfer/claimCode.js';
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
