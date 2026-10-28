import { AppError } from "../lib/errors.js";

const addressPattern = "^0x[0-9a-fA-F]{40}$";
const bytes32Pattern = "^0x[0-9a-fA-F]{64}$";

const claimBody = {
  type: "object",
  additionalProperties: false,
  required: ["seriesId", "serial", "credentialSigner", "proof", "recipient", "deadline", "signature"],
  properties: {
    seriesId: { type: "string", pattern: "^[0-9]+$", maxLength: 78 },
    serial: { type: "integer", minimum: 1, maximum: 4_294_967_295 },
    credentialSigner: { type: "string", pattern: addressPattern },
    proof: {
      type: "array",
      maxItems: 64,
      items: { type: "string", pattern: bytes32Pattern },
    },
    recipient: { type: "string", pattern: addressPattern },
    deadline: { type: "string", pattern: "^[0-9]+$", maxLength: 78 },
    signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$", maxLength: 200 },
  },
};

const idempotencyHeaders = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": { type: "string", minLength: 8, maxLength: 128 },
  },
};

const jobParams = {
  type: "object",
  required: ["jobId"],
  properties: {
    jobId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
  },
};

export async function claimsRoutes(app, { claimService, config }) {
  function service() {
    if (!claimService) {
      throw new AppError(
        "SERVICE_NOT_CONFIGURED",
        "Sponsored claims are not configured on this server.",
        503,
      );
    }
    return claimService;
  }

  app.post("/claims", {
    preHandler: app.authenticate,
    schema: {
      headers: idempotencyHeaders,
      body: claimBody,
    },
  }, async (request, reply) => {
    const job = await service().submit(
      request.identity,
      request.body,
      request.headers["idempotency-key"],
    );
    return reply.code(202).send(job);
  });

  app.get("/claims/:jobId", {
    preHandler: app.authenticate,
    schema: { params: jobParams },
  }, async (request) => service().get(request.identity, request.params.jobId));

  app.get("/claims", {
    preHandler: app.authenticate,
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["active", "terminal", "all"], default: "active" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
  }, async (request) => service().list(request.identity, request.query));

  app.post("/claims/:jobId/authorization", {
    preHandler: app.authenticate,
    schema: {
      headers: idempotencyHeaders,
      params: jobParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["deadline", "signature"],
        properties: {
          deadline: { type: "string", pattern: "^[0-9]+$", maxLength: 78 },
          signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$", maxLength: 200 },
        },
      },
    },
  }, async (request) => service().updateAuthorization(
    request.identity,
    request.params.jobId,
    request.body,
    request.headers["idempotency-key"],
  ));

  // Keep the config in the closure for consistent diagnostics without exposing
  // secrets or the relayer address in a response.
  void config;
}
