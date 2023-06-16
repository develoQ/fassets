import { requiredEventArgs } from "../../lib/utils/events/truffle";
import { createTestAgent } from "../../test/utils/test-settings";
import { getTestFile } from "../../test/utils/test-helpers";
import { AssetManagerControllerInstance } from "../../typechain-truffle";
import { ChainContracts, loadContracts } from "../lib/contracts";
import { requiredEnvironmentVariable } from "../lib/deploy-utils";

const AssetManagerController = artifacts.require('AssetManagerController');
const AssetManager = artifacts.require('AssetManager');

contract(`test-deployed-contracts; ${getTestFile(__filename)}; Deploy tests`, async accounts => {
    let networkConfig: string;
    let contracts: ChainContracts;

    let assetManagerController: AssetManagerControllerInstance;

    before(async () => {
        networkConfig = requiredEnvironmentVariable('NETWORK_CONFIG');
        contracts = loadContracts(`deployment/deploys/${networkConfig}.json`);
        assetManagerController = await AssetManagerController.at(contracts.AssetManagerController!.address);
    });

    it("Controller must be in production mode", async () => {
        const production = await assetManagerController.productionMode();
        assert.isTrue(production, "not in production mode");
    });

    it("Controller has at least one manager", async () => {
        const managers = await assetManagerController.getAssetManagers();
        assert.isAbove(managers.length, 0);
    });

    it("All managers must be attached to this controller", async () => {
        const managers = await assetManagerController.getAssetManagers();
        for (const mgrAddress of managers) {
            const assetManager = await AssetManager.at(mgrAddress);
            // must be attached...
            const attached = await assetManager.controllerAttached();
            assert.isTrue(attached, "not attached");
            // ...to this controller
            const mgrController = await assetManager.assetManagerController();
            assert.equal(mgrController, assetManagerController.address);
        }
    });

    it("Can create an agent on all managers", async () => {
        const managers = await assetManagerController.getAssetManagers();
        const owner = accounts[0];
        for (const mgrAddress of managers) {
            const assetManager = await AssetManager.at(mgrAddress);
            const settings = await assetManager.getSettings();
            const collaterals = await assetManager.getCollateralTypes();
            // create agent
            const underlyingAddress = "TESTADDRESS";    // address doesn't matter - won't do anything on underlying chain
            const agentVault = await createTestAgent({ assetManager, settings }, owner, underlyingAddress, collaterals[1].token);
            // // try to make available - fails if ftso price is not set
            // const availableRes = assetManager.makeAgentAvailable(createArgs.agentVault, 500, 5_0000, { from: accounts[0] })
            // await expectRevert(availableRes, "not enough free collateral");
            // announce destroy (can really destroy later)
            const destroyRes = await assetManager.announceDestroyAgent(agentVault.address, { from: owner });
            const destroyArgs = requiredEventArgs(destroyRes, "AgentDestroyAnnounced");
            console.log(`    you can destroy agent ${agentVault.address} on asset manager ${mgrAddress} after timestamp ${destroyArgs.destroyAllowedAt}`);
        }
    });

});
