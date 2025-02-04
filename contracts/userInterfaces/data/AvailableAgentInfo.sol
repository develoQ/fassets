// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


library AvailableAgentInfo {
    struct Data {
        // Agent vault address.
        address agentVault;

        // Agent's minting fee in BIPS.
        uint256 feeBIPS;

        // Minimum agent (class1) collateral ratio needed for minting.
        uint256 mintingClass1CollateralRatioBIPS;

        // Minimum pool collateral ratio needed for minting.
        uint256 mintingPoolCollateralRatioBIPS;

        // The number of lots that can be minted by this agent.
        // Note: the value is only informative since it can can change at any time
        // due to price changes, reservation, minting, redemption, or even lot size change.
        uint256 freeCollateralLots;
    }
}
