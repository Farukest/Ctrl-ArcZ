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
