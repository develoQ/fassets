import { expectRevert, time } from "@openzeppelin/test-helpers";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { EventArgs } from "../../../lib/utils/events/common";
import { deepFormat, toBN, toWei } from "../../../lib/utils/helpers";
import { RedemptionRequested } from "../../../typechain-truffle/AssetManager";
import { MockChain } from "../../utils/fasset/MockChain";
import { MockStateConnectorClient } from "../../utils/fasset/MockStateConnectorClient";
import { getTestFile } from "../../utils/test-helpers";
import { assertWeb3Equal } from "../../utils/web3assertions";
import { Agent } from "../utils/Agent";
import { AssetContext } from "../utils/AssetContext";
import { Challenger } from "../utils/Challenger";
import { CommonContext } from "../utils/CommonContext";
import { Liquidator } from "../utils/Liquidator";
import { Minter } from "../utils/Minter";
import { Redeemer } from "../utils/Redeemer";
import { testChainInfo, testNatInfo } from "../utils/TestChainInfo";
import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";

contract(`AssetManagerSimulation.sol; ${getTestFile(__filename)}; Asset manager simulations`, async accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const minterAddress1 = accounts[30];
    const minterAddress2 = accounts[31];
    const redeemerAddress1 = accounts[40];
    const redeemerAddress2 = accounts[41];
    const challengerAddress1 = accounts[50];
    const challengerAddress2 = accounts[51];
    const liquidatorAddress1 = accounts[60];
    const liquidatorAddress2 = accounts[61];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingAgent2 = "Agent2";
    const underlyingMinter1 = "Minter1";
    const underlyingMinter2 = "Minter2";
    const underlyingRedeemer1 = "Redeemer1";
    const underlyingRedeemer2 = "Redeemer2";

    let commonContext: CommonContext;
    let context: AssetContext;
    let mockChain: MockChain;
    let mockStateConnectorClient: MockStateConnectorClient;

    beforeEach(async () => {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.eth);
        mockChain = context.chain as MockChain;
        mockStateConnectorClient = context.stateConnectorClient as MockStateConnectorClient;
    });

    describe("simple scenarios - illegal payment challenges and full liquidation", () => {

        it("illegal payment challenge", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // perform illegal payment
            const tx1Hash = await agent.performPayment("IllegalPayment1", 100);
            // challenge agent for illegal payment
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.illegalPaymentChallenge(agent, tx1Hash);
            await expectRevert(challenger.illegalPaymentChallenge(agent, tx1Hash), "chlg: already liquidating");
            await expectRevert(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "chlg dbl: already liquidating");
            await expectRevert(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "mult chlg: already liquidating");
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // test rewarding
            const reward = await challenger.getChallengerReward(minted.mintedAmountUBA, agent);
            assertWeb3Equal(endBalance.sub(startBalance), reward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({ totalClass1CollateralWei: fullAgentCollateral.sub(reward), freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0, announcedClass1WithdrawalWei: 0, status: AgentStatus.FULL_LIQUIDATION });
            assertWeb3Equal(info.ccbStartTimestamp, 0);
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // check that agent cannot withdraw or even announce withdrawal when being fully liquidated
            await expectRevert(agent.announceClass1CollateralWithdrawal(fullAgentCollateral), "withdrawal ann: invalid status");
            await expectRevert(agent.withdrawClass1Collateral(fullAgentCollateral), "withdrawal: invalid status");
            // check that agent cannot exit
            await expectRevert(agent.exitAndDestroy(fullAgentCollateral.sub(reward)), "agent still backing f-assets");
        });

        it("double payment challenge", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // perform double payment
            const tx1Hash = await agent.performPayment(underlyingRedeemer1, 100, PaymentReference.redemption(5));
            const tx2Hash = await agent.performPayment(underlyingRedeemer1, 100, PaymentReference.redemption(5));
            const tx3Hash = await agent.performPayment(underlyingRedeemer1, 100, PaymentReference.redemption(6));
            // check that we cannot use the same transaction multiple times or transactions with different payment references
            await expectRevert(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "chlg dbl: same transaction");
            await expectRevert(challenger.doublePaymentChallenge(agent, tx1Hash, tx3Hash), "challenge: not duplicate");
            // challenge agent for double payment
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.doublePaymentChallenge(agent, tx1Hash, tx2Hash);
            await expectRevert(challenger.illegalPaymentChallenge(agent, tx1Hash), "chlg: already liquidating");
            await expectRevert(challenger.doublePaymentChallenge(agent, tx1Hash, tx2Hash), "chlg dbl: already liquidating");
            await expectRevert(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "mult chlg: already liquidating");
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // test rewarding
            const reward = await challenger.getChallengerReward(minted.mintedAmountUBA, agent);
            assertWeb3Equal(endBalance.sub(startBalance), reward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({ totalClass1CollateralWei: fullAgentCollateral.sub(reward), freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0, announcedClass1WithdrawalWei: 0, status: AgentStatus.FULL_LIQUIDATION });
            assertWeb3Equal(info.ccbStartTimestamp, 0);
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // check that agent cannot exit
            await expectRevert(agent.exitAndDestroy(fullAgentCollateral.sub(reward)), "agent still backing f-assets");
        });

        it("free balance negative challenge", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            // perform some payments
            const tx1Hash = await agent.performPayment(underlyingRedeemer1, context.convertLotsToUBA(lots));
            // check that we cannot use the same transaction multiple times
            await expectRevert(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash, tx1Hash]), "mult chlg: repeated transaction");
            // challenge agent for negative underlying balance
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]);
            await expectRevert(challenger.illegalPaymentChallenge(agent, tx1Hash), "chlg: already liquidating");
            await expectRevert(challenger.doublePaymentChallenge(agent, tx1Hash, tx1Hash), "chlg dbl: already liquidating");
            await expectRevert(challenger.freeBalanceNegativeChallenge(agent, [tx1Hash]), "mult chlg: already liquidating");
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // test rewarding
            const reward = await challenger.getChallengerReward(minted.mintedAmountUBA, agent);
            assertWeb3Equal(endBalance.sub(startBalance), reward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({ totalClass1CollateralWei: fullAgentCollateral.sub(reward), freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0, announcedClass1WithdrawalWei: 0, status: AgentStatus.FULL_LIQUIDATION });
            assertWeb3Equal(info.ccbStartTimestamp, 0);
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // check that agent cannot exit
            await expectRevert(agent.exitAndDestroy(fullAgentCollateral.sub(reward)), "agent still backing f-assets");
        });

        it("free balance negative challenge - multiple transactions", async () => {
            const N = 10;
            const lots = 1;
            // actors
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            for (let i = 0; i < N; i++) {
                const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
                const txHash = await minter.performMintingPayment(crt);
                const minted = await minter.executeMinting(crt, txHash);
                assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            }
            // find free balance
            const agentInfo = await context.assetManager.getAgentInfo(agent.agentVault.address);
            const payGas = toBN(agentInfo.freeUnderlyingBalanceUBA).divn(N).addn(10);   // in total, pay just a bit more then there is free balance
            // transfer f-assets to redeemer
            const totalMinted = await context.fAsset.balanceOf(minter.address);
            await context.fAsset.transfer(redeemer.address, totalMinted, { from: minter.address });
            // make redemption requests
            const requests: EventArgs<RedemptionRequested>[] = [];
            for (let i = 0; i < N; i++) {
                const [rrqs] = await redeemer.requestRedemption(lots);
                requests.push(...rrqs);
            }
            assert.equal(requests.length, N);
            // perform some payments
            const txHashes: string[] = [];
            for (const request of requests) {
                const amount = (context.convertLotsToUBA(lots)).add(payGas);
                const txHash = await agent.performPayment(request.paymentAddress, amount, request.paymentReference);
                txHashes.push(txHash);
            }
            // check that all payments are legal
            for (const txHash of txHashes) {
                await expectRevert(challenger.illegalPaymentChallenge(agent, txHash), "matching redemption active");
            }
            // check that N-1 payments doesn't make free underlying balance negative
            await expectRevert(challenger.freeBalanceNegativeChallenge(agent, txHashes.slice(0, N - 1)), "mult chlg: enough balance");
            // check that N payments do make the transaction negative
            const liquidationStarted = await challenger.freeBalanceNegativeChallenge(agent, txHashes);
            // check that full liquidation started
            const info = await context.assetManager.getAgentInfo(agent.agentVault.address);
            assertWeb3Equal(info.ccbStartTimestamp, 0);
            assertWeb3Equal(info.ccbStartTimestamp, 0);
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
        });

        it("full liquidation", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const challenger = await Challenger.create(context, challengerAddress1);
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            const mintedAmount = toBN(minted.mintedAmountUBA).add(minted.poolFeeUBA);
            // perform illegal payment
            const tx1Hash = await agent.performPayment("IllegalPayment1", 100);
            // challenge agent for illegal payment
            const startBalance = await context.usdc.balanceOf(challenger.address);
            const liquidationStarted = await challenger.illegalPaymentChallenge(agent, tx1Hash);
            const endBalance = await context.usdc.balanceOf(challenger.address);
            // test rewarding
            const challengerReward = await challenger.getChallengerReward(mintedAmount, agent);
            assertWeb3Equal(endBalance.sub(startBalance), challengerReward);
            // test full liquidation started
            const info = await agent.checkAgentInfo({
                totalClass1CollateralWei: fullAgentCollateral.sub(challengerReward),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: mintedAmount,
                status: AgentStatus.FULL_LIQUIDATION });
            assertWeb3Equal(info.ccbStartTimestamp, 0);
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationStarted.timestamp);
            assert.equal(liquidationStarted.agentVault, agent.agentVault.address);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateUBA = minted.mintedAmountUBA.divn(3);
            const startBalanceLiquidator1Class1 = await context.usdc.balanceOf(liquidator.address);
            const startBalanceLiquidator1Pool = await context.wNat.balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateUBA);
            const endBalanceLiquidator1Class1 = await context.usdc.balanceOf(liquidator.address);
            const endBalanceLiquidator1Pool = await context.wNat.balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateUBA);
            assert.isUndefined(liquidationStarted1);
            assert.isUndefined(liquidationCancelled1);
            // full liquidation cannot be stopped
            await expectRevert(agent.endLiquidation(), "cannot stop liquidation");
            await expectRevert(liquidator.endLiquidation(agent), "cannot stop liquidation");
            // test rewarding
            const collateralRatioBIPS1Class1 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(challengerReward), mintedAmount);
            const liquidationFactorBIPS1Class1 = await liquidator.getLiquidationFactorBIPSClass1(collateralRatioBIPS1Class1, liquidationStarted.timestamp, liquidationTimestamp1);
            const liquidationReward1Class1 = await liquidator.getLiquidationRewardClass1(liquidatedUBA1, liquidationFactorBIPS1Class1);
            assertWeb3Equal(endBalanceLiquidator1Class1.sub(startBalanceLiquidator1Class1), liquidationReward1Class1);
            const collateralRatioBIPS1Pool = await agent.getCollateralRatioBIPS(fullAgentCollateral, mintedAmount);
            const liquidationFactorBIPS1Pool = await liquidator.getLiquidationFactorBIPSPool(collateralRatioBIPS1Pool, liquidationStarted.timestamp, liquidationTimestamp1);
            const liquidationReward1Pool = await liquidator.getLiquidationRewardPool(liquidatedUBA1, liquidationFactorBIPS1Pool);
            assertWeb3Equal(endBalanceLiquidator1Pool.sub(startBalanceLiquidator1Pool), liquidationReward1Pool);
            await agent.checkAgentInfo({
                totalClass1CollateralWei: fullAgentCollateral.sub(challengerReward).sub(liquidationReward1Class1),
                totalPoolCollateralNATWei: fullAgentCollateral.sub(liquidationReward1Pool),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidateUBA),
                mintedUBA: mintedAmount.sub(liquidateUBA),
                ccbStartTimestamp: 0,
                liquidationStartTimestamp: liquidationStarted.timestamp,
                status: AgentStatus.FULL_LIQUIDATION });
            // wait some time to get next premium
            await time.increase(90);
            // liquidate agent (second part)
            const startBalanceLiquidator2Class1 = await context.usdc.balanceOf(liquidator.address);
            const startBalanceLiquidator2Pool = await context.wNat.balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateUBA);
            const endBalanceLiquidator2Class1 = await context.usdc.balanceOf(liquidator.address);
            const endBalanceLiquidator2Pool = await context.wNat.balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA2, liquidateUBA);
            assert.isUndefined(liquidationStarted2);
            assert.isUndefined(liquidationCancelled2);
            // full liquidation cannot be stopped
            await expectRevert(agent.endLiquidation(), "cannot stop liquidation");
            await expectRevert(liquidator.endLiquidation(agent), "cannot stop liquidation");
            // test rewarding
            const collateralRatioBIPS2Class1 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(challengerReward).sub(liquidationReward1Class1), mintedAmount.sub(liquidateUBA));
            const liquidationFactorBIPS2Class1 = await liquidator.getLiquidationFactorBIPSClass1(collateralRatioBIPS2Class1, liquidationStarted.timestamp, liquidationTimestamp2);
            const liquidationReward2Class1 = await liquidator.getLiquidationRewardClass1(liquidatedUBA2, liquidationFactorBIPS2Class1);
            assertWeb3Equal(endBalanceLiquidator2Class1.sub(startBalanceLiquidator2Class1), liquidationReward2Class1);
            const collateralRatioBIPS2Pool = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(liquidationReward1Pool), mintedAmount.sub(liquidateUBA));
            const liquidationFactorBIPS2Pool = await liquidator.getLiquidationFactorBIPSPool(collateralRatioBIPS2Pool, liquidationStarted.timestamp, liquidationTimestamp2);
            const liquidationReward2Pool = await liquidator.getLiquidationRewardPool(liquidatedUBA2, liquidationFactorBIPS2Pool);
            assertWeb3Equal(endBalanceLiquidator2Pool.sub(startBalanceLiquidator2Pool), liquidationReward2Pool);
            await agent.checkAgentInfo({
                totalClass1CollateralWei: fullAgentCollateral.sub(challengerReward).sub(liquidationReward1Class1).sub(liquidationReward2Class1),
                totalPoolCollateralNATWei: fullAgentCollateral.sub(liquidationReward1Pool).sub(liquidationReward2Pool),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidateUBA.muln(2)),
                mintedUBA: mintedAmount.sub(liquidateUBA.muln(2)),
                ccbStartTimestamp: 0,
                liquidationStartTimestamp: liquidationStarted.timestamp,
                status: AgentStatus.FULL_LIQUIDATION });
            // wait some time to get next premium
            await time.increase(90);
            // liquidate agent (last part)
            const startBalanceLiquidator3Class1 = await context.usdc.balanceOf(liquidator.address);
            const startBalanceLiquidator3Pool = await context.wNat.balanceOf(liquidator.address);
            const [liquidatedUBA3, liquidationTimestamp3, liquidationStarted3, liquidationCancelled3] = await liquidator.liquidate(agent, liquidateUBA);
            const endBalanceLiquidator3Class1 = await context.usdc.balanceOf(liquidator.address);
            const endBalanceLiquidator3Pool = await context.wNat.balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA3, liquidateUBA);
            assert.isUndefined(liquidationStarted3);
            assert.isUndefined(liquidationCancelled3);
            // full liquidation cannot be stopped
            await expectRevert(agent.endLiquidation(), "cannot stop liquidation");
            await expectRevert(liquidator.endLiquidation(agent), "cannot stop liquidation");
            // test rewarding
            const collateralRatioBIPS3Class1 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(challengerReward).sub(liquidationReward1Class1).sub(liquidationReward2Class1), mintedAmount.sub(liquidateUBA.muln(2)));
            const liquidationFactorBIPS3Class1 = await liquidator.getLiquidationFactorBIPSClass1(collateralRatioBIPS3Class1, liquidationStarted.timestamp, liquidationTimestamp3);
            const liquidationReward3Class1 = await liquidator.getLiquidationRewardClass1(liquidatedUBA3, liquidationFactorBIPS3Class1);
            assertWeb3Equal(endBalanceLiquidator3Class1.sub(startBalanceLiquidator3Class1), liquidationReward3Class1);
            const collateralRatioBIPS3Pool = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(liquidationReward1Pool).sub(liquidationReward2Pool), mintedAmount.sub(liquidateUBA.muln(2)));
            const liquidationFactorBIPS3Pool = await liquidator.getLiquidationFactorBIPSPool(collateralRatioBIPS3Pool, liquidationStarted.timestamp, liquidationTimestamp3);
            const liquidationReward3Pool = await liquidator.getLiquidationRewardPool(liquidatedUBA3, liquidationFactorBIPS3Pool);
            assertWeb3Equal(endBalanceLiquidator3Pool.sub(startBalanceLiquidator3Pool), liquidationReward3Pool);
            await agent.checkAgentInfo({
                totalClass1CollateralWei: fullAgentCollateral.sub(challengerReward).sub(liquidationReward1Class1).sub(liquidationReward2Class1).sub(liquidationReward3Class1),
                totalPoolCollateralNATWei: fullAgentCollateral.sub(liquidationReward1Pool).sub(liquidationReward2Pool).sub(liquidationReward3Pool),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidateUBA.muln(3)),
                mintedUBA: mintedAmount.sub(liquidateUBA.muln(3)),
                ccbStartTimestamp: 0,
                liquidationStartTimestamp: liquidationStarted.timestamp,
                status: AgentStatus.FULL_LIQUIDATION
            });
            // final tests
            assertWeb3Equal(liquidatedUBA1, liquidatedUBA2);
            assertWeb3Equal(liquidatedUBA1, liquidatedUBA3);
            assert(liquidationFactorBIPS1Class1.eq(liquidationFactorBIPS2Class1));
            assert(liquidationFactorBIPS2Class1.eq(liquidationFactorBIPS3Class1));
            assert(liquidationFactorBIPS1Pool.lt(liquidationFactorBIPS2Pool));
            assert(liquidationFactorBIPS2Pool.lt(liquidationFactorBIPS3Pool));
            assert(liquidationReward1Class1.eq(liquidationReward2Class1));
            assert(liquidationReward2Class1.eq(liquidationReward3Class1));
            assert(liquidationReward1Pool.lt(liquidationReward2Pool));
            assert(liquidationReward2Pool.lt(liquidationReward3Pool));
            // full liquidation cannot be stopped
            await expectRevert(agent.endLiquidation(), "cannot stop liquidation");
            await expectRevert(liquidator.endLiquidation(agent), "cannot stop liquidation");
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(challengerReward).sub(liquidationReward1Class1).sub(liquidationReward2Class1).sub(liquidationReward3Class1));
        });
    });
});
