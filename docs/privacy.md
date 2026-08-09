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
deploy   (SpendPolicyFactory.createAccount)   sent by relayer
announce (StealthAnnouncer.announce)          sent by relayer, caller = relayer
fund     Circle minter -> box   0.1  USDC     sent by Circle's forwarder
gas      relayer -> stealth     0.05 USDC     sent by relayer
sweep    box    -> stealth      0.1  USDC     sent by stealth
```

None of the five carries the payer's address.

The funding line used to, and it was the one that mattered: it read
`PAYER -> box`, both ends indexed, so anyone could take a wallet's outgoing
transfers, intersect them with the announcer's metadata and recover its boxes with
no viewing key. Measured on a real wallet, that recovered eight boxes out of eight
with no false positives. The box is funded through Circle Gateway now, so the
transfer Arc records is a mint from Circle's minter.

## Why the relay is not cosmetic

It would be, if it stopped at the announcement. Two of those four were removed for
reasons that survive any future privacy upgrade:

- `StealthAnnouncer` indexes `msg.sender`. Announcing from the payer's wallet
  publishes "this address created a stealth box", which is most of what the stealth
  address was there to hide.
- Cancelling used to send the stealth address its gas straight from the payer's
  wallet. On Arc gas is USDC, so this was a plain, public `payer -> stealthAddress`
  transfer: not a hint, the link itself.

Both are gone, and so is the funding transfer they used to sit beside.

What is left is not on the chain. The payer still deposits into Gateway from their
own wallet, in public, and Circle sees both ends of the mint that follows. So the
link moved off the ledger rather than disappearing: reading Arc no longer connects
a payer to their boxes, and Circle could.

## What APS changes, and what it does not

[Arc Privacy Sector](https://docs.arc.io/arc/concepts/opt-in-privacy) is a
confidential execution environment: a transaction is encrypted to the APS network
key and submitted as calldata to a precompile, and the public ledger sees no state,
no return values and no event logs. It is on Arc's roadmap and not yet live.

APS would close the deposit, which is the last public step the payer takes: moving
USDC into Gateway is an ordinary transfer from their own wallet, and inside APS it
would not be. It does not close the sender link: the precompile call is still an
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
2. The Gateway deposit moves inside APS as well, which is the last step still
   submitted by the payer's own wallet. That is what would take the remaining link
   off Circle's books as well as off the chain.
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
- **Circle knows.** The mint that funds a box is Circle's, and it debited the
  payer's Gateway balance to make it. Nothing on Arc joins those two, and Circle
  can. Moving the link off a public ledger and onto one company's records is a real
  improvement over writing it on chain, and it is not the same as nobody knowing.
- **APS is enclave-based.** Confidentiality rests on hardware attestation and a
  threshold key held across validators, not on a proof anyone can check. That is a
  different assumption from zk, and worth stating rather than blurring.

The honest one-line version: **nothing on Arc connects you to your boxes; Circle
still could, and that you hold a Gateway balance is public.**
