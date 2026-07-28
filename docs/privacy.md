# What a subscription reveals, and what it does not

A stealth subscription box is owned and vaulted by a one-time address. The
cryptography is only half the story: a box also has to be deployed, funded, told
apart from every other box, and eventually swept, and each of those is a public
transaction with a public sender. This page states exactly which of them still
name the payer, so nobody has to infer it from the code.

## Measured, not asserted

The trace below is every USDC movement around one real box on Arc Testnet
(`0x3cDB93434d64d08a803694C64f4027Fc7CBFE50E`), created and cancelled through the
app:

```
deploy   (SpendPolicyFactory.createAccount)  sent by relayer
announce (StealthAnnouncer.announce)         sent by relayer, caller = relayer
fund     PAYER  -> box       0.1  USDC       sent by PAYER      <-- the one link
gas      relayer -> stealth  0.05 USDC       sent by relayer
sweep    box    -> stealth   0.1  USDC       sent by stealth
```

Four of the five carry no payer identity. The funding transfer does, and it is
enough on its own to tie the payer to the box.

## Why the relay is not cosmetic

It would be, if it stopped at the announcement. Two of those four were removed for
reasons that survive any future privacy upgrade:

- `StealthAnnouncer` indexes `msg.sender`. Announcing from the payer's wallet
  publishes "this address created a stealth box", which is most of what the stealth
  address was there to hide.
- Cancelling used to send the stealth address its gas straight from the payer's
  wallet. On Arc gas is USDC, so this was a plain, public `payer -> stealthAddress`
  transfer: not a hint, the link itself.

Both are gone. What remains is the funding transfer, and no amount of relaying
fixes that: the money is the payer's, it starts in a public balance, and moving it
is a public act.

## What APS changes, and what it does not

[Arc Privacy Sector](https://docs.arc.io/arc/concepts/opt-in-privacy) is a
confidential execution environment: a transaction is encrypted to the APS network
key and submitted as calldata to a precompile, and the public ledger sees no state,
no return values and no event logs. It is on Arc's roadmap and not yet live.

APS closes the funding link, because the transfer into the box becomes part of
private state. It does not close the sender link: the precompile call is still an
ordinary Arc transaction with a public `from` that pays public gas. "This wallet
submitted a private transaction at this height" stays visible.

So the two halves are orthogonal. **APS hides what you did. The relayer hides that
it was you who submitted it.** Building the relay now is building the half that APS
will not provide.

## The seam APS drops into

The three relayed calls live behind one server module,
`packages/demo-kit/src/relayServer.ts`, and one client module,
`apps/sender/src/lib/relay.ts`. Neither knows anything about how the transaction is
carried, only what it should do. When APS is available:

1. `relayServer.ts` encrypts the same call to the APS network key and sends the
   ciphertext to the privacy precompile instead of calling the contract directly.
   The endpoints, validation and quota are unchanged.
2. Funding moves inside APS as well, at which point `SubscriptionsTab`'s step 4 (the
   only step still submitted by the payer's own wallet) stops being a public
   transfer. That is the change that takes the trace above from one public link to
   none.
3. Discovery keeps working as it does today, or gets cheaper: with events private,
   the announcement registry can be read from private state instead of scanned.

Nothing about the contracts has to change. `SpendPolicyFactory.createAccount` takes
no `msg.sender`-dependent path and `StealthAnnouncer.announce` only emits, which is
what let a relayer take them over in the first place.

## What we do not claim

- **Not anonymity.** Privacy here is unlinkability inside a crowd, and the crowd is
  however many people use this relayer. With one user, timing correlation restores
  every link. A shared relayer with real traffic is a prerequisite, not a detail.
- **The relayer knows.** Requests are signed so each caller can be quota-limited,
  which means the relayer sees who asked for what. It is trusted not to keep that.
  It is not trusted with money: `createAccount` and `announce` cannot move funds,
  and the gas top-up is a fixed 0.05 USDC of the relayer's own balance, skipped when
  the address already has enough.
- **APS is enclave-based.** Confidentiality rests on hardware attestation and a
  threshold key held across validators, not on a proof anyone can check. That is a
  different assumption from zk, and worth stating rather than blurring.

The honest one-line version: **who you pay, how much, and on what terms is private;
that you funded something is not.**
