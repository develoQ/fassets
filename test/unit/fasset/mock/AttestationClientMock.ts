import { SCProofVerifierMockInstance } from "../../../../typechain-truffle";
import { getTestFile } from "../../../utils/test-helpers";
import { MerkleTree } from "../../../utils/MerkleTree";
import { assertWeb3Equal } from "../../../utils/web3assertions";

const AttestationClient = artifacts.require('SCProofVerifierMock');

contract(`SCProofVerifierMock.sol; ${getTestFile(__filename)}; Attestation client mock basic tests`, async accounts => {
    let attestationClient: SCProofVerifierMockInstance;

    describe("create and set", () => {
        it("should create", async () => {
            attestationClient = await AttestationClient.new();
        });
        it("should set merkle root", async () => {
            attestationClient = await AttestationClient.new();
            const hashes = [web3.utils.soliditySha3Raw("test1")!, web3.utils.soliditySha3Raw("test2")!];
            const tree = new MerkleTree(hashes);
            await attestationClient.setMerkleRoot(5, tree.root!);
            const root = await attestationClient.merkleRootForRound(5);
            assertWeb3Equal(tree.root, root);
        });
    });
});
