/**
 * What a payment costs on top of itself, on a chain that charges gas in the money
 * being sent.
 *
 * Arc prices gas in USDC out of the same balance the transfer comes from, so the
 * amount and the cost are never separable the way they are on a chain with a
 * separate gas token. Two things follow, and both used to be worked out per screen:
 * a "send everything" has to hold something back or it produces a transaction that
 * cannot be mined, and a confirmation that shows only the amount is showing the
 * smaller of the two figures that leave the wallet.
 *
 * The numbers here match the Android client's `TransferService` exactly, because a
 * user with both should not be quoted two different costs for the same payment.
 */

/** Arc prices gas in its 18-decimal native unit. Balances are 6-decimal USDC. */
const NATIVE_DECIMALS = 18n;
const USDC_DECIMALS = 6n;

/** Approve plus the memo-wrapped send, with headroom. */
export const SEND_GAS_LIMIT = 700_000n;

/**
 * The three transactions a private payment sends from this wallet.
 *
 * Measured on Arc Testnet rather than guessed: deploying the disposable account
 * costs 252,592, funding it is an ordinary USDC transfer at 48,950, and the account
 * paying the merchant is 142,820. That is 444,362, and this is twice it.
 *
 * Generous on purpose, and not symmetrical with the send. Reserving too much costs
 * somebody the last cent of a "Max"; reserving too little strands a payment after
 * the account exists and holds the money but the wallet cannot afford the
 * transaction that pays it out.
 */
export const PAY_GAS_LIMIT = 900_000n;

/** 0.05 USDC, in case the node reports an unusable gas price. */
export const MIN_GAS_RESERVE = 50_000n;

/**
 * What to hold back from a balance so the transaction spending it can be paid for.
 *
 * The live gas price times a limit that covers every transaction the operation
 * sends, with a floor so a momentarily zero gas price cannot produce a zero
 * reserve.
 *
 * Units matter: gas is priced in the 18-decimal native unit while USDC balances are
 * 6-decimal, so the estimate is scaled down before it can be compared with one.
 * Skipping that step makes the reserve a trillion times too large and every balance
 * unspendable.
 */
export function gasReserve(gasPrice: bigint, gasLimit: bigint = SEND_GAS_LIMIT): bigint {
  const scale = 10n ** (NATIVE_DECIMALS - USDC_DECIMALS);
  const estimate = (gasPrice * gasLimit) / scale;
  return estimate > MIN_GAS_RESERVE ? estimate : MIN_GAS_RESERVE;
}

/**
 * What a balance can actually pay out once its own gas is held back.
 *
 * Never negative: a balance smaller than the reserve can send nothing, and a
 * negative figure offered as "Max" would be worse than a zero.
 */
export function spendableAfterGas(balance: bigint, reserve: bigint): bigint {
  const max = balance - reserve;
  return max > 0n ? max : 0n;
}

/**
 * The reserve for a given operation, read from the chain.
 *
 * Falls back to the floor rather than throwing: a screen that cannot reach the node
 * for a gas price still has to offer a Max, and refusing to show one because an
 * estimate is unavailable stops a payment the wallet could well afford.
 */
export async function readGasReserve(
  client: { getGasPrice: () => Promise<bigint> },
  gasLimit: bigint = SEND_GAS_LIMIT,
): Promise<bigint> {
  try {
    return gasReserve(await client.getGasPrice(), gasLimit);
  } catch {
    return MIN_GAS_RESERVE;
  }
}
