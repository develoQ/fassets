// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "../interface/IFAsset.sol";
import "../interface/IAddressValidator.sol";
import "./data/AssetManagerState.sol";


// global state helpers
library Globals {
    function getWNat()
        internal view
        returns (IWNat)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return IWNat(address(state.collateralTokens[state.poolCollateralIndex].token));
    }

    function getPoolCollateral()
        internal view
        returns (CollateralTypeInt.Data storage)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return state.collateralTokens[state.poolCollateralIndex];
    }

    function getFAsset()
        internal view
        returns (IFAsset)
    {
        AssetManagerSettings.Data storage settings = AssetManagerState.getSettings();
        return IFAsset(settings.fAsset);
    }

    function validateAndNormalizeUnderlyingAddress(string memory _underlyingAddressString)
        internal view
        returns (string memory _normalizedAddressString, bytes32 _uniqueHash)
    {
        IAddressValidator validator = IAddressValidator(AssetManagerState.getSettings().underlyingAddressValidator);
        require(bytes(_underlyingAddressString).length != 0, "empty underlying address");
        require(validator.validate(_underlyingAddressString), "invalid underlying address");
        return validator.normalize(_underlyingAddressString);
    }
}
