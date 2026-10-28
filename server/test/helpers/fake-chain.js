import { Interface, Transaction, keccak256 } from "ethers";
import { GLOWPET_ABI } from "../../../shared/glowpet-abi.js";

const iface = new Interface(GLOWPET_ABI);
const SERIES_STRIDE = 1_000_000n;

function blockHash(number) {
  return `0x${BigInt(number).toString(16).padStart(64, "0")}`;
}

export function createFakeChain({
  chainId = 11155111,
  contractAddress = "0x0000000000000000000000000000000000001234",
  root,
  maxSupply = 100,
  open = true,
  feePerGas = 1_000_000_000n,
} = {}) {
  const series = { maxSupply, minted: 0, open, root, label: "DeltaX" };
  const claims = new Map();
  const owners = new Map();
  const transactions = new Map();
  const receipts = new Map();
  const broadcasts = [];
  let pendingNonce = 0;
  let currentBlock = 100;
  let nextBlock = 101;
  let failBroadcasts = 0;

  function tokenIdFor(seriesId, serial) {
    return BigInt(seriesId) * SERIES_STRIDE + BigInt(serial);
  }

  function succeedTransaction(entry, recipient, seriesId, serial, tokenId) {
    series.minted += 1;
    const number = nextBlock;
    nextBlock += 1;
    currentBlock = Math.max(currentBlock, number);
    const hash = blockHash(number);
    claims.set(tokenId.toString(), {
      recipient,
      tokenId,
      seriesId,
      serial,
      txHash: entry.hash,
      blockNumber: number,
      blockHash: hash,
    });
    owners.set(tokenId.toString(), recipient);
    receipts.set(entry.hash, {
      hash: entry.hash,
      status: 1,
      blockNumber: number,
      blockHash: hash,
      gasUsed: 120_000n,
      gasPrice: feePerGas,
      effectiveGasPrice: feePerGas,
      claimed: { recipient, tokenId, seriesId, serial },
    });
  }

  const chain = {
    kind: "fake-chain",
    contractAddress,
    series,
    claims,
    owners,
    broadcasts,
    transactions,
    receipts,
    get pendingNonce() { return pendingNonce; },
    get currentBlock() { return currentBlock; },

    async getChainId() { return chainId; },
    async getCode() { return "0x6000"; },
    async getProtocolVersion() { return 2; },
    async getSeries() { return { ...series }; },
    async getSerialClaimed(tokenId) { return claims.has(BigInt(tokenId).toString()); },
    async getOwner(tokenId) {
      const owner = owners.get(BigInt(tokenId).toString());
      if (!owner) throw new Error("ERC721NonexistentToken");
      return owner;
    },
    async getOwnerSnapshot(tokenId) {
      const owner = await chain.getOwner(tokenId);
      return { owner, blockNumber: currentBlock, blockHash: blockHash(currentBlock) };
    },
    async findClaimed(tokenId) {
      return claims.get(BigInt(tokenId).toString()) ?? null;
    },
    async estimateClaimGas() { return 120_000n; },
    async getFeeData() {
      return { maxFeePerGas: feePerGas, maxPriorityFeePerGas: 1_000_000n };
    },
    async getBalance() { return 100n * 10n ** 18n; },
    async getTransactionCount() { return pendingNonce; },
    async getBlockNumber() { return currentBlock; },
    async getBlock(number) {
      if (number > currentBlock) return null;
      return { number, hash: blockHash(number) };
    },
    async broadcast(rawSignedTx) {
      if (failBroadcasts > 0) {
        failBroadcasts -= 1;
        throw new Error("network timeout");
      }
      const parsed = Transaction.from(rawSignedTx);
      const decoded = iface.parseTransaction({ data: parsed.data });
      const [seriesId, serial, , , recipient] = decoded.args;
      const tokenId = tokenIdFor(seriesId, serial);
      const entry = {
        hash: parsed.hash,
        rawSignedTx,
        nonce: parsed.nonce,
        args: { seriesId, serial, recipient, tokenId },
      };
      transactions.set(entry.hash, entry);
      broadcasts.push(entry);
      pendingNonce = Math.max(pendingNonce, Number(parsed.nonce) + 1);
      return { hash: parsed.hash, wait: async () => receipts.get(parsed.hash) ?? null };
    },
    async getTransaction(hash) { return transactions.get(hash) ?? null; },
    async getTransactionReceipt(hash) { return receipts.get(hash) ?? null; },
    encodeClaimData(args) {
      return iface.encodeFunctionData("claim", [
        args.seriesId, args.serial, args.credentialSigner, args.proof,
        args.recipient, args.deadline, args.signature,
      ]);
    },
    parseClaimedReceipt(receipt) {
      return receipt?.claimed ?? null;
    },

    // Test controls ---------------------------------------------------------
    mineSuccess() {
      for (const entry of transactions.values()) {
        if (receipts.has(entry.hash)) continue;
        succeedTransaction(
          entry, entry.args.recipient, entry.args.seriesId, entry.args.serial, entry.args.tokenId,
        );
      }
    },
    mineRevert() {
      for (const entry of transactions.values()) {
        if (receipts.has(entry.hash)) continue;
        const number = nextBlock;
        nextBlock += 1;
        currentBlock = Math.max(currentBlock, number);
        receipts.set(entry.hash, {
          hash: entry.hash,
          status: 0,
          blockNumber: number,
          blockHash: blockHash(number),
          gasUsed: 21_000n,
          gasPrice: feePerGas,
          effectiveGasPrice: feePerGas,
          claimed: null,
        });
      }
    },
    advanceBlocks(count = 1) {
      currentBlock += count;
    },
    failNextBroadcasts(count = 1) {
      failBroadcasts = count;
    },
    claimExternally(tokenId, recipient) {
      const number = nextBlock;
      nextBlock += 1;
      currentBlock = Math.max(currentBlock, number);
      const hash = blockHash(number);
      const entry = {
        recipient,
        tokenId: BigInt(tokenId),
        seriesId: 1n,
        serial: Number(BigInt(tokenId) % SERIES_STRIDE),
        txHash: `0x${"ab".repeat(32)}`,
        blockNumber: number,
        blockHash: hash,
      };
      claims.set(BigInt(tokenId).toString(), entry);
      owners.set(BigInt(tokenId).toString(), recipient);
      series.minted += 1;
      return entry;
    },
    setOwner(tokenId, owner) {
      owners.set(BigInt(tokenId).toString(), owner);
    },
    rawHash(rawSignedTx) {
      return keccak256(rawSignedTx);
    },
  };

  return chain;
}

export { blockHash };
