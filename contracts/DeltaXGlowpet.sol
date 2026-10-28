// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Glowpet} from "./Glowpet.sol";
import {Traits} from "./GlowpetTypes.sol";
import {Base64} from "@openzeppelin/contracts@5.6.1/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts@5.6.1/utils/Strings.sol";

/// @notice Immutable artwork rules and IPFS directory for one finite edition.
/// @dev Uniqueness is scoped to one deployment, not to independent collections.
contract DeltaXPortraits {
    using Strings for uint256;

    uint32 public constant CAPACITY = 18_432; // (5 * 7 shared headwear + cat-only lion cap) * 8^3.
    uint32 public immutable editionSize;
    bytes32 public immutable artworkSeed;
    uint32 public immutable multiplier;
    uint32 public immutable permutationOffset;
    string public directoryURI;

    struct Appearance {
        uint32 appearanceId;
        uint8 speciesIndex;
        uint8 headwear;
        uint8 neckwear;
        uint8 palette;
        uint8 motif;
    }

    error InvalidDirectoryCID();
    error InvalidEditionSize();
    error InvalidArtworkIndex();

    constructor(string memory cid, uint32 editionSize_, bytes32 seed_) {
        bytes memory value = bytes(cid);
        if (value.length != 59) revert InvalidDirectoryCID();
        if (value[0] != 'b' || value[1] != 'a' || value[2] != 'f' || value[3] != 'y') {
            revert InvalidDirectoryCID();
        }
        for (uint256 i; i < value.length; i++) {
            bytes1 c = value[i];
            if (!((c >= 'a' && c <= 'z') || (c >= '2' && c <= '7'))) revert InvalidDirectoryCID();
        }
        if (editionSize_ == 0 || editionSize_ > CAPACITY) revert InvalidEditionSize();

        // CAPACITY has only prime factors 2 and 3. An odd multiplier not divisible
        // by 3 is coprime to CAPACITY, so this affine map is a permutation.
        uint32 a = uint32((uint256(seed_) >> 128) % CAPACITY) | 1;
        while (a % 3 == 0) a = uint32((uint256(a) + 2) % CAPACITY);
        multiplier = a;
        permutationOffset = uint32(uint256(seed_) % CAPACITY);
        artworkSeed = seed_;
        editionSize = editionSize_;
        directoryURI = string.concat("ipfs://", cid, "/portraits/");
    }

    function appearanceId(uint256 globalIndex) public view returns (uint32) {
        if (globalIndex >= editionSize) revert InvalidArtworkIndex();
        uint256 rank = (globalIndex * multiplier + permutationOffset) % CAPACITY;
        uint256 slot = rank % 36;
        uint256 speciesIndex = slot == 35 ? 1 : slot % 5;
        uint256 headwear = slot == 35 ? 7 : slot / 5;
        return uint32(speciesIndex + 5 * headwear + 40 * (rank / 36));
    }

    function appearanceTraits(uint256 globalIndex) public view returns (Appearance memory t) {
        uint32 id = appearanceId(globalIndex);
        t.appearanceId = id;
        t.speciesIndex = uint8(id % 5);
        id /= 5;
        t.headwear = uint8(id % 8);
        id /= 8;
        t.neckwear = uint8(id % 8);
        id /= 8;
        t.palette = uint8(id % 8);
        id /= 8;
        t.motif = uint8(id % 8);
    }

    function imageURI(uint256 globalIndex) public view returns (string memory) {
        return string.concat(directoryURI, uint256(appearanceId(globalIndex)).toString(), ".png");
    }

    function tokenURI(uint256 tokenId, uint256 globalIndex, uint8 stage) external view returns (string memory) {
        Appearance memory t = appearanceTraits(globalIndex);
        string[5] memory species = ["Rabbit", "Cat", "Fox", "Mouse", "Sheep"];
        string[8] memory headwear = [
            "Jade Hairpin", "Plum Blossom", "Osmanthus Bloom", "Silk Bow",
            "Butterfly Clip", "Cloud Comb", "Lotus Crown", "Lion Cap"
        ];
        string[8] memory neckwear = [
            "Chinese Knot", "Silk Scarf", "Cloud Collar", "Sachet",
            "Jade Pendant", "Porcelain Pendant", "Brocade Collar", "Longevity Lock"
        ];
        string[8] memory palettes = ["Cinnabar", "Celadon", "Indigo", "Lotus", "Amber", "Jade", "Wisteria", "Pearl"];
        string[8] memory motifs = ["Cloud", "Lotus", "Plum", "Bamboo", "Waves", "Ruyi", "Moon", "Koi"];
        string memory json = string.concat(
            '{"name":"Glowpet #', tokenId.toString(),
            '","description":"DeltaX pet with a unique accessory combination within this edition. Ownership and appearance assignment are on-chain; raster artwork is stored on IPFS.",',
            '"attributes":[{"trait_type":"Species","value":"', species[t.speciesIndex],
            '"},{"trait_type":"Stage","value":"', uint256(stage).toString(),
            '"},{"trait_type":"Headwear","value":"', headwear[t.headwear],
            '"},{"trait_type":"Neckwear","value":"', neckwear[t.neckwear],
            '"},{"trait_type":"Palette","value":"', palettes[t.palette],
            '"},{"trait_type":"Motif","value":"', motifs[t.motif],
            '"},{"trait_type":"Appearance","value":"', uint256(t.appearanceId).toString(),
            '"},{"trait_type":"Artwork","value":"deltax-unique-v2"}],"image":"',
            imageURI(globalIndex), '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}

/// @notice Finite DeltaX edition with non-reusable artwork reservations per series.
/// @dev Mint order, recipient, transfer and evolution do not affect appearance.
contract DeltaXGlowpet is Glowpet {
    uint32 public constant CAPACITY = 18_432;
    uint32 public immutable editionSize;
    bytes32 public immutable artworkSeed;
    uint32 public allocatedArtwork;
    mapping(uint256 => uint32) public seriesArtworkOffset;

    error ArtworkSupplyExhausted();

    event ArtworkReserved(uint256 indexed seriesId, uint32 offset, uint64 count);

    constructor(string memory directoryCID, uint32 editionSize_, bytes32 seed_)
        Glowpet(address(new DeltaXPortraits(directoryCID, editionSize_, seed_)))
    {
        editionSize = editionSize_;
        artworkSeed = seed_;
    }

    function artworkVersion() external pure returns (string memory) {
        return "deltax-unique-v2";
    }

    function _reserveArtwork(uint256 seriesId, uint64 maxSupply) internal override {
        uint256 next = uint256(allocatedArtwork) + maxSupply;
        if (next > editionSize) revert ArtworkSupplyExhausted();
        seriesArtworkOffset[seriesId] = allocatedArtwork;
        emit ArtworkReserved(seriesId, allocatedArtwork, maxSupply);
        allocatedArtwork = uint32(next);
    }

    function _artworkIndex(uint256 tokenId) internal view returns (uint256) {
        return uint256(seriesArtworkOffset[tokenSeries[tokenId]]) + tokenSerial[tokenId] - 1;
    }

    function appearanceOf(uint256 tokenId) external view returns (uint32) {
        _requireOwned(tokenId);
        return DeltaXPortraits(art).appearanceId(_artworkIndex(tokenId));
    }

    function appearanceTraits(uint256 tokenId) external view returns (DeltaXPortraits.Appearance memory) {
        _requireOwned(tokenId);
        return DeltaXPortraits(art).appearanceTraits(_artworkIndex(tokenId));
    }

    function _traits(uint256 tokenId) internal view override returns (Traits memory t) {
        uint8[5] memory species = [uint8(2), 0, 4, 9, 7];
        uint32 id = DeltaXPortraits(art).appearanceId(_artworkIndex(tokenId));
        t.species = species[id % 5];
        // Preserve the legacy PetState shape; multi-layer accessories are exposed
        // accurately by appearanceTraits and tokenURI, not legacy eyewear fields.
        t.bodyScale = 1000;
        t.eyeSpacing = 1000;
        t.eyeSize = 1000;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return DeltaXPortraits(art).tokenURI(tokenId, _artworkIndex(tokenId), stageOf[tokenId]);
    }
}
