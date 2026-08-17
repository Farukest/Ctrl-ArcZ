import { describe, expect, it, beforeAll } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ADDRESSES, MODE_PULL } from '@ctrl-arcz/sdk';
import type * as Handlers from '../src/handlers.js';

/**
 * `parsePolicy` is what stands between a request and a call the relayer signs, so
 * it is tested directly rather than through the route: the route adds a signature
 * and a quota, and neither of those is what decides whether a box is one this
 * operator meant to deploy.
 *
 * The co-signer key has to exist before the module is imported, because the
 * handler reads `env` at call time and refuses without one.
 */
const cosignerPk = generatePrivateKey();
process.env.COSIGNER_PK = cosignerPk;

let parsePolicy: typeof Handlers.parsePolicy;
let cosigner: string;

beforeAll(async () => {
  ({ parsePolicy } = await import('../src/handlers.js'));
  cosigner = privateKeyToAccount(cosignerPk).address;
});

const salt = `0x${'11'.repeat(32)}`;
const someone = () => privateKeyToAccount(generatePrivateKey()).address;

const body = (over: Record<string, unknown> = {}) => ({
  salt,
  policy: {
    token: ADDRESSES.USDC,
    owner: someone(),
    cosigner,
    vault: someone(),
    target: someone(),
    maxAmount: '1000000',
    perPullMax: '100000',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    interval: 60,
    mode: MODE_PULL,
    ...over,
  },
});

describe('which tokens the relayer will deploy a box for', () => {
  it('accepts USDC', () => {
    expect(parsePolicy(body()).policy.token).toBe(ADDRESSES.USDC);
  });

  it('accepts EURC, which is why the list exists', () => {
    expect(parsePolicy(body({ token: ADDRESSES.EURC })).policy.token).toBe(ADDRESSES.EURC);
  });

  it('refuses anything else, and names what it does take', () => {
    expect(() => parsePolicy(body({ token: someone() }))).toThrow(/only USDC and EURC/);
  });

  /**
   * The point of the allowlist is that the relayer signs a call the operator
   * chose. Comparing the caller's string and then writing that same string back
   * would make the check advisory, so the parsed policy has to carry our address,
   * not theirs, even when the two compare equal.
   */
  it('writes back our own address, not the caller´s spelling of it', () => {
    const out = parsePolicy(body({ token: ADDRESSES.EURC.toLowerCase() }));
    expect(out.policy.token).toBe(ADDRESSES.EURC);
    expect(out.policy.token).not.toBe(ADDRESSES.EURC.toLowerCase());
  });

  it('still pins the co-signer to this server', () => {
    expect(() => parsePolicy(body({ cosigner: someone() }))).toThrow(/cosigner is not this server/);
  });
});

describe('the demo ceiling', () => {
  /**
   * It used to be a fixed count of base units with a comment calling it 1000 USDC,
   * which is only the same thing while every token has six decimals. A thousand
   * whole tokens is the rule; the base-unit figure follows from the token.
   */
  it('allows a thousand whole tokens', () => {
    expect(parsePolicy(body({ maxAmount: '1000000000' })).policy.maxAmount).toBe(1_000_000_000n);
  });

  it('refuses more than a thousand', () => {
    expect(() => parsePolicy(body({ maxAmount: '1000000001' }))).toThrow(/above the demo ceiling/);
  });

  it('applies to perPullMax as well as to the total', () => {
    expect(() => parsePolicy(body({ perPullMax: '1000000001' }))).toThrow(
      /above the demo ceiling/,
    );
  });
});
