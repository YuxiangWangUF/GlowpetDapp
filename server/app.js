import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createAuthVerifier } from "./auth/verifier.js";
import { AppError, publicError } from "./lib/errors.js";
import { meRoutes } from "./routes/me.js";
import { claimsRoutes } from "./routes/claims.js";
import { gardensRoutes } from "./routes/gardens.js";

const API_PREFIX = "/api/v1";

/**
 * Build the HTTP surface. Dependencies are injected so tests can use an
 * isolated database, fake chain and deterministic clock.
 */
export async function buildApp({
  config,
  db = null,
  chain = null,
  verifier = null,
  claimService = null,
  gardenService = null,
  clock = Date.now,
  enableRateLimit = true,
  logger = true,
}) {
  const app = Fastify({
    logger,
    ...(logger ? { logController: new LogController({ disableRequestLogging: true }) } : {}),
    trustProxy: config.trustProxy,
    bodyLimit: 32 * 1024,
    requestTimeout: 15_000,
  });

  await app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    maxAge: 600,
  });

  if (enableRateLimit) {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
    });
  }

  const authVerifier = verifier ?? createAuthVerifier(config);
  app.decorateRequest("identity", null);
  app.decorate("authenticate", async function authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new AppError("AUTH_REQUIRED", "Sign in is required.", 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new AppError("AUTH_REQUIRED", "Sign in is required.", 401);
    request.identity = await authVerifier.verify(token);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.routeOptions?.url?.startsWith(API_PREFIX) || request.url.startsWith(API_PREFIX)) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error?.validation) {
      reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "The request fields are not valid.",
      });
      return;
    }
    const { status, body } = publicError(error);
    if (status >= 500) {
      request.log.error({ requestId: request.id, code: body.code }, "request_failed");
    } else {
      request.log.warn({ requestId: request.id, code: body.code }, "request_rejected");
    }
    reply.code(status).send(body);
  });

  app.get("/health", async () => ({
    ok: true,
    database: Boolean(db),
    chain: Boolean(chain),
    auth: config.authMode === "mock" ? "mock" : config.authConfigured ? "privy" : "unconfigured",
    sponsoredClaim: !config.sponsorPaused && Boolean(chain),
    cloudGarden: Boolean(chain && db),
    serverTime: new Date(clock()).toISOString(),
  }));

  if (!db) {
    app.all(`${API_PREFIX}/*`, async (_request, reply) => reply.code(503).send({
      code: "SERVICE_NOT_CONFIGURED",
      message: "The account database is not configured on this server.",
    }));
    return app;
  }

  await app.register(meRoutes, { prefix: API_PREFIX, db, config });
  await app.register(claimsRoutes, { prefix: API_PREFIX, claimService, config });
  await app.register(gardensRoutes, { prefix: API_PREFIX, gardenService });

  return app;
}
