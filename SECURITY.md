# Security Audit — Ctrl+ArcZ

A full-surface review of the smart contract, SDK, bridge/gasless integration, and
the two demo UIs, covering the common failure modes of blockchain apps
(bridge/transfer/signature/wallet handling) and of AI-generated code. Each finding
is marked **Fixed**, **Hardened**, **Accepted**, or **Documented**.

## Threat model

The two apps are a **testnet demo**. To be a self-contained playground with no
external wallet, they sign with **throwaway Arc-testnet demo keys**. Those keys are
disposable and hold only test USDC. Nothing in this repo should ever hold a
real-value or mainnet key. Production integrators must run all signing server-side.

## Smart contract (`packages/contracts`) — fund-safe

No critical or high issues. Verified clean: reentrancy (all mutators are
`nonReentrant` with strict CEI; the verifier call is a `STATICCALL`), integer
bounds, access control, duplicate/colliding ids, zero-amount / zero-address /
self-transfer guards, SafeERC20 on every movement, and no admin / upgrade /
`selfdestruct` surface. Funds are always recoverable by the sender.

- **Claim-code reveal front-running — safe by design.** `claim()` submits the
  plaintext code, so it is visible in the mempool, but the payout target is read
  from storage (`t.to`), never `msg.sender`. A front-runner who replays a revealed
  proof merely settles the transfer for its intended recipient — which is exactly
  the gasless-relayer behavior the design wants. Funds cannot be redirected.
- **Accepted — griefing lockout.** Anyone can burn a transfer's 5 wrong-code
  attempts and move it to `LOCKED`, blocking the recipient's claim (a liveness/DoS
  griefing vector). No funds are lost: the sender can always `cancel` and re-send.
  This is a deliberate tradeoff (counting attempts only for the recipient would let
  an attacker grind the 20-bit code for free from throwaway addresses). Documented
  as a known limit for testnet.
- **Documented — `receive()` accepts native value that is unrecoverable.** Stray
  native/USDC sent directly to the contract is stranded (no sweep, no admin). It
  does not affect per-transfer accounting. Consider dropping `receive()` on a
  redeploy.

## SDK (`packages/sdk`)

- **Verified secure — claim code + commitment.** Code and 32-byte salt come from a
  CSPRNG (`crypto.getRandomValues`), digits use rejection sampling (no modulo bias).
  The on-chain commitment `keccak256(salt‖code)` is un-brute-forceable given the
  secret 256-bit salt; security rests on salt secrecy, which the split (code spoken,
  salt in the link) preserves.
- **Verified secure — Permit2 signing.** Correct EIP-712 domain (`Permit2`, chainId,
  verifyingContract, no version field), `spender` bound in the typed data, bounded
  `deadline`, full-entropy unordered nonce → no cross-chain or same-chain replay.
- **Fixed — claim-receipt event binding.** `interpretClaimReceipt` now matches events
  by **emitting contract address _and_ exact `transferId`**, not event name alone. In
  a batched/ERC-4337 receipt (the gasless path), an unrelated or attacker-planted
  `TransferClaimed` can no longer decide a victim transfer's outcome. `TransferCreated`
  selection is likewise bound to the contract address.
- **Fixed — firewall fails closed.** If the sender's payment history can't be fetched
  the lookalike rule can't run; the report now **blocks** an unverified target
  instead of downgrading to a click-through warning. A firewall that waves traffic
  through when its data source is down is worse than none. A verified/known-good
  recipient still only warns; a non-history source outage still only warns.
- **Fixed — `RecipientVerified` read failure** is now recorded as incomplete data
  (never silently "safe").
- **Hardened — send-path guards.** `sendProtected*` reject a zero/invalid recipient
  and non-positive amount before touching the chain.
