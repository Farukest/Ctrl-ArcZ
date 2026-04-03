// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Stand-in for Arc's USDC ERC-20 interface: 6 decimals, standard ERC-20.
/// @dev Foundry runs a stock EVM, so it cannot reproduce Arc's native/ERC-20 dual
///      balance model (see https://docs.arc.io/arc/references/evm-differences). Unit tests
///      therefore assert contract logic against this mock, and the real dual-interface
///      behaviour is verified against Arc Testnet in the SDK integration tests.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
