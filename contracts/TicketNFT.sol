// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// OpenZeppelin supplies audited building blocks: the ERC-721 standard itself,
// plus the Base64 and Strings helpers used to build the artwork on-chain.
// The @5.6.1 suffix is a Remix feature: Remix fetches that exact npm release
// when it compiles, so every learner builds against identical source.
import {ERC721} from "@openzeppelin/contracts@5.6.1/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts@5.6.1/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts@5.6.1/utils/Strings.sol";

/**
 * @title TicketNFT
 * @notice A free, non-transferable event ticket. One per wallet.
 *
 * Three deliberate choices take this past a boilerplate NFT:
 *
 * 1. Soulbound. Transfers revert, so a ticket cannot be resold or moved to
 *    another wallet. The mechanism matches what a real event ticket should do.
 *
 * 2. The artwork lives in the contract. tokenURI() builds a base64-encoded SVG
 *    out of live contract state. There is no IPFS pin, no server, and no image
 *    file anywhere: the picture is produced by the code, so it cannot break or
 *    disappear as long as Ethereum exists. The tradeoff is that storing bytes
 *    on-chain costs more gas than storing a link.
 *
 * 3. The artwork changes. checkIn() records attendance, and tokenURI() reads
 *    that state, so the image drawn for a ticket changes from "NOT CHECKED IN"
 *    to "CHECKED IN" without anyone updating a file.
 */
contract TicketNFT is ERC721 {
    // Lets us call tokenId.toString() when assembling the SVG.
    using Strings for uint256;

    // Token IDs start at 1 because that is easier to recognize in explorers.
    uint256 private _nextTokenId = 1;

    // Solidity generates a read-only hasMinted(address) getter for this.
    mapping(address => bool) public hasMinted;

    // Lets the frontend find a wallet's ticket without scanning past events.
    mapping(address => uint256) public tokenOf;

    // 0 means "not checked in yet". Any other value is the check-in timestamp.
    mapping(uint256 => uint256) public checkedInAt;

    event Mint(address indexed minter, uint256 indexed tokenId);
    event CheckedIn(address indexed holder, uint256 indexed tokenId, uint256 timestamp);

    // Custom errors are cheaper than require strings and are easy to decode
    // from a failed transaction, because the name travels in the revert data.
    error OneTicketPerWallet();
    error NotTicketOwner();
    error AlreadyCheckedIn();
    error TicketNonTransferable();

    constructor() ERC721("Ticket NFT", "TICKET") {}

    /**
     * @notice Mint one ticket to the wallet that sends this transaction.
     * @return tokenId The unique ID assigned to the new ticket.
     */
    function mint() external returns (uint256 tokenId) {
        // msg.sender is the address that approved this transaction in MetaMask.
        if (hasMinted[msg.sender]) revert OneTicketPerWallet();

        tokenId = _nextTokenId;
        _nextTokenId += 1;

        // Record the claim before _safeMint, which may call into the recipient.
        // If anything later in this call reverts, Ethereum undoes all of it.
        hasMinted[msg.sender] = true;
        tokenOf[msg.sender] = tokenId;

        _safeMint(msg.sender, tokenId);
        emit Mint(msg.sender, tokenId);
    }

    /**
     * @notice Record attendance for a ticket you own. Callable once per ticket.
     * @dev This is the second write path in the contract, and it changes what
     *      tokenURI() renders for the ticket.
     */
    function checkIn(uint256 tokenId) external {
        // ownerOf reverts if the token does not exist, so this also validates
        // that tokenId is real before we compare it to the caller.
        if (ownerOf(tokenId) != msg.sender) revert NotTicketOwner();
        if (checkedInAt[tokenId] != 0) revert AlreadyCheckedIn();

        checkedInAt[tokenId] = block.timestamp;
        emit CheckedIn(msg.sender, tokenId, block.timestamp);
    }

    /**
     * @dev OpenZeppelin 5.x routes mints, transfers, and burns through this one
     *      hook. (The older _beforeTokenTransfer hook was removed in 5.0.)
     *      from == address(0) is a mint and to == address(0) is a burn; anything
     *      with both sides set is a transfer, which we reject to make the token
     *      soulbound.
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert TicketNonTransferable();

        return super._update(to, tokenId, auth);
    }

    /**
     * @notice Returns the ticket image, built from contract state at read time.
     * @dev The result is a data URI. Wallets and marketplaces display these
     *      directly, and a browser renders them with no server involved.
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        // Reverts for nonexistent tokens, which is the ERC-721 expectation.
        _requireOwned(tokenId);

        string memory status;
        string memory checkedInLabel;
        if (checkedInAt[tokenId] == 0) {
            status = "NOT CHECKED IN";
            checkedInLabel = "No";
        } else {
            status = "CHECKED IN";
            checkedInLabel = "Yes";
        }

        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0%" stop-color="#7c3aed"/>',
            '<stop offset="100%" stop-color="#2563eb"/>',
            '</linearGradient></defs>',
            '<rect width="400" height="240" rx="18" fill="#09090b"/>',
            '<rect x="1" y="1" width="398" height="238" rx="17" fill="none" stroke="url(#g)" stroke-width="2"/>',
            '<text x="28" y="50" font-family="monospace" font-size="12" fill="#a78bfa" letter-spacing="3">ETHEREUM SEPOLIA</text>',
            '<text x="28" y="98" font-family="monospace" font-size="30" fill="#f8fafc">TICKET #',
            tokenId.toString(),
            '</text>',
            '<text x="28" y="136" font-family="monospace" font-size="10" fill="#a1a1aa" letter-spacing="2">OWNER</text>',
            '<text x="28" y="154" font-family="monospace" font-size="12" fill="#e4e4e7">',
            Strings.toHexString(ownerOf(tokenId)),
            '</text>',
            '<text x="28" y="192" font-family="monospace" font-size="10" fill="#a1a1aa" letter-spacing="2">STATUS</text>',
            '<text x="28" y="210" font-family="monospace" font-size="12" fill="#e4e4e7">',
            status,
            '</text>',
            '</svg>'
        );

        string memory json = string.concat(
            '{"name":"Ticket #',
            tokenId.toString(),
            '","description":"A free, non-transferable event ticket on Ethereum Sepolia.",',
            '"attributes":[{"trait_type":"Checked In","value":"',
            checkedInLabel,
            '"}],',
            '"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
