/**
 * English, the base dictionary. Every other locale is checked against these
 * keys, and any missing key falls back to the English string here. To add a
 * language, copy this file, translate the values, and register it in `locales.ts`.
 *
 * Interpolation uses `{name}` placeholders, filled via `t('key', { name })`.
 */
export const en = {
  // What a payment costs, in one vocabulary for every screen that moves money.
  // "(max)" is not hedging: both figures are ceilings the transaction is allowed to
  // reach, and the chain and Circle each charge what they charge out of it.
  'cost.amount': 'Amount',
  'cost.networkMax': 'Network fee (max)',
  'cost.circleFee': 'Circle fee',
  'cost.forwarding': 'Forwarding to {chain}',
  'cost.youPay': 'You pay',

  'common.appName': 'Ctrl+ArcZ',
  'common.connect': 'Connect wallet',
  'common.connecting': 'Connecting...',
  'common.disconnect': 'Disconnect',
  'common.noWallet': 'No wallet detected.',
  'common.installWallet': 'Install MetaMask',
  'common.connected': 'connected',
  'common.testWallet': 'test wallet',
  'common.testMode': 'test mode',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.back': 'Back',
  'common.select': 'Select',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.viewOnArcScan': 'View on ArcScan',
  'common.connectPrompt': 'Connect your wallet to continue.',
  // Named for the chain being offered rather than fixed to Arc: it is no longer
  // the only one, and a button that says "Switch to Arc" while offering Base is a
  // button that lies about what pressing it does.
  'common.switchTo': 'Switch to {chain}',
  // These say what is true of the network the wallet is on, not where the feature
  // "happens". Every one of them used to read "... happens on Arc Testnet", which
  // was the whole truth with one deployment and became false with five: protected
  // sends happen on four chains, and a user on Avalanche Fuji told they must go to
  // Arc is being given a reason that is not the reason.
  'chain.needs.protectedSend': 'Protected sends are not available on {chain}.',
  'chain.needs.receive': 'Claiming is not available on {chain}.',
  'chain.needs.privatePay': 'Private payments are not available on {chain}.',
  'chain.needs.subscriptions': 'Subscriptions are not available on {chain}.',
  'ppay.gasShort':
    'Sending {symbol} still costs USDC for gas, and this wallet does not have enough.',
  'token.restricted.allowlist': 'Needs an allowlist',
  'token.choose': 'Choose a token',
  'token.label': 'Token',
  'token.search': 'Search by name or address',
  'token.none': 'No matching token',
  'common.network': 'Network',
  'common.networkSearch': 'Search networks',
  'common.networkNone': 'No matching network',
  'common.chainNumber': 'Chain {chainId}',
  'common.switchRejected': 'Network switch was rejected.',
  'common.connectRejected': 'Connection rejected.',
  'common.noResults': 'No match',
  'common.search': 'Search',
  'common.pagination': 'Pagination',
  'common.prevPage': 'Previous page',
  'common.nextPage': 'Next page',
  'common.firstPage': 'First page',
  'common.lastPage': 'Last page',
  'common.notifications': 'Notifications',
  'common.language': 'Language',
  'common.themeLight': 'Switch to light theme',
  'common.themeDark': 'Switch to dark theme',

  'amount.label': 'Amount',
  'amount.balance': 'Balance',
  'amount.max': 'Max',

  'app.subtitle': 'Protected USDC transfers on Arc',

  'footer.nav': 'Project links',
  'footer.docs': 'Documentation',
  'footer.docsSub': 'Integrate the SDK',
  'footer.deck': 'Deck',
  'footer.deckSub': 'The project in slides',
  'footer.github': 'Source',
  'footer.githubSub': 'Contracts, SDK and this app',
  'footer.sdk': 'SDK',
  'footer.sdkSub': '@ctrl-arcz/sdk on npm',
  'footer.android': 'Android',
  'footer.androidSub': 'On Google Play',
  'footer.ios': 'iOS',
  // Short enough to sit on one line beside the chip: the sub wrapping made this
  // card taller than the one next to it, for a line nobody needed.
  'footer.iosSub': 'On iPhone',
  'footer.soon': 'Coming soon',
  // Said once, at the bottom, in the one place a person looks for the catch.
  'footer.note': 'Testnet build. Nothing here moves real money.',
  'footer.copyright': '© {year} Ctrl+ArcZ',

  'mode.send': 'Send',
  'mode.receive': 'Receive',
  'receive.yourAddress': 'Your address',
  'receive.shareToGetPaid': 'Share this to get paid. Scan the code or copy the address.',
  'receive.newIncoming': 'A protected payment arrived. Switch to Receive to claim it.',
  'receive.newIncomingHere': 'A protected payment arrived. Enter its claim code to take it.',
  'received.title': 'Received',
  'received.unreadable': 'Could not read the chain just now. Retrying.',
  'received.search': 'Search by amount, sender or id',
  'received.returnToSender': 'Return it to the sender',
  'received.expiredHint':
    'The claim window has lapsed. You cannot claim this any more, but you can send it back.',
  'received.returned': 'Sent back to the sender.',
  // Scoped on purpose. This card lists protected transfers only, and it was
  // saying "nothing has been sent to this wallet" to a wallet holding money that
  // arrived over a bridge, which the History tab was showing at the same moment.
  'received.empty': 'No protected transfer has been sent to this wallet yet.',
  'received.expiredLabel': 'Expired',
  'received.noMatch': 'No match',
  'received.filter.all': 'All',
  'received.filter.pending': 'Waiting',
  'received.filter.claimed': 'Received',
  'received.filter.cancelled': 'Cancelled',
  'received.filter.expired': 'Refunded',
  'nav.subscriptions': 'Subscriptions',
  'common.prev': 'Prev',
  'common.next': 'Next',
  'common.save': 'Save',
  'common.retry': 'Try again',
  'common.clear': 'Clear',
  'common.loading': 'Loading…',
  'sub.createTitle': 'New subscription',
  // Names the thing being picked rather than the field it fills in. "(optional)" went
  // with it: the control is a list with an escape hatch, so what it wants is obvious,
  // and nothing stops a box being created without one.
  'sub.label': 'Merchant',
  'sub.labelPh': 'e.g. Netflix',
  'sub.merchant': 'Merchant address',
  'sub.perPull': 'Per pull',
  'sub.frequency': 'How often',
  // Follows the frequency, because "How many charges" made the reader do the
  // conversion themselves: monthly x 12 is a year, and only the label can say so.
  'sub.count': 'How many {unit}',
  'sub.unit.minute': 'minutes',
  'sub.unit.daily': 'days',
  'sub.unit.weekly': 'weeks',
  'sub.unit.monthly': 'months',
  'sub.unit.yearly': 'years',
  // The singular is a separate string rather than a stripped "s", which only
  // works in English and not even reliably there.
  'sub.unitOne.minute': 'minute',
  'sub.unitOne.daily': 'day',
  'sub.unitOne.weekly': 'week',
  'sub.unitOne.monthly': 'month',
  'sub.unitOne.yearly': 'year',
  'sub.freq.minute': 'Every minute',
  'sub.freq.daily': 'Daily',
  'sub.freq.weekly': 'Weekly',
  'sub.freq.monthly': 'Monthly',
  'sub.freq.yearly': 'Yearly',
  // The budget, in the words of the schedule that produces it. The frequency is
  // interpolated lowercased, so "Monthly" reads as "Your monthly payment total".
  'sub.paymentTotal': 'Your {freq} payment total',
  'sub.pickMerchant': 'Choose a merchant',
  'sub.merchantOther': 'Something else',
  'sub.merchantList': 'Back to list',
  'sub.countTooLow': 'At least one {unit}',
  'sub.countTooHigh': 'At most {max} {unit}',
  'sub.gwShort':
    'Short {amount} USDC of Gateway balance on {chain}. Top it up above to create this subscription.',
  'sub.fundingOnWay':
    'Created. Circle is minting the budget into the box; it lands in a few minutes.',
  'sub.step.fundGw': 'Circle minting budget',
  // Says which figure is missing and that nothing was charged. A price that
  // cannot be quoted is not a failed subscription, it is a form that cannot
  // total up yet.
  'sub.quoteUnavailable': "Circle's fee could not be read, so this cannot be priced yet.",
  'sub.createButton': 'Create subscription',
  'sub.fundTitle': 'Balance for subscriptions',
  'sub.step.machine': 'Checking merchant',
  'sub.step.create': 'Creating box',
  'sub.step.listing': 'Show it in the list',
  'sub.vetoTitle': 'Vetoed',
  'sub.vetoedToast': 'The Machine vetoed this merchant.',
  'sub.createdToast': 'Subscription created.',
  'sub.pulledToast': 'Pulled.',
  'sub.cancelledToast': 'Subscription cancelled, funds returned.',
  'sub.cancelConfirm': 'Cancel this subscription and return the remaining funds?',
  'sub.stealthLocked':
    'Your private subscriptions are hidden. Finding them needs a key derived from one wallet signature, and that signature was declined.',
  'sub.stealthUnlock': 'Find my subscriptions',
  'sub.listTitle': 'Your subscriptions',
  'sub.searchPh': 'Search by name or address',
  'sub.empty': 'No subscriptions yet.',
  'sub.noMatch': 'No subscription matches this filter.',
  'sub.sortAria': 'Sort subscriptions',
  'sub.sort.newest': 'Newest',
  'sub.sort.oldest': 'Oldest',
  'sub.sort.amountHigh': 'Budget: high to low',
  'sub.sort.amountLow': 'Budget: low to high',
  'sub.sort.endsSoon': 'Ends soonest',
  'sub.filter.all': 'All',
  'sub.filter.active': 'Active',
  // Nothing in the box and nothing ever charged. Covers a box swept home before
  // its first pull and one whose funding never landed, which the chain cannot
  // tell apart; "Cancelled" would claim an action neither is proof of.
  'sub.filter.empty': 'Empty',
  'sub.filter.completed': 'Completed',
  'sub.filter.cancelled': 'Cancelled',
  'sub.filter.expired': 'Expired',
  'sub.remaining': 'Left',
  'sub.details': 'Details',
  'sub.nextPullAt': 'Not due yet. The next charge is allowed at {when}.',
  'sub.notFundedYet': 'The budget has not landed on chain yet. This clears in a few seconds.',
  'sub.budgetSpent': 'The whole budget has been spent.',
  'sub.pulling': 'Charging...',
  'sub.pullNow': 'Pull now',
  'sub.tooSoon': 'Not yet',
  'sub.cancel': 'Cancel',
  'sub.d.account': 'Box address',
  'sub.d.merchant': 'Merchant',
  'sub.d.perPull': 'Per pull',
  'sub.d.cap': 'Total budget',
  'sub.d.spent': 'Pulled so far',
  'sub.d.remaining': 'Remaining budget',
  'sub.d.balance': 'Box balance',
  'sub.d.lastPull': 'Last pull',
  'sub.d.nextPull': 'Next pull',
  'sub.d.expiry': 'Expires',
  'sub.d.never': 'Never',
  'sub.d.now': 'Now',
  'sub.rename': 'Name on this device',
  'sub.renameHint': 'Only here. The name it was created with stays on the network.',
  'sub.renameSave': 'Rename',
  'sub.renameClear': 'Use the original',
  'nav.send': 'Send',
  'nav.active': 'Active',
  'nav.history': 'History',
  'nav.poisoning': 'Poisoning',
  'nav.bridge': 'Bridge',
  'nav.privatepay': 'Private Pay',
  'nav.pay': 'Pay',
  'nav.activity': 'Activity',
  'nav.more': 'More',
  'pay.seg.standard': 'Protected',
  'pay.seg.private': 'Private',
  'pay.pick.aria': 'Protected and Private, and when to use each',
  'pay.pick.protected.lead':
    'Best for a new address or a larger amount. The money waits until they claim it with a code you give them.',
  'pay.pick.protected.b1': 'Held in escrow, never on their address, until it is claimed.',
  'pay.pick.protected.b2': 'Cancel any time before they claim, and get it straight back.',
  'pay.pick.protected.b3': 'If it is never claimed, it refunds to you on its own.',

  'ppay.title': 'Private Pay',
  'ppay.body':
    'Pay a merchant from a fresh, single-use address they cannot tie to your history, like a disposable virtual card. The funding transfer stays visible on a transparent chain.',
  'ppay.summary':
    'Pay from a fresh, single-use address the merchant cannot tie to your history. The funding transfer stays visible on-chain.',
  'ppay.newPayment': 'New payment',
  'ppay.point1':
    'A new address is created per payment, locked to this merchant, this amount, 15 minutes.',
  'ppay.point2':
    'The Machine (an enclave co-signer) checks every payment and vetoes a drainer or lookalike before it can send.',
  'ppay.point3': 'Anything unspent can only ever return to your vault, never anywhere else.',
  'ppay.merchant': 'Merchant address',
  'ppay.button': 'Pay privately',
  'ppay.step.create': 'Create private address',
  'ppay.step.fund': 'Fund it',
  'ppay.step.machine': 'The Machine checks',
  'ppay.step.pay': 'Pay',
  'ppay.doneToast': 'Paid privately.',
  'ppay.vetoedToast': 'The Machine vetoed this payment. No funds moved.',
  'ppay.vetoTitle': 'Vetoed by The Machine',
  'ppay.vetoBody':
    'The co-signer withheld its signature, so the payment was impossible, not merely warned against. No funds moved.',
  'ppay.successTitle': 'Paid privately',
  'ppay.successBody': '{amount} {symbol} reached the merchant from a clean, single-use address.',
  'ppay.merchantSees': 'What the merchant sees',
  'ppay.txn': 'Transaction',
  'ppay.successNote':
    'The merchant sees a zero-history address that stores no link to you on-chain. Hiding the funding transfer itself comes with Arc Privacy Sector.',

  'bridge.cctp.point1': 'Burned on the source chain, minted on the destination.',
  'bridge.cctp.point2': 'Circle attestation authorizes the mint once the burn is final.',
  'bridge.cctp.point3': 'Circle sponsors the destination mint, so you need no gas there.',
  'bridge.gateway.point1': 'Deposit once into a unified USDC balance.',
  'bridge.gateway.point2': 'Spend from it on any chain in seconds, with no transaction to send.',
  'bridge.gateway.point3': "Circle's forwarder mints on the destination, so you need no gas there.",
  'bridge.engine.cctp': 'CCTP',
  'bridge.engine.gateway': 'Gateway',
  'bridge.info.aria': 'How CCTP and Gateway differ',
  'bridge.info.cctpBody':
    'Best for a one-off transfer. Your USDC arrives on the other chain in about a minute.',
  'bridge.info.gatewayBody':
    'Best if you send often. Fund a balance once, then each transfer lands in about a second.',
  'bridge.gwstep.approve': 'Approving USDC...',
  'bridge.gwstep.deposit': 'Funding unified balance...',
  // Named for the wait, not for the transaction. The deposit is mined long before
  // the money can be spent, and this row is the gap between those two moments.
  'bridge.gwstep.counted': 'Waiting for Circle to count it...',
  'bridge.gwstep.sign': 'Signing the transfer...',
  'bridge.gwstep.attestation': 'Waiting for Circle attestation...',
  'bridge.gwstep.mint': 'Minting on the destination chain...',
  'bridge.from': 'From',
  'bridge.to': 'To',
  'bridge.searchChain': 'Search network',
  'bridge.selfFunded':
    'This moves your own USDC: your wallet signs the burn and Circle mints it back to you on the destination. No gas needed there.',
  'bridge.wrongSourceChain':
    'Your wallet needs to be on {chain} to burn USDC there. Switch it below.',
  'bridge.switchTo': 'Switch wallet to {chain}',
  'bridge.sameChain': 'Choose two different chains.',
  'bridge.amount': 'Amount (USDC)',
  'bridge.feeNote': 'A small network fee applies, so the amount must exceed it.',
  'bridge.button': 'Bridge',
  'bridge.bridging': 'Bridging...',
  'bridge.step.approve': 'Approving USDC...',
  'bridge.step.burn': 'Burning on the source chain...',
  'bridge.step.fetchAttestation': 'Waiting for Circle attestation...',
  'bridge.step.mint': 'Minting on the destination chain...',
  'bridge.forwardPending':
    'Burned. Circle is minting on the destination; the burn hash is your receipt.',
  'bridge.gwBalanceHere': 'On {chain}: {here} USDC of your {total} USDC Gateway balance.',
  'bridge.gwBalanceElsewhere':
    'The rest sits on other chains, and a transfer spends only the balance on its source chain.',
  'bridge.gwBalance': 'A transfer costs a flat {fee} USDC whatever the amount.',
  'bridge.gwBalanceLoading': 'Reading your Gateway balance...',
  'bridge.gwDepositWait': 'Deposits here count in about {wait}.',
  'bridge.youReceive': 'You receive',
  'bridge.balance': 'Balance',
  'bridge.gwBalanceLabel': 'Gateway balance',
  'bridge.feeOverAmount':
    'The fee is larger than the transfer. Another route, or one bigger transfer, costs less.',
  // Where a Gateway payment comes from. One From block, the networks carrying it
  // listed inside, plus the one control that adds another. Phrased as offers
  // throughout: a payment that has outgrown one chain is not a mistake somebody
  // made, so nothing here scolds.
  'bridge.src.title': 'Networks',
  'bridge.src.spendable': 'Spendable',
  'bridge.src.count': '{n} networks',
  'bridge.src.heldOn': '{amount} USDC in Gateway',
  'bridge.src.ready': '{amount} USDC available',
  'bridge.src.legFee': 'fee {fee} USDC',
  'bridge.src.hasAmount': '{amount} USDC',
  'bridge.src.auto': 'split for you',
  'bridge.src.pinned': 'set by you',
  'bridge.src.legAria': 'Amount from {chain}',
  'bridge.src.short': 'Still {amount} USDC short of this transfer.',
  'bridge.src.overfill': 'The networks add up to {amount} USDC more than you are sending.',
  'bridge.src.costlyNote': 'One leg runs over Ethereum, which charges about 1 USDC on its own.',
  'bridge.src.add': 'Add a network',
  // Beside each network in the add list. The fee is the whole transfer's, not this
  // network's share: what somebody is choosing between is two complete plans.
  'bridge.src.totalFee': '{fee} USDC total fee',
  'bridge.src.stillShort': '{amount} short',
  'bridge.src.tooSmall': 'too small to use',
  'bridge.src.cover': 'Take the other {amount} from {chain}',
  'bridge.src.coverCostly': 'Take the other {amount} from {chain}, {fee} in fees',
  'bridge.src.topUp': 'Top up {amount} USDC',
  'bridge.src.remove': 'Remove {chain}',
  // On the card that is asking for more than its chain holds. Pressing it takes
  // the ceiling. Not an error: the chain has a limit, and this is what it is.
  'bridge.src.overCapacity': '{chain} can send {amount} of this',
  'bridge.src.raise': '{chain} can carry {amount} more',
  'bridge.src.nothingHere': 'Nothing spare on {chain} for this',
  'bridge.src.costlyAsk': 'Finishing this on {chain} means {amount} USDC in fees',
  'bridge.src.costlyUse': 'Use {chain}',
  'bridge.src.reduce': 'Send {amount} instead',
  'bridge.refusal.gwShort': 'Short {amount} USDC across every chain, fee included.',
  'bridge.refusal.gwStranded':
    '{total} USDC in Gateway, but each chain pays its own fee. {amount} USDC is what reaches the other end.',
  'bridge.refusal.shortWithFee': 'Short {amount} USDC on {chain}, fee included.',
  'bridge.refusal.shortWithGas': 'Short {amount} USDC on {chain}, gas included.',
  'bridge.refusal.noGas': '{chain} charges gas in {symbol} and this wallet has none.',
  'bridge.fixDeposit': 'Deposit {amount} USDC',
  'bridge.fixMax': 'Send {amount} USDC instead',
  'bridge.gwFundTitle': 'Gateway balance',
  'bridge.gwOnChain': 'On {chain}',
  'bridge.fundForBridgeTitle': 'Balance for Bridge',
  'bridge.gwHere': '{amount} USDC ready to send',
  'bridge.swap': 'Swap the two chains',
  'bridge.gwWalletLabel': 'Wallet balance',
  'bridge.gwWalletBalance': '{amount} USDC in your wallet on {chain}.',
  'bridge.gwWalletLoading': 'Reading your wallet balance...',
  // Reading a balance no longer needs the wallet to be standing on that chain, so
  // this stopped being about reading. What is still true is that a deposit is an
  // on-chain transaction and has to happen there -- and the button handles that
  // itself, so this says what will happen rather than what cannot.
  //
  // It carries the wait as well, because these two facts used to be two lines and
  // only one of them was ever conditional, which is what made the box change
  // height when you changed network. Neither names the chain any more: the box is
  // titled with it and the picker inside shows it, so a third mention cost the
  // width that keeping this to one line needs.
  'bridge.gwWalletOtherChain': 'Switches your wallet first, then counts in about {wait}.',
  'bridge.gwWalletUnreadable': 'Your wallet did not answer. Retrying.',
  'bridge.gwNoGas': 'No {symbol} here to pay the gas with.',
  'bridge.gwDepositCta': 'Deposit',
  'bridge.gwDepositTooBig': 'More than your wallet holds here.',
  'bridge.depositButton': 'Deposit {amount} USDC on {chain}',
  'bridge.deposited': 'Deposited {amount} USDC. It becomes spendable in about {wait}.',
  'bridge.withdrawButton': 'Withdraw to my wallet',
  'bridge.recipient': 'Recipient (optional)',
  'bridge.recipientHint': 'Leave empty to send to yourself, which is what a bridge usually means.',
  'bridge.recipientPlaceholder': 'Your own address',
  'bridge.recipientBad': 'That is not a valid address.',
  'bridge.gwBalanceShort': '{here} USDC on {chain}. Fee {fee}.',
  'bridge.gwUseFunded': 'Use {chain} instead ({amount} USDC there)',
  'bridge.gwChainMissing': 'Pick two chains Gateway supports.',
  'bridge.gwPending': '{amount} deposited, counts in about {wait}.',
  'history.days3': 'Last 3 days',
  'history.custom': 'Pick dates',
  'history.from': 'From date',
  'history.to': 'To date',
  'history.search': 'Search by address, amount, token or tx',
  'history.noMatch': 'No match',
  'history.sent': 'Sent',
  'history.received': 'Received',
  'history.filteredOut': 'Filtered out',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',
  'history.week': 'Last 7 days',
  'history.month': 'Last 30 days',
  'history.anyTime': 'Any time',
  'history.dateFilter': 'Filter by date',
  // A subscription's date is when it ends, which has not happened yet. "Last 7
  // days" cannot narrow a list of future dates, so the presets point the other way.
  'history.tomorrow': 'Tomorrow',
  'history.endsToday': 'Ends today',
  'history.endsDays3': 'Ends within 3 days',
  'history.endsWeek': 'Ends within 7 days',
  'history.endsMonth': 'Ends within 30 days',
  'bridge.rowTo': 'To',
  'bridge.rowReceipt': 'Receipt',
  'bridge.rowReason': 'Reason',
  'active.stepSent': 'Sent',
  'bridge.rowstep.approve': 'Approve',
  'bridge.rowstep.burn': 'Burn',
  'bridge.rowstep.fetchAttestation': 'Attestation',
  'bridge.rowstep.mint': 'Mint',
  'bridge.rowstep.deposit': 'Deposit',
  'bridge.rowstep.counted': 'Counted by Circle',
  'bridge.rowstep.sign': 'Sign',
  'bridge.rowstep.attestation': 'Attestation',
  'bridge.done': 'Bridged. USDC arrived on the destination chain.',
  'bridge.recovered':
    'An interrupted transfer finished: {amount} USDC arrived on the destination chain.',
  'bridge.failed': 'Bridge failed.',
  'bridge.noKey': 'Bridging needs the demo wallet key (test mode).',
  'bridge.historySubsTitle': 'Subscription funding',
  'bridge.historyKindBridge': 'Bridge',
  'bridge.historyKindSubs': 'Subscriptions',
  // The block at the bottom of every screen that moves money.
  'activity.title': 'Recent transfers',
  'activity.fundingTitle': 'Recent funding',
  'activity.empty': 'Nothing from this browser yet.',
  'activity.all': 'All',
  'activity.running': '{n} in progress',
  'activity.failed': '{n} needs a look',
  'activity.fresh': 'Just now',
  'activity.feeIs': 'Fee {fee} USDC',
  'activity.andMoreNetworks': '+{n} more',
  'activity.type': 'Type',
  'activity.jump': 'Go to it',
  'activity.steps': 'Steps',
  'activity.today': 'Today',
  'activity.yesterday': 'Yesterday',
  'activity.day': 'Show one day',
  'activity.filter': 'Filter',
  'activity.sortBy': 'Sort',
  'activity.sort.newest': 'Newest',
  'activity.sort.oldest': 'Oldest',
  'activity.sort.largest': 'Largest',
  'activity.noMatch': 'Nothing matches that.',
  'activity.noExplorer': 'This network publishes no transaction history we can read.',
  'activity.v.sent': 'Sent',
  'activity.v.history': 'History',
  'activity.v.bridge': 'Bridge',
  'activity.v.subs': 'Subs',
  'activity.f.all': 'All',
  'activity.f.undoable': 'Undoable',
  'activity.f.pending': 'Waiting',
  'activity.f.claimed': 'Claimed',
  'activity.f.refunded': 'Refunded',
  'activity.f.received': 'Received',
  'activity.f.sent': 'Sent',
  'activity.f.arrived': 'Arrived',
  'activity.f.failed': 'Needs a look',
  'activity.search.sent': 'Id, amount, address',
  'activity.search.history': 'Address, amount, token',
  'activity.search.bridge': 'Chain, amount, transaction',
  'activity.search.subs': 'Name, chain, amount',
  'activity.emptyIn.sent': 'No protected transfer has been made from this browser yet.',
  'activity.emptyIn.history': 'This wallet has no token transfers yet.',
  'activity.emptyIn.bridge': 'Nothing has been bridged from this browser yet.',
  'activity.emptyIn.subs': 'No subscription has been funded from this browser yet.',
  'activity.from': 'From',
  'activity.to': 'To',
  // The contract's own words for where a protected transfer ended up. `reclaimed`
  // is what cancelling one does, and `none` is the chain not answering rather than
  // a state a transfer can be in.
  'active.status.none': 'Unreadable',
  'active.status.pending': 'Waiting',
  'active.status.locked': 'Locked',
  'active.status.claimed': 'Claimed',
  'active.status.cancelled': 'Cancelled',
  'active.status.reclaimed': 'Refunded',
  'bridge.historyTitle': 'Bridge history',
  'bridge.historyEmpty': 'No bridges from this browser yet.',
  'bridge.historySearch': 'Search by network, amount, or tx hash',
  'bridge.filterEngine': 'Filter by engine',
  'bridge.filterAll': 'All',
  'bridge.historyNoMatch': 'No bridge matches your search.',
  'bridge.state.success': 'arrived',
  'bridge.state.pending': 'pending',
  'bridge.state.error': 'failed',
  'bridge.state.running': 'in progress',
  // Not a failure. A run whose page went away mid-flight, which may well have
  // landed on chain; saying it failed would be a guess, and the wrong one more
  // often than not.
  'bridge.state.stalled': 'interrupted',
  // A Gateway spend does not burn on the source chain until settlement, so a
  // mint that fails leaves a hold rather than a payment, and Circle lets it go.
  // "failed" would tell someone their money is gone while it is on its way back.
  'bridge.state.returning': 'returning',
  'bridge.state.returned': 'returned',
  'bridge.returnNote': 'Did not arrive. Returning to your Gateway balance.',
  'bridge.returnedNote': 'Returned to your Gateway balance.',
  'bridge.returnedToast': '{amount} USDC is back in your Gateway balance.',

  'send.recipient': 'Recipient address',
  'send.invalidAddress': 'Invalid address',
  'send.invalidAmount': 'Invalid amount',
  'send.selfSend': 'You cannot send to your own address',
  'send.amount': 'Amount (USDC)',
  'send.waitingAdvisory': 'Waiting for the second opinion...',
  'send.window': 'Cancel / claim window',
  'send.window60s': '60 seconds',
  'send.window1h': '1 hour',
  'send.window24h': '24 hours',
  'send.plainHint': 'Below the threshold, an unprotected plain transfer may be cheaper.',
  'send.button': 'Send protected',
  'send.sending': 'Sending...',
  'send.blocked': 'Send blocked',
  'send.stepConfig': 'Register config',
  'send.stepApprove': 'Approve / sign',
  'send.stepLock': 'Lock',
  'send.successTitle': 'Sent and locked',
  'send.successBody': '{amount} USDC locked. Give the recipient this code:',
  'send.successTo': 'locked for',
  'send.copyCode': 'Copy code',
  'send.claimStep1':
    'Hand the code to the recipient yourself: say it, or send it over a channel only they can read.',
  'send.claimStep2':
    'It is shown once and never saved. It is the only thing that stops a lookalike address from taking the money.',
  'send.newTransfer': 'New transfer',
  'send.sentToast': 'Sent and locked.',
  'send.failedToast': 'Send failed.',
  'send.blockedToast': 'The firewall stopped the send. No funds moved.',

  'risk.safe': 'Looks safe',
  'risk.warning': 'Caution',
  'risk.block': 'Send blocked',
  'risk.reason.LOOKALIKE_ADDRESS':
    'This address looks identical, by first and last characters, to {addr} which you have paid before, but it is a different address. Wallets hide the middle, so the two are indistinguishable.',
  'risk.reason.ZERO_VALUE_BAIT':
    'This address sent you {count} zero-value transfer(s). That is the signature of an address-poisoning attack: it plants the address in your history.',
  'risk.reason.NEW_ADDRESS':
    'This address has no on-chain history. Normal for a new recipient; stop if you did not expect it.',
  'risk.reason.FRESH_ADDRESS':
    'This address is less than 24 hours old. Poisoning addresses are minted fresh for the attack.',
  'risk.reason.VERIFIED_RECIPIENT':
    'A protected transfer to this address settled before, claimed with a code.',
  'risk.reason.KNOWN_COUNTERPARTY': 'You have paid this exact address before.',
  'risk.show': 'Show',
  'risk.hide': 'Hide',
  'risk.expandAll': 'Expand all',
  'risk.collapseAll': 'Collapse all',
  // The two sources, named as the user sees them. "Rules" is what runs in the
  // browser off chain data. The other half is Claude, reading a dossier this
  // server assembles about the recipient and answering in its own words, so it is
  // named for what it is: "Deep check" described the depth and hid the mechanism,
  // and the mechanism is the interesting part.
  'risk.checkRules': 'Rules',
  'risk.rulePassed': 'Nothing matched',
  'risk.ruleFinding': '1 finding',
  'risk.ruleFindings': '{count} findings',
  'risk.checkDeep': 'Agent check',
  'risk.checkRunning': 'Checking',
  'risk.checkingAddress': 'Checking this address',
  'risk.deepClear': 'Nothing further found',
  // Three different gaps, said out loud rather than left blank or, worse, dressed
  // up as a clean result. The rules alone are a thinner answer than the user
  // thinks, and which half is missing changes what they should do about it.
  'risk.deepUnavailable': 'Could not be reached, rules only',
  'risk.deepOff': 'Not configured here, rules only',
  'risk.deepBudget': "Today's limit reached, rules only",
  'risk.investigating': 'Asking the agent what the rules cannot see...',
  'risk.override.open': 'This is a different address, and I mean to pay it',
  'risk.override.openUnverified': 'Send without verifying this address',
  'risk.override.compareTitle': 'Look at both before you decide',
  'risk.override.yours': 'What you entered',
  'risk.override.known': 'What you have paid before',
  'risk.override.middle':
    'Only the middle differs, and your wallet hides the middle. If you did not mean to pay a new address, this is the attack.',
  'risk.override.unverifiedTitle': 'We could not verify this address',
  'risk.override.unverifiedBody':
    'A data source did not answer, so the lookalike check could not run. That does not mean the address is bad. It means we do not know.',
  'risk.override.confirmLabel': 'I know this address is the one I mean to pay',
  'risk.override.proceed': 'Send anyway',
  'risk.override.cancel': 'Go back',
  'risk.override.armed': 'Proceeding despite the warning. The transfer is still protected.',
  'risk.override.armedPlain':
    'Proceeding despite the warning. This one is not recoverable once it lands.',
  'risk.reason.DATA_UNAVAILABLE':
    'The risk check was incomplete ({sources} did not respond). We will not say "safe" without a full scan.',

  'active.empty': 'No protected transfer has been made from this browser yet.',
  'active.search': 'Search by id, amount, address, code, or status',
  'active.noMatch': 'No transfer matches your search.',
  'active.code': 'Claim code',
  'active.cancel': 'Cancel',
  'active.cancelling': 'Cancelling...',
  'active.cancelledToast': '#{id} cancelled, refund received.',
  'active.cancelFailed': 'Cancel failed.',

  'history.note':
    'Zero-value and unknown-token rows are hidden, the surface address poisoning lives on is gone.',
  'history.empty': 'No entries in the clean history.',
  'history.showSpam': 'Show {count} spam rows',
  'history.hideSpam': 'Hide spam',
  'history.zeroValue': 'zero value',
  'history.unknownToken': 'unknown token',
  // A mint has no sender, so these rows used to show 0x0000...0000 as the party
  // who paid you. On Arc the money is almost always your own, arriving over a
  // bridge, so the row says which bridge instead of naming nobody.
  'history.bridgedIn': 'Bridged in',
  'history.bridgedInCctp': 'Bridged in over CCTP',
  'history.bridgedInGateway': 'Bridged in from Gateway balance',
  'history.burned': 'Burned',

  'demo.tryIt': 'Try the poisoning attack',
  'demo.craftedFrom': 'Crafted to imitate {addr}. Both render the same in a wallet.',
  'demo.noHistory':
    'No verified recipient yet. Complete one protected transfer first, then the scenario has something real to imitate.',
  'demo.running': 'Generating and scanning...',

  'claim.title': 'Claim the transfer',
  'claim.transferId': 'Transfer number',
  'claim.picked': 'Transfer #{id}',
  'claim.pickBelow': 'Pick the transfer you were sent from the list below, then enter the code.',
  'claim.change': 'Change',
  'claim.code': 'Claim code',
  'claim.codeInvalid': 'That is not a valid claim code',
  'claim.codeHint': 'The 16-character code the sender gave you.',
  'claim.noMatch': 'No transfer waiting for you matches this code.',
  'claim.searching': 'Looking this code up on the chain...',
  'claim.matched': 'Matches transfer #{id}, {amount} USDC from {from}',
  'claim.matchedExpired':
    'Transfer #{id} matches, but its claim window closed. The sender gets it back.',
  'claim.claimOwnGas': 'Claim (my own gas)',
  // Not "relayer pays": with Circle Gas Station configured the paymaster covers
  // the gas and the relayer's own balance does not move, which is the deployed
  // setup and what the line below already says. The button states the part that
  // is true either way, which is the part the reader is choosing between.
  'claim.claimGasless': 'Claim without gas',
  'claim.gasless1': 'Circle Gas Station sponsors the gas, so you pay nothing.',
  'claim.gasless2': 'You receive the USDC even with a completely empty wallet.',
  'claim.claiming': 'Claiming...',
  'claim.pendingTitle': 'Transfers waiting for you',
  'claim.pendingEmpty': 'No protected transfer waiting.',
  'claim.successTitle': 'Received',
  'claim.successBody': 'It reached your wallet. New balance: {balance} USDC.',
  // A claim is permissionless and always pays the recipient recorded at send
  // time, so the person who settles it is not always the person who gets it.
  'claim.settledTitle': 'Settled',
  'claim.settledBody':
    'The transfer was released to the address it was sent to. Your own balance is unchanged, apart from the gas.',
  'claim.needTid': 'Transfer number is required.',
  'claim.wrongCode': 'Wrong code. Attempts remaining: {n}.',
  'claim.wrongCodeLast':
    'Wrong code. No attempts left; the transfer is locked and only the sender can cancel.',
  'claim.locked':
    'Transfer locked (5 wrong attempts). The funds are safe: only the sender can cancel and reclaim them.',

  // What went wrong, said to the person it happened to. A wallet's own error is
  // written for whoever wrote the code: declining a prompt returns a page of
  // request arguments with the one useful line buried at the top of it.
  'failure.rejected': 'You cancelled it in your wallet. Nothing happened on chain.',
  'failure.funds': 'Not enough balance to cover this, including its network fee.',
  'failure.allowance': 'This spend has not been approved yet. Approve it, then try again.',
  'failure.nonce':
    'Another transaction from this wallet is still in flight. Wait for it to land, then try again.',
  'failure.ratelimited':
    'Your wallet is being rate limited by the network it is connected to. Wait a moment and try again, or change its RPC in the wallet.',
  'failure.chain':
    'Your wallet is on a different network than this transaction. Switch it, then try again.',
  'failure.timeout':
    'The network did not answer in time. The transaction may still land, so check Activity before sending it again.',
  'failure.network': 'Could not reach the network. Check the connection, then try again.',
  'failure.gas':
    'The network fee could not be worked out, which usually means the transaction would fail as it stands.',
  'failure.reverted': 'The chain rejected this transaction.',
  'failure.unknown': 'It did not go through.',
  // The literal error, kept for the expanded row so support has something exact.
  'activity.rawError': 'Wallet said',
  // Which of a run's prompts this was. A deposit asks twice in a row.
  'failure.at': '{step}: {message}',

  'transfer.unavailable.not_pending':
    'This transfer is no longer available (already claimed, cancelled, or refunded).',
  'transfer.unavailable.expired': 'This transfer has expired.',
  'transfer.unavailable.unknown': 'No such transfer.',
  'transfer.unavailable.not_sender': 'Only the sender can cancel this transfer.',
} as const;

export type TranslationKey = keyof typeof en;
