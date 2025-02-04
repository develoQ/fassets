import { constants, expectEvent, expectRevert, time } from "@openzeppelin/test-helpers";
import { AssetManagerSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { LiquidationStrategyImplSettings, encodeLiquidationStrategyImplSettings } from "../../../../lib/fasset/LiquidationStrategyImpl";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BN_ZERO, DAYS, HOURS, MAX_BIPS, WEEKS, randomAddress, toBIPS, toBN, toStringExp, erc165InterfaceId } from "../../../../lib/utils/helpers";
import { AssetManagerControllerInstance, AssetManagerInstance, ERC20MockInstance, FAssetInstance, WNatInstance, WhitelistInstance, IERC165Contract, AddressUpdatableContract } from "../../../../typechain-truffle";
import { testChainInfo } from "../../../integration/utils/TestChainInfo";
import { newAssetManager, waitForTimelock } from "../../../utils/fasset/DeployAssetManager";
import { MockChain, MockChainWallet } from "../../../utils/fasset/MockChain";
import { MockStateConnectorClient } from "../../../utils/fasset/MockStateConnectorClient";
import { getTestFile } from "../../../utils/test-helpers";
import { assertWeb3Equal, web3ResultStruct } from "../../../utils/web3assertions";
import { TestFtsos, TestSettingsContracts, createEncodedTestLiquidationSettings, createTestCollaterals, createTestContracts, createTestFtsos, createTestLiquidationSettings, createTestSettings } from "../../../utils/test-settings";
import { AddressUpdatableInstance, AddressUpdatableMockContract } from "../../../../typechain-truffle";

const Whitelist = artifacts.require('Whitelist');
const AssetManagerController = artifacts.require('AssetManagerController');
const AddressUpdatableMock = artifacts.require('AddressUpdatableMock');

