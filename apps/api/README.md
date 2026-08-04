# @ctrl-arcz/api

The Ctrl+ArcZ backend. One small service that both the web and mobile apps call,
holding the server-only keys and running the event watcher. It replaces the Vite
dev endpoints so the mobile app (and any real deployment) has a stable API.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness. |
| GET | `/api/cosign` | The co-signer's public address. |
| POST | `/api/cosign` | The Machine: validate a spend against on-chain policy + the firewall, sign or veto. |
| POST | `/api/bridge` | CCTP bridge (server-held relayer key). |
| POST | `/api/gateway` | Circle Gateway transfer. |
| POST | `/api/gasless-claim` | Gas-sponsored claim (Circle Gas Station). |
| POST | `/api/relay/create` | Deploy a stealth spend box, so the deploy does not name the payer. |
| POST | `/api/relay/announce` | Announce that box (`StealthAnnouncer` indexes `msg.sender`). |
| POST | `/api/relay/gas` | Fixed 0.05 USDC so a stealth address can pay for its own sweep. |
| POST | `/api/investigate` | A reasoned second opinion on a recipient. Advisory only; it can only tighten a verdict. |
| POST | `/api/notifications/register` | Register a device Expo push token for a wallet address. |

The co-signer, bridge, gasless and gateway logic is reused from `@ctrl-arcz/demo-kit`
so the web and mobile apps share exactly one implementation.

Every route that spends the relayer's gas requires a signed request
(`x-ctrl-address` / `x-ctrl-timestamp` / `x-ctrl-signature` over path, timestamp and
body hash) and is quota-limited per caller and per day.

## The relay routes

They exist so a stealth box's own transactions do not carry the payer's address.
None of them can move a user's funds: `createAccount` deploys a clone bound to a
hash of the stealth address and reads no `msg.sender`, `announce` only emits an
event, and the gas top-up is a fixed amount of the relayer's own balance, skipped
when the address already has enough.

The server rebuilds the policy from named fields rather than accepting calldata,
with the token pinned to USDC and the cosigner pinned to itself, so the relayer can
only ever sign a call the operator intended. What this does not hide is funding;
see [`docs/privacy.md`](../../docs/privacy.md).

## Notifications

The mobile app registers its Expo push token against the user's address. The Arc
event watcher polls the CtrlArcZ contract and delivers pushes:

- `TransferCreated` to you -> "you have a payment to claim"
- `TransferClaimed` of yours -> "your transfer was claimed"

Tokens are kept in `.tokens.json` (gitignored); a production deploy would use a
database.

## Run

```bash
cp .env.example .env.local   # fill in COSIGNER_PK, RELAYER_PK (throwaway testnet keys)
pnpm --filter @ctrl-arcz/api dev
```

All keys are server-only and never reach a browser or the mobile bundle. In
production this runs behind nginx (e.g. `api.ctrlarcz.xyz`) with TLS.

## The investigator

The rule engine answers one question at a time and answers it the same way every
time. That is what makes it worth trusting, and it is also why it says "this
address has no on-chain history" about a colleague's fresh wallet and about a
contract that would swallow the payment: from any single rule those are the same
address. `/api/investigate` gathers the signals a rule cannot combine (is it a
contract, does it nearly collide with several people you have paid, has it sent
you zero-value bait) and reports what they add up to.

Two properties make it safe to have a model in a payment path:

- **It can only tighten.** Every answer goes through `clampVerdict` before it
  leaves the server, so the rule engine's verdict is a floor. A wrong, confused or
  prompt-injected reply can refuse a good payment; it cannot approve a bad one and
  cannot un-block a lookalike. The only operation available to it is `max`.
- **It is optional.** No `ANTHROPIC_API_KEY`, a timeout, a malformed reply, a
  refusal. Each returns a null advisory alongside the unchanged rule verdict, and
  the app behaves exactly as it does without the feature. The firewall never
  depends on this being up.

The dossier's contents are attacker-influenced, so it is passed as JSON inside a
user turn and never concatenated into the instructions, and the reply is
constrained to a fixed schema. Neither of those is what makes it safe. The clamp
is.
