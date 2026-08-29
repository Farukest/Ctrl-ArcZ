import { describe, expect, it } from 'vitest';
import {
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  DEPOSIT_CONFIRMATION_SECONDS,
  GATEWAY_CHAIN_NAMES,
  chainLabel,
  deployedChainIds,
  type CctpChainName,
} from '@ctrl-arcz/sdk';
import {
  chainsFor,
  depositWaitLabel,
  labelOf,
  needsWalletOn,
  type ChainPurpose,
} from '../src/chainCatalog.js';
import { supportsChain } from '../src/chainSupport.js';
import { en } from '../src/i18n/en.js';
import { tr } from '../src/i18n/tr.js';

/**
 * Which networks a job can be done on.
 *
 * The rule being pinned here is that this file composes the registries rather than
 * restating them: every list has to be derivable from `CCTP_CHAINS`,
 * `GATEWAY_CHAIN_NAMES` and the deployment registry, so adding a chain is a data
 * change and never an edit here. The thing that made these tests necessary was a
 * second, hand-written chain table that had drifted -- five Gateway chains where
 * Circle serves eleven, and ids Circle does not use.
 */

const PURPOSES: ChainPurpose[] = [
  'protectedSend',
  'receive',
  'privatePay',
  'subscriptions',
  'cctpSource',
  'cctpDestination',
  'gatewayDeposit',
  'gatewaySource',
  'gatewayDestination',
];

