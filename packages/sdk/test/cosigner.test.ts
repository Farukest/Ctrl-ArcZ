import { describe, expect, it } from 'vitest';
import { recoverMessageAddress, type Address } from 'viem';
import { LocalCoSigner, type RiskVerdict } from '../src/shield/cosigner.js';
import { payStructHash } from '../src/shield/digest.js';

const COSIGNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OWNER = '0x0000000000000000000000000000000000000a11' as Address;
const ACCOUNT = '0x0000000000000000000000000000000000000acc' as Address;
const MERCHANT = '0x0000000000000000000000000000000000000b22' as Address;
const DRAINER = '0x000000000000000000000000000000000000dead' as Address;
const CHAIN = 5042002n;

const safe: RiskVerdict = { level: 'safe', complete: true };
const blocked: RiskVerdict = { level: 'block', complete: true, reasons: ['known drainer'] };

function req(overrides: Partial<Parameters<LocalCoSigner['authorize']>[0]> = {}) {
  return {
    account: ACCOUNT,
    owner: OWNER,
    target: MERCHANT,
    amount: 50n,
    nonce: 0n,
    chainId: CHAIN,
    policy: { lockedTarget: MERCHANT, remaining: 100n, expiry: 4_000_000_000 },
    now: 1_000_000_000,
    ...overrides,
  };
}

describe('LocalCoSigner (The Machine)', () => {
  it('signs a clean, in-policy request; the signature recovers to the cosigner', async () => {
    const cs = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => safe });
    const res = await cs.authorize(req());
    expect(res.approved).toBe(true);
    if (!res.approved) return;
    const hash = payStructHash({ account: ACCOUNT, target: MERCHANT, amount: 50n, nonce: 0n, chainId: CHAIN });
    const recovered = await recoverMessageAddress({ message: { raw: hash }, signature: res.signature });
    expect(recovered.toLowerCase()).toBe(cs.address.toLowerCase());
  });

  it('vetoes when the firewall blocks the target', async () => {
    const cs = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => blocked });
    const res = await cs.authorize(req({ target: DRAINER, policy: { lockedTarget: DRAINER, remaining: 100n, expiry: 4_000_000_000 } }));
    expect(res.approved).toBe(false);
    if (res.approved) return;
    expect(res.riskReasons).toContain('known drainer');
  });

  it('fails closed when risk data is unavailable', async () => {
    const cs = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => null });
    const res = await cs.authorize(req());
    expect(res.approved).toBe(false);
  });

  it('fails closed when the risk check throws', async () => {
    const cs = new LocalCoSigner(COSIGNER_PK, {
      riskCheck: async () => {
        throw new Error('blockscout down');
      },
    });
    const res = await cs.authorize(req());
    expect(res.approved).toBe(false);
  });

  it('fails closed with no risk source configured', async () => {
    const cs = new LocalCoSigner(COSIGNER_PK);
    const res = await cs.authorize(req());
    expect(res.approved).toBe(false);
  });

  it('vetoes a target that does not match the locked policy (redirect attempt)', async () => {
    const cs = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => safe });
    const res = await cs.authorize(req({ target: DRAINER })); // policy still locks MERCHANT
    expect(res.approved).toBe(false);
    if (res.approved) return;
    expect(res.reason).toMatch(/locked policy target/);
  });

  it('vetoes over-limit and expired requests', async () => {
    const cs = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => safe });
    const over = await cs.authorize(req({ amount: 500n }));
    expect(over.approved).toBe(false);
    const expired = await cs.authorize(req({ now: 5_000_000_000 }));
    expect(expired.approved).toBe(false);
  });

  it('vetoOn: warning is stricter than the default', async () => {
    const warn: RiskVerdict = { level: 'warning', complete: false, reasons: ['new address'] };
    const lenient = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => warn });
    const strict = new LocalCoSigner(COSIGNER_PK, { riskCheck: async () => warn, vetoOn: 'warning' });
    expect((await lenient.authorize(req())).approved).toBe(true);
    expect((await strict.authorize(req())).approved).toBe(false);
  });
});
