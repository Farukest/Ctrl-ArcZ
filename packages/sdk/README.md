# @ctrl-arcz/sdk

Protected USDC transfers on [Arc](https://docs.arc.io): a pre-send risk firewall, code-gated claim, sender cancel, and automatic refund. Kills the "send one dollar first and wait" ritual and blocks address poisoning before the transaction is signed.

```bash
npm install @ctrl-arcz/sdk viem
```

## 30-second quickstart

```ts
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, RPC_URL } from '@ctrl-arcz/sdk';
import {
  defineConfig,
  registerConfig,
  approveUsdc,
  generateClaimCode,
  sendProtected,
  claim,
  RiskBlockedError,
} from '@ctrl-arcz/sdk';

const account = privateKeyToAccount(process.env.SENDER_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) });
const clients = { publicClient, walletClient };

const recipient = '0x…';

// 1. Register your integrator behaviour once (idempotent).
const config = defineConfig({ recallWindow: 3600 });
const { configId } = await registerConfig(clients, config);

// 2. Approve, then lock the funds with a claim commitment.
const amount = parseUnits('100', 6); // USDC has 6 decimals on Arc's ERC-20 interface
await approveUsdc(clients, amount);

const secret = generateClaimCode(); // { code, salt, claimHash }

try {
  // The firewall runs inside sendProtected. A lookalike or a zero-value baiter
  // throws RiskBlockedError before a single unit of USDC moves.
  const { transferId } = await sendProtected(
    clients,
    {
      configId,
      to: recipient,
      amount,
      claimHash: secret.claimHash,
    },
    { config },
  );

  // Share `secret.code` with the recipient out of band, and the claim link
  //   `https://your-app/claim?tid=${transferId}&salt=${secret.salt}`.

  // 3. The recipient releases it, or you relay for them. Funds always go to `to`.
  await claim(clients, transferId, secret.code, secret.salt);
} catch (e) {
  if (e instanceof RiskBlockedError) {
    // e.report is the full RiskReport: level, rule codes, lookalikeOf, complete.
    renderRiskCard(e.report);
  } else throw e;
}
```

Cancel any time before a claim lands, and unclaimed transfers refund themselves:

```ts
import { cancel, reclaimExpired } from '@ctrl-arcz/sdk';

