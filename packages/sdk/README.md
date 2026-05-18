# @ctrl-arcz/sdk

Protected USDC transfers on [Arc](https://docs.arc.io) — a pre-send risk firewall, code-gated claim, sender cancel, and automatic refund. Kills the "send $1 first and wait" ritual and blocks address-poisoning before the transaction is signed.

```bash
npm install @ctrl-arcz/sdk viem
```

## 30-second quickstart

```ts
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, RPC_URL } from '@ctrl-arcz/sdk';
import {
  check,
  defineConfig,
  registerConfig,
  approveUsdc,
  generateClaimCode,
  sendProtected,
  claim,
} from '@ctrl-arcz/sdk';

const account = privateKeyToAccount(process.env.SENDER_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) });
const clients = { publicClient, walletClient };

const recipient = '0x…';

// 1. Firewall — run before every send. A lookalike or a 0-value baiter is blocked.
const report = await check(account.address, recipient, { client: publicClient });
if (report.level === 'block') throw new Error(report.reasons[0]?.message);

// 2. Register your integrator behaviour once (idempotent).
const { configId } = await registerConfig(clients, defineConfig({ recallWindow: 3600 }));

// 3. Approve, then lock the funds with a claim commitment.
const amount = parseUnits('100', 6); // USDC has 6 decimals on Arc's ERC-20 interface
await approveUsdc(clients, amount);

const secret = generateClaimCode(); // { code, salt, claimHash }
const { transferId } = await sendProtected(clients, {
  configId,
  to: recipient,
  amount,
  claimHash: secret.claimHash,
});

// Share `secret.code` with the recipient out-of-band, and the claim link
//   `https://your-app/claim?tid=${transferId}&salt=${secret.salt}`.

// 4. The recipient releases it (or you relay on their behalf — funds always go to `to`).
await claim(clients, transferId, secret.code, secret.salt);
```

Cancel any time before a claim lands, and unclaimed transfers refund themselves:

```ts
import { cancel, reclaimExpired } from '@ctrl-arcz/sdk';

await cancel(clients, transferId); // sender only, before a claim
await reclaimExpired(clients, transferId); // anyone, after the window — money returns to the sender
```

## Security notes

- **The salt is the secret, the code is the human factor.** A 6-digit code is ~20 bits; if the salt were public it could be brute-forced offline. `generateClaimCode` mints a 256-bit salt — deliver it via the claim link, never publish it. The chain only ever stores the hash.
- **A wrong code does not revert** on-chain (the attempt counter has to survive so the 5-guess lockout can bind). `claim` inspects the receipt and throws `WrongClaimCodeError` / `TransferLockedError`, so you never mistake a mined transaction for a successful claim.
- **The firewall never degrades to "safe".** If a data source is unavailable, the report is `warning` at best and `complete: false`.

## API

| Function                                                      | Purpose                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `check(sender, target, opts)`                                 | Layer 1 firewall → `RiskReport` (`safe` / `warning` / `block`)            |
| `evaluateRisk(input, now?)`                                   | The pure rule engine, provider-free (for custom data sources)             |
| `craftLookalike(target)`                                      | Mint a real lookalike address (demos / tests)                             |
| `defineConfig(input)`                                         | Build an integrator config (window, claim mode, fee, thresholds)          |
| `registerConfig(clients, config)`                             | Register it on-chain → `configId` (idempotent)                            |
| `recommendTransferMode(config, amount)`                       | `plain` below `minProtectedAmount`, else `protected`                      |
| `generateClaimCode()`                                         | `{ code, salt, claimHash }`                                               |
| `approveUsdc(clients, amount)`                                | ERC-20 approval to CtrlArcZ                                               |
| `sendProtected(clients, params)`                              | Lock funds (Memo-wrapped by default) → `{ transferId, txHash, deadline }` |
| `approvePermit2` / `sendProtectedWithPermit(clients, params)` | One-signature send via Permit2 — no per-send approve tx                   |
| `claim(clients, id, code, salt)`                              | Release to the recorded recipient                                         |
| `cancel(clients, id)`                                         | Sender takes the money back                                               |
| `reclaimExpired(clients, id)`                                 | Anyone refunds an expired transfer to the sender                          |
| `getTransfer(clients, id)`                                    | On-chain transfer state                                                   |
| `watchTransfer(client, id, opts)`                             | Subscribe to state changes                                                |
| `getCleanHistory(address, opts)`                              | Layer 3 — spam-free history                                               |

All addresses and chain constants live in one export: `import { ADDRESSES, arcTestnet, CTRL_ARCZ_ADDRESS } from '@ctrl-arcz/sdk'`.

## Custom data source

The rule engine is a pure function; point it at any indexer by implementing `IDataProvider`, or call `evaluateRisk` with data you already have:

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

## Live reference example

`apps/sender` and `apps/receiver` in the repo are the reference integration: a
professional React + Vite UI on top of this SDK, with real EIP-1193 wallet
connection, the risk firewall, protected send (classic + Permit2), code/gasless
claim, cancel, and the poisoning demo. Run `pnpm dev:sender` / `pnpm dev:receiver`.
They are the "grab and adapt" starting point for an integrator.

Testnet only. Not audited. See the repo for the contract, tests, and live demos.
