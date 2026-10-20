import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));
const demoProofs = path.resolve(root, ".glowpet-demo/proofs");

/**
 * Demo claim files are bearer credentials. They live outside public/ and are
 * served only by the dev server; `vite build` must never publish them.
 */
function demoProofServer() {
  return {
    name: "glowpet-demo-proofs",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/proofs", (request, response, next) => {
        // Mounted at /proofs, so request.url is "/<serial>.json".
        const serial = path.basename(request.url ?? "").replace(/[^0-9]/g, "");
        const file = serial ? path.join(demoProofs, `${serial}.json`) : "";

        // Do not fall through to the SPA fallback: the client would receive
        // index.html with status 200 and fail while parsing JSON.
        if (!file || !fs.existsSync(file)) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ error: "not found" }));
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        fs.createReadStream(file).pipe(response);
      });
    },
  };
}

function findJsonFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findJsonFiles(full, found);
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
  }
  return found;
}

function forbidPublishedProofs() {
  return {
    name: "glowpet-forbid-published-proofs",
    apply: "build",
    buildStart() {
      const publicDir = path.resolve(root, "public");
      if (!fs.existsSync(publicDir)) return;

      const legacyDir = path.join(publicDir, "proofs");
      if (fs.existsSync(legacyDir) && fs.readdirSync(legacyDir).some((file) => file.endsWith(".json"))) {
        this.error(
          "public/proofs contains claim secrets. Delete it before building; " +
            "demo proofs belong in .glowpet-demo/proofs (served only by the dev server).",
        );
      }

      const suspicious = findJsonFiles(publicDir).filter((file) => {
        try {
          const data = JSON.parse(fs.readFileSync(file, "utf8"));
          return Boolean(data && (data.secret || data.proof || data.proofs));
        } catch {
          return false;
        }
      });
      if (suspicious.length > 0) {
        this.error(
          `Claim credentials found in public/: ${suspicious.join(", ")}. ` +
            "Move them outside public/ before building.",
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), demoProofServer(), forbidPublishedProofs()],
});
