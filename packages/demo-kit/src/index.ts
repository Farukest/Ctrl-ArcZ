export {
  getPublicClient,
  hasWallet,
  injectedSession,
  ensureArcChain,
  switchToArc,
  watchWallet,
  localSigner,
  type Session,
} from './session.js';
export { useSession, type SessionState } from './useSession.js';
export { makeTestProvider, installTestProvider } from './testProvider.js';
// Browser-safe CCTP constants/types only. The server-only bridgeUsdc,
// circleGaslessClaim, and their Node-first Circle/Bridge-Kit imports are reached
// via the './cctp' and './gasless' subpaths, never the browser barrel.
export {
  BRIDGE_CHAINS,
  BRIDGE_STEPS,
  bridgeChainLabel,
  type BridgeChainName,
  type BridgeStepName,
  type BridgeStep,
  type BridgeOutcome,
} from './bridgeChains.js';
