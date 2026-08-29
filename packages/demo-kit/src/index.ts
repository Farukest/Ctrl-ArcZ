export {
  getPublicClient,
  hasWallet,
  injectedSession,
  ensureArcChain,
  switchToArc,
  watchWallet,
  localSigner,
  signerFor,
  bridgeClients,
  switchWalletChain,
  switchWalletTo,
  type Session,
} from './session.js';
export { readUsdcOn, readWalletUsdc } from './walletUsdc.js';
export {
  useWalletChain,
  chainForWallet,
  destinationChain,
  walletChainName,
  type ChainOptionSet,
  type WalletChainBinding,
} from './chainBinding.js';
export { useSession, type SessionState } from './useSession.js';
export { makeTestProvider, installTestProvider } from './testProvider.js';
// Browser-safe CCTP constants/types only. The server-only bridgeUsdc,
// circleGaslessClaim, and their Node-first Circle/Bridge-Kit imports are reached
// via the './cctp' and './gasless' subpaths, never the browser barrel.
export {
  BRIDGE_STEPS,
  GATEWAY_STEPS,
  type BridgeStepName,
  type GatewayStepName,
  type BridgeEngine,
  type BridgeStep,
  type BridgeOutcome,
} from './bridgeChains.js';
export { supportsChain, preferredChainFor, type ChainFeature } from './chainSupport.js';
export {
  chainsFor,
  depositWaitLabel,
  labelOf,
  needsWalletOn,
  type ChainPurpose,
} from './chainCatalog.js';
export { isPlainClick } from './isPlainClick.js';
export { useToken } from './useToken.js';
export {
  DEPOSIT_STEPS,
  chainForStep,
  stepExplorerUrl,
  stepsForEngine,
  stepsForRun,
  ownedBy,
  jobForEngine,
  deriveStepStatuses,
  stepIndexFor,
  type StepStatus,
  type ReportedStep,
  type LiveRun,
} from './bridgeProgress.js';

// A wallet error, as a sentence rather than as a page of request arguments.
export {
  classifyFailure,
  detailOf,
  failureText,
  type Failure,
  type FailureCode,
} from './failure.js';

// The activity engine: one row shape for everything that has happened, and the
// query it is read through. UI for it lives in `@ctrl-arcz/demo-kit/ui`.
export {
  ALL_FACET,
  dayStart,
  emptyQuery,
  facetCounts,
  groupByDay,
  pageOf,
  selectEntries,
  type ActivityAction,
  type ActivityDay,
  type ActivityEntry,
  type ActivityFact,
  type ActivityIcon,
  type ActivityPage,
  type ActivityQuery,
  type ActivitySort,
  type ActivityStep,
  type ActivityTone,
  type ActivityView,
} from './activity/model.js';
export {
  useActivityFeed,
  type ActivityFacetOption,
  type ActivityFeed,
} from './activity/useActivityFeed.js';
