// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;
pragma abicoder v2;

interface IAddressValidator {
    function validate(string memory _underlyingAddress)
        external view
        returns (bool);

    function normalize(string memory _underlyingAddress)
        external view
        returns (string memory _normalizedAddress, bytes32 _uniqueHash);
}
