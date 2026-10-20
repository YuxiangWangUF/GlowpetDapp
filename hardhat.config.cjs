// Tests compile with scripts/compile-contracts.mjs and the pinned local solc.
// `--no-compile` prevents Hardhat from downloading a compiler.
module.exports = {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "cancun",
    },
  },
  mocha: { timeout: 120000 },
};
