import { readFileSync, writeFileSync } from "fs";

export interface Contract {
    name: string;
    contractName: string;
    address: string;
}

export interface ChainContracts {
    // flare smart contract
    GovernanceSettings: Contract;
    AddressUpdater: Contract;
    StateConnector: Contract;
    WNat: Contract;
    FtsoRegistry: Contract;
    FtsoManager: Contract;
    // fasset
    AttestationClient?: Contract;
    AgentVaultFactory?: Contract;
    CollateralPoolFactory?: Contract;
    AssetManagerController?: Contract;
    FAssetWhitelist?: Contract;
    FAssetAgentWhitelist?: Contract;
    // others (asset managers & fassets & everything from flare-smart-contract)
    [key: string]: Contract | undefined;
}

export function newContract(name: string, contractName: string, address: string) {
    return { name, contractName, address };
}

export function loadContracts(filename: string): ChainContracts {
    return loadContractsDict(filename) as ChainContracts;
}

export function saveContracts(filename: string, contracts: ChainContracts) {
    saveContractsDict(filename, contracts);
}

export function loadContractsDict(filename: string): Record<string, Contract> {
    const result: Record<string, Contract> = {};
    for (const contract of loadContractsList(filename)) {
        result[contract.name] = contract;
    }
    return result;
}

export function saveContractsDict(filename: string, contracts: Record<string, Contract | null | undefined>) {
    const contractList: Contract[] = [];
    for (const contract of Object.values(contracts)) {
        if (contract) contractList.push(contract);
    }
    saveContractsList(filename, contractList);
}

export function loadContractsList(filename: string): Contract[] {
    return JSON.parse(readFileSync(filename).toString());
}

export function saveContractsList(filename: string, contractList: Contract[]) {
    writeFileSync(filename, JSON.stringify(contractList, null, 2));
}