contract(`AssetManagerController.sol; ${getTestFile(__filename)}; Asset manager controller basic tests`, async accounts => {
    const governance = accounts[10];
    const updateExecutor = accounts[11];
    let assetManagerController: AssetManagerControllerInstance;
    let contracts: TestSettingsContracts;
    let assetManager: AssetManagerInstance;
    let fAsset: FAssetInstance;
    let wNat: WNatInstance;
    let usdc: ERC20MockInstance;
    let ftsos: TestFtsos;
    let settings: AssetManagerSettings;
    let collaterals: CollateralType[];
    let chain: MockChain;
    let wallet: MockChainWallet;
    let stateConnectorClient: MockStateConnectorClient;
    let attestationProvider: AttestationHelper;
    let whitelist: WhitelistInstance;
    let addressUpdatableMock : AddressUpdatableInstance;

    let liquidationStrategySettings: LiquidationStrategyImplSettings;

    beforeEach(async () => {
        const ci = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        await contracts.governanceSettings.setExecutors([governance, updateExecutor], { from: governance });
        // save some contracts as globals
        ({ wNat } = contracts);
        usdc = contracts.stablecoins.USDC;
        // create FTSOs for nat, stablecoins and asset and set some price
        ftsos = await createTestFtsos(contracts.ftsoRegistry, ci);
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        stateConnectorClient = new MockStateConnectorClient(contracts.stateConnector, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(stateConnectorClient, chain, ci.chainId);
        // create whitelist
        whitelist = await Whitelist.new(contracts.governanceSettings.address, governance, false);
        await whitelist.switchToProductionMode({ from: governance });
        // create asset manager controller
        assetManagerController = await AssetManagerController.new(contracts.governanceSettings.address, governance, contracts.addressUpdater.address);
        await assetManagerController.switchToProductionMode({ from: governance });
        // crate liquidation strategy settings
        liquidationStrategySettings = createTestLiquidationSettings();
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true });
        const encodedLiquidationStrategySettings = encodeLiquidationStrategyImplSettings(liquidationStrategySettings);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, encodedLiquidationStrategySettings, updateExecutor);
        addressUpdatableMock = await AddressUpdatableMock.new(contracts.addressUpdater.address);
    });

    describe("set and update settings with controller", () => {

        it("should know about governance", async () => {
            const governance_test = await assetManagerController.governance();
            assert.equal(governance, governance_test);
        })

        it("should get asset managers and check if exist", async () => {
            const managers = await assetManagerController.getAssetManagers();
            assert.equal(assetManager.address, managers[0]);

            const manager_exists = await assetManagerController.assetManagerExists(assetManager.address)
            assert.equal(true, manager_exists);
        });

        it("should add and remove asset manager", async () => {
            let assetManager2: AssetManagerInstance;
            let fAsset2: FAssetInstance;
            const managers_current = await assetManagerController.getAssetManagers();
            [assetManager2, fAsset2] = await newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, settings, collaterals, createEncodedTestLiquidationSettings(), updateExecutor);

            const res1 = await assetManagerController.addAssetManager(assetManager2.address, { from: governance });
            await waitForTimelock(res1, assetManagerController, updateExecutor);
            const managers_add = await assetManagerController.getAssetManagers();
            assert.equal(managers_current.length + 1, managers_add.length);

            const res2 = await assetManagerController.removeAssetManager(assetManager.address, { from: governance });
            await waitForTimelock(res2, assetManagerController, updateExecutor);
            const managers_remove = await assetManagerController.getAssetManagers();
            assert.equal(managers_current.length, managers_remove.length);
        });

        it("should not add asset manager twice", async () => {
            const managers_current = await assetManagerController.getAssetManagers();

            await assetManagerController.addAssetManager(managers_current[0], { from: governance });
            const managers_add = await assetManagerController.getAssetManagers();
            assert.equal(managers_current.length, managers_add.length);
        });

        it("should do nothing if removing unexisting asset manager", async () => {
            let assetManager2: AssetManagerInstance;
            let fAsset2: FAssetInstance;
            const managers_current = await assetManagerController.getAssetManagers();
            [assetManager2, fAsset2] = await newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, settings, collaterals, createEncodedTestLiquidationSettings(), updateExecutor);

            await waitForTimelock(assetManagerController.addAssetManager(assetManager2.address, { from: governance }), assetManagerController, updateExecutor);
            const managers_add = await assetManagerController.getAssetManagers();
            assert.equal(managers_current.length + 1, managers_add.length);

            await waitForTimelock(assetManagerController.removeAssetManager(assetManager2.address, { from: governance }), assetManagerController, updateExecutor);
            const managers_remove = await assetManagerController.getAssetManagers();
            assert.equal(managers_current.length, managers_remove.length);

            await waitForTimelock(assetManagerController.removeAssetManager(assetManager2.address, { from: governance }), assetManagerController, updateExecutor);
            const managers_remove2 = await assetManagerController.getAssetManagers();
            assert.equal(managers_current.length, managers_remove2.length);
        });

        it("should revert setting whitelist without governance", async () => {
            let res = assetManagerController.setWhitelist([assetManager.address], randomAddress());
            await expectRevert(res, "only governance")
        });

        it("should set whitelist address", async () => {
            let encodedCall: string = assetManagerController.contract.methods.setWhitelist([assetManager.address], whitelist.address).encodeABI();
            let res = await assetManagerController.setWhitelist([assetManager.address], whitelist.address, { from: governance });
            let allowedAfterTimestamp = (await time.latest()).addn(60);
            expectEvent(res, "GovernanceCallTimelocked", { selector: encodedCall.slice(0, 10), allowedAfterTimestamp, encodedCall })
        });

        it("should execute set whitelist", async () => {
            const res = await assetManagerController.setWhitelist([assetManager.address], whitelist.address, { from: governance });
            await waitForTimelock(res, assetManagerController, updateExecutor);
            // assert
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(newSettings.whitelist, whitelist.address);
        });

        it("should not execute set whitelist", async () => {
            const res1 = await assetManagerController.setWhitelist([assetManager.address], whitelist.address, { from: governance });
            const timelock = requiredEventArgs(res1, 'GovernanceCallTimelocked');
            let res = assetManagerController.executeGovernanceCall(timelock.selector, { from: updateExecutor });
            await expectRevert(res, "timelock: not allowed yet");
        });

        it("should revert setting lot size when increase or decrease is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let lotSizeAMG_big = toBN(currentSettings.lotSizeAMG).muln(5);
            let lotSizeAMG_small = toBN(currentSettings.lotSizeAMG).divn(5);

            await expectRevert(waitForTimelock(assetManagerController.setLotSizeAmg([assetManager.address], lotSizeAMG_big, { from: governance }), assetManagerController, updateExecutor), "lot size increase too big");
            await expectRevert(waitForTimelock(assetManagerController.setLotSizeAmg([assetManager.address], lotSizeAMG_small, { from: governance }), assetManagerController, updateExecutor), "lot size decrease too big");
            await expectRevert(waitForTimelock(assetManagerController.setLotSizeAmg([assetManager.address], 0, { from: governance }), assetManagerController, updateExecutor), "cannot be zero");
        });

        it("should revert setting payment challenge reward when increase or decrease is too big", async () => {
            let paymentChallengeRewardUSD5 = toStringExp(100, 18);
            let paymentChallengeRewardBIPS = 100;
            await assetManagerController.setPaymentChallengeReward([assetManager.address], paymentChallengeRewardUSD5, paymentChallengeRewardBIPS, { from: governance });

            let val = toStringExp(100, 18);
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            let paymentChallengeRewardUSD5_big = (toBN(newSettings.paymentChallengeRewardUSD5).muln(5).add(toBN(val)));
            let paymentChallengeRewardUSD5_small = toBN(newSettings.paymentChallengeRewardUSD5).divn(5);

            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            let res1 = assetManagerController.setPaymentChallengeReward([assetManager.address], paymentChallengeRewardUSD5_big, newSettings.paymentChallengeRewardBIPS, { from: governance });
            await expectRevert(res1, "increase too big");
            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            let res2 = assetManagerController.setPaymentChallengeReward([assetManager.address], paymentChallengeRewardUSD5_small, newSettings.paymentChallengeRewardBIPS, { from: governance });
            await expectRevert(res2, "decrease too big");

            let paymentChallengeRewardBIPS_big = (toBN(newSettings.paymentChallengeRewardBIPS).addn(100)).muln(5);
            let paymentChallengeRewardBIPS_small = toBN(newSettings.paymentChallengeRewardBIPS).divn(5);

            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            let res3 = assetManagerController.setPaymentChallengeReward([assetManager.address], newSettings.paymentChallengeRewardUSD5, paymentChallengeRewardBIPS_big, { from: governance });
            await expectRevert(res3, "increase too big");
            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            let res4 = assetManagerController.setPaymentChallengeReward([assetManager.address], newSettings.paymentChallengeRewardUSD5, paymentChallengeRewardBIPS_small, { from: governance });
            await expectRevert(res4, "decrease too big");
        });

        it("should set payment challenge reward", async () => {
            const currentSettings = await assetManager.getSettings();
            let paymentChallengeRewardUSD5_new = toBN(currentSettings.paymentChallengeRewardUSD5).muln(4);
            let paymentChallengeRewardBIPS_new = (toBN(currentSettings.paymentChallengeRewardBIPS).muln(4)).addn(100);

            let res = await assetManagerController.setPaymentChallengeReward([assetManager.address], paymentChallengeRewardUSD5_new, paymentChallengeRewardBIPS_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "paymentChallengeRewardUSD5", value: paymentChallengeRewardUSD5_new });
            expectEvent(res, "SettingChanged", { name: "paymentChallengeRewardBIPS", value: paymentChallengeRewardBIPS_new });
        });

        it("should set time for payment", async () => {
            const currentSettings = await assetManager.getSettings();
            let underlyingBlocksForPayment_new = toBN(currentSettings.underlyingBlocksForPayment).muln(2);
            let underlyingSecondsForPayment_new = toBN(currentSettings.underlyingSecondsForPayment).muln(2);
            let res = await assetManagerController.setTimeForPayment([assetManager.address], underlyingBlocksForPayment_new, underlyingSecondsForPayment_new, { from: governance });
            expectEvent(res, "GovernanceCallTimelocked");
        });

        it("should revert setting max trusted price age seconds when increase or decrease is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let maxTrustedPriceAgeSeconds_big = toBN(currentSettings.maxTrustedPriceAgeSeconds).muln(60);
            let maxTrustedPriceAgeSeconds_small = toBN(currentSettings.maxTrustedPriceAgeSeconds).divn(60);
            let res_big = assetManagerController.setMaxTrustedPriceAgeSeconds([assetManager.address], maxTrustedPriceAgeSeconds_big, { from: governance });
            let res_small = assetManagerController.setMaxTrustedPriceAgeSeconds([assetManager.address], maxTrustedPriceAgeSeconds_small, { from: governance });
            let res_zero = assetManagerController.setMaxTrustedPriceAgeSeconds([assetManager.address], 0, { from: governance });
            await expectRevert(res_big, "fee increase too big");
            await expectRevert(res_small, "fee decrease too big");
            await expectRevert(res_zero, "cannot be zero");
        });

        it("should set max trusted price age seconds", async () => {
            const currentSettings = await assetManager.getSettings();
            let maxTrustedPriceAgeSeconds_new = toBN(currentSettings.maxTrustedPriceAgeSeconds).addn(20);
            let res = await assetManagerController.setMaxTrustedPriceAgeSeconds([assetManager.address], maxTrustedPriceAgeSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "maxTrustedPriceAgeSeconds", value: toBN(maxTrustedPriceAgeSeconds_new) });
        });

        it("should revert setting collateral reservation fee bips when increase or decrease is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let collateralReservationFeeBIPS_big = toBN(currentSettings.collateralReservationFeeBIPS).muln(5);
            let collateralReservationFeeBIPS_small = toBN(currentSettings.collateralReservationFeeBIPS).divn(5);
            let collateralReservationFeeBIPS_too_high = toBN(MAX_BIPS).addn(1);
            let res_big = assetManagerController.setCollateralReservationFeeBips([assetManager.address], collateralReservationFeeBIPS_big, { from: governance });
            let res_small = assetManagerController.setCollateralReservationFeeBips([assetManager.address], collateralReservationFeeBIPS_small, { from: governance });
            let res_too_high = assetManagerController.setCollateralReservationFeeBips([assetManager.address], collateralReservationFeeBIPS_too_high, { from: governance });
            let res_zero = assetManagerController.setCollateralReservationFeeBips([assetManager.address], 0, { from: governance });
            await expectRevert(res_big, "fee increase too big");
            await expectRevert(res_small, "fee decrease too big");
            await expectRevert(res_too_high, "bips value too high");
            await expectRevert(res_zero, "cannot be zero");
        });

        it("should set collateral reservation fee bips", async () => {
            const currentSettings = await assetManager.getSettings();
            let collateralReservationFeeBIPS_new = toBN(currentSettings.collateralReservationFeeBIPS).muln(2);
            let res = await assetManagerController.setCollateralReservationFeeBips([assetManager.address], collateralReservationFeeBIPS_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "collateralReservationFeeBIPS", value: toBN(collateralReservationFeeBIPS_new) });
        });

        it("should revert setting redemption fee bips when increase or decrease is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let redemptionFeeBIPS_big = toBN(currentSettings.redemptionFeeBIPS).muln(5);
            let redemptionFeeBIPS_small = toBN(currentSettings.redemptionFeeBIPS).divn(5);
            let redemptionFeeBIPS_too_high = toBN(MAX_BIPS).addn(1);
            let res_big = assetManagerController.setRedemptionFeeBips([assetManager.address], redemptionFeeBIPS_big, { from: governance });
            let res_small = assetManagerController.setRedemptionFeeBips([assetManager.address], redemptionFeeBIPS_small, { from: governance });
            let res_too_high = assetManagerController.setRedemptionFeeBips([assetManager.address], redemptionFeeBIPS_too_high, { from: governance });
            let res_zero = assetManagerController.setRedemptionFeeBips([assetManager.address], 0, { from: governance });
            await expectRevert(res_big, "fee increase too big");
            await expectRevert(res_small, "fee decrease too big");
            await expectRevert(res_too_high, "bips value too high");
            await expectRevert(res_zero, "cannot be zero");
        });

        it("should revert setting confirmation by others after seconds when value too low", async () => {
            let confirmationByOthersAfterSeconds_small = 1.8 * HOURS;
            let res_big = assetManagerController.setConfirmationByOthersAfterSeconds([assetManager.address], confirmationByOthersAfterSeconds_small, { from: governance });
            await expectRevert(res_big, "must be at least two hours");
        });

        it("should set confirmation by others after seconds", async () => {
            const currentSettings = await assetManager.getSettings();
            let confirmationByOthersAfterSeconds_new = toBN(currentSettings.confirmationByOthersAfterSeconds).muln(2);
            let res = await assetManagerController.setConfirmationByOthersAfterSeconds([assetManager.address], confirmationByOthersAfterSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "confirmationByOthersAfterSeconds", value: toBN(confirmationByOthersAfterSeconds_new) });
        });

        it("should revert setting confirmation by others reward NATWei when increase or decrease is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let confirmationByOthersRewardUSD5_big = toBN(currentSettings.confirmationByOthersRewardUSD5).muln(5);
            let confirmationByOthersRewardUSD5_small = toBN(currentSettings.confirmationByOthersRewardUSD5).divn(5);
            let res_big = assetManagerController.setConfirmationByOthersRewardUSD5([assetManager.address], confirmationByOthersRewardUSD5_big, { from: governance });
            let res_small = assetManagerController.setConfirmationByOthersRewardUSD5([assetManager.address], confirmationByOthersRewardUSD5_small, { from: governance });
            let res_zero = assetManagerController.setConfirmationByOthersRewardUSD5([assetManager.address], 0, { from: governance });
            await expectRevert(res_big, "fee increase too big");
            await expectRevert(res_small, "fee decrease too big");
            await expectRevert(res_zero, "cannot be zero");
        });

        it("should set confirmation by others reward NATWei", async () => {
            const currentSettings = await assetManager.getSettings();
            let confirmationByOthersRewardUSD5_new = toBN(currentSettings.confirmationByOthersRewardUSD5).muln(2);
            let res = await assetManagerController.setConfirmationByOthersRewardUSD5([assetManager.address], confirmationByOthersRewardUSD5_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "confirmationByOthersRewardUSD5", value: toBN(confirmationByOthersRewardUSD5_new) });
        });

        it("should revert setting max redeemed tickets when increase or decrease is too big or value is < 1", async () => {
            const currentSettings = await assetManager.getSettings();
            let maxRedeemedTickets_big = toBN(currentSettings.maxRedeemedTickets).muln(3);
            let maxRedeemedTickets_small = toBN(currentSettings.maxRedeemedTickets).divn(5);
            let maxRedeemedTickets_zero = 0;

            let res_big = assetManagerController.setMaxRedeemedTickets([assetManager.address], maxRedeemedTickets_big, { from: governance });
            let res_small = assetManagerController.setMaxRedeemedTickets([assetManager.address], maxRedeemedTickets_small, { from: governance });
            let res_zero = assetManagerController.setMaxRedeemedTickets([assetManager.address], maxRedeemedTickets_zero, { from: governance });

            await expectRevert(res_big, "increase too big");
            await expectRevert(res_small, "decrease too big");
            await expectRevert(res_zero, "cannot be zero");
        });

        it("should set max redeemed tickets", async () => {
            const currentSettings = await assetManager.getSettings();
            let maxRedeemedTickets_new = toBN(currentSettings.maxRedeemedTickets).muln(2);
            let res = await assetManagerController.setMaxRedeemedTickets([assetManager.address], maxRedeemedTickets_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "maxRedeemedTickets", value: toBN(maxRedeemedTickets_new) });
        });

        it("should revert setting withdrawal wait when increase is too big or value is < 1", async () => {
            const currentSettings = await assetManager.getSettings();
            let withdrawalWaitMinSeconds_big = toBN(currentSettings.withdrawalWaitMinSeconds).addn(11 * 60);
            let withdrawalWaitMinSeconds_zero = 0;

            let res_big = assetManagerController.setWithdrawalOrDestroyWaitMinSeconds([assetManager.address], withdrawalWaitMinSeconds_big, { from: governance });
            let res_zero = assetManagerController.setWithdrawalOrDestroyWaitMinSeconds([assetManager.address], withdrawalWaitMinSeconds_zero, { from: governance });

            await expectRevert(res_big, "increase too big");
            await expectRevert(res_zero, "cannot be zero");
        });

        it("should set withdrawal wait", async () => {
            const currentSettings = await assetManager.getSettings();
            let withdrawalWaitMinSeconds_new = toBN(currentSettings.withdrawalWaitMinSeconds).muln(2);
            let res = await assetManagerController.setWithdrawalOrDestroyWaitMinSeconds([assetManager.address], withdrawalWaitMinSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "withdrawalWaitMinSeconds", value: toBN(withdrawalWaitMinSeconds_new) });
        });

        it("should revert setting ccb time when increase or decrease is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let ccbTimeSeconds_big = toBN(currentSettings.ccbTimeSeconds).muln(3);
            let ccbTimeSeconds_small = toBN(currentSettings.ccbTimeSeconds).divn(3);

            let res_big = assetManagerController.setCcbTimeSeconds([assetManager.address], ccbTimeSeconds_big, { from: governance });
            let res_small = assetManagerController.setCcbTimeSeconds([assetManager.address], ccbTimeSeconds_small, { from: governance });
            let res_zero = assetManagerController.setCcbTimeSeconds([assetManager.address], 0, { from: governance });

            await expectRevert(res_big, "increase too big");
            await expectRevert(res_small, "decrease too big");
            await expectRevert(res_zero, "cannot be zero");
        });

        it("should set ccb time", async () => {
            const currentSettings = await assetManager.getSettings();
            let ccbTimeSeconds_new = toBN(currentSettings.ccbTimeSeconds).muln(2);
            let res = await assetManagerController.setCcbTimeSeconds([assetManager.address], ccbTimeSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "ccbTimeSeconds", value: toBN(ccbTimeSeconds_new) });
        });

        it("should revert setting liquidation step when increase or decrease is too big", async () => {
            const liquidationStrategySettings_big = {
                ...liquidationStrategySettings,
                liquidationStepSeconds: toBN(liquidationStrategySettings.liquidationStepSeconds).muln(3)
            };
            const liquidationStrategySettings_small = {
                ...liquidationStrategySettings,
                liquidationStepSeconds: toBN(liquidationStrategySettings.liquidationStepSeconds).divn(3)
            };
            const liquidationStrategySettings_zero = {
                ...liquidationStrategySettings,
                liquidationStepSeconds: BN_ZERO
            };
            const res_big = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_big), { from: governance });
            await expectRevert(waitForTimelock(res_big, assetManagerController, updateExecutor), "increase too big");
            const res_small = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_small), { from: governance });
            await expectRevert(waitForTimelock(res_small, assetManagerController, updateExecutor), "decrease too big");
            const res_zero = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_zero), { from: governance });
            await expectRevert(waitForTimelock(res_zero, assetManagerController, updateExecutor), "cannot be zero");
        });

        it("should set liquidation step", async () => {
            const newLiquidationStrategySettings = {
                ...liquidationStrategySettings,
                liquidationStepSeconds: toBN(liquidationStrategySettings.liquidationStepSeconds).muln(2)
            };
            let prms = assetManagerController.setLiquidationStrategy([assetManager.address], contracts.liquidationStrategy, encodeLiquidationStrategyImplSettings(newLiquidationStrategySettings), { from: governance });
            let res = await waitForTimelock(prms, assetManagerController, updateExecutor);
            expectEvent(res, "SettingChanged", { name: "liquidationStepSeconds", value: toBN(newLiquidationStrategySettings.liquidationStepSeconds) });
        });

        it("should revert setting liquidation collateral factor bips", async () => {
            let liquidationCollateralFactorBIPS_empty: (string | number | import("bn.js"))[] = [];
            let liquidationCollateralFactorBIPS_maxBips = [1200, MAX_BIPS+1];
            let liquidationCollateralFactorBIPS_notIncreasing = [12000, 12000];

            const liquidationStrategySettings_lengths = {
                ...liquidationStrategySettings,
                liquidationFactorClass1BIPS: liquidationStrategySettings.liquidationFactorClass1BIPS.slice(0,1)
            };
            const liquidationStrategySettings_empty = {
                ...liquidationStrategySettings,
                liquidationFactorClass1BIPS: liquidationCollateralFactorBIPS_empty,
                liquidationCollateralFactorBIPS: liquidationCollateralFactorBIPS_empty
            };
            const liquidationStrategySettings_maxBips = {
                ...liquidationStrategySettings,
                liquidationFactorClass1BIPS: liquidationStrategySettings.liquidationFactorClass1BIPS.slice(0,2),
                liquidationCollateralFactorBIPS: liquidationCollateralFactorBIPS_maxBips
            };
            const liquidationStrategySettings_notIncreasing = {
                ...liquidationStrategySettings,
                liquidationFactorClass1BIPS: liquidationStrategySettings.liquidationFactorClass1BIPS.slice(0,2),
                liquidationCollateralFactorBIPS: liquidationCollateralFactorBIPS_notIncreasing
            };
            const liquidationStrategySettings_tooHigh = {
                ...liquidationStrategySettings,
                liquidationFactorClass1BIPS: [12000, 14001],
                liquidationCollateralFactorBIPS: [12000, 14000]
            }

            let res_lengths = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_lengths), { from: governance });
            await expectRevert(waitForTimelock(res_lengths, assetManagerController, updateExecutor), "lengths not equal");
            let res_empty = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_empty), { from: governance });
            await expectRevert(waitForTimelock(res_empty, assetManagerController, updateExecutor), "at least one factor required");
            let res_tooMaxBips = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_maxBips), { from: governance });
            await expectRevert(waitForTimelock(res_tooMaxBips, assetManagerController, updateExecutor), "factor not above 1");
            let res_notIncreasing = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_notIncreasing), { from: governance });
            await expectRevert(waitForTimelock(res_notIncreasing, assetManagerController, updateExecutor), "factors not increasing");
            let res_tooHigh = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(liquidationStrategySettings_tooHigh), { from: governance });
            await expectRevert(waitForTimelock(res_tooHigh, assetManagerController, updateExecutor), "class1 factor higher than total");
        });

        it("should set liquidation collateral factor bips", async () => {
            const newLiquidationStrategySettings = {
                ...liquidationStrategySettings,
                liquidationFactorClass1BIPS: liquidationStrategySettings.liquidationFactorClass1BIPS.slice(0,2),
                liquidationCollateralFactorBIPS: [2_0000, 2_5000]
            }
            let prms = assetManagerController.updateLiquidationStrategySettings([assetManager.address], encodeLiquidationStrategyImplSettings(newLiquidationStrategySettings), { from: governance });
            let res = await waitForTimelock(prms, assetManagerController, updateExecutor);
            expectEvent(res, "SettingArrayChanged", { name: "liquidationCollateralFactorBIPS", value: [toBN(2_0000), toBN(2_5000)] });
        });

        it("should revert setting attestation window when window is less than a day", async () => {
            let attestationWindowSeconds_small = 0.8 * DAYS;
            let res_small = assetManagerController.setAttestationWindowSeconds([assetManager.address], attestationWindowSeconds_small, { from: governance });

            await expectRevert(res_small, "window too small");
        });

        it("should revert setting announced underlying confirmation delay when setting is more than an hour", async () => {
            let announcedUnderlyingConfirmationMinSeconds_new = 2 * HOURS;
            let res_small = assetManagerController.setAnnouncedUnderlyingConfirmationMinSeconds([assetManager.address], announcedUnderlyingConfirmationMinSeconds_new, { from: governance });

            await expectRevert(res_small, "confirmation time too big");
        });

        it("should set attestation window", async () => {
            const currentSettings = await assetManager.getSettings();
            let attestationWindowSeconds_new = toBN(currentSettings.attestationWindowSeconds).muln(2);
            let res = await assetManagerController.setAttestationWindowSeconds([assetManager.address], attestationWindowSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "attestationWindowSeconds", value: toBN(attestationWindowSeconds_new) });
        });

        it("should set announced underlying confirmation min seconds", async () => {
            let announcedUnderlyingConfirmationMinSeconds_new = 100;
            let res = await assetManagerController.setAnnouncedUnderlyingConfirmationMinSeconds([assetManager.address], announcedUnderlyingConfirmationMinSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "announcedUnderlyingConfirmationMinSeconds", value: toBN(announcedUnderlyingConfirmationMinSeconds_new) });
        });

        it("should revert redemption default factor bips", async () => {
            const currentSettings = await assetManager.getSettings();
            let redemptionDefaultFactorAgentC1BIPS_big = toBN(currentSettings.redemptionDefaultFactorAgentC1BIPS).muln(12001).divn(10_000);
            let redemptionDefaultFactorAgentC1BIPS_low = MAX_BIPS;
            let redemptionDefaultFactorPoolBIPS = toBN(currentSettings.redemptionDefaultFactorPoolBIPS);

            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            let res_big = assetManagerController.setRedemptionDefaultFactorBips([assetManager.address], redemptionDefaultFactorAgentC1BIPS_big, redemptionDefaultFactorPoolBIPS, { from: governance });
            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            let res_low = assetManagerController.setRedemptionDefaultFactorBips([assetManager.address], redemptionDefaultFactorAgentC1BIPS_low, BN_ZERO, { from: governance });

            await expectRevert(res_big, "fee increase too big");
            await expectRevert(res_low, "bips value too low");

            let redemptionDefaultFactorBIPS_new = 1_3000;
            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            await assetManagerController.setRedemptionDefaultFactorBips([assetManager.address], redemptionDefaultFactorBIPS_new, redemptionDefaultFactorPoolBIPS, { from: governance });
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            let redemptionDefaultFactorBIPS_small = toBN(newSettings.redemptionDefaultFactorAgentC1BIPS).muln(8332).divn(10_000);;

            await time.increase(toBN(settings.minUpdateRepeatTimeSeconds).addn(1));
            let res_small = assetManagerController.setRedemptionDefaultFactorBips([assetManager.address], redemptionDefaultFactorBIPS_small, redemptionDefaultFactorPoolBIPS, { from: governance });
            await expectRevert(res_small, "fee decrease too big");
        });

        it("should set redemption default factor bips for agent", async () => {
            const currentSettings = await assetManager.getSettings();
            let redemptionDefaultFactorPoolBIPS = toBN(currentSettings.redemptionDefaultFactorPoolBIPS);
            let redemptionDefaultFactorAgentC1BIPS_new = 1_1000;
            let res = await assetManagerController.setRedemptionDefaultFactorBips([assetManager.address], redemptionDefaultFactorAgentC1BIPS_new, redemptionDefaultFactorPoolBIPS, { from: governance });
            expectEvent(res, "SettingChanged", { name: "redemptionDefaultFactorAgentC1BIPS", value: toBN(redemptionDefaultFactorAgentC1BIPS_new) });
        });

        it("should revert update - too close to previous update", async () => {
            const currentSettings = await assetManager.getSettings();
            let redemptionDefaultFactorPoolBIPS = toBN(currentSettings.redemptionDefaultFactorPoolBIPS);
            let redemptionDefaultFactorAgentC1BIPS_new = 1_3000;
            await assetManagerController.setRedemptionDefaultFactorBips([assetManager.address], redemptionDefaultFactorAgentC1BIPS_new, redemptionDefaultFactorPoolBIPS, { from: governance });
            let update = assetManagerController.setRedemptionDefaultFactorBips([assetManager.address], redemptionDefaultFactorAgentC1BIPS_new, redemptionDefaultFactorPoolBIPS, { from: governance });
            await expectRevert(update, "too close to previous update");
        });

        it("should correctly set asset manager settings", async () => {
            const settings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(settings.redemptionFeeBIPS, 200);
            await assetManagerController.setRedemptionFeeBips([assetManager.address], 250, { from: governance });
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(newSettings.redemptionFeeBIPS, 250);
        });

        it("should not change settings if manager not passed", async () => {
            await assetManagerController.setRedemptionFeeBips([], 250, { from: governance });
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(newSettings.redemptionFeeBIPS, 200);
        });

        it("should change wnat contract", async () => {
            const newWNat = {
                ...collaterals[0],
                token: accounts[82],
                ftsoSymbol: "NAT",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "19000",
                safetyMinCollateralRatioBIPS: "21000",
            };
            const prms = assetManagerController.setPoolWNatCollateralType([assetManager.address], newWNat, { from: governance });
            await waitForTimelock(prms, assetManagerController, updateExecutor);
            assertWeb3Equal(await assetManager.getWNat(), accounts[82]);
        });

        it("should change agent vault factory on asset manager controller", async () => {
            const prms = assetManagerController.setAgentVaultFactory([assetManager.address], accounts[84], { from: governance });
            await waitForTimelock(prms, assetManagerController, updateExecutor);
            const settings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(settings.agentVaultFactory, accounts[84]);
        });

        it("should change collateral pool factory on asset manager controller", async () => {
            const prms = assetManagerController.setCollateralPoolFactory([assetManager.address], accounts[84], { from: governance });
            await waitForTimelock(prms, assetManagerController, updateExecutor);
            const settings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(settings.collateralPoolFactory, accounts[84]);
        });

        it("should change contracts", async () => {
            await contracts.addressUpdater.update(["AddressUpdater", "AssetManagerController", "AttestationClient", "FtsoRegistry"],
                [contracts.addressUpdater.address, assetManagerController.address, accounts[80], accounts[81]],
                [assetManagerController.address],
                { from: governance });
            const settings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(settings.assetManagerController, assetManagerController.address);
            assertWeb3Equal(settings.attestationClient, accounts[80]);
            assertWeb3Equal(settings.ftsoRegistry, accounts[81]);
            assertWeb3Equal(await assetManagerController.replacedBy(), constants.ZERO_ADDRESS);
        });

        it("should change contracts, including asset manager controller", async () => {
            await contracts.addressUpdater.update(["AddressUpdater", "AssetManagerController", "AttestationClient", "FtsoRegistry"],
                [contracts.addressUpdater.address, accounts[79], accounts[80], accounts[81]],
                [assetManagerController.address],
                { from: governance });
            const settings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(settings.assetManagerController, accounts[79]);
            assertWeb3Equal(settings.attestationClient, accounts[80]);
            assertWeb3Equal(settings.ftsoRegistry, accounts[81]);
            assertWeb3Equal(await assetManagerController.replacedBy(), accounts[79]);
        });

        it("should change time for payment settings after timelock", async () => {
            // change settings
            const currentSettings = await assetManager.getSettings();
            let underlyingBlocksForPayment_new = toBN(currentSettings.underlyingBlocksForPayment).muln(2);
            let underlyingSecondsForPayment_new = toBN(currentSettings.underlyingSecondsForPayment).muln(2);
            const res = await assetManagerController.setTimeForPayment([assetManager.address], underlyingBlocksForPayment_new, underlyingSecondsForPayment_new, { from: governance });
            await waitForTimelock(res, assetManagerController, updateExecutor);
            // assert
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(newSettings.underlyingBlocksForPayment, underlyingBlocksForPayment_new);
            assertWeb3Equal(newSettings.underlyingSecondsForPayment, underlyingSecondsForPayment_new);
        });

        it("should change collateral settings after timelock", async () => {
            // change settings
            for (const collateral of collaterals) {
                const res = await assetManagerController.setCollateralRatiosForToken([assetManager.address], collateral.collateralClass, collateral.token, 2_2000, 1_8000, 2_4000, { from: governance });
                await waitForTimelock(res, assetManagerController, updateExecutor);
                // assert
                const collateralInfo = await assetManager.getCollateralType(collateral.collateralClass, collateral.token);
                assertWeb3Equal(collateralInfo.minCollateralRatioBIPS, 2_2000);
                assertWeb3Equal(collateralInfo.ccbMinCollateralRatioBIPS, 1_8000);
                assertWeb3Equal(collateralInfo.safetyMinCollateralRatioBIPS, 2_4000);
            }
        });

        it("should not set collateral", async () => {
            for (const collateral of collaterals) {
                let res_invalid = waitForTimelock(assetManagerController.setCollateralRatiosForToken([assetManager.address], collateral.collateralClass, collateral.token, 1_8000, 2_2000, 2_4000, { from: governance }),
                    assetManagerController, updateExecutor);
                await expectRevert(res_invalid, "invalid collateral ratios");
            }
        });

        it("settings change should be executed by executor", async () => {
            // change settings
            for (const collateral of collaterals) {
                const res = await assetManagerController.setCollateralRatiosForToken([assetManager.address], collateral.collateralClass, collateral.token, 2_2000, 1_8000, 2_4000, { from: governance });
                const timelock = requiredEventArgs(res, 'GovernanceCallTimelocked');
                await expectRevert(assetManagerController.executeGovernanceCall(timelock.selector), "only executor");
                const res1 = await assetManagerController.setTimeForPayment([assetManager.address], 10, 120, { from: governance });
                const timelock1 = requiredEventArgs(res1, 'GovernanceCallTimelocked');
                await expectRevert(assetManagerController.executeGovernanceCall(timelock1.selector), "only executor");
            }
        });

        it("shouldn't change collateral settings without timelock", async () => {
            // change settings
            for (const collateral of collaterals) {
                const res = await assetManagerController.setCollateralRatiosForToken([assetManager.address], collateral.collateralClass, collateral.token, 2_2000, 1_8000, 2_4000, { from: governance });
                const timelock = requiredEventArgs(res, 'GovernanceCallTimelocked');
                await expectRevert(assetManagerController.executeGovernanceCall(timelock.selector, { from: updateExecutor }),
                    "timelock: not allowed yet");
                // assert no changes
                const collateralInfo = await assetManager.getCollateralType(collateral.collateralClass, collateral.token);
                assertWeb3Equal(collateralInfo.minCollateralRatioBIPS, collateral.minCollateralRatioBIPS);
                assertWeb3Equal(collateralInfo.ccbMinCollateralRatioBIPS, collateral.ccbMinCollateralRatioBIPS);
                assertWeb3Equal(collateralInfo.safetyMinCollateralRatioBIPS, collateral.safetyMinCollateralRatioBIPS);
            }
        });

        it("shouldn't change time for payment settings without timelock", async () => {
            // change settings
            const currentSettings = await assetManager.getSettings();
            let underlyingBlocksForPayment_new = toBN(currentSettings.underlyingBlocksForPayment).muln(2);
            let underlyingSecondsForPayment_new = toBN(currentSettings.underlyingSecondsForPayment).muln(2);
            const res = await assetManagerController.setTimeForPayment([assetManager.address], underlyingBlocksForPayment_new, underlyingSecondsForPayment_new, { from: governance });
            const timelock = requiredEventArgs(res, 'GovernanceCallTimelocked');

            await expectRevert(assetManagerController.executeGovernanceCall(timelock.selector, { from: updateExecutor }), "timelock: not allowed yet");
            // assert no changes
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            assertWeb3Equal(newSettings.underlyingBlocksForPayment, settings.underlyingBlocksForPayment);
            assertWeb3Equal(newSettings.underlyingSecondsForPayment, settings.underlyingSecondsForPayment);
        });

        it("should revert setting minting pool holdings required BIPS when increase is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let mintingPoolHoldingsRequiredBIPS_tooBig = toBN(currentSettings.mintingPoolHoldingsRequiredBIPS).muln(5).add(toBN(MAX_BIPS));
            const res = assetManagerController.setMintingPoolHoldingsRequiredBIPS([assetManager.address], mintingPoolHoldingsRequiredBIPS_tooBig, { from: governance });
            await expectRevert(res, "value too big");
        });

        it("should set minting pool holdings required BIPS", async () => {
            const currentSettings = await assetManager.getSettings();
            let mintingPoolHoldingsRequiredBIPS_new = toBN(currentSettings.mintingPoolHoldingsRequiredBIPS).muln(3).add(toBN(MAX_BIPS));
            const res = await assetManagerController.setMintingPoolHoldingsRequiredBIPS([assetManager.address], mintingPoolHoldingsRequiredBIPS_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "mintingPoolHoldingsRequiredBIPS", value: toBN(mintingPoolHoldingsRequiredBIPS_new) });
        });

        it("should set minting cap AMG", async () => {
            const currentSettings = await assetManager.getSettings();
            let mintingCapAMG_new = toBN(currentSettings.mintingCapAMG).add(toBN(1));
            const res = await assetManagerController.setMintingCapAmg([assetManager.address], mintingCapAMG_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "mintingCapAMG", value: toBN(mintingCapAMG_new) });
        });

        it("should set token invalidation time min seconds after timelock", async () => {
            const currentSettings = await assetManager.getSettings();
            let tokenInvalidationTimeMinSeconds = DAYS;
            const res = await assetManagerController.setTokenInvalidationTimeMinSeconds([assetManager.address], tokenInvalidationTimeMinSeconds, { from: governance });
            const timelock_info = await waitForTimelock(res, assetManagerController, updateExecutor);
            expectEvent(timelock_info, "SettingChanged", { name: "tokenInvalidationTimeMinSeconds", value: toBN(tokenInvalidationTimeMinSeconds) });
        });

        it("should revert setting Class1 buy for flare factor BIPS when value is too low after timelock", async () => {
            let class1BuyForFlareFactorBIPS_tooSmall = toBN(MAX_BIPS).divn(2);
            const res = assetManagerController.setClass1BuyForFlareFactorBIPS([assetManager.address], class1BuyForFlareFactorBIPS_tooSmall, { from: governance });
            const timelock_info = waitForTimelock(res, assetManagerController, updateExecutor);
            await expectRevert(timelock_info, "value too small");
        });

        it("should set Class1 buy for flare factor BIPS after timelock", async () => {
            let class1BuyForFlareFactorBIPS_new = toBN(MAX_BIPS).muln(2);
            const res = await assetManagerController.setClass1BuyForFlareFactorBIPS([assetManager.address], class1BuyForFlareFactorBIPS_new, { from: governance });
            const timelock_info = await waitForTimelock(res, assetManagerController, updateExecutor);
            expectEvent(timelock_info, "SettingChanged", { name: "class1BuyForFlareFactorBIPS", value: toBN(class1BuyForFlareFactorBIPS_new) });
        });

        it("should revert setting agent exit available timelock seconds when value is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let agentExitAvailableTimelockSeconds_tooBig = toBN(currentSettings.agentExitAvailableTimelockSeconds).muln(5).addn(WEEKS);
            const res = assetManagerController.setAgentExitAvailableTimelockSeconds([assetManager.address], agentExitAvailableTimelockSeconds_tooBig, { from: governance });
            await expectRevert.unspecified(res);
        });

        it("should set agent exit available timelock seconds", async () => {
            let agentExitAvailableTimelockSeconds_new = DAYS;
            const res = await assetManagerController.setAgentExitAvailableTimelockSeconds([assetManager.address], agentExitAvailableTimelockSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "agentExitAvailableTimelockSeconds", value: toBN(agentExitAvailableTimelockSeconds_new) });
        });

        it("should revert setting agent fee change timelock seconds when value is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let agentFeeChangeTimelockSeconds_tooBig = toBN(currentSettings.agentFeeChangeTimelockSeconds).muln(5).addn(WEEKS);
            const res = assetManagerController.setAgentFeeChangeTimelockSeconds([assetManager.address], agentFeeChangeTimelockSeconds_tooBig, { from: governance });
            await expectRevert.unspecified(res);
        });

        it("should set agent exit available timelock seconds", async () => {
            let agentFeeChangeTimelockSeconds_new = DAYS;
            const res = await assetManagerController.setAgentFeeChangeTimelockSeconds([assetManager.address], agentFeeChangeTimelockSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "agentFeeChangeTimelockSeconds", value: toBN(agentFeeChangeTimelockSeconds_new) });
        });

        it("should revert setting agent collateral ratio change timelock seconds when value is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let agentCollateralRatioChangeTimelockSeconds_tooBig = toBN(currentSettings.agentCollateralRatioChangeTimelockSeconds).muln(5).addn(WEEKS);
            const res = assetManagerController.setAgentCollateralRatioChangeTimelockSeconds([assetManager.address], agentCollateralRatioChangeTimelockSeconds_tooBig, { from: governance });
            await expectRevert.unspecified(res);
        });

        it("should set agent collateral ratio change timelock seconds", async () => {
            let agentCollateralRatioChangeTimelockSeconds_new = DAYS;
            const res = await assetManagerController.setAgentCollateralRatioChangeTimelockSeconds([assetManager.address], agentCollateralRatioChangeTimelockSeconds_new, { from: governance });
            expectEvent(res, "SettingChanged", { name: "agentCollateralRatioChangeTimelockSeconds", value: toBN(agentCollateralRatioChangeTimelockSeconds_new) });
        });

        it("should set agent whitelist after timelock", async () => {
            const addr = randomAddress();
            const res = await assetManagerController.setAgentWhitelist([assetManager.address], addr, { from: governance });
            const timelock_info = await waitForTimelock(res, assetManagerController, updateExecutor);
            expectEvent(timelock_info, "ContractChanged", { name: "agentWhitelist", value: addr });
        });

        it("should revert setting underlying address validator after timelock when address 0 is provided", async () => {
            const res = assetManagerController.setUnderlyingAddressValidator([assetManager.address], constants.ZERO_ADDRESS, { from: governance });
            const timelock_info = waitForTimelock(res, assetManagerController, updateExecutor);
            await expectRevert(timelock_info, "address zero");
        });

        it("should set underlying address validator after timelock", async () => {
            const addr = randomAddress();
            const res = await assetManagerController.setUnderlyingAddressValidator([assetManager.address], addr, { from: governance });
            const timelock_info = await waitForTimelock(res, assetManagerController, updateExecutor);
            expectEvent(timelock_info, "ContractChanged", { name: "underlyingAddressValidator", value: addr });
        });

        it("should revert setting min update repeat time when 0 seconds is provided", async () => {
            const res = assetManagerController.setMinUpdateRepeatTimeSeconds([assetManager.address], 0, { from: governance });
            const timelock_info = waitForTimelock(res, assetManagerController, updateExecutor);
            await expectRevert(timelock_info, "cannot be zero");
        });

        it("should set min update repeat time", async () => {
            const res = await assetManagerController.setMinUpdateRepeatTimeSeconds([assetManager.address], toBN(DAYS), { from: governance });
            const timelock_info = await waitForTimelock(res, assetManagerController, updateExecutor);
            expectEvent(timelock_info, "SettingChanged", { name: "minUpdateRepeatTimeSeconds", value: toBN(DAYS) });
        });

        it("should revert setting min underlying backing bips if value is 0", async () => {
            let minUnderlyingBackingBIPS_zero = toBIPS(0);
            const res = assetManagerController.setMinUnderlyingBackingBips([assetManager.address], minUnderlyingBackingBIPS_zero, { from: governance });
            const timelock_info = waitForTimelock(res, assetManagerController, updateExecutor);
            await expectRevert(timelock_info, "cannot be zero");
        });

        it("should revert setting min underlying backing bips if value is above 1", async () => {
            let minUnderlyingBackingBIPS_zero = toBIPS("110%");
            const res = assetManagerController.setMinUnderlyingBackingBips([assetManager.address], minUnderlyingBackingBIPS_zero, { from: governance });
            const timelock_info = waitForTimelock(res, assetManagerController, updateExecutor);
            await expectRevert(timelock_info, "must be below 1");
        });

        it("should revert setting min underlying backing bips if decrease is too big", async () => {
            const currentSettings = await assetManager.getSettings();
            let minUnderlyingBackingBIPS_decreaseTooBig = toBN(currentSettings.minUnderlyingBackingBIPS).divn(3);
            const res = assetManagerController.setMinUnderlyingBackingBips([assetManager.address], minUnderlyingBackingBIPS_decreaseTooBig, { from: governance });
            const timelock_info = waitForTimelock(res, assetManagerController, updateExecutor);
            await expectRevert(timelock_info, "decrease too big");
        });

        it("should revert setting min underlying backing bips if increase is too big", async () => {
            //First we need to lower the setting to 30% so we can multiply by 3 and still be below 100%
            const res_prev1 = assetManagerController.setMinUnderlyingBackingBips([assetManager.address], toBIPS("50%"), { from: governance });
            await waitForTimelock(res_prev1, assetManagerController, updateExecutor);
            await time.increase(WEEKS);

            const res_prev2 = assetManagerController.setMinUnderlyingBackingBips([assetManager.address], toBIPS("30%"), { from: governance });
            await waitForTimelock(res_prev2, assetManagerController, updateExecutor);
            await time.increase(WEEKS);

            const currentSettings = await assetManager.getSettings();
            let minUnderlyingBackingBIPS_increaseTooBig = toBN(currentSettings.minUnderlyingBackingBIPS).muln(3);
            const res = assetManagerController.setMinUnderlyingBackingBips([assetManager.address], minUnderlyingBackingBIPS_increaseTooBig, { from: governance });
            const timelock_info = waitForTimelock(res, assetManagerController, updateExecutor);
            await expectRevert(timelock_info, "increase too big");
        });

        it("should set min underlying backing bips", async () => {
            const currentSettings = await assetManager.getSettings();
            let minUnderlyingBackingBIPS_new = toBN(currentSettings.minUnderlyingBackingBIPS).divn(2);
            const res = assetManagerController.setMinUnderlyingBackingBips([assetManager.address], minUnderlyingBackingBIPS_new, { from: governance });
            const timelock_info = await waitForTimelock(res, assetManagerController, updateExecutor);
            expectEvent(timelock_info, "SettingChanged", { name: "minUnderlyingBackingBIPS", value: minUnderlyingBackingBIPS_new });
        });

        it("should add Collateral token", async () => {
            const newToken = {
                ...collaterals[0],
                token: accounts[82],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };
            await assetManagerController.addCollateralType([assetManager.address], newToken, { from: governance });
            const getCollateral = await assetManager.getCollateralType(newToken.collateralClass, newToken.token);
            assertWeb3Equal(getCollateral.token, accounts[82]);
        });

        it("should revert adding Collateral token when address 0", async () => {
            const newToken = {
                ...collaterals[0],
                token: constants.ZERO_ADDRESS,
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };
            const res = assetManagerController.addCollateralType([assetManager.address], newToken, { from: governance });
            await expectRevert(res, "token zero");
        });

        it("should revert adding Collateral token when class is wrong", async () => {
            const newToken = {
                ...collaterals[0],
                token: constants.ZERO_ADDRESS,
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
            };
            const res = assetManagerController.addCollateralType([assetManager.address], newToken, { from: governance });
            await expectRevert(res, "not a class1 collateral");
        });

        it("should revert adding Collateral token when token exists", async () => {
            const newToken = {
                ...collaterals[0],
                token: accounts[82],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };
            const copyToken = {
                ...collaterals[0],
                token: accounts[82],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };
            await assetManagerController.addCollateralType([assetManager.address], newToken, { from: governance });
            const res = assetManagerController.addCollateralType([assetManager.address], copyToken, { from: governance });
            await expectRevert(res, "token already exists");
        });

        it("should revert adding Collateral token when collateral ratios are invalid", async () => {
            const newToken_invalidCCBRatio = {
                ...collaterals[0],
                token: accounts[82],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "180",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };
            const res1 = assetManagerController.addCollateralType([assetManager.address], newToken_invalidCCBRatio, { from: governance });
            await expectRevert(res1, "invalid collateral ratios");

            const newToken_invalidMinColRatio = {
                ...collaterals[0],
                token: accounts[81],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "17000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };
            const res2 = assetManagerController.addCollateralType([assetManager.address], newToken_invalidMinColRatio, { from: governance });
            await expectRevert(res2, "invalid collateral ratios");

            const newToken_invalidSafetyMinColRatio = {
                ...collaterals[0],
                token: accounts[80],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "19000",
                collateralClass: 2,
            };
            const res3 = assetManagerController.addCollateralType([assetManager.address], newToken_invalidSafetyMinColRatio, { from: governance });
            await expectRevert(res3, "invalid collateral ratios");
        });

        it("should revert deprecating token", async () => {
            const currentSettings = await assetManager.getSettings();
            const invalidToken = {
                ...collaterals[0],
                token: accounts[81],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };

            const newToken = {
                ...collaterals[0],
                token: accounts[82],
                ftsoSymbol: "TOK",
                minCollateralRatioBIPS: "20000",
                ccbMinCollateralRatioBIPS: "18000",
                safetyMinCollateralRatioBIPS: "21000",
                collateralClass: 2,
            };
            await assetManagerController.addCollateralType([assetManager.address], newToken, { from: governance });
            await assetManagerController.addCollateralType([assetManager.address], invalidToken, { from: governance });
            await assetManagerController.deprecateCollateralType([assetManager.address],2, invalidToken.token,currentSettings.tokenInvalidationTimeMinSeconds ,{ from: governance });
            await time.increase(WEEKS);
            const res = assetManagerController.deprecateCollateralType([assetManager.address],2, invalidToken.token,currentSettings.tokenInvalidationTimeMinSeconds ,{ from: governance });
            await expectRevert(res, "token not valid");

            const res2 = assetManagerController.deprecateCollateralType([assetManager.address],2, newToken.token,toBN(currentSettings.tokenInvalidationTimeMinSeconds).subn(1) ,{ from: governance });
            await expectRevert(res2, "deprecation time to short");
        });


    });

    describe("pause, unpause and terminate", () => {
        it("should pause and terminate only after 30 days", async () => {
            const MINIMUM_PAUSE_BEFORE_STOP = 30 * DAYS;
            assert.isFalse(await assetManager.paused());
            await assetManagerController.pause([assetManager.address], { from: governance });
            assert.isTrue(await assetManager.paused());
            await time.increase(MINIMUM_PAUSE_BEFORE_STOP / 2);
            await assetManagerController.pause([assetManager.address], { from: governance });
            assert.isTrue(await assetManager.paused());
            await expectRevert(assetManagerController.terminate([assetManager.address], { from: governance }), "asset manager not paused enough");
            await time.increase(MINIMUM_PAUSE_BEFORE_STOP / 2);
            assert.isFalse(await fAsset.terminated());
            await assetManagerController.terminate([assetManager.address], { from: governance })
            assert.isTrue(await fAsset.terminated());
            await expectRevert(assetManagerController.unpause([assetManager.address], { from: governance }), "f-asset terminated");
        });

        it("should unpause if not yet terminated", async () => {
            await assetManagerController.pause([assetManager.address], { from: governance });
            assert.isTrue(await assetManager.paused());
            await assetManagerController.unpause([assetManager.address], { from: governance });
            assert.isFalse(await assetManager.paused());
        });

        it("should not pause if not called from governance", async () => {
            const promise = assetManagerController.pause([assetManager.address], { from: accounts[0] });
            await expectRevert(promise, "only governance");
            assert.isFalse(await assetManager.paused());
        });

        it("should not unpause if not called from governance", async () => {
            await assetManagerController.pause([assetManager.address], { from: governance });
            assert.isTrue(await assetManager.paused());
            const promise = assetManagerController.unpause([assetManager.address], { from: accounts[0] })
            await expectRevert(promise, "only governance");
            assert.isTrue(await assetManager.paused());
        });

        it("should not terminate if not called from governance", async () => {
            const MINIMUM_PAUSE_BEFORE_STOP = 30 * DAYS;
            assert.isFalse(await assetManager.paused());
            await assetManagerController.pause([assetManager.address], { from: governance });
            assert.isTrue(await assetManager.paused());
            await time.increase(MINIMUM_PAUSE_BEFORE_STOP);
            const promise = assetManagerController.terminate([assetManager.address], { from: accounts[0] })
            await expectRevert(promise, "only governance");
            assert.isFalse(await fAsset.terminated());
        });

    });

    describe("ERC-165 interface identification", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as any) as any as IERC165Contract;
            const IIAddressUpdatable = artifacts.require('flare-smart-contracts/contracts/addressUpdater/interface/IIAddressUpdatable.sol:IIAddressUpdatable'as any) as any as AddressUpdatableContract;
            const iERC165 = await IERC165.at(assetManagerController.address);
            const iiAddressUpdatable = await IIAddressUpdatable.at(addressUpdatableMock.address);
            assert.isTrue(await assetManagerController.supportsInterface(erc165InterfaceId(iERC165.abi)));
            assert.isTrue(await assetManagerController.supportsInterface(erc165InterfaceId(iiAddressUpdatable.abi)));
            assert.isFalse(await assetManagerController.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });
});
