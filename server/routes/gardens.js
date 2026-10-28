import { AppError } from "../lib/errors.js";
import { CROPS } from "../../shared/garden-state.js";

const cropIds = CROPS.map((crop) => crop.id);
const tokenParams = {
  type: "object",
  required: ["tokenId"],
  properties: {
    tokenId: { type: "string", pattern: "^[0-9]+$", maxLength: 78 },
  },
};

export async function gardensRoutes(app, { gardenService }) {
  function service() {
    if (!gardenService) {
      throw new AppError(
        "SERVICE_NOT_CONFIGURED",
        "Cloud gardens are not configured on this server.",
        503,
      );
    }
    return gardenService;
  }

  app.get("/gardens/:tokenId", {
    preHandler: app.authenticate,
    schema: { params: tokenParams },
  }, async (request) => service().get(request.identity, request.params.tokenId));

  app.post("/gardens/:tokenId/actions", {
    preHandler: app.authenticate,
    schema: {
      params: tokenParams,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["actionId", "expectedRevision", "action"],
        properties: {
          actionId: {
            type: "string",
            pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
          },
          expectedRevision: { type: "string", pattern: "^[0-9]+$", maxLength: 78 },
          action: {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: { type: "string", enum: ["buy", "plant", "harvest", "feed", "play"] },
              cropId: { type: "string", enum: cropIds },
              plotIndex: { type: "integer", minimum: 0, maximum: 2 },
            },
          },
        },
      },
    },
  }, async (request) => service().action(request.identity, request.params.tokenId, request.body));
}
