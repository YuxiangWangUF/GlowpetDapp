import { Contract, JsonRpcProvider } from "ethers";
import { GLOWPET_ABI } from "../../shared/glowpet-abi.js";
import { AppError } from "../lib/errors.js";

function normalizeSeries(info) {
  return {
    maxSupply: Number(info.maxSupply ?? info[0]),
    minted: Number(info.minted ?? info[1]),
    open: Boolean(info.open ?? info[2]),
    salt: Number(info.salt ?? info[3]),
    root: String(info.serialRoot ?? info[4]),
    label: String(info.label ?? info[5]),
  };
}

/**
 * Read/broadcast adapter around the deployed Glowpet contract. Tests inject a
 * fake with the same surface, so service and worker tests do not need a node.
 */
export function createChainAdapter({
  rpcUrl, chainId, contractAddress, deployBlock = 0, relayerAddress = "", provider = null,
}) {
  const rpc = provider ?? new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true });
  const contract = new Contract(contractAddress, GLOWPET_ABI, rpc);

  function encodeClaimData({ seriesId, serial, credentialSigner, proof, recipient, deadline, signature }) {
    return contract.interface.encodeFunctionData("claim", [
      seriesId, serial, credentialSigner, proof, recipient, deadline, signature,
    ]);
  }

  return {
    kind: "glowpet-chain",
    contractAddress,
    relayerAddress,

    async getChainId() {
      return Number(BigInt(await rpc.send("eth_chainId", [])));
    },

    async getCode() {
      return rpc.getCode(contractAddress);
    },

    async getProtocolVersion() {
      return Number(await contract.claimProtocolVersion());
    },

    async getSeries(seriesId) {
      return normalizeSeries(await contract.seriesInfo(seriesId));
    },

    async getSerialClaimed(tokenId) {
      return Boolean(await contract.serialClaimed(tokenId));
    },

    async getOwner(tokenId) {
      return contract.ownerOf(tokenId);
    },

    async getOwnerSnapshot(tokenId) {
      const owner = await contract.ownerOf(tokenId);
      const blockNumber = await rpc.getBlockNumber();
      const block = await rpc.getBlock(blockNumber);
      return {
        owner,
        blockNumber,
        blockHash: block?.hash ?? "",
      };
    },

    async findClaimed(tokenId) {
      const events = await contract.queryFilter(
        contract.filters.Claimed(null, tokenId),
        deployBlock,
        "latest",
      );
      const event = events.at(-1);
      if (!event) return null;
      return {
        recipient: event.args.owner,
        tokenId: event.args.tokenId,
        seriesId: event.args.seriesId,
        serial: Number(event.args.serial),
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
      };
    },

    async estimateClaimGas(args, from = relayerAddress) {
      const data = encodeClaimData(args);
      await rpc.call({ from, to: contractAddress, data });
      return rpc.estimateGas({ from, to: contractAddress, data });
    },

    async getFeeData() {
      const fee = await rpc.getFeeData();
      const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
      if (maxFeePerGas == null) {
        throw new AppError("CHAIN_UNAVAILABLE", "The network did not return a gas price.", 503);
      }
      return {
        maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
      };
    },

    async getBalance(address) {
      return rpc.getBalance(address);
    },

    async getTransactionCount(address) {
      return rpc.getTransactionCount(address, "pending");
    },

    async getBlockNumber() {
      return rpc.getBlockNumber();
    },

    async getBlock(number) {
      return rpc.getBlock(number);
    },

    async broadcast(rawSignedTx) {
      return rpc.broadcastTransaction(rawSignedTx);
    },

    async getTransaction(hash) {
      return rpc.getTransaction(hash);
    },

    async getTransactionReceipt(hash) {
      return rpc.getTransactionReceipt(hash);
    },

    encodeClaimData,

    parseClaimedReceipt(receipt) {
      for (const log of receipt?.logs ?? []) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed?.name === "Claimed") {
            return {
              tokenId: parsed.args.tokenId,
              recipient: parsed.args.owner,
              seriesId: parsed.args.seriesId,
              serial: Number(parsed.args.serial),
            };
          }
        } catch {
          // Logs from another contract in the same transaction.
        }
      }
      return null;
    },
  };
}

export function createConfiguredChain(config, options = {}) {
  if (!config.chainConfigured) {
    throw new AppError("SERVICE_NOT_CONFIGURED", "The Glowpet contract address is not configured.", 503);
  }
  if (!config.rpcUrl && !options.provider) {
    throw new AppError("SERVICE_NOT_CONFIGURED", "The server RPC URL is not configured.", 503);
  }
  return createChainAdapter({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    contractAddress: config.contractAddress,
    deployBlock: config.deployBlock,
    relayerAddress: config.relayerAddress,
    provider: options.provider ?? null,
  });
}
