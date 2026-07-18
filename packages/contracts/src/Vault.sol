// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Vault — the user's main kasa for the payer-side shield
/// @notice Holds the owner's USDC and funds disposable `SpendPolicyAccount`s from
///         it. The vault is where every ephemeral account sweeps back to, so the
///         user's balance never has to leave their control to make a private
///         payment.
///
/// @dev Owner-only outflows, no admin, no upgrade. The funding leg (`fundAccount`)
///      is the one that becomes confidential under Arc Privacy Sector (APS): the
///      link between the vault and the ephemeral address is what a merchant must
///      not be able to trace. Today it is a plaintext ERC-20 transfer routed
///      through `_moveOut`, the single seam we swap for an APS confidential
///      transfer once APS ships. Until then payer privacy is NOT delivered
///      on-chain here — this is the documented mock leg; the security legs
///      (policy, veto, sweep) are fully real.
contract Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable owner;

    event Deposited(address indexed from, uint256 amount);
    event AccountFunded(address indexed account, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();

    constructor(IERC20 token_, address owner_) {
        if (address(token_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        token = token_;
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev On Arc a USDC ERC-20 transfer moves native balance, so the vault must
    ///      accept native value to receive deposits and sweeps. No-op on plain EVMs.
    receive() external payable {}

    /// @notice Pull `amount` USDC into the vault (requires prior approval). Sweeps
    ///         from ephemeral accounts arrive by plain transfer and need no call.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Fund an ephemeral `SpendPolicyAccount`. Owner only. This is the
    ///         APS-confidential leg (mocked as plaintext today).
    function fundAccount(address account, uint256 amount) external onlyOwner nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _moveOut(account, amount);
        emit AccountFunded(account, amount);
    }

    /// @notice Withdraw from the vault to any address. Owner only.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _moveOut(to, amount);
        emit Withdrawn(to, amount);
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @dev Adapter seam. Swap for an APS confidential transfer to make the
    ///      vault→ephemeral amount unobservable. Keep this the ONLY outflow path.
    function _moveOut(address to, uint256 amount) private {
        token.safeTransfer(to, amount);
    }
}
