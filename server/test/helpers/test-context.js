import { Wallet } from "ethers";
import { loadConfig } from "../../config.js";
import { createDatabase } from "../../db/index.js";
import { migrate } from "../../db/migrate.js";
import { createAuthVerifier } from "../../auth/verifier.js";
import { buildApp } from "../../app.js";
import { createClaimService } from "../../services/claims.js";
import { createGardenService } from "../../services/gardens.js";
import { ClaimWorker } from "../../services/claim-worker.js";
import { createFakeChain } from "./fake-chain.js";
import { claimLeaf, claimDomain, CLAIM_TYPES, claimMessage } from "../../../shared/claim-protocol.js";

export const TEST_RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const TEST_CONTRACT = "0x0000000000000000000000000000000000001234";
export const TEST_CHAIN_ID = 11155111;

export async function createTestContext({ configOverrides = {}, serial = 7, open = true } = {}) {
  const credential = Wallet.createRandom();
  const root = claimLeaf({
    chainId: TEST_CHAIN_ID,
    seriesId: 1,
    serial,
    credentialSigner: credential.address,
  });
  const chain = createFakeChain({
    chainId: TEST_CHAIN_ID,
    contractAddress: TEST_CONTRACT,
    root,
    open,
  });

  let now = Date.now();
  const clock = () => now;
  const db = await createDatabase({ databaseUrl: "pglite:memory" });
  await migrate(db);

  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "mock",
    DATABASE_URL: "pglite:memory",
    CHAIN_ID: String(TEST_CHAIN_ID),
    RPC_URL: "http://127.0.0.1:8545",
    GLOWPET_ADDRESS: TEST_CONTRACT,
    ALLOWED_SERIES_IDS: "1",
    RELAYER_ENABLED: "true",
    RELAYER_PRIVATE_KEY: TEST_RELAYER_KEY,
    RELAYER_MAX_GAS_PER_TX: "300000",
    RELAYER_MAX_FEE_PER_GAS_WEI: "5000000000",
    RELAYER_DAILY_BUDGET_WEI: "1000000000000000000",
    CLAIM_CONFIRMATIONS: "2",
    CLAIM_AUTH_MAX_TTL_SECONDS: "600",
    ALLOWED_ORIGINS: "",
    ...configOverrides,
  });

  const verifier = createAuthVerifier(config);
  const claimService = createClaimService({ db, chain, config, clock });
  const gardenService = createGardenService({ db, chain, config, clock });
  const signer = new Wallet(TEST_RELAYER_KEY);
  const worker = new ClaimWorker({
    db,
    chain,
    config,
    signer,
    clock,
    logger: { info() {}, warn() {}, error() {} },
  });
  const app = await buildApp({
    config,
    db,
    chain,
    verifier,
    claimService,
    gardenService,
    clock,
    enableRateLimit: false,
    logger: false,
  });

  const identities = new Map();
  async function identityFor(email = "alice@example.com") {
    if (!identities.has(email)) {
      identities.set(email, await verifier.verify(`mock:${email}`));
    }
    return identities.get(email);
  }

  function authHeaders(identity, extra = {}) {
    return {
      authorization: `Bearer mock:${identity.subject}`,
      ...extra,
    };
  }

  async function me(email = "alice@example.com") {
    const identity = await identityFor(email);
    const response = await app.inject({ method: "GET", url: "/api/v1/me", headers: authHeaders(identity) });
    return { identity, response, body: response.json() };
  }

  async function makeClaimBody({
    email = "alice@example.com",
    recipient,
    serialNumber = serial,
    seriesId = 1n,
    deadline,
    proof = [],
    credentialSigner = credential.address,
    signatureOverride,
    chainId = TEST_CHAIN_ID,
    contractAddress = TEST_CONTRACT,
  } = {}) {
    const { body: meBody } = await me(email);
    const to = recipient ?? meBody.wallet.address;
    const expires = deadline ?? BigInt(Math.floor(clock() / 1000) + 600);
    const message = claimMessage({
      seriesId, serial: serialNumber, recipient: to, deadline: expires,
    });
    const domain = claimDomain({ chainId, verifyingContract: contractAddress });
    const signature = signatureOverride
      ?? await credential.signTypedData(domain, CLAIM_TYPES, message);
    return {
      body: {
        seriesId: String(seriesId),
        serial: serialNumber,
        credentialSigner,
        proof,
        recipient: to,
        deadline: String(expires),
        signature,
      },
      credential,
      recipient: to,
      deadline: expires,
    };
  }

  return {
    app,
    db,
    chain,
    config,
    signer,
    worker,
    claimService,
    gardenService,
    verifier,
    identityFor,
    authHeaders,
    me,
    makeClaimBody,
    credential,
    now: () => now,
    advance(ms) { now += ms; },
    async close() {
      await app.close();
      await db.close();
    },
  };
}
