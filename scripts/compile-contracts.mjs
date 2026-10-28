import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import solc from "solc";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openzeppelinRoot = path.dirname(require.resolve("@openzeppelin/contracts/package.json"));
const contractFiles = ["GlowpetTypes.sol", "GlowpetFaceArt.sol", "GlowpetArt.sol", "Glowpet.sol", "DeltaXGlowpet.sol"];

/** Compile exclusively with the pinned local compiler and OpenZeppelin package. */
export function compileContracts({ writeArtifacts = false } = {}) {
  const sources = Object.fromEntries(contractFiles.map((name) => [
    `contracts/${name}`,
    { content: fs.readFileSync(path.join(root, "contracts", name), "utf8") },
  ]));
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import(importPath) {
      const prefix = "@openzeppelin/contracts@5.6.1/";
      if (!importPath.startsWith(prefix)) return { error: `Unsupported import: ${importPath}` };
      const relativePath = importPath.slice(prefix.length);
      const resolved = path.resolve(openzeppelinRoot, relativePath);
      if (!resolved.startsWith(openzeppelinRoot + path.sep)) return { error: "Invalid import path" };
      try {
        return { contents: fs.readFileSync(resolved, "utf8") };
      } catch {
        return { error: `Missing local dependency: ${importPath}` };
      }
    },
  }));
  const errors = (output.errors ?? []).filter((error) => error.severity === "error");
  if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join("\n"));
  const artifacts = {};
  for (const [sourceName, contracts] of Object.entries(output.contracts ?? {})) {
    if (!sourceName.startsWith("contracts/")) continue;
    for (const [contractName, contract] of Object.entries(contracts)) {
      const artifact = {
        _format: "hh-sol-artifact-1",
        contractName,
        sourceName,
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        linkReferences: contract.evm.bytecode.linkReferences,
        deployedLinkReferences: contract.evm.deployedBytecode.linkReferences,
      };
      artifacts[contractName] = artifact;
      if (writeArtifacts) {
        const outputDir = path.join(root, "artifacts", sourceName);
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, `${contractName}.json`), JSON.stringify(artifact, null, 2) + "\n");
      }
    }
  }
  return { artifacts, compilerVersion: solc.version(), warnings: (output.errors ?? []).filter((e) => e.severity === "warning") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { artifacts, compilerVersion, warnings } = compileContracts({ writeArtifacts: true });
  console.log(`Local Solidity ${compilerVersion}; optimizer 200 runs; viaIR; Cancun`);
  for (const warning of warnings) console.warn(warning.formattedMessage);
  for (const name of ["GlowpetFaceArt", "GlowpetArt", "Glowpet", "DeltaXGlowpet", "DeltaXPortraits"]) {
    const bytes = (artifacts[name].deployedBytecode.length - 2) / 2;
    console.log(`${name}: ${bytes.toLocaleString("en-US")} deployed bytes / 24,576`);
    if (bytes > 24_576) process.exitCode = 1;
  }
}
