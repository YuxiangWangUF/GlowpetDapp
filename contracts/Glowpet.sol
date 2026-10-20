// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts@5.6.1/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts@5.6.1/access/Ownable.sol";
import {Base64} from "@openzeppelin/contracts@5.6.1/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts@5.6.1/utils/Strings.sol";
import {MerkleProof} from "@openzeppelin/contracts@5.6.1/utils/cryptography/MerkleProof.sol";
import {EIP712} from "@openzeppelin/contracts@5.6.1/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts@5.6.1/utils/cryptography/ECDSA.sol";
import {Traits, IGlowpetArt} from "./GlowpetTypes.sol";

/**
 * @title Glowpet
 * @notice Limited-edition physical charm backed by a unique on-chain pet.
 *
 * Asset responsibilities only: series caps, serial-bound minting, ownership,
 * evolution, and the trait derivation that both the chain portrait and the
 * animated app rig consume. All drawing lives in GlowpetArt.
 *
 * tokenId = seriesId * 1_000_000 + serial, so the pet belongs to a physical
 * charm rather than to a mint order.
 */
contract Glowpet is ERC721, EIP712, Ownable {
    using Strings for uint256;

    uint256 public constant SERIES_STRIDE = 1_000_000;
    uint256 public constant MAX_LABEL_BYTES = 64;

    /// @dev The physical credential's private key signs this authorisation.
    ///      Its public signer address is committed in the Merkle tree. The key
    ///      never enters calldata, so observers cannot authorise another recipient.
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256("Claim(uint256 seriesId,uint32 serial,address recipient,uint256 deadline)");

    address public immutable art;

    struct Series {
        uint64 maxSupply;
        uint64 minted;
        bool open;
        uint32 salt; // metadata only; not part of the Merkle leaf
        bytes32 serialRoot;
        string label;
    }

    struct PetState {
        uint8 species;
        uint8 palette;
        uint8 eyeStyle;
        uint8 mouthStyle;
        uint8 accessory;
        uint8 eyewear;
        uint8 frameColor;
        uint8 stage;
        uint8 bodyShape;
        int8 tilt;
        uint16 level;
        uint32 serial;
        uint256 seriesId;
    }

    mapping(uint256 => Series) private _series;
    mapping(uint256 => bool) public serialClaimed;
    mapping(uint256 => uint256) public tokenSeries;
    mapping(uint256 => uint32) public tokenSerial;
    mapping(uint256 => uint8) public stageOf;

    event SeriesCreated(uint256 indexed seriesId, uint64 maxSupply, bytes32 serialRoot, string label);
    event SeriesClosed(uint256 indexed seriesId);
    event Claimed(address indexed owner, uint256 indexed tokenId, uint256 seriesId, uint32 serial);
    event Evolved(uint256 indexed tokenId, uint8 stage);

    error InvalidConfig();
    error InvalidSerial();
    error InvalidCredentialSigner();
    error InvalidRecipient();
    error InvalidProof();
    error InvalidSignature();
    error SignatureExpired();
    error SeriesExists();
    error SeriesNotOpen();
    error AlreadyClaimed();
    error MaxSupplyReached();
    error StageMustIncrease();

    constructor(address art_)
        ERC721("Glowpet", "GLOW")
        EIP712("Glowpet", "2")
        Ownable(msg.sender)
    {
        // The renderer is immutable, so fail the deployment instead of minting
        // tokens whose tokenURI can never be read.
        if (art_ == address(0)) revert InvalidConfig();
        art = art_;
    }

    // ------------------------------------------------------------------
    // Series
    // ------------------------------------------------------------------

    function createSeries(
        uint256 seriesId,
        uint64 maxSupply,
        uint32 salt,
        bytes32 serialRoot,
        string calldata label
    ) external onlyOwner {
        if (maxSupply == 0 || maxSupply >= SERIES_STRIDE) revert InvalidConfig();
        if (seriesId == 0 || seriesId > (type(uint256).max - maxSupply) / SERIES_STRIDE) {
            revert InvalidConfig();
        }
        if (_series[seriesId].maxSupply != 0) revert SeriesExists();
        if (serialRoot == bytes32(0)) revert InvalidConfig();
        if (bytes(label).length > MAX_LABEL_BYTES) revert InvalidConfig();

        _series[seriesId] = Series(maxSupply, 0, true, salt, serialRoot, label);
        emit SeriesCreated(seriesId, maxSupply, serialRoot, label);
    }

    function closeSeries(uint256 seriesId) external onlyOwner {
        Series storage s = _series[seriesId];
        if (!s.open) revert SeriesNotOpen();
        s.open = false;
        emit SeriesClosed(seriesId);
    }

    function seriesInfo(uint256 seriesId)
        external
        view
        returns (uint64 maxSupply, uint64 minted, bool open, uint32 salt, bytes32 serialRoot, string memory label)
    {
        Series storage s = _series[seriesId];
        return (s.maxSupply, s.minted, s.open, s.salt, s.serialRoot, s.label);
    }

    // ------------------------------------------------------------------
    // Claim (physical -> digital)
    // ------------------------------------------------------------------

    function claimProtocolVersion() external pure returns (uint256) {
        return 2;
    }

    /// @notice Claim the pet bound to one physical charm.
    /// @dev The NFC / QR credential contains a private key. The app signs the
    ///      recipient and deadline locally; only the public credentialSigner,
    ///      proof and signature are submitted. The leaf commits to the chain,
    ///      series and serial. The EIP-712 domain also binds this deployment.
    ///      Any relayer can submit an authorisation, but cannot redirect it.
    function claim(
        uint256 seriesId,
        uint32 serial,
        address credentialSigner,
        bytes32[] calldata proof,
        address recipient,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 tokenId) {
        Series storage s = _series[seriesId];
        if (!s.open) revert SeriesNotOpen();
        if (serial == 0 || serial > s.maxSupply) revert InvalidSerial();
        if (credentialSigner == address(0)) revert InvalidCredentialSigner();
        if (recipient == address(0)) revert InvalidRecipient();
        if (deadline < block.timestamp) revert SignatureExpired();
        if (s.minted >= s.maxSupply) revert MaxSupplyReached();

        tokenId = seriesId * SERIES_STRIDE + serial;
        if (serialClaimed[tokenId]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(abi.encode(block.chainid, seriesId, serial, credentialSigner));
        if (!MerkleProof.verify(proof, s.serialRoot, leaf)) revert InvalidProof();

        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, seriesId, serial, recipient, deadline)
        );
        (address recovered, ECDSA.RecoverError signatureError,) =
            ECDSA.tryRecover(_hashTypedDataV4(structHash), signature);
        if (signatureError != ECDSA.RecoverError.NoError || recovered != credentialSigner) {
            revert InvalidSignature();
        }

        serialClaimed[tokenId] = true;
        s.minted += 1;
        tokenSeries[tokenId] = seriesId;
        tokenSerial[tokenId] = serial;

        _safeMint(recipient, tokenId);
        emit Claimed(recipient, tokenId, seriesId, serial);
    }

    // ------------------------------------------------------------------
    // Evolution (operator-authorized for the MVP)
    // ------------------------------------------------------------------

    function evolve(uint256 tokenId, uint8 newStage) external onlyOwner {
        _requireOwned(tokenId);
        if (newStage <= stageOf[tokenId]) revert StageMustIncrease();
        stageOf[tokenId] = newStage;
        emit Evolved(tokenId, newStage);
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    function petState(uint256 tokenId) external view returns (PetState memory) {
        _requireOwned(tokenId);
        Traits memory t = _traits(tokenId);
        uint8 stage = stageOf[tokenId];

        return PetState({
            species: t.species,
            palette: t.palette,
            eyeStyle: t.eyeStyle,
            mouthStyle: t.mouthStyle,
            accessory: t.accessory,
            eyewear: t.eyewear,
            frameColor: t.frameColor,
            stage: stage,
            bodyShape: t.bodyShape,
            tilt: t.tilt,
            level: uint16(stage) + 1,
            serial: tokenSerial[tokenId],
            seriesId: tokenSeries[tokenId]
        });
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        Traits memory t = _traits(tokenId);
        string memory label = _series[tokenSeries[tokenId]].label;
        string memory svg = IGlowpetArt(art).render(t, label, tokenSerial[tokenId], stageOf[tokenId]);

        string memory json = string.concat(
            '{"name":"Glowpet #',
            tokenId.toString(),
            '","description":"A unique on-chain pet. Its traits are derived from the token id; the artwork is generated by the contract.",',
            '"attributes":[{"trait_type":"Species","value":"',
            _speciesName(t.species),
            '"},{"trait_type":"Stage","value":"',
            uint256(stageOf[tokenId]).toString(),
            '"}],"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ------------------------------------------------------------------
    // Trait derivation (must match the JS reference generator)
    // ------------------------------------------------------------------

    function _traits(uint256 tokenId) internal pure returns (Traits memory t) {
        uint256 h = uint256(keccak256(abi.encode(tokenId)));

        t.species = uint8(h >> 128) % 14;
        t.palette = _paletteFor(t.species, uint8(h));
        t.bgVariant = uint8(h >> 8) % 3;
        t.bodyScale = uint16(940 + (uint256(uint8(h >> 16)) * 120) / 255);
        t.earVariant = uint8(h >> 32) % 2;
        t.eyeSpacing = uint16(920 + (uint256(uint8(h >> 40)) * 160) / 255);
        t.eyeSize = uint16(920 + (uint256(uint8(h >> 48)) * 160) / 255);
        t.eyeStyle = uint8(h >> 56) % 6;
        t.mouthStyle = uint8(h >> 64) % 3;
        t.blush = uint8(h >> 72) % 2;
        t.patternStyle = uint8(h >> 80) % 3;
        t.patternCount = (uint8(h >> 88) % 3) + 3;
        t.accessory = uint8(h >> 96) % 6;
        t.patternSeed = uint8(h >> 104);
        t.bodyShape = uint8(h >> 112) % 2;
        t.tilt = int8(uint8(h >> 120) % 7) - 3;
        t.eyewear = uint8(h >> 136) % 6;
        t.frameColor = uint8(h >> 144) % 6;
    }

    /// @dev Species constrain the palette range so an animal never arrives in a
    ///      colour that breaks recognition (no green pandas, no blue frogs).
    function _paletteFor(uint8 species, uint8 b0) internal pure returns (uint8) {
        if (species == 0) return b0 % 10;
        if (species == 1) return 1 + (b0 % 5);
        if (species == 2) {
            uint8[6] memory m = [0, 1, 6, 7, 8, 9];
            return m[b0 % 6];
        }
        if (species == 3) return 1 + (b0 % 4);
        if (species == 4) return 1 + (b0 % 3);
        if (species == 5) return 3;
        if (species == 6) return 4 + (b0 % 2);
        if (species == 7) {
            uint8[4] memory s = [3, 7, 8, 9];
            return s[b0 % 4];
        }
        if (species == 8) return b0 % 3;                 // pig: rose/coral/peach
        if (species == 9) {
            uint8[5] memory m = [0, 1, 7, 8, 9];         // mouse
            return m[b0 % 5];
        }
        if (species == 10) {
            uint8[3] memory p = [6, 7, 8];               // penguin
            return p[b0 % 3];
        }
        if (species == 11) {
            uint8[3] memory c = [3, 6, 7];               // cow
            return c[b0 % 3];
        }
        if (species == 12) return 1 + (b0 % 3);          // tiger
        uint8[3] memory l = [2, 3, 1];                   // lion
        return l[b0 % 3];
    }

    function _speciesName(uint8 species) internal pure returns (string memory) {
        if (species == 0) return "Cat";
        if (species == 1) return "Dog";
        if (species == 2) return "Rabbit";
        if (species == 3) return "Bear";
        if (species == 4) return "Fox";
        if (species == 5) return "Panda";
        if (species == 6) return "Frog";
        if (species == 7) return "Sheep";
        if (species == 8) return "Pig";
        if (species == 9) return "Mouse";
        if (species == 10) return "Penguin";
        if (species == 11) return "Cow";
        if (species == 12) return "Tiger";
        return "Lion";
    }
}
