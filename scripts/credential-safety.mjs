import fs from "node:fs";
import path from "node:path";

const CREDENTIAL_FIELDS = new Set([
  "secret", "secrets", "seed", "privatekey", "privatekeys", "mnemonic",
  "proof", "proofs", "claimurl",
]);
const normalizeField = (field) => field.toLowerCase().replace(/[_\s-]/g, "");

// realpath also has to cover output directories that do not exist yet. Resolve
// the closest existing ancestor, so a symlink above a new directory cannot
// bypass the public/ boundary. Dangling symlinks fail closed.
export function resolvedOutputPath(target) {
  let ancestor = path.resolve(target);
  const suffix = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      return path.join(fs.realpathSync(ancestor), ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // lstat sees a dangling link but realpath does not; do not walk past it.
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) {
          throw new Error(`Cannot safely resolve output symlink: ${ancestor}`);
        }
      } catch (linkError) {
        if (linkError.code !== "ENOENT") throw linkError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function assertPrivateOutput(target, publicDirectories) {
  const resolved = resolvedOutputPath(target);
  for (const directory of publicDirectories) {
    const publicDir = resolvedOutputPath(directory);
    const relative = path.relative(publicDir, resolved);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error(
        `Refusing to write claim credentials inside public/: ${target}. ` +
        "Use a private output directory such as deployments/ or .glowpet-demo/.",
      );
    }
  }
}

export function containsCredentialFields(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsCredentialFields);
  return Object.entries(value).some(
    ([key, child]) => CREDENTIAL_FIELDS.has(normalizeField(key)) || containsCredentialFields(child),
  );
}

function isCredentialFile(file) {
  const name = path.basename(file).toLowerCase();
  if (/^(?:.*[-_.])?seed(?:[-_.].*)?\.txt$/.test(name) || name === "seed.txt") return true;
  const extension = path.extname(name);
  if (![".json", ".csv", ".tsv", ".txt"].includes(extension)) return false;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");

  if (extension === ".json") {
    try {
      if (containsCredentialFields(JSON.parse(text))) return true;
    } catch {
      // Also check recognizable secret markers in malformed exports.
    }
  }
  if (extension === ".csv" || extension === ".tsv") {
    const header = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
    if (header.split(/[,\t;]/).some((field) => CREDENTIAL_FIELDS.has(normalizeField(field.trim().replace(/^"|"$/g, ""))))) {
      return true;
    }
  }
  return /(?:["']?(?:seed|secret|private[_-]?key)["']?\s*[:=]\s*["']?\s*0x[0-9a-f]{64})|(?:[?&](?:secret|seed)=)/i.test(text);
}

/** Find generated credentials anywhere in public/, including linked folders. */
export function findPublishedCredentials(publicDir) {
  if (!fs.existsSync(publicDir)) return [];
  const found = [];
  const visited = new Set();
  function visit(directory) {
    const resolved = fs.realpathSync(directory);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile() && isCredentialFile(file)) found.push(file);
    }
  }
  visit(publicDir);
  return found;
}
