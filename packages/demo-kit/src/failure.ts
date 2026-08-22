/**
 * What went wrong, in one sentence a person can act on.
 *
 * A wallet error is written for a developer. Declining an approval prompt
 * produces a page: the request arguments, the decoded contract call, the token
 * address, a docs link and a library version, with "User rejected the request."
 * as the first line and everything after it addressed to whoever wrote the code.
 * Showing that verbatim tells someone who pressed Cancel nothing they did not
 * already know, and tells someone whose RPC is rate limited nothing at all.
 *
 * So errors are classified once, here, and the screens show a sentence. The
 * classification is by symptom rather than by library: an EIP-1193 code, an error
 * name, or the phrase every node client happens to use. That way a rejection
 * still reads as a rejection whether it arrived from viem, from ethers, from a
 * provider that only sets `code`, or from a wallet that only sets a message.
 *
 * The original text is never thrown away. It travels on the `detail` of the
 * result, which is what the row's expanded view and the console get, so a real
 * diagnosis is still one click away from the person who needs it.
 */
import type { TranslationKey } from './i18n/en.js';
import type { Translate } from './i18n/context.js';

export type FailureCode =
  | 'rejected'
  | 'funds'
  | 'allowance'
  | 'nonce'
  | 'ratelimited'
  | 'chain'
  | 'timeout'
  | 'network'
  | 'gas'
  | 'reverted'
  | 'unknown';

export interface Failure {
  code: FailureCode;
  /** The sentence to show. Absent when nothing was recognised. */
  key?: TranslationKey;
  /**
   * The person's own decision rather than something that went wrong.
   *
   * Pressing Cancel is a successful outcome of asking, and a red alarm about it
   * reads as though the wallet broke.
   */
  benign: boolean;
  /** The shortest true thing the error itself said, for the record. */
  detail: string;
}

/** How much of the original text a row can carry before it stops being a row. */
const DETAIL_MAX = 160;

/** Nested causes, deduplicated, and not forever. */
function causes(e: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur != null && depth < 8; depth += 1) {
    if (out.includes(cur)) break;
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** Every string and every code the error and its causes carry, flattened. */
function evidence(e: unknown): { blob: string; codes: Set<number>; names: Set<string> } {
  const codes = new Set<number>();
  const names = new Set<string>();
  const parts: string[] = [];
  for (const node of causes(e)) {
    if (typeof node === 'string') {
      parts.push(node);
      continue;
    }
    const o = node as Record<string, unknown>;
    if (typeof o.code === 'number') codes.add(o.code);
    // Some libraries name the condition in `code` instead: ACTION_REJECTED.
    if (typeof o.code === 'string') names.add(o.code.toLowerCase());
    if (typeof o.name === 'string') names.add(o.name.toLowerCase());
    for (const field of ['shortMessage', 'details', 'reason', 'message'] as const) {
      const v = o[field];
      if (typeof v === 'string') parts.push(v);
    }
  }
  return { blob: parts.join(' \n ').toLowerCase(), codes, names };
}

/**
 * The one line worth keeping.
 *
 * `shortMessage` is viem's own summary and is already a sentence. Anything else
 * gets its first line, because the rest of a wallet error is the appendix.
 */
export function detailOf(e: unknown): string {
  if (typeof e === 'string') return e.slice(0, DETAIL_MAX);
  const short = (e as { shortMessage?: unknown })?.shortMessage;
  const text =
    typeof short === 'string' && short.length > 0
      ? short
      : e instanceof Error
        ? e.message
        : e == null
          ? ''
          : String(e);
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 3)}...` : line;
}

/**
 * The symptoms, most decisive first.
 *
 * Order is by decisiveness, not by likelihood. A declined prompt is a rejection
 * however the rest of the text reads, and a revert is tested last because
 * "execution reverted" is what a node says about a missing allowance just as
 * much as about a broken contract: whichever rule above it matches is the more
 * useful sentence.
 *
 * A rule matches on any of three kinds of evidence, because wallets disagree
 * about which one they set. `codes` are EIP-1193 and JSON-RPC numbers, `names`
 * covers both error class names and the string codes some libraries use instead,
 * and `text` is the phrase node clients have settled on for the condition.
 */
interface Rule {
  code: FailureCode;
  codes?: number[];
  names?: string[];
  text?: RegExp;
}

const RULES: Rule[] = [
  {
    code: 'rejected',
    codes: [4001],
    names: ['userrejectedrequesterror', 'action_rejected'],
    text: /user (rejected|denied|cancell?ed)|rejected the request|denied (transaction|message|request)/,
  },
  { code: 'allowance', text: /insufficient allowance|allowance too low/ },
  {
    code: 'funds',
    names: ['insufficientfundserror'],
    text: /insufficient funds|exceeds the balance|insufficient balance|amount exceeds balance/,
  },
  {
    code: 'nonce',
    text: /nonce too (low|high)|nonce has already been used|replacement transaction underpriced|already known/,
  },
  {
    code: 'ratelimited',
    codes: [-32005],
    text: /rate limit|too many requests|request limit|exceeds defined limit|status(?: code)?:? 429/,
  },
  {
    code: 'chain',
    codes: [4902],
    names: ['chainmismatcherror'],
    text: /chain mismatch|does not match the target chain|unrecognized chain|unsupported chain|wrong network/,
  },
  {
    code: 'timeout',
    names: ['timeouterror', 'waitfortransactionreceipttimeouterror'],
    text: /timed out|timeout/,
  },
  {
    code: 'network',
    names: ['httprequesterror'],
    text: /failed to fetch|fetch failed|network ?error|load failed|socket hang up|econnrefused|connection (refused|closed|reset)/,
  },
  {
    code: 'gas',
    text: /cannot estimate gas|gas required exceeds|intrinsic gas too low|max fee per gas less than|transaction underpriced/,
  },
  {
    code: 'reverted',
    codes: [3],
    names: ['contractfunctionrevertederror', 'executionrevertederror'],
    text: /execution reverted|reverted with|function .* reverted/,
  },
];

export function classifyFailure(e: unknown): Failure {
  const detail = detailOf(e);
  const { blob, codes, names } = evidence(e);

  const hit = RULES.find(
    (rule) =>
      rule.codes?.some((c) => codes.has(c)) ||
      rule.names?.some((n) => names.has(n)) ||
      (rule.text ? rule.text.test(blob) : false),
  );

  const code = hit?.code ?? 'unknown';
  return {
    code,
    ...(hit ? { key: `failure.${code}` as TranslationKey } : {}),
    benign: code === 'rejected',
    detail,
  };
}

/**
 * The sentence, with the step it happened on when the caller knows it.
 *
 * A deposit asks for two signatures in a row, so "you cancelled it" is ambiguous
 * for exactly the length of time it matters. The step turns it back into a fact.
 * When nothing was recognised the error's own line is shown, which is still a
 * sentence rather than a page.
 */
export function failureText(e: unknown, t: Translate, step?: string): string {
  const { key, detail } = classifyFailure(e);
  // `String(e)` on a thrown object is "[object Object]", which is worse than
  // saying nothing in particular.
  const usable = detail.length > 0 && !detail.startsWith('[object ');
  const message = key ? t(key) : usable ? detail : t('failure.unknown');
  return step ? t('failure.at', { step, message }) : message;
}