describe('chainsFor', () => {
  it('never offers a network the job cannot be done on', () => {
    // The whole premise of the redesign: an unusable chain is absent, not greyed
    // out and not behind a "switch networks" screen. So for every one of our own
    // features, every chain offered must actually support it.
    for (const purpose of ['protectedSend', 'receive', 'privatePay', 'subscriptions'] as const) {
      for (const name of chainsFor(purpose)) {
        expect(supportsChain(CCTP_CHAINS[name].chainId, purpose)).toBe(true);
      }
    }
  });

  it('offers every chain that does support the job, not a subset somebody typed', () => {
    // The inverse, which is the half a hand-written list gets wrong: a chain we
    // deployed to and then forgot to add to a picker is invisible for no reason.
    for (const purpose of ['protectedSend', 'receive', 'privatePay', 'subscriptions'] as const) {
      const offered = new Set(chainsFor(purpose));
      for (const chainId of deployedChainIds()) {
        if (!supportsChain(chainId, purpose)) continue;
        const name = (Object.keys(CCTP_CHAINS) as CctpChainName[]).find(
          (n) => CCTP_CHAINS[n].chainId === chainId,
        );
        expect(name && offered.has(name)).toBe(true);
      }
    }
  });

  it('does not gate CCTP on our own deployments', () => {
    /*
     * Bridging is Circle's, not ours: no contract of ours is involved, so a chain
     * we have never deployed to bridges perfectly well. Filtering these by the
     * deployment registry would refuse fifteen of the twenty for a reason that
     * does not apply to them.
     */
    expect(chainsFor('cctpSource')).toHaveLength(Object.keys(CCTP_CHAINS).length);
    expect(chainsFor('cctpDestination')).toHaveLength(Object.keys(CCTP_CHAINS).length);
    expect(chainsFor('cctpSource').length).toBeGreaterThan(deployedChainIds().length);
  });

  it('offers exactly the chains Circle runs Gateway on', () => {
    // Not a copy of that list: the same list. The table this replaced had five.
    for (const purpose of ['gatewayDeposit', 'gatewaySource', 'gatewayDestination'] as const) {
      expect([...chainsFor(purpose)].sort()).toEqual([...GATEWAY_CHAIN_NAMES].sort());
    }
    expect(GATEWAY_CHAIN_NAMES.length).toBe(11);
  });

  it('puts Arc first wherever Arc is on offer', () => {
    // Where every contract lives, and the answer to "put me back".
    for (const purpose of PURPOSES) {
      const list = chainsFor(purpose);
      const arc = list.find((n) => CCTP_CHAINS[n].chainId === ARC_TESTNET_CHAIN_ID);
      if (arc) expect(list[0]).toBe(arc);
    }
  });

  it('returns names the chain registry actually knows', () => {
    /*
     * The failure that motivated deleting the old table: it named
     * `Optimism_Sepolia` and `Polygon_Amoy_Testnet`, while Circle calls them
     * `OP_Sepolia` and `Polygon_Amoy`. A lookup for either missed silently, so the
     * two entries most likely to be looked up were the two guaranteed to fail.
     */
    for (const purpose of PURPOSES) {
      for (const name of chainsFor(purpose)) {
        expect(CCTP_CHAINS[name]).toBeDefined();
      }
    }
  });

  it('lists each chain once', () => {
    for (const purpose of PURPOSES) {
      const list = chainsFor(purpose);
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe('needsWalletOn', () => {
  it('asks for the wallet only where something is signed on that chain', () => {
    // A CCTP burn leaves the wallet, a Gateway deposit is a transaction, and our
    // own contracts are reached through a client pinned to the connected chain.
    for (const purpose of [
      'cctpSource',
      'gatewayDeposit',
      'protectedSend',
      'receive',
      'privatePay',
      'subscriptions',
    ] as const) {
      expect(needsWalletOn(purpose)).toBe(true);
    }
  });

  it('does not move the wallet for a Gateway source', () => {
    /*
     * The expensive mistake to get wrong in the permissive direction. A Gateway
     * spend is one signature over an intent whose EIP-712 domain names no chain;
     * there is no source-chain transaction at all. Prompting MetaMask when
     * somebody picks a source network would be a wallet popup that buys nothing
     * and interrupts the form it appears over.
     */
    expect(needsWalletOn('gatewaySource')).toBe(false);
    // Destinations are the other side of the same fact: nothing is signed there.
    expect(needsWalletOn('cctpDestination')).toBe(false);
    expect(needsWalletOn('gatewayDestination')).toBe(false);
  });
});

describe('labelOf', () => {
  it('is the one rule, and it is the registry’s', () => {
    // There were two, and the second one existed only to be fallen back from.
    for (const name of Object.keys(CCTP_CHAINS) as CctpChainName[]) {
      expect(labelOf(name)).toBe(chainLabel(name));
    }
  });

  it('reads the chains whose old hand-written labels used the wrong id', () => {
    expect(labelOf('OP_Sepolia')).toBe('OP Sepolia');
    expect(labelOf('Polygon_Amoy')).toBe('Polygon Amoy');
  });
});

describe('depositWaitLabel', () => {
  it('is seconds under a minute and whole minutes above it', () => {
    // Arc counts in one second, Base in nineteen minutes. Both are Circle's
    // published figures and neither is rounded towards the other.
    expect(depositWaitLabel('Arc_Testnet')).toBe('1s');
    expect(depositWaitLabel('Sonic_Testnet')).toBe('8s');
    expect(depositWaitLabel('Base_Sepolia')).toBe('19m');
  });

  it('says nothing when there is no chain to say it about', () => {
    // The bridge can render its deposit box for a frame before a source is
    // settled, and "undefineds" is worse than an empty line.
    expect(depositWaitLabel(undefined)).toBe('');
  });

  it('answers for every Gateway chain', () => {
    for (const chain of GATEWAY_CHAIN_NAMES) {
      expect(depositWaitLabel(chain)).toMatch(/^\d+[sm]$/);
    }
  });
});

/**
 * The small print under the deposit field, and why it has a length budget.
 *
 * The box used to render up to four independent lines here, so choosing a network
 * the wallet was not on made it a line taller and shifted the whole bridge below
 * it. It now shows exactly one of them, and the stylesheet holds two lines of room
 * for that one below 520px and one line above -- which fixes the height only as
 * long as no sentence outgrows the room held for it.
 *
 * Sixty characters is the measured budget. The region is 224px wide at a 380px
 * viewport, which is about thirty-seven characters of 12px text, so two lines is
 * seventy-four and every variant has to fit inside that once `{amount}` has taken
 * its widest value. Above the breakpoint the region is wide enough that the same
 * sixty characters fit on the single line held there.
 *
 * The heights themselves are checked in a browser, which is the only place a wrap
 * is real. What this stops is a translation being added months from now that
 * quietly puts the jump back.
 */
describe('the deposit note fits the room held for it', () => {
  const KEYS = [
    'bridge.gwDepositWait',
    'bridge.gwWalletOtherChain',
    'bridge.gwWalletUnreadable',
    'bridge.gwDepositTooBig',
    'bridge.gwPending',
  ] as const;

  const filled = (s: string) =>
    s.replace('{wait}', '19m').replace('{amount}', '176.502194').replace('{chain}', '');

  for (const [name, dict] of [
    ['en', en],
    ['tr', tr],
  ] as const) {
    it(`in ${name}`, () => {
      for (const key of KEYS) {
        expect(filled(dict[key]).length, `${name} ${key}`).toBeLessThanOrEqual(60);
      }
    });
  }

  it('never names the chain, which the box is already titled with', () => {
    // Three mentions of "World Chain Sepolia" in one small box, and the third one
    // was what pushed the line into wrapping.
    for (const key of KEYS) {
      expect(en[key]).not.toContain('{chain}');
      expect(tr[key]).not.toContain('{chain}');
    }
  });

  it('leaves the wait sayable from every state that has one', () => {
    // Hiding a line is only acceptable because the line that wins carries what the
    // hidden one would have said. These two are shown instead of the plain wait,
    // so they have to carry it.
    expect(en['bridge.gwWalletOtherChain']).toContain('{wait}');
    expect(en['bridge.gwPending']).toContain('{wait}');
    expect(tr['bridge.gwWalletOtherChain']).toContain('{wait}');
    expect(tr['bridge.gwPending']).toContain('{wait}');
  });
});

/**
 * `DEPOSIT_CONFIRMATION_SECONDS` is Circle's and this file only words it. Pinned so
 * that a chain added to the registry without a wait fails here rather than printing
 * "NaNs" under a deposit field.
 */
describe('every Gateway chain has a published wait', () => {
  it('and it is a real number of seconds', () => {
    for (const chain of GATEWAY_CHAIN_NAMES) {
      expect(Number.isFinite(DEPOSIT_CONFIRMATION_SECONDS[chain])).toBe(true);
      expect(DEPOSIT_CONFIRMATION_SECONDS[chain]).toBeGreaterThan(0);
    }
  });
});
