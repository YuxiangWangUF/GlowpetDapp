// Local-only Hardhat network for an end-to-end wallet/claim demo. The chain id
// matches Sepolia so the browser code and EIP-712 domain stay identical; no
// public network is involved. Run with `--no-compile` after `contracts:compile`.
const base = require("./hardhat.config.cjs");

module.exports = {
  ...base,
  networks: {
    hardhat: {
      chainId: 11155111,
      hardfork: "cancun",
      initialBaseFeePerGas: 1_000_000_000,
    },
  },
};
