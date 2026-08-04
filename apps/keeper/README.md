# @ctrl-arcz/keeper

An autonomous agent that returns expired unclaimed transfers to the people who
sent them, and pays for its own gas out of a budget the chain enforces.

## Why it exists

`reclaimExpired` is permissionless: anyone may call it, and the contract always
sends the money to the original sender. That makes the refund *possible* without
trusting anyone, but permissionless is not automatic. Until something actually
calls it, an unclaimed transfer just sits in the contract. The keeper is the
something.

This is also where the agent case stops being a diagram. The keeper holds a key
and decides for itself when to spend, and the reason that is safe to run
unattended is structural, not a promise:

| What it can do | What stops it going further |
| --- | --- |
| Call `reclaimExpired` | The contract pays `t.sender`. The keeper picks *which* transfer, never *who* gets paid. |
| Draw its own salary | A `SpendPolicyAccount` in PULL mode: target locked to the keeper, a per-pull ceiling, a minimum interval, a total budget, an expiry, all on chain. |
| Nothing else | It has no owner signature for anyone else's box, is never told a vault address, and never sees a claim code. |

Revoking it is one `sweepToVault` from the operator's wallet. That call is gated
on `msg.sender == vault`, so the keeper cannot make it and cannot stop it.

## Verified on Arc Testnet

Transfer #50, 0.05 USDC, created with a 60-second window and left unclaimed:

```
transfer #50 status: RECLAIMED
TransferReclaimed:
  caller (who paid gas): 0x2dc7618c07FA3d3F166F5469770123306cb50d41   <- the keeper
  sender (who got paid): 0x46D060E22B84BFE396DF9CE61D5bA217ba6346C5   <- the original sender
  amount: 0.05 USDC
recorded recipient balance: 0 USDC   <- it never claimed, and never received
keeper balance: 1.0 -> 0.998347      <- it paid gas and took nothing
```

Four attacks against its own salary box, run with the keeper's real key:

```
A. asked the co-signer for 10x the per-pull cap -> VETOED: amount exceeds the remaining policy limit
B. forged the co-signer signature               -> reverted on chain
C. swept the box to itself                      -> reverted (NotVault)
D. swept the box to the correct vault           -> reverted (gated on msg.sender, not knowledge)
box still holds 0.4 USDC after all four
```

Then the operator revoked it: `sweepToVault` from the vault wallet moved the
remaining 0.4 USDC home in one transaction.

## Decisions it makes

All of it is in `src/decide.ts`, which is pure: it takes a snapshot of chain
state and returns what to do, so the rules are testable without a chain and the
reasons it reports are the reasons it acted.

- **Is it reclaimable?** Only `PENDING` and `LOCKED`. A frozen transfer still
  holds funds, so five wrong guesses must not strand the money.
- **Has the deadline actually passed?** The contract's gate is
  `block.timestamp <= deadline`, so equality is not yet reclaimable. Getting this
  off by one just buys a reverting transaction.
- **Is it worth the gas?** The keeper pays and someone else gets paid, so it
  never profits; the question is whether the action leaves the system better off.
  Burning 0.02 USDC to return 0.01 destroys value, so it declines, which is also
  what makes a swarm of dust transfers a non-event rather than a way to drain it.
- **What first?** Largest amount first, so a short budget rescues the most money
  it can. The rest stay reclaimable; nothing expires twice.
- **Does it need to refuel?** Only below the low-water mark, only after the
  interval the box enforces, and only for the shortfall, capped by the per-pull
  ceiling, the remaining budget, and what the box actually holds.

On Arc the keeper's operating cost and the money it rescues are the same asset,
so its entire blast radius is one number in USDC that the operator chose and can
read back from chain.

## Run it

```bash
cp .env.example .env      # set KEEPER_PK (throwaway testnet key)
pnpm --filter @ctrl-arcz/keeper start
```

`KEEPER_DRY_RUN=1` decides and logs without sending anything. `--once` runs a
single tick and exits, which is what a cron-style deployment wants.

To give it a budget, with the co-signer running:

```bash
OPERATOR_PK=0x... KEEPER_PK=0x... \
  pnpm --filter @ctrl-arcz/keeper exec tsx scripts/create-salary-box.ts
```

That prints the box address for `KEEPER_SALARY_BOX`. Without one the keeper still
reclaims. It just cannot refill itself and stops at its reserve.

## Tests

`pnpm --filter @ctrl-arcz/keeper test` runs 33 unit tests, no chain and no funds.
The ledger tests cover the failure that once wedged this project's event watcher:
a tick that fails must not make the next request larger.