- **Fixed — firewall is on by default.** `sendProtected` / `sendProtectedWithPermit`
  now run the poisoning `check()` themselves before submitting, throwing
  `RiskBlockedError` on a `block` result — no funds move. Previously the scan was
  caller-invoked, so an integrator who called `sendProtected` directly got no
  firewall at all ("install the SDK, then remember to also call the firewall").
  Verified live on Arc Testnet: a crafted lookalike passed straight to
  `sendProtected`, with no `check()` call of its own, threw `RiskBlockedError` and
  the sender's balance did not move. Hard blocks cannot be waved through.
- **One warning policy, not two.** The guard runs the caller's `IntegratorConfig`
  through the same `shouldBlockSend` the UI uses, so a config that says
  `onWarning: 'block'` cannot mean one thing on the pre-send screen and another
  inside the SDK. An earlier revision had a second, separate `onWarning` option on
  the send call, which silently ignored the config's own policy.
- **`RiskBlockedError` carries the whole `RiskReport`,** not just the message
  strings, so a caller that catches it can render the same explanation (rule codes,
  `lookalikeOf`, `complete`) instead of a flattened line of text.
- **A reused report must be fresh and about the right pair.** Callers that already
  ran `check()` pass the report through `report` rather than disabling the guard.
  It is honoured only when it matches the same sender and target and is younger
  than `MAX_REPORT_AGE_MS` (2 minutes); otherwise the guard re-scans. A stale or
  mismatched report is not evidence: a bait transfer could have landed since, and a
  clean report for address A must never wave through a send to poisoned address B.
- **Accepted — `skipRiskCheck` exists.** It removes the poisoning defense from the
  send path entirely. It is documented as a last resort, and the demo no longer
  uses it: the reference integration runs the real guarded code path.
- **Known dependency.** The guard reads ArcScan. If the indexer is unreachable, a
  send to an address the sender has never paid will throw, because a lookalike
  cannot be ruled out and the firewall fails closed. That is the intended behaviour
  of a firewall, but it makes `sendProtected` depend on an indexer being up.
  Integrators can supply their own `IDataProvider`, or an `evaluateRisk` report
  built from their own data.

## Bridge / gasless / keys

- **Fixed — relayer/Circle keys removed from the browser.** Gasless claims are now
  signed server-side at `/api/gasless-claim` (receiver `vite.config.ts` →
  `@ctrl-arcz/demo-kit/gasless`); the browser only posts `{ transferId, code, salt }`.
  `VITE_RELAYER_PK` and `VITE_CLIENT_KEY` are no longer referenced in any client code
  and are **verified absent from the production bundle** (grep of `dist/` returns
  none). The bridge is likewise server-side (`/api/bridge`), and its tab gates on a
  non-secret `VITE_BRIDGE_ENABLED` flag.
