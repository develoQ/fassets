import { UnderlyingWithdrawalAnnounced, FullLiquidationStarted, RedemptionRequested, RedemptionPaymentFailed, RedemptionDefault } from "../../../typechain-truffle/AssetManager";
import { checkEventNotEmited, eventArgs, findRequiredEvent, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { EventArgs } from "../../../lib/utils/events/common";
import { BNish, MAX_BIPS, toBN, toBNExp } from "../../../lib/utils/helpers";
import { Agent } from "./Agent";
import { AssetContext, AssetContextClient } from "./AssetContext";

export class Challenger extends AssetContextClient {
    constructor(
        context: AssetContext,
        public address: string
    ) {
        super(context);
    }

    static async create(ctx: AssetContext, address: string) {
        // creater object
        return new Challenger(ctx, address);
    }

    async illegalPaymentChallenge(agent: Agent, txHash: string): Promise<EventArgs<FullLiquidationStarted>> {
        const proof = await this.attestationProvider.proveBalanceDecreasingTransaction(txHash, agent.underlyingAddress);
        const res = await this.assetManager.illegalPaymentChallenge(proof, agent.agentVault.address, { from: this.address });
        findRequiredEvent(res, 'IllegalPaymentConfirmed');
        return eventArgs(res, 'FullLiquidationStarted');
    }

    async doublePaymentChallenge(agent: Agent, txHash1: string, txHash2: string): Promise<EventArgs<FullLiquidationStarted>> {
        const proof1 = await this.attestationProvider.proveBalanceDecreasingTransaction(txHash1, agent.underlyingAddress);
        const proof2 = await this.attestationProvider.proveBalanceDecreasingTransaction(txHash2, agent.underlyingAddress);
        const res = await this.assetManager.doublePaymentChallenge(proof1, proof2, agent.agentVault.address, { from: this.address });
        findRequiredEvent(res, 'DuplicatePaymentConfirmed');
        return eventArgs(res, 'FullLiquidationStarted');
    }

    async freeBalanceNegativeChallenge(agent: Agent, txHashes: string[]): Promise<EventArgs<FullLiquidationStarted>> {
        const proofs: any[] = [];
        for (const txHash of txHashes) {
            proofs.push(await this.attestationProvider.proveBalanceDecreasingTransaction(txHash, agent.underlyingAddress));
        }
        const res = await this.assetManager.freeBalanceNegativeChallenge(proofs, agent.agentVault.address, { from: this.address });
        findRequiredEvent(res, 'UnderlyingBalanceTooLow');
        return eventArgs(res, 'FullLiquidationStarted');
    }

    async confirmActiveRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        return requiredEventArgs(res, 'RedemptionPerformed');
    }

    async confirmDefaultedRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        checkEventNotEmited(res, 'RedemptionPerformed');
    }

    async confirmFailedRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent): Promise<[redemptionPaymentFailed: EventArgs<RedemptionPaymentFailed>, redemptionDefault: EventArgs<RedemptionDefault>]>  {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        return [requiredEventArgs(res, 'RedemptionPaymentFailed'), requiredEventArgs(res, 'RedemptionDefault')];
    }

    async confirmBlockedRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        return requiredEventArgs(res, 'RedemptionPaymentBlocked');
    }

    async confirmUnderlyingWithdrawal(request: EventArgs<UnderlyingWithdrawalAnnounced>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, null);
        const res = await this.assetManager.confirmUnderlyingWithdrawal(proof, request.agentVault, { from: this.address });
        return requiredEventArgs(res, 'UnderlyingWithdrawalConfirmed');
    }

    async getChallengerReward(backingAtChallengeUBA: BNish, agent: Agent) {
        const settings = await this.context.assetManager.getSettings();
        const backingAtChallengeAMG = this.context.convertUBAToAmg(backingAtChallengeUBA);
        // assuming class1 is usd-pegged
        const rewardAMG = backingAtChallengeAMG.mul(toBN(settings.paymentChallengeRewardBIPS)).divn(MAX_BIPS);
        const rewardClass1 = await agent.usd5ToClass1Wei(toBN(settings.paymentChallengeRewardUSD5));
        const priceClass1 = await this.context.getCollateralPrice(agent.class1Collateral());
        return priceClass1.convertAmgToTokenWei(rewardAMG).add(rewardClass1)
    }
}
