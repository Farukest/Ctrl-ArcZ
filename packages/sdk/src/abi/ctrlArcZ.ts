/**
 * GENERATED FILE — do not edit.
 * Source: packages/contracts/out/**, produced by `pnpm gen:abi`.
 */

export const ctrlArcZAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'usdc',
        type: 'address',
        internalType: 'contract IERC20',
      },
      {
        name: 'codeVerifier',
        type: 'address',
        internalType: 'contract IClaimVerifier',
      },
      {
        name: 'permit2',
        type: 'address',
        internalType: 'contract IPermit2',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'receive',
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'CODE_VERIFIER',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IClaimVerifier',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_CLAIM_ATTEMPTS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint8',
        internalType: 'uint8',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_FEE_BPS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint16',
        internalType: 'uint16',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_RECALL_WINDOW',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'PERMIT2',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IPermit2',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'USDC',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IERC20',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'attemptsRemaining',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'uint8',
        internalType: 'uint8',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'cancel',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'code',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'salt',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: 'claimed',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claimWithProof',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'proof',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [
      {
        name: 'claimed',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'configs',
    inputs: [
      {
        name: 'configId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: 'integrator',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'recallWindow',
        type: 'uint32',
        internalType: 'uint32',
      },
      {
        name: 'claimMode',
        type: 'uint8',
        internalType: 'enum CtrlArcZ.ClaimMode',
      },
      {
        name: 'feeBps',
        type: 'uint16',
        internalType: 'uint16',
      },
      {
        name: 'feeRecipient',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'verifier',
        type: 'address',
        internalType: 'contract IClaimVerifier',
      },
      {
        name: 'exists',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'createConfig',
    inputs: [
      {
        name: 'recallWindow',
        type: 'uint32',
        internalType: 'uint32',
      },
      {
        name: 'claimMode',
        type: 'uint8',
        internalType: 'enum CtrlArcZ.ClaimMode',
      },
      {
        name: 'feeBps',
        type: 'uint16',
        internalType: 'uint16',
      },
      {
        name: 'feeRecipient',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'configId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'createConfigWithVerifier',
    inputs: [
      {
        name: 'recallWindow',
        type: 'uint32',
        internalType: 'uint32',
      },
      {
        name: 'verifier',
        type: 'address',
        internalType: 'contract IClaimVerifier',
      },
      {
        name: 'feeBps',
        type: 'uint16',
        internalType: 'uint16',
      },
      {
        name: 'feeRecipient',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'configId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getTransfer',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct CtrlArcZ.ProtectedTransfer',
        components: [
          {
            name: 'sender',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'amount',
            type: 'uint96',
            internalType: 'uint96',
          },
          {
            name: 'to',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'deadline',
            type: 'uint40',
            internalType: 'uint40',
          },
          {
            name: 'attempts',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'status',
            type: 'uint8',
            internalType: 'enum CtrlArcZ.TransferStatus',
          },
          {
            name: 'claimHash',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'configId',
            type: 'bytes32',
            internalType: 'bytes32',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isClaimable',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isVerifiedRecipient',
    inputs: [
      {
        name: 'sender',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'recipient',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nextTransferId',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'reclaimExpired',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'sendProtected',
    inputs: [
      {
        name: 'configId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'claimHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'sendProtectedWithPermit',
    inputs: [
      {
        name: 'configId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'to',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'claimHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'permitNonce',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'permitDeadline',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'signature',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'ClaimAttemptFailed',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'caller',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'attempts',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ConfigCreated',
    inputs: [
      {
        name: 'configId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'integrator',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'recallWindow',
        type: 'uint32',
        indexed: false,
        internalType: 'uint32',
      },
      {
        name: 'claimMode',
        type: 'uint8',
        indexed: false,
        internalType: 'enum CtrlArcZ.ClaimMode',
      },
      {
        name: 'feeBps',
        type: 'uint16',
        indexed: false,
        internalType: 'uint16',
      },
      {
        name: 'feeRecipient',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'verifier',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RecipientVerified',
    inputs: [
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'transferId',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferCancelled',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferClaimed',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'caller',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amountToRecipient',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'fee',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferCreated',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'configId',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'deadline',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'claimHash',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferLocked',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferReclaimed',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'caller',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'AmountTooLarge',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ClaimModeNotSupported',
    inputs: [
      {
        name: 'mode',
        type: 'uint8',
        internalType: 'enum CtrlArcZ.ClaimMode',
      },
    ],
  },
  {
    type: 'error',
    name: 'EmptyClaimHash',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FeeRecipientRequired',
    inputs: [],
  },
  {
    type: 'error',
    name: 'FeeTooHigh',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotSender',
    inputs: [
      {
        name: 'caller',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'sender',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'RecallWindowTooLong',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ReentrancyGuardReentrantCall',
    inputs: [],
  },
  {
    type: 'error',
    name: 'SafeERC20FailedOperation',
    inputs: [
      {
        name: 'token',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'SelfTransfer',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferExpired',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'deadline',
        type: 'uint40',
        internalType: 'uint40',
      },
    ],
  },
  {
    type: 'error',
    name: 'TransferNotExpired',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'deadline',
        type: 'uint40',
        internalType: 'uint40',
      },
    ],
  },
  {
    type: 'error',
    name: 'TransferNotPending',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'status',
        type: 'uint8',
        internalType: 'enum CtrlArcZ.TransferStatus',
      },
    ],
  },
  {
    type: 'error',
    name: 'UnknownConfig',
    inputs: [
      {
        name: 'configId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
  },
  {
    type: 'error',
    name: 'UnknownTransfer',
    inputs: [
      {
        name: 'transferId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'ZeroAddress',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroAmount',
    inputs: [],
  },
] as const;

export const codeClaimVerifierAbi = [
  {
    type: 'function',
    name: 'hashCode',
    inputs: [
      {
        name: 'salt',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'code',
        type: 'string',
        internalType: 'string',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'verify',
    inputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'claimHash',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: '',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'proof',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [
      {
        name: 'ok',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'pure',
  },
] as const;

/**
 * Arc's Memo predeploy.
 * Source: https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo
 * Callable only by an EOA: a contract caller reverts as sender spoofing, which is why
 * CtrlArcZ wraps the send from the SDK instead of calling Memo itself.
 */
export const memoAbi = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Memo',
    anonymous: false,
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'callDataHash', type: 'bytes32', indexed: false },
      { name: 'memoId', type: 'bytes32', indexed: true },
      { name: 'memo', type: 'bytes', indexed: false },
      { name: 'memoIndex', type: 'uint256', indexed: false },
    ],
  },
] as const;
