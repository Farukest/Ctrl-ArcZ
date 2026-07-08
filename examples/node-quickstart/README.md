# Node quickstart — `@ctrl-arcz/sdk`

The smallest complete integration: firewall check, protected send, and claim,
headless (no UI), against Arc testnet. This is exactly how a dApp backend or
script uses the SDK — you bring your own [viem](https://viem.sh) clients, the SDK
never touches wallets.

## Run

```bash
# from the repo root (workspace-linked), or after `npm i @ctrl-arcz/sdk viem`
cp .env.example .env    # fill in test keys (Arc testnet)
pnpm start              # or: node quickstart.mjs
```

Expected output:

```
1. check()  -> warning  [FRESH_ADDRESS, VERIFIED_RECIPIENT]
2. send()   -> transfer #12  code 078984
3. claim()  -> 0xb42476…0a754
4. status   -> CLAIMED
```

## The three calls

```ts
import {
  check,
  shouldBlockSend,
  defineConfig,
  registerConfig,
  generateClaimCode,
  sendProtected,
  claim,
} from '@ctrl-arcz/sdk';

// 1. Firewall — ALWAYS run before sending. `block` means: do not send.
const risk = await check(sender, recipient, { client: publicClient });
if (shouldBlockSend(config, risk.level)) return;

// 2. Protected send — funds are locked under a one-time code.
const { configId } = await registerConfig(clients, defineConfig({ recallWindow: 3600 }));
const secret = generateClaimCode();
const { transferId } = await sendProtected(clients, {
  configId,
  to: recipient,
  amount,
  claimHash: secret.claimHash,
});
// give `secret.code` to the recipient over a separate channel + the salt link

// 3. Recipient claims with the code.
await claim(recipientClients, transferId, code, salt);
```

## Notes for integrators

- **Any chain / deployment:** pass `contractAddress` on the client bundle
  (`{ publicClient, walletClient, contractAddress: '0x…' }`). Defaults to the Arc
  testnet deployment.
- **Custom risk data source:** `check()` accepts a `provider` implementing
  `IDataProvider`; the default is an Arc Blockscout provider.
- **Typed errors:** wrong code → `WrongClaimCodeError` (with `attemptsRemaining`),
  already-claimed/expired → `TransferUnavailableError` (with a `reason` code). Catch
  these instead of parsing raw revert strings.
- **Want a UI?** See the reference web apps in `apps/sender` and `apps/receiver`.
