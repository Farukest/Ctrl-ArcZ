// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of Uniswap's Permit2 SignatureTransfer interface.
/// @dev Permit2 is a predeployed contract on Arc
///      (`0x000000000022D473030F116dDEE9F6B43aC78BA3`). We use `permitTransferFrom`
///      so a sender can authorise a single, exact-amount pull with an off-chain
///      signature instead of a separate `approve` transaction per send. The
///      one-time prerequisite is a single `USDC.approve(PERMIT2, ...)`, which many
///      users already have from other Permit2-integrated apps.
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    /// @param permit The permitted token, amount, unordered nonce and deadline.
    /// @param transferDetails Where the tokens go and how many (must be <= permitted).
    /// @param owner The account that signed the permit (the sender).
    /// @param signature EIP-712 signature over `permit`, bound to `msg.sender` as spender.
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}
