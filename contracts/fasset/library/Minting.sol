// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "../../generated/interface/ISCProofVerifier.sol";
import "../../utils/lib/SafePct.sol";
import "./data/AssetManagerState.sol";
import "./AMEvents.sol";
import "./Agents.sol";
import "./UnderlyingBalance.sol";
import "./CollateralReservations.sol";
import "./AgentCollateral.sol";
import "./TransactionAttestation.sol";

library Minting {
    using SafePct for *;
    using RedemptionQueue for RedemptionQueue.State;
    using PaymentConfirmations for PaymentConfirmations.State;
    using AgentCollateral for Collateral.CombinedData;
    using Agent for Agent.State;

    function executeMinting(
        ISCProofVerifier.Payment calldata _payment,
        uint64 _crtId
    )
        external
    {
        CollateralReservation.Data storage crt = CollateralReservations.getCollateralReservation(_crtId);
        Agent.State storage agent = Agent.get(crt.agentVault);
        // verify transaction
        TransactionAttestation.verifyPaymentSuccess(_payment);
        // minter or agent can present the proof - agent may do it to unlock the collateral if minter
        // becomes unresponsive
        require(msg.sender == crt.minter || Agents.isOwner(agent, msg.sender),
            "only minter or agent");
        require(_payment.paymentReference == PaymentReference.minting(_crtId),
            "invalid minting reference");
        require(_payment.receivingAddressHash == agent.underlyingAddressHash,
            "not minting agent's address");
        uint256 receivedAmount = SafeCast.toUint256(_payment.receivedAmount);
        uint256 mintValueUBA = Conversion.convertAmgToUBA(crt.valueAMG);
        require(receivedAmount >= mintValueUBA + crt.underlyingFeeUBA,
            "minting payment too small");
        // we do not allow payments before the underlying block at requests, because the payer should have guessed
        // the payment reference, which is good for nothing except attack attempts
        require(_payment.blockNumber >= crt.firstUnderlyingBlock,
            "minting payment too old");
        // execute minting
        _performMinting(agent, _crtId, crt.minter, crt.valueAMG, receivedAmount,
            calculatePoolFee(agent, crt.underlyingFeeUBA));
        // burn collateral reservation fee (guarded against reentrancy in AssetManager.executeMinting)
        Agents.burnDirectNAT(crt.reservationFeeNatWei);
        // cleanup
        CollateralReservations.releaseCollateralReservation(crt, _crtId);   // crt can't be used after this
    }

    function selfMint(
        ISCProofVerifier.Payment calldata _payment,
        address _agentVault,
        uint64 _lots
    )
        external
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        Agent.State storage agent = Agent.get(_agentVault);
        Agents.requireAgentVaultOwner(agent);
        Agents.requireWhitelistedAgentVaultOwner(agent);
        Collateral.CombinedData memory collateralData = AgentCollateral.combinedData(agent);
        TransactionAttestation.verifyPaymentSuccess(_payment);
        require(state.pausedAt == 0, "minting paused");
        require(agent.status == Agent.Status.NORMAL, "self-mint invalid agent status");
        require(collateralData.freeCollateralLots(agent) >= _lots, "not enough free collateral");
        uint64 valueAMG = _lots * state.settings.lotSizeAMG;
        checkMintingCap(valueAMG);
        uint256 mintValueUBA = Conversion.convertAmgToUBA(valueAMG);
        uint256 poolFeeUBA = calculatePoolFee(agent, mintValueUBA.mulBips(agent.feeBIPS));
        require(_payment.paymentReference == PaymentReference.selfMint(_agentVault),
            "invalid self-mint reference");
        require(_payment.receivingAddressHash == agent.underlyingAddressHash,
            "self-mint not agent's address");
        require(_payment.receivedAmount >= 0 && uint256(_payment.receivedAmount) >= mintValueUBA + poolFeeUBA,
            "self-mint payment too small");
        require(_payment.blockNumber >= agent.underlyingBlockAtCreation,
            "self-mint payment too old");
        state.paymentConfirmations.confirmIncomingPayment(_payment);
        // case _lots==0 is allowed for self minting because if lot size increases between the underlying payment
        // and selfMint call, the paid assets would otherwise be stuck; in this way they are converted to free balance
        uint256 receivedAmount = uint256(_payment.receivedAmount);  // guarded by require
        if (_lots > 0) {
            _performMinting(agent, 0, msg.sender, valueAMG, receivedAmount, poolFeeUBA);
        } else {
            UnderlyingBalance.increaseBalance(agent, receivedAmount);
            emit AMEvents.MintingExecuted(_agentVault, 0, 0, 0, receivedAmount, 0);
        }
    }

    function checkMintingCap(
        uint64 _increaseAMG
    )
        internal view
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        uint256 mintingCapAMG = state.settings.mintingCapAMG;
        if (mintingCapAMG == 0) return;     // minting cap disabled
        uint256 totalMintedUBA = IERC20(state.settings.fAsset).totalSupply();
        uint256 totalAMG = state.totalReservedCollateralAMG + Conversion.convertUBAToAmg(totalMintedUBA);
        require(totalAMG + _increaseAMG <= mintingCapAMG, "minting cap exceeded");
    }

    function calculatePoolFee(
        Agent.State storage _agent,
        uint256 _mintingFee
    )
        internal view
        returns (uint256)
    {
        // round to whole number of amg's to avoid rounding errors after minting (minted amount is in amg)
        return Conversion.roundUBAToAmg(_mintingFee.mulBips(_agent.poolFeeShareBIPS));
    }

    function _performMinting(
        Agent.State storage _agent,
        uint64 _crtId,
        address _minter,
        uint64 _mintValueAMG,
        uint256 _receivedAmountUBA,
        uint256 _poolFeeUBA
    )
        private
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        // Add pool fee to dust (usually less than 1 lot), but if dust exceeds 1 lot, add as much as possible
        // to the created ticket. At the end, there will always be less than 1 lot of dust left.
        uint64 poolFeeAMG = Conversion.convertUBAToAmg(_poolFeeUBA);
        uint64 newDustAMG = _agent.dustAMG + poolFeeAMG;
        uint64 ticketValueAMG = _mintValueAMG;
        if (newDustAMG >= state.settings.lotSizeAMG) {
            uint64 remainder = newDustAMG % state.settings.lotSizeAMG;
            ticketValueAMG += newDustAMG - remainder;
            newDustAMG = remainder;
        }
        // create ticket and change dust
        Agents.allocateMintedAssets(_agent, _mintValueAMG + poolFeeAMG);
        uint64 redemptionTicketId =
            state.redemptionQueue.createRedemptionTicket(_agent.vaultAddress(), ticketValueAMG);
        Agents.changeDust(_agent, newDustAMG);
        // update agent balance with deposited amount
        UnderlyingBalance.increaseBalance(_agent, _receivedAmountUBA);
        // perform minting
        uint256 mintValueUBA = Conversion.convertAmgToUBA(_mintValueAMG);
        uint256 agentFeeUBA = _receivedAmountUBA - mintValueUBA - _poolFeeUBA;
        Globals.getFAsset().mint(_minter, mintValueUBA);
        Globals.getFAsset().mint(address(_agent.collateralPool), _poolFeeUBA);
        _agent.collateralPool.fAssetFeeDeposited(_poolFeeUBA);
        // notify
        emit AMEvents.MintingExecuted(_agent.vaultAddress(), _crtId, redemptionTicketId,
            mintValueUBA, agentFeeUBA, _poolFeeUBA);
    }
}
