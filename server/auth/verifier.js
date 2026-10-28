import { PrivyClient } from "@privy-io/node";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { AppError } from "../lib/errors.js";

const MOCK_SUBJECT = /^[A-Za-z0-9._%+@-]{1,160}$/;

function mockAddress(subject) {
  const hash = keccak256(toUtf8Bytes(`glowpet-mock-wallet:${subject}`));
  return getAddress(`0x${hash.slice(-40)}`);
}

function mockVerifier() {
  return {
    kind: "mock",
    async verify(token) {
      if (typeof token !== "string" || !token.startsWith("mock:")) {
        throw new AppError("AUTH_REQUIRED", "Sign in is required.", 401);
      }
      const subject = token.slice("mock:".length).trim().toLowerCase();
      if (!MOCK_SUBJECT.test(subject)) {
        throw new AppError("AUTH_REQUIRED", "The local test identity is invalid.", 401);
      }
      return {
        issuer: "mock",
        subject,
        email: subject.includes("@") ? subject : "",
        address: mockAddress(subject),
        walletId: `mock:${subject}`,
        kind: "embedded_eoa",
      };
    },
  };
}

function privyVerifier(config) {
  if (!config.authConfigured) {
    return {
      kind: "privy",
      async verify() {
        throw new AppError(
          "AUTH_NOT_CONFIGURED",
          "Email sign-in is not configured on the server. Add the Privy app ID and secret.",
          503,
        );
      },
    };
  }

  const privy = new PrivyClient({
    appId: config.privyAppId,
    appSecret: config.privyAppSecret,
    ...(config.privyVerificationKey ? { jwtVerificationKey: config.privyVerificationKey } : {}),
  });

  return {
    kind: "privy",
    async verify(token) {
      if (typeof token !== "string" || token.length < 20) {
        throw new AppError("AUTH_REQUIRED", "Sign in is required.", 401);
      }

      let claims;
      try {
        claims = await privy.utils().auth().verifyAccessToken(token);
      } catch {
        throw new AppError("AUTH_REQUIRED", "Your sign-in expired. Sign in again.", 401);
      }
      if (claims.app_id !== config.privyAppId) {
        throw new AppError("AUTH_REQUIRED", "This sign-in token was issued for another app.", 401);
      }

      let user;
      try {
        user = await privy.users()._get(claims.user_id);
      } catch {
        throw new AppError("AUTH_REQUIRED", "The account could not be loaded. Sign in again.", 401);
      }

      const linked = Array.isArray(user.linked_accounts) ? user.linked_accounts : [];
      const wallets = linked
        .filter((account) =>
          account.type === "wallet"
          && account.chain_type === "ethereum"
          && account.connector_type === "embedded"
          && typeof account.address === "string",
        )
        .sort((left, right) => (left.wallet_index ?? 0) - (right.wallet_index ?? 0));

      const wallet = wallets[0];
      if (!wallet) {
        throw new AppError(
          "WALLET_NOT_READY",
          "Your Glowpet wallet is still being created. Try again in a moment.",
          409,
        );
      }

      const emailAccount = linked.find((account) => account.type === "email");

      return {
        issuer: claims.issuer,
        subject: claims.user_id,
        email: emailAccount?.address ?? "",
        address: getAddress(wallet.address),
        walletId: wallet.id ?? `ethereum:${wallet.wallet_index ?? 0}`,
        kind: "embedded_eoa",
      };
    },
  };
}

export function createAuthVerifier(config) {
  return config.authMode === "mock" ? mockVerifier() : privyVerifier(config);
}
