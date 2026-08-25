---
title: The Android client
description: "A separate native Kotlin port, held to this repository by byte-identical parity vectors rather than by shared code."
---


The Android client is a separate native Kotlin application. It does not consume
`@ctrl-arcz/sdk`; it is a hand-written port of the same protocol, and its source is
not published here.

![Confirming a send](/android/send-confirm.png)

![Picking a merchant](/android/merchant-picker.png)

![A bridge transfer returned](/android/bridge-returned.png)

What is published is the file that holds it to this repository:
[`ParityVectorsTest.kt`](https://github.com/Farukest/Ctrl-ArcZ/blob/main/docs/android/ParityVectorsTest.kt),
a byte-identical copy of the test
that runs in the Android project's own suite. It contains no application code, no
keys and no endpoints. It is the whole of what the two implementations promise each
other, written as assertions rather than as a claim in a README.

## What it actually asserts

| Area    | Held identical                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Chain   | Chain id, USDC decimals, log range, deploy blocks, and all twelve contract addresses, EIP-55 case included                      |
| Claim   | Secret entropy, derivation from a secret, normalisation of what a user types, what is rejected, grouping, salts and commitments |
| Stealth | Scheme id, the exact signing message, key derivation, generated stealth addresses, view tags, recognition and the spending key  |

The two that matter most are the least obvious. Addresses are compared with their
checksum case intact, because that is where the two sides drifted the first time.
And the stealth signing message is compared character for character, because one
character apart derives different keys from the same wallet signature, which loses
every box the other platform created.

## Why this is checkable and not just stated

The vectors are never generated on the Android side. They come from this repository,
and three things link the chain end to end:

1. `packages/sdk/scripts/gen-parity-vectors.ts` derives every vector from the SDK's
   own code. Nothing in it reaches a CSPRNG, so the output is the same on every run.
2. `packages/sdk/test/parityVectors.test.ts` fails if the committed
   `packages/sdk/parity-vectors.json` is not what the code produces right now. Change
   `claimCode.ts` or `stealth.ts` without regenerating and this repository goes red
   before anything reaches the other implementation.
3. The Android project's `app/src/test/resources/parity-vectors.json` is a copy of
   that same file. At the time this was written both were
   `md5 0c46c0edc9bb77d40f34d0663c318189`, so the assertions above ran against these
   exact values.

So the part you cannot read is pinned to the part you can. A port that drifts fails a
test rather than a payment.

## Refreshing it

On the Android side the vectors are a file copy:

```bash
cp <monorepo>/packages/sdk/parity-vectors.json app/src/test/resources/
```

The copy of the test in this directory is refreshed the same way, from
`app/src/test/java/xyz/ctrlarcz/domain/crypto/ParityVectorsTest.kt`. It is kept
byte-identical on purpose: an edited copy would prove nothing.