- **Mitigated — remaining `VITE_DEMO_PK`.** The demo's "connect wallet" is a headless
  test signer standing in for MetaMask (the user's own wallet), so it is read in dev
  only; it is not a server secret. A **build guard** in both apps refuses any
  production build that would inline a `VITE_*_PK`/`VITE_CLIENT_KEY` unless the
  operator sets `VITE_ALLOW_DEMO_KEYS=1` — turning "never in production" from a comment
  into enforcement. Always use throwaway testnet keys and rotate any that has been in
  a build.
- **Hardened — `/api/bridge`.** Now validates `from`/`to` against a chain allowlist,
  enforces a positive amount with a hard cap, rejects cross-origin requests, caps the
  request body size, and returns generic errors (detail logged server-side). Still
  dev-only; never expose the dev server with `--host`.
- **Verified clean** — gasless userOp targets the fixed contract with SDK-encoded
  calldata and pays the recorded recipient (a malicious relayer/paymaster gains
  nothing); the test provider only installs when no real wallet is present and never
  auto-approves; `.env`/`.env.local` are gitignored (only placeholder `.env.example`
  is committed).

## Frontend

- **Verified clean — no XSS via `dangerouslySetInnerHTML`.** The only sink (chain
  logos) is fed strictly by a compile-time `import.meta.glob` over repo-committed SVG
  files; no user/network/localStorage string reaches it. All 11 committed SVGs were
  inspected: no `<script>`, `on*`, `javascript:`, `<foreignObject>`, or external
  refs. No `eval`/`innerHTML`/`document.write` anywhere.
- **Fixed — stored link injection.** Explorer URLs read back from localStorage are
  now scheme-checked (https only) before rendering as an `<a href>`, so a tampered
  history entry cannot smuggle a `javascript:`/`data:` link.
- **Verified clean** — claim-link params (`tid`/`code`/`salt`) are sanitized before
  use and never rendered as HTML; all `target="_blank"` links carry `rel="noreferrer"`;
  no open-redirect; SDK-built explorer links are fixed-scheme.
- **Documented — address truncation in list rows.** Counterparty/recipient rows show
  `0x1234…abcd`, the same ambiguous form poisoning exploits. The send flow is guarded
  by the risk firewall; consider full-address-on-hover in history/pending lists.

## Production checklist

1. Rotate every key that has ever been in a build; never use real-value keys.
2. Signing is already server-side (bridge and gasless). Keep it that way; the only
   key still reaching the browser is the dev-only test-wallet stand-in.
3. Set `onWarning: 'block'` on your `IntegratorConfig` and pass it to `sendProtected`
   if your users must be hard-stopped on any doubt, not just a hard block.
4. Redeploy the contract if you want to remove `receive()` or change the lockout
   griefing tradeoff.

---

# Follow-up audit — payer shield, backend API, and mobile app (2026)

A second, adversarial audit covering the redesigned payer-side shield, the new
standalone backend (`apps/api`, public at `api.ctrlarcz.xyz`), and the Expo mobile
app (`apps/mobile`). Three parallel reviews; findings below with status
**Fixed** / **Mitigated** / **Documented**.

## A. Payer-side shield — contracts + SDK

- **CRITICAL — CREATE2 salt did not commit to the policy → front-run init theft.**
  The salt bound only `ownerHash + userSalt`, so an attacker could occupy the
  payer's predicted address with a substituted policy (`target`, `cosigner`, cap)
  and steal funds the payer then deposited; `createEphemeral` also ignored the
  deploy receipt. **Fixed:** the salt now folds in `keccak256(InitParams)` so a
  different policy maps to a different address, and `createEphemeral` reads the
  deployed policy back and refuses to fund a mismatch. Factory redeployed to Arc
  testnet; contract + unit + anvil + real-testnet e2e pass.
- **MEDIUM (DoS) — `sweepToVault` preimage was not a real capability.** The vault
  is the public funding source, so any observer could front-run a pending pay with
  a sweep and permanently grief it. **Fixed:** only the vault (`msg.sender == vault`)
  may sweep pre-expiry; `sweepExpired` keeps the preimage-gated liveness hatch.
- **LOW — co-signer trusts the client-supplied `owner`** (firewall scope only; funds
  stay locked to the on-chain target). **Documented:** bind `owner` to the
  authenticated session in production.
- **LOW — co-signer does not re-validate `perPullMax`/`interval` for PULL** (the
  contract enforces both). **Documented:** add to the pre-sign checks for
  defense-in-depth.
- **Verified hardened:** replay (cross-account/chain/nonce/action all fail),
  signature malleability, CEI/reentrancy, the closed fund-exit set (locked target
  or committed vault only), one-time `init`, non-hijackable clone implementation,
  and fail-closed policy reads.

## B. Backend API (`apps/api`) — public, unauthenticated

- **CRITICAL — unauthenticated relayer fund/gas drain** (`/api/bridge`,
  `/api/gateway`): no auth, no rate limit; `MAX_BRIDGE_AMOUNT` caps only per call.
  **Mitigated:** the funded relayer key is removed from the live deployment, so
  these endpoints return "no relayer key configured" and cannot spend. **To enable
  them, add authentication + per-address quotas first.**
- **HIGH — `/api/gasless-claim` wrong-code lock griefing:** 5 attempts with a random
  code (only the public `transferId` needed) permanently locks any transfer.
  **Mitigated:** gasless is disabled on the live deploy (no relayer/Circle key).
  Proper fix: authenticate the recipient and pre-check the code against the public
  `claimHash` before spending an attempt.
- **HIGH — `/api/cosign` firewall-scan DoS:** varying `target` misses the verdict
  cache and forces a from-deploy-block `getLogs` scan each call. **Mitigated:** a
  per-IP sliding-window rate limit (40/min) now fronts every endpoint, on top of
  the verdict cache. Further: bound the scan range / use a dedicated indexer.
- **MEDIUM-HIGH — notification registry spoofing + storage DoS:** anyone could
  register any push token for any address (surveil a victim's payments) or grow the
  store unbounded. **Fixed:** registration now requires a signature proving control
  of the address; per-address token cap (10); atomic store write.
- **MEDIUM — gasless error-detail leak.** **Documented:** only reachable when
  gasless is enabled; map unknown errors to a generic message.
- **Verified hardened:** loopback bind behind nginx TLS (8787 not exposed), the
  co-signer trust boundary (target/nonce/remaining/expiry read from chain, client
  policy ignored, funds cannot be redirected — DoS only, no theft), fail-closed
  risk, 8 KB body cap, generic errors + no key logging, server-only keys.

## C. Mobile app (`apps/mobile`) — pre-ship

- **HIGH — claim QR is a bearer credential** (code + salt in one QR): anyone who
  sees it can claim. **Documented (ship-blocker):** split the 6-digit code
  out-of-band from the salt QR; the contract's 5-attempt lockout already mitigates
  brute-forcing a salt-only QR.
- **MEDIUM — biometric gate failed open** on error/no-enrollment. **Fixed:** fails
  closed on error and falls back to the device passcode when no biometric is
  enrolled.
- **MEDIUM — device key not backup-protected, no wipe.** **Fixed:**
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (no backup extraction) + a "Remove wallet from
  this device" wipe action. Note: this is the interim dev-key model; the shipping
  wallet is Privy (embedded/passkey).
- **MEDIUM — secret screens are screenshot/snapshot exposed.** **Documented:** add
  `expo-screen-capture` (`FLAG_SECURE`) on the secret-bearing screens before ship.
- **MEDIUM — no certificate pinning** for a funds-moving app. **Documented:** pin the
  API + RPC + the co-signer address before public ship.
- **LOW — push-nav has no screen allowlist; http override example.** **Documented.**
- **Verified hardened:** no key logging/clipboard/eval/exfiltration, hostile
  QR/JSON parsing is safe, https-only, CSPRNG salts, firewall enforced before send.

## Production checklist (additions)

5. Backend: add authentication + per-address rate limits **before** re-enabling the
   relayer endpoints (`bridge`, `gateway`, `gasless-claim`); keep the loopback bind
   + TLS.
6. Mobile: ship with Privy (the device key is interim), split the claim code
   out-of-band, and add screenshot protection + certificate pinning.

## Resolution — production-hardening pass

A follow-up pass closed the remaining findings with real tests:

- **Backend relayer endpoints (was: CRITICAL, mitigated by disabling).** Now
  **Fixed** and safe to expose: `/api/bridge`, `/api/gateway`, `/api/gasless-claim`
  require an EIP-191 **signed request** (bound to path + timestamp + body-hash,
  fresh within 120s) plus a **per-address daily quota**. Verified live and locally:
  an unsigned request is 401, a tampered body is 401, and the 11th over-quota call
  is 429. The relayer key stays out of the deployment until an operator enables it
  behind this guard.
- **Gasless lock-griefing (was: HIGH).** Now **Fixed**: the code is checked against
  the transfer's on-chain `claimHash` off-chain, so a wrong code is rejected before
  any sponsored/relayer transaction and cannot consume the 5-attempt lockout;
  errors are generic. Logic covered by the `claimCode` tests.
- **Co-signer PULL policy (was: LOW).** Now **Fixed**: an over-`perPullMax` or
  too-soon PULL is vetoed before signing; unit-tested.
- **Mobile claim QR bearer (was: HIGH) + snapshot exposure (was: MEDIUM).** Now
  **Fixed**: the QR carries only `transferId + salt`; the 6-digit code is entered
  separately and never co-located with the QR; the secret screen blocks
  screenshots/snapshots (`expo-screen-capture`).
- **Co-signer owner binding (was: LOW/F3).** Now **Fixed**: every `/api/cosign`
  request carries an owner-signed message; the server recovers it and rejects a
  request whose signature does not match the claimed `owner` (or is stale).
  Verified: no-signature, forged-owner and stale requests are all vetoed.
- **Bridge amount normalization (was: LOW/#8).** Now **Fixed**: only a canonical
  USDC decimal is accepted and the validated value is what is forwarded. Verified:
  `5e-7`, `5.0000001` and ` 5 ` are rejected.
- **Mobile co-signer pinning (part of M5).** Now **Fixed**: the app pins the
  expected co-signer address and refuses to bake any other into an account, so a
  MITM cannot substitute an attacker-controlled co-signer.
- **Co-signer scan performance (relates to the HIGH cosign DoS).** A dedicated
  `VerifiedRecipientIndex` backfills the `RecipientVerified` events once then polls
  incrementally, and `check()` takes the sender's verified recipients from it
  instead of scanning from the deploy block on every call. Measured live: the
  precheck dropped from ~220s (504 timeout) to ~3s for any target (two distinct
  targets, so not just the verdict cache). Together with the per-IP rate limit this
  closes the amplification surface too.
- **TLS certificate pinning (mobile) — FIXED.** `apps/mobile/plugins/withCertPinning.js`
  is an Expo config plugin that pins the SPKI hashes of `api.ctrlarcz.xyz` and
  `rpc.testnet.arc.network` at the OS TLS layer (Android `network_security_config`
  `<pin-set>` + iOS `NSPinnedDomains`), so it covers every backend fetch and every
  viem RPC call, not just app-level fetches. It pins the Let's Encrypt roots (ISRG
  Root X1/X2) plus the current issuing intermediates — surviving normal 90-day leaf
  rotation while still rejecting a rogue-CA / mis-issued certificate, the exact MITM
  pinning defends against. The Android pin-set carries an `expiration` safety valve
  so a stale pin can never brick the app in the field. Enforced in the native (EAS)
  build; Expo Go cannot pin. Validated via `expo config --type introspect`.

## Deep audit — five-agent adversarial pass (all findings fixed)

A second, deeper review ran five independent adversarial auditors over the whole
system (contracts, SDK, backend + demo-kit, mobile, web). Each finding below was
reproduced, fixed, and covered by a test or a live check. No CRITICAL/HIGH remained
after this pass; the residuals were data-layer fail-open paths and abuse-prevention
gaps rather than key/fund-theft vectors.

### SDK — firewall data layer (the core promise)
- **HIGH — provider swallowed its own errors, making the fail-closed branch dead
  code.** `BlockscoutDataProvider.getOutgoingCounterparties` caught every fetch
  error and returned `[]`, so under explorer degradation a poisoning lookalike
  downgraded to `warning`/`safe` and both the transfer and the co-signer proceeded.
  FIXED: the provider now REJECTS on a failed history fetch (`IDataProvider` documents
  this), so `check()` marks the report incomplete and fails closed. Regression test
  added; the old test only passed because its fake provider threw where the real one
  never did.
- **HIGH — no pagination: only the most-recent ~50 counterparties were scanned, with
  `complete:true`.** A lookalike of an older counterparty slipped through silently.
  FIXED: `getAllPages` follows `next_page_params` up to a cap and returns a `complete`
  flag; a truncated scan marks the report incomplete (never authoritative). Test added.
- **MEDIUM — co-signer ignored `verdict.complete`.** FIXED: `LocalCoSigner` now vetoes
  any incomplete scan regardless of level (a successful bounded scan stays complete,
  so the cold-start path is unaffected). Test added.
- **MEDIUM — owner-auth signature was a reusable bearer proof.** `cosignAuthMessage`
  bound only owner+ts. FIXED: it now binds the request scope (target/account/amount/
  action); the server reconstructs and verifies it and rejects a replayed signature.
  Test added.
- **MEDIUM — `assertDeployedPolicy` checked only 4 of 9 fields.** FIXED: it now verifies
  token/cosigner/target/vaultHash/maxAmount/perPullMax/expiry/interval/mode (accounting
  for the contract's perPullMax==0→maxAmount normalization — a bug the live E2E caught).
- **LOW — indexer backfill gap** (events mined during the backfill were dropped while
  `isReady()` reported ready). FIXED: the head is snapshotted before the scan and the
  poll resumes from it.

### Backend
- **HIGH — rate limiter was bypassable via a spoofed `X-Forwarded-For`.** It keyed on
  the leftmost (client-controlled) hop. FIXED: it takes the rightmost hop nginx
  appended; a per-key ceiling and periodic sweep bound the map.
- **MEDIUM — signed requests were replayable within the 120s window.** FIXED: a
  single-use nonce store (keyed by signature hash) rejects repeats. Tested.
- **MEDIUM — no global relayer spend cap** (per-address only). FIXED: a process-wide
  daily unit ceiling. Tested.
- **MEDIUM — 30-minute verdict cache TOCTOU.** FIXED: TTL cut to 60s, verdicts computed
  before the indexer is ready are not cached, and the cache is swept.
- **MEDIUM — unbounded in-memory maps.** FIXED: sweeps + ceilings on the rate-limit,
  quota, verdict, owner-sig, and notification stores.
- **LOW — CORS reflected any Origin when unset.** FIXED: fail closed (a browser Origin
  is allowed only if explicitly listed; same-origin web + no-Origin mobile are
  unaffected). **LOW — notification registration** replayable/unbounded: FIXED with a
  timestamped, freshness-checked message and a registry ceiling.

### Mobile
- **HIGH — biometric gate failed OPEN on a device with no biometric hardware.** FIXED:
  it now falls back to the device passcode and fails closed when the device has no
  security at all.
- **MEDIUM — the Send screen ignored `warning`/incomplete verdicts.** FIXED: a warning
  or an incomplete scan now routes to an explicit confirm step; only `block` hard-stops.
- **MEDIUM — cert "pinning" pinned the shared CA root.** FIXED: pins the issuing
  intermediates (rejects a different CA) and drops the roots; residual LE-mis-issuance
  is covered by the on-chain co-signer pin.
- **MEDIUM — one-tap irreversible wallet wipe.** FIXED: a destructive-action confirm.
  **LOW** — screenshot guard engaged earlier + claim code is tap-to-reveal; push nav is
  allow-listed to known routes; registration is timestamped.

### Web + contracts
- **LOW — claim code persisted to localStorage.** FIXED: the code is kept in memory for
  the session only, never written to disk (the salt alone cannot claim). **LOW** — the
  receiver no longer reads the secret code from a URL query param.
- **LOW — contract: `interval==0` disabled the PULL rate limit.** FIXED: `init` requires
  `interval > 0` for PULL. New `SpendPolicyFactory`
  (`0x8AB90Dfe39D9c9bFE8bdDa84545FA734c02442B9`) + implementation
  (`0xa06419b913abA4BFdfEeb9D1A8800DbC2E3A2C11`) redeployed and re-verified with the
  live create→pay→sweep E2E. **LOW** — the SDK now treats a benign deploy collision
  (someone force-deploys the identical account) as success rather than a hard error.
