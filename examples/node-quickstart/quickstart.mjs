/**
 * Ctrl+ArcZ SDK — headless quickstart.
 *
 * This is what an integrating dApp / backend does: install `@ctrl-arcz/sdk` and
 * `viem`, bring your own viem clients (the SDK never touches wallets), and call
 * the functions. It runs the full path against Arc testnet:
 *
 *   1. check()          — the pre-send firewall (blocks address poisoning)
 *   2. sendProtected()  — lock funds under a claim code
 *   3. claim()          — recipient releases the funds with the code + salt
 *
 * Run:  SENDER_PK=0x.. RECIPIENT=0x.. RECIPIENT_PK=0x.. pnpm start
 * (see .env.example)
 */
import {
  arcTestnet,
  RPC_URL,
  check,
  shouldBlockSend,
  defineConfig,
  registerConfig,
  generateClaimCode,
  sendProtected,
  claim,
  getTransfer,
} from '@ctrl-arcz/sdk';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
};

const SENDER_PK = need('SENDER_PK');
const RECIPIENT = need('RECIPIENT');
const RECIPIENT_PK = need('RECIPIENT_PK');
const AMOUNT = process.env.AMOUNT ?? '0.01'; // USDC

// --- Bring your own viem clients (Arc testnet; override contractAddress for a
//     different deployment via the `clients.contractAddress` field). ----------
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });

const senderAccount = privateKeyToAccount(SENDER_PK);
const sender = {
  publicClient,
  walletClient: createWalletClient({
    account: senderAccount,
    chain: arcTestnet,
    transport: http(RPC_URL),
  }),
};

// A per-app policy (recall window, when to warn/block). Register it once on-chain.
const config = defineConfig({ recallWindow: 3600, onWarning: 'warn' });

async function main() {
  console.log('sender   :', senderAccount.address);
  console.log('recipient:', RECIPIENT, '\n');

  // 1) FIREWALL — always check before sending. `block` = do not send.
  const risk = await check(senderAccount.address, RECIPIENT, { client: publicClient });
  console.log(
    `1. check()  -> ${risk.level}  [${risk.reasons.map((r) => r.code).join(', ') || '-'}]`,
  );
  if (shouldBlockSend(config, risk.level)) {
    console.log('   blocked by the firewall — aborting the send.');
    return;
  }

  // 2) PROTECTED SEND — lock the funds; the recipient needs the code to claim.
  const { configId } = await registerConfig(sender, config);
  const secret = generateClaimCode();
  const sent = await sendProtected(sender, {
    configId,
    to: RECIPIENT,
    amount: parseUnits(AMOUNT, 6), // USDC has 6 decimals
    claimHash: secret.claimHash,
  });
  console.log(`2. send()   -> transfer #${sent.transferId}  code ${secret.code}`);
  // Hand `secret.code` to the recipient over a separate channel, and the link
  // `?tid=${sent.transferId}&salt=${secret.salt}` for the salt.

  // 3) CLAIM — the recipient (a different wallet) releases the funds.
  const recipientAccount = privateKeyToAccount(RECIPIENT_PK);
  const recipient = {
    publicClient,
    walletClient: createWalletClient({
      account: recipientAccount,
      chain: arcTestnet,
      transport: http(RPC_URL),
    }),
  };
  const tx = await claim(recipient, sent.transferId, secret.code, secret.salt);
  console.log(`3. claim()  -> ${tx}`);

  const final = await getTransfer(sender, sent.transferId);
  console.log(`4. status   -> ${final.status}`);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
