/**
 * Emit the cross-implementation parity vectors.
 *
 * Ctrl+ArcZ has a second, independent client: a native Kotlin Android app that
 * re-implements this protocol by hand, because an npm package cannot be consumed
 * from Kotlin without dragging in a JS runtime. That is a reasonable thing to do
 * and a dangerous one to leave unchecked: nothing in either build fails when the
 * two drift, and the failure surfaces on chain, with a user's money. A claim code
 * minted on one platform stops being claimable on the other; a stealth box created
 * on one becomes invisible to the other.
 *
 * These vectors are that check. They are the observable behaviour of the two
 * modules where drift is silent and expensive, written out as data any language can
 * assert against.
 *
 * They are GENERATED, never hand-edited, and `parityVectors.test.ts` fails if the
 * committed file stops matching what the code produces. That is the whole point: a
 * hand-copied vector file rots exactly like hand-copied code, except it rots into a
 * test that can only pass. Change `claimCode.ts` or `stealth.ts` in a way that moves
 * the output and this repo's own test suite goes red until you rerun:
 *
 *   npx tsx packages/sdk/scripts/gen-parity-vectors.ts
 *
 * Every input here is fixed. Nothing calls a CSPRNG, so the output is byte-identical
 * on every machine and every run.
 */
import { writeFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  fromSecret,
  normaliseSecret,
  formatSecret,
  saltFromSecret,
  hashClaim,
  CLAIM_SECRET_BITS,
} from '../src/transfer/claimCode.js';
import {
  deriveStealthKeys,
  generateStealthAddress,
  checkStealthAddress,
  computeStealthPrivateKey,
  STEALTH_KEY_MESSAGE,
  STEALTH_SCHEME_ID,
} from '../src/shield/stealth.js';

// Fixed inputs. A secret a human could actually be handed, plus the mistyping the
// normaliser is supposed to forgive: lower case, wrong grouping, and the Crockford
// aliases (I and L for 1, O for zero) that a person reading off a screen produces.
const SECRETS = ['A4K79QMX2PR6TH8D', '0123456789ABCDEFG'.slice(0, 16), 'ZZZZZZZZZZZZZZZZ'];
// No expected column. A vector file records what the code does; writing down what
// it ought to do would be the same hand-copied expectation this file exists to
// replace, and the first draft of it was already wrong. Whether the behaviour is
// correct is settled by claimCode's own unit tests.
const MISTYPED = ['a4k7-9qmx-2pr6-th8d', 'A4K7 9QMX 2PR6 TH8D', 'aIKLoQMX2PR6TH8D'];
const REJECTED = ['too-short', '', 'A4K79QMX2PR6TH8DE', 'A4K79QMX2PR6TH8U'];

// A signature is 65 bytes; these are fixed stand-ins, not real signatures over the
// message. Key derivation only hashes the bytes, so any fixed input pins the maths.
const SIGNATURES: Hex[] = [
  `0x${'11'.repeat(65)}`,
  `0x${'ab'.repeat(65)}`,
  `0x${'00'.repeat(64)}ff`,
];
const EPHEMERAL_KEYS: Hex[] = [`0x${'22'.repeat(32)}`, `0x${'7f'.repeat(32)}`];

const claim = {
  secretBits: CLAIM_SECRET_BITS,
  derived: SECRETS.map((s) => ({ input: s, ...fromSecret(s) })),
  normalisation: MISTYPED.map((input) => ({ input, normalised: normaliseSecret(input) })),
  rejected: REJECTED.map((input) => ({ input, normalised: normaliseSecret(input) })),
  formatting: SECRETS.map((s) => ({ input: s, formatted: formatSecret(s) })),
  salts: SECRETS.map((s) => ({ secret: s, salt: saltFromSecret(s) })),
  // The commitment the contract recomputes. If this column ever differs between
  // implementations, a transfer created on one platform is unclaimable on the other.
  commitments: SECRETS.map((s) => {
    const salt = saltFromSecret(s);
    return { secret: s, salt, claimHash: hashClaim(salt, s) };
  }),
};

const stealth = {
  schemeId: STEALTH_SCHEME_ID,
  // Byte-exact. A single differing character produces different keys and therefore
  // a box one platform can see and the other cannot.
  keyMessage: STEALTH_KEY_MESSAGE,
  keys: SIGNATURES.map((signature) => ({ signature, ...deriveStealthKeys(signature) })),
  addresses: SIGNATURES.flatMap((signature) => {
    const keys = deriveStealthKeys(signature);
    return EPHEMERAL_KEYS.map((ephemeralKey) => {
      const announcement = generateStealthAddress(keys, ephemeralKey);
      return {
        signature,
        ephemeralKey,
        ...announcement,
        // The payer rediscovering their own box from the announcement alone.
        recovered: checkStealthAddress({
          viewingKey: keys.viewingKey,
          spendingPub: keys.spendingPub,
          ephemeralPubKey: announcement.ephemeralPubKey,
          viewTag: announcement.viewTag,
        }),
        // The key that lets the payer sweep it home.
        stealthPrivateKey: computeStealthPrivateKey({
          spendingKey: keys.spendingKey,
          viewingKey: keys.viewingKey,
          ephemeralPubKey: announcement.ephemeralPubKey,
        }),
      };
    });
  }),
  // A wrong view tag must not match, or scanning would claim boxes that are not ours.
  viewTagMismatch: (() => {
    const keys = deriveStealthKeys(SIGNATURES[0]!);
    const a = generateStealthAddress(keys, EPHEMERAL_KEYS[0]!);
    return {
      viewTag: a.viewTag,
      wrongTag: (a.viewTag + 1) % 256,
      matchedWithWrongTag: checkStealthAddress({
        viewingKey: keys.viewingKey,
        spendingPub: keys.spendingPub,
        ephemeralPubKey: a.ephemeralPubKey,
        viewTag: (a.viewTag + 1) % 256,
      }),
    };
  })(),
};

export const vectors = {
  $comment:
    'GENERATED by packages/sdk/scripts/gen-parity-vectors.ts. Do not edit by hand. ' +
    'Any implementation of the Ctrl+ArcZ protocol must reproduce these exactly. ' +
    'The private keys here are cryptographic test vectors, derived from fixed ' +
    'placeholder signatures, not from any wallet. Every address below is empty ' +
    'and unused on chain, and always will be. Never fund one.',
  claim,
  stealth,
};

export const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'parity-vectors.json',
);

/**
 * Write only when run as a script, never on import.
 *
 * The first version of this file wrote at module scope, and the test meant to catch
 * drift imports it -- so that test rewrote the very file it was about to compare
 * against, and could not fail. It survived a deliberately injected change to the
 * salt domain separator without going red. A guard whose failure mode is silence is
 * worse than no guard, and this one had exactly that shape.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  writeFileSync(VECTORS_PATH, `${JSON.stringify(vectors, null, 2)}
`);
  console.log(`wrote ${VECTORS_PATH}`);
  console.log(
    `  claim: ${claim.derived.length} secrets, ${claim.normalisation.length} normalisations, ${claim.rejected.length} rejections`,
  );
  console.log(`  stealth: ${stealth.keys.length} key sets, ${stealth.addresses.length} addresses`);
}
