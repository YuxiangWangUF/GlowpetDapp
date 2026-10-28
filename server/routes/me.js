import { syncAccount } from "../services/accounts.js";

export async function meRoutes(app, { db, config }) {
  app.get("/me", {
    preHandler: app.authenticate,
    schema: {
      response: {
        200: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  }, async (request) => {
    const { account, wallet } = await syncAccount(db, request.identity, {
      chainId: config.chainId,
      bindingVersion: config.walletBindingVersion,
    });
    return {
      accountId: account.accountId,
      email: account.email,
      wallet: {
        address: wallet.address,
        providerWalletId: wallet.providerWalletId,
        kind: wallet.kind,
      },
      chain: {
        chainId: String(config.chainId),
        contractAddress: config.contractAddress,
        allowedSeriesIds: [...config.allowedSeriesIds],
      },
      capabilities: {
        sponsoredClaim: !config.sponsorPaused && config.chainConfigured,
        cloudGarden: config.chainConfigured && Boolean(config.rpcUrl),
      },
      serverTime: new Date().toISOString(),
    };
  });
}
