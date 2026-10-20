// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Full visual traits of one pet, derived from its tokenId.
/// @dev Shared by the asset contract and the renderer so the two can never
///      disagree about what a token looks like.
struct Traits {
    uint8 species;      // 0 cat .. 7 sheep
    uint8 palette;      // index into the curated palette table
    uint8 bgVariant;    // 0..2
    uint16 bodyScale;   // per-mille 940..1060
    uint8 earVariant;   // 0..1
    uint16 eyeSpacing;  // per-mille 920..1080
    uint16 eyeSize;     // per-mille 920..1080
    uint8 eyeStyle;     // 0..5
    uint8 mouthStyle;   // 0..2
    uint8 blush;        // 0..1
    uint8 patternStyle; // 0..2
    uint8 patternCount; // 3..5
    uint8 accessory;    // 0..5
    uint8 patternSeed;
    uint8 bodyShape;    // 0..1
    int8 tilt;          // -3..3
    uint8 eyewear;      // 0..5
    uint8 frameColor;   // 0..5
}

interface IGlowpetArt {
    function render(Traits calldata t, string calldata label, uint32 serial, uint8 stage)
        external
        view
        returns (string memory);
}

/// @dev Face parts are split into their own contract so neither renderer
///      exceeds the 24KB deployed-bytecode limit.
interface IGlowpetFaceArt {
    function eyes(
        uint8 species,
        uint8 eyeStyle,
        uint256 cx,
        uint256 eyeX,
        uint256 eyeY,
        uint256 eyeR,
        string calldata ink
    ) external pure returns (string memory);

    function eyewear(
        uint8 style,
        uint8 frameColor,
        uint256 cx,
        uint256 eyeX,
        uint256 eyeY,
        uint256 eyeR
    ) external pure returns (string memory);

    function ears(
        uint8 species,
        uint8 earVariant,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata ear,
        string calldata earIn
    ) external pure returns (string memory);

    function marks(
        uint8 species,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata ink,
        string calldata muzzle
    ) external pure returns (string memory);

    function pandaPatches(uint256 cx, uint256 ex, uint256 ey, uint256 er, string calldata ink)
        external
        pure
        returns (string memory);

    function frogBulges(uint256 cx, uint256 ex, uint256 ey, uint256 er, string calldata body)
        external
        pure
        returns (string memory);

    function sheepFleece(uint256 cx, uint256 cy, uint256 rx, uint256 ry, string calldata fleece)
        external
        pure
        returns (string memory);

    function penguinPatch(uint256 cx, uint256 cy, uint256 rx, uint256 ry)
        external
        pure
        returns (string memory);

    function mane(
        uint8 species,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata color
    ) external pure returns (string memory);

    function specialFace(
        uint8 species,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata ink,
        string calldata ear,
        string calldata nose
    ) external pure returns (string memory);
}