await cancel(clients, transferId); // sender only, before a claim
await reclaimExpired(clients, transferId); // anyone, after the window. Money returns to the sender
```

## The firewall is on by default

`sendProtected` and `sendProtectedWithPermit` run the address-poisoning `check()` themselves, before any funds move. Installing the SDK is enough to be protected; there is no separate call to remember, and forgetting one cannot quietly disable the defense.

What stops a send:

| Verdict   | Default             | Rules                                                               |
| --------- | ------------------- | ------------------------------------------------------------------- |
| `block`   | **Throws**          | `LOOKALIKE_ADDRESS`, `ZERO_VALUE_BAIT`, an unrulable-out lookalike  |
| `warning` | Proceeds (advisory) | `NEW_ADDRESS`, `FRESH_ADDRESS`, an incomplete but non-critical scan |
| `safe`    | Proceeds            | `VERIFIED_RECIPIENT`, `KNOWN_COUNTERPARTY`                          |

Warnings are advisory on purpose. Paying a brand-new address is the most common legitimate payment there is, and a default that hard-failed it would only teach integrators to switch the guard off. Set `onWarning: 'block'` on your config if your users must be hard-stopped on any doubt.

```ts
const strict = defineConfig({ recallWindow: 3600, onWarning: 'block' });
await registerConfig(clients, strict);
await sendProtected(clients, params, { config: strict }); // warnings now throw too
```

The policy lives in **one** place. `sendProtected` runs your config through the same `shouldBlockSend` your UI uses, so a config that says `onWarning: 'block'` cannot mean one thing in your pre-send screen and another inside the SDK.

### Options

| Option          | Purpose                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `config`        | The `IntegratorConfig` whose `onWarning` decides what a warning does. Defaults to `defineConfig()` |
| `report`        | A `RiskReport` you already have for this exact pair, to avoid scanning twice                       |
| `checkOptions`  | Forwarded to `check` (custom `provider`, `contractAddress`, `now`)                                 |
| `onReport`      | Called with the report when the scan does not block, so you can surface warnings                   |
| `skipRiskCheck` | Turns the guard off entirely. Prefer `report` if you only want to avoid a redundant scan           |

**If your UI already ran `check()`, hand the report over rather than skipping the guard.** The report is reused only when it is about the same sender and target and is younger than `MAX_REPORT_AGE_MS` (two minutes); otherwise the guard silently re-scans. A stale report proves nothing, because a bait transfer could have landed since it was taken.

```ts
const report = await check(sender, recipient, { client: publicClient }); // for your UI
// ... user reviews the risk card, then confirms
await sendProtected(clients, params, { config, report }); // no second scan, guard still runs
```

### The failure mode you need to know

The guard calls `check()`, which reads ArcScan. **If the indexer cannot be reached, a send to an address you have not paid before will throw**, because a lookalike cannot be ruled out and the firewall fails closed rather than waving the send through. That is the intended behaviour of a firewall, but it means `sendProtected` now depends on an indexer being up. Your options, in order of preference: retry, verify the address out of band and pass a `report` you built with `evaluateRisk` and your own data, or supply a different `IDataProvider` through `checkOptions`.

## Security notes

- **The salt is the secret, the code is the human factor.** A six-digit code is about twenty bits; if the salt were public it could be brute-forced offline. `generateClaimCode` mints a 256-bit salt. Deliver it in the claim link, never publish it. The chain only ever stores the hash.
- **A wrong code does not revert** on-chain (the attempt counter has to survive so the five-guess lockout can bind). `claim` inspects the receipt and throws `WrongClaimCodeError` or `TransferLockedError`, so you never mistake a mined transaction for a successful claim.
- **The firewall never degrades to "safe".** If a data source is unavailable, the report is `warning` at best, `complete: false`, and a lookalike that cannot be ruled out is a `block`.

## API

| Function                                                             | Purpose                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `check(sender, target, opts)`                                        | Layer 1 firewall, returns a `RiskReport` (`safe`, `warning`, `block`)         |
| `evaluateRisk(input, now?)`                                          | The pure rule engine, provider-free (for custom data sources)                 |
| `craftLookalike(target)`                                             | Mint a real lookalike address (demos and tests)                               |
| `defineConfig(input)`                                                | Build an integrator config (window, claim mode, fee, thresholds, `onWarning`) |
| `registerConfig(clients, config)`                                    | Register it on-chain, returns an idempotent `configId`                        |
| `shouldBlockSend(config, level)`                                     | The single warning policy, shared by your UI and the SDK guard                |
| `recommendTransferMode(config, amount)`                              | `plain` below `minProtectedAmount`, else `protected`                          |
| `generateClaimCode()`                                                | `{ code, salt, claimHash }`                                                   |
| `approveUsdc(clients, amount)`                                       | ERC-20 approval to CtrlArcZ                                                   |
| `sendProtected(clients, params, opts?)`                              | Firewall, then lock funds. Returns `{ transferId, txHash, deadline }`         |
| `approvePermit2` / `sendProtectedWithPermit(clients, params, opts?)` | One-signature send via Permit2, no per-send approve tx                        |
| `claim(clients, id, code, salt)`                                     | Release to the recorded recipient                                             |
| `cancel(clients, id)`                                                | Sender takes the money back                                                   |
| `reclaimExpired(clients, id)`                                        | Anyone refunds an expired transfer to the sender                              |
| `getTransfer(clients, id)`                                           | On-chain transfer state                                                       |
| `watchTransfer(client, id, opts)`                                    | Subscribe to state changes                                                    |
| `getCleanHistory(address, opts)`                                     | Layer 3, a spam-free history                                                  |

All addresses and chain constants live in one export: `import { ADDRESSES, arcTestnet, CTRL_ARCZ_ADDRESS } from '@ctrl-arcz/sdk'`.

## Custom data source

The rule engine is a pure function. Point it at any indexer by implementing `IDataProvider`, or call `evaluateRisk` with data you already have:

```ts
import { evaluateRisk } from '@ctrl-arcz/sdk';

const report = evaluateRisk({
  sender, target,
  counterparties: [...],       // addresses this sender has paid
  targetActivity: { transactionCount, firstSeenAt },
  zeroValueBait: { count },
  isVerifiedRecipient: false,
});
```

The report it returns can be handed straight to `sendProtected` as `report`, so the guard runs on your data without touching ArcScan.

## Live reference example

`apps/sender` and `apps/receiver` in the repo are the reference integration: a React and Vite UI on top of this SDK, with real EIP-1193 wallet connection, the risk firewall, protected send (classic and Permit2), code or gasless claim, cancel, and the poisoning scenario. Run `pnpm dev:sender` and `pnpm dev:receiver`. They are the "grab and adapt" starting point for an integrator.

Testnet only. Not audited. See the repo for the contract, tests, and live demos.
