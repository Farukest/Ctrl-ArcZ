/**
 * Wallet errors, as the screens have to read them.
 *
 * The fixtures are real shapes rather than invented ones: the rejection is the
 * one MetaMask produced when an approval prompt was declined on Base Sepolia,
 * down to the request arguments and the version line, and the rate limit is the
 * one that made a deposit fail while the site itself was working. Both are the
 * cases this exists for, so both are tested as they actually arrive.
 */
import { describe, it, expect } from 'vitest';
import { classifyFailure, detailOf, failureText } from '../src/failure.js';
import { en } from '../src/i18n/en.js';
import { tr } from '../src/i18n/tr.js';

/** The dictionary, as a `Translate`, without a React tree to hold it. */
const translate =
  (dict: Record<string, string>) =>
  (key: string, params?: Record<string, string | number>): string =>
    (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? `{${k}}`));

const t = translate(en) as never;
const tTr = translate(tr) as never;

/** A viem error: a one-line summary, and a page of everything else. */
function viemError(shortMessage: string, extra = ''): Error {
  const e = new Error(
    `${shortMessage}\n\nRequest Arguments:\n  chain: chain-84532 (id: 84532)\n  from: 0x1111111111111111111111111111111111111111\n  to: 0x036CbD53842c5426634e7929541eC2318f3dCF7e\n  data: 0x095ea7b3\n\nContract Call:\n  address: 0x036CbD53842c5426634e7929541eC2318f3dCF7e\n  function: approve(address spender, uint256 amount)\n  args: (0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA, 1018779)\n\nDocs: https://viem.sh/docs/contract/writeContract\n${extra}\nVersion: viem@2.55.0`,
  );
  Object.assign(e, { shortMessage, name: 'ContractFunctionExecutionError' });
  return e;
}

describe('classifyFailure', () => {
  it('reads a declined approval prompt as the person cancelling', () => {
    const e = viemError(
      'User rejected the request.',
      'Details: Request Signature: User denied request signature.',
    );
    const f = classifyFailure(e);
    expect(f.code).toBe('rejected');
    expect(f.benign).toBe(true);
  });

  it('reads a rejection that only carries the EIP-1193 code', () => {
    expect(classifyFailure({ code: 4001, message: 'unknown' }).code).toBe('rejected');
  });

  it('reads a rejection nested under a cause', () => {
    const inner = Object.assign(new Error('user denied'), { name: 'UserRejectedRequestError' });
    const outer = Object.assign(new Error('Transaction failed'), { cause: inner });
    expect(classifyFailure(outer).code).toBe('rejected');
  });

  it("reads ethers' string code as a rejection too", () => {
    expect(classifyFailure({ code: 'ACTION_REJECTED', message: 'rejected' }).code).toBe('rejected');
  });

  it('tells a rate limit from a failure of ours', () => {
    const e = new Error(
      'Request exceeds defined limit.\n\nDetails: RPC 0x14a34 Custom eth_getBlockByNumber: Request is being rate limited.\nVersion: viem@2.55.0',
    );
    expect(classifyFailure(e).code).toBe('ratelimited');
    expect(classifyFailure({ code: -32005, message: 'nope' }).code).toBe('ratelimited');
  });

  it('separates a missing balance from a missing approval', () => {
    expect(classifyFailure(new Error('insufficient funds for gas * price + value')).code).toBe(
      'funds',
    );
    expect(classifyFailure(viemError('ERC20: insufficient allowance')).code).toBe('allowance');
  });

  it('prefers the specific cause over the bare revert it arrives as', () => {
    // A node says "execution reverted" about a missing allowance as readily as
    // about a broken contract; the row that says which is the useful one.
    const e = viemError('execution reverted: ERC20: transfer amount exceeds balance');
    expect(classifyFailure(e).code).toBe('funds');
  });

  it('still calls a plain revert a revert', () => {
    expect(classifyFailure(viemError('The contract function "pull" reverted.')).code).toBe(
      'reverted',
    );
  });

  it('recognises the remaining shapes a wallet fails in', () => {
    const cases: Array<[unknown, string]> = [
      [new Error('nonce too low'), 'nonce'],
      [new Error('replacement transaction underpriced'), 'nonce'],
      [{ code: 4902, message: 'Unrecognized chain ID' }, 'chain'],
      [Object.assign(new Error('x'), { name: 'ChainMismatchError' }), 'chain'],
      [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'timeout'],
      [new Error('Failed to fetch'), 'network'],
      [new Error('cannot estimate gas; transaction may fail'), 'gas'],
    ];
    for (const [e, code] of cases) expect(classifyFailure(e).code, String(code)).toBe(code);
  });

  it('says nothing it cannot tell, rather than guessing', () => {
    const f = classifyFailure(new Error('Something specific went wrong'));
    expect(f.code).toBe('unknown');
    expect(f.key).toBeUndefined();
    expect(f.benign).toBe(false);
  });

  it('survives an error that is not one', () => {
    for (const e of [null, undefined, 'plain string', 42, {}, { cause: {} }]) {
      expect(() => classifyFailure(e)).not.toThrow();
    }
    expect(classifyFailure('user rejected the request').code).toBe('rejected');
  });

  it('does not loop on an error that causes itself', () => {
    const e: { cause?: unknown; message: string } = { message: 'round we go' };
    e.cause = e;
    expect(classifyFailure(e).code).toBe('unknown');
  });
});

describe('detailOf', () => {
  it('keeps the summary line and drops the appendix', () => {
    const detail = detailOf(viemError('User rejected the request.'));
    expect(detail).toBe('User rejected the request.');
    expect(detail).not.toContain('viem@');
    expect(detail).not.toContain('Contract Call');
  });

  it('caps anything that arrives without a summary', () => {
    expect(detailOf(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(160);
  });
});

describe('failureText', () => {
  const rejected = viemError(
    'User rejected the request.',
    'Details: Request Signature: User denied request signature.',
  );

  it('replaces the page with a sentence', () => {
    const text = failureText(rejected, t);
    expect(text).toBe('You cancelled it in your wallet. Nothing happened on chain.');
    expect(text).not.toContain('0x');
    expect(text).not.toContain('viem');
    expect(text.split('\n')).toHaveLength(1);
  });

  it('names the prompt when the caller knows which one it was', () => {
    expect(failureText(rejected, t, 'Approve')).toBe(
      'Approve: You cancelled it in your wallet. Nothing happened on chain.',
    );
  });

  it('answers in the language on screen', () => {
    expect(failureText(rejected, tTr)).toBe(
      'Cüzdanınızda iptal ettiniz. Zincirde hiçbir şey olmadı.',
    );
  });

  it('falls back to what the error said when it recognises nothing', () => {
    expect(failureText(new Error('Box is not fundable yet'), t)).toBe('Box is not fundable yet');
  });

  it('says something rather than "[object Object]"', () => {
    expect(failureText({}, t)).toBe('It did not go through.');
  });

  it('has a sentence for every code it can return', () => {
    const codes = [
      'rejected',
      'funds',
      'allowance',
      'nonce',
      'ratelimited',
      'chain',
      'timeout',
      'network',
      'gas',
      'reverted',
      'unknown',
    ];
    for (const code of codes) {
      expect(en[`failure.${code}` as keyof typeof en], code).toBeTruthy();
      expect(tr[`failure.${code}` as keyof typeof tr], code).toBeTruthy();
    }
  });
});
