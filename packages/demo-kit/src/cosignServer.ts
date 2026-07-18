import { createPublicClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  LocalCoSigner,
  check,
  arcTestnet,
  RPC_URL,
  CTRL_ARCZ_ADDRESS,
  type AuthorizeRequest,
  type AuthorizeResult,
  type RiskVerdict,
} from '@ctrl-arcz/sdk';

/**
 * Server-only co-signer ("The Machine"). Runs the enclave's job off the browser:
 * validate the request against the account's on-chain policy and the poisoning
 * firewall, then return the second signature or a veto. The co-signer key stays
 * server-side. Fail-closed: if the firewall's data source is unreachable, the
 * risk check returns incomplete and the co-signer withholds its signature.
 */

/** The wire shape the browser POSTs (bigints as decimal strings). */
export interface CosignBody {
  account?: string;
  owner?: string;
  target?: string;
  amount?: string;
  nonce?: string;
  chainId?: string;
  policy?: { lockedTarget?: string; remaining?: string; expiry?: number };
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

/** Firewall-backed risk source: the SDK poisoning check, mapped to a verdict. */
async function riskCheck(owner: Address, target: Address): Promise<RiskVerdict | null> {
  const report = await check(owner, target, { client: publicClient, contractAddress: CTRL_ARCZ_ADDRESS });
  return {
    level: report.level,
    complete: report.complete,
    reasons: report.reasons.map((r) => r.message),
  };
}

function reconstruct(body: CosignBody): AuthorizeRequest {
  if (
    !body.account ||
    !body.owner ||
    !body.target ||
    body.amount == null ||
    body.nonce == null ||
    body.chainId == null ||
    !body.policy?.lockedTarget ||
    body.policy.remaining == null ||
    body.policy.expiry == null
  ) {
    throw new Error('missing fields');
  }
  return {
    account: body.account as Address,
    owner: body.owner as Address,
    target: body.target as Address,
    amount: BigInt(body.amount),
    nonce: BigInt(body.nonce),
    chainId: BigInt(body.chainId),
    policy: {
      lockedTarget: body.policy.lockedTarget as Address,
      remaining: BigInt(body.policy.remaining),
      expiry: body.policy.expiry,
    },
  };
}

export async function cosign(params: { privateKey: Hex; body: CosignBody }): Promise<AuthorizeResult> {
  const request = reconstruct(params.body);
  const machine = new LocalCoSigner(params.privateKey, { riskCheck });
  return machine.authorize(request);
}

/** The co-signer's public address — the UI locks it into each account it creates. */
export function cosignerAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}
