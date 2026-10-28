/**
 * Human-readable ABI shared by the browser and the claim API.
 * It lists only the calls and events the app uses, plus the custom errors so
 * ethers can decode reverts into readable messages.
 */
export const GLOWPET_ABI = [
  "function claimProtocolVersion() pure returns (uint256)",
  "function claim(uint256 seriesId, uint32 serial, address credentialSigner, bytes32[] proof, address recipient, uint256 deadline, bytes signature) returns (uint256 tokenId)",
  "function seriesInfo(uint256 seriesId) view returns (uint64 maxSupply, uint64 minted, bool open, uint32 salt, bytes32 serialRoot, string label)",
  "function petState(uint256 tokenId) view returns (uint8 species, uint8 palette, uint8 eyeStyle, uint8 mouthStyle, uint8 accessory, uint8 eyewear, uint8 frameColor, uint8 stage, uint8 bodyShape, int8 tilt, uint16 level, uint32 serial, uint256 seriesId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function serialClaimed(uint256 tokenId) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Claimed(address indexed owner, uint256 indexed tokenId, uint256 seriesId, uint32 serial)",
  "event Evolved(uint256 indexed tokenId, uint8 stage)",
  "error InvalidConfig()",
  "error InvalidSerial()",
  "error InvalidCredentialSigner()",
  "error InvalidRecipient()",
  "error InvalidProof()",
  "error InvalidSignature()",
  "error SignatureExpired()",
  "error SeriesExists()",
  "error SeriesNotOpen()",
  "error AlreadyClaimed()",
  "error MaxSupplyReached()",
  "error StageMustIncrease()",
];
