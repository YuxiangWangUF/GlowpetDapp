import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PrivyProvider,
  useCreateWallet,
  useExportWallet,
  useLinkWithPasskey,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import { AccountContext } from "./account-context.jsx";
import { API_BASE_URL, PRIVY_APP_ID } from "./config.js";
import { createApiClient } from "../api/client.js";

const WALLET_RETRY_DELAY_MS = 1500;
const WALLET_RETRY_ATTEMPTS = 8;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function embeddedWallet(wallets) {
  return wallets.find((wallet) =>
    wallet?.walletClientType === "privy"
    || wallet?.walletClientType === "privy-v2"
    || wallet?.connectorType === "embedded",
  ) ?? null;
}

function PrivyAccountBridge({ children }) {
  const {
    ready, authenticated, user, login, logout, getAccessToken, error: privyError,
  } = usePrivy();
  const { wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const { createWallet } = useCreateWallet();
  const { linkWithPasskey } = useLinkWithPasskey();

  const [me, setMe] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [loading, setLoading] = useState(false);
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  const embedded = embeddedWallet(wallets);
  const embeddedAddress = embedded?.address ?? "";

  const client = useMemo(() => createApiClient({
    baseUrl: API_BASE_URL,
    getAccessToken: () => tokenRef.current(),
  }), []);

  const loadMe = useCallback(async ({ retries = 0 } = {}) => {
    if (!authenticated) {
      setMe(null);
      setServerError(null);
      return null;
    }
    setLoading(true);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const data = await client.getMe();
        setMe(data);
        setServerError(null);
        setLoading(false);
        return data;
      } catch (requestError) {
        if (requestError.code === "WALLET_NOT_READY" && attempt < retries) {
          await delay(WALLET_RETRY_DELAY_MS);
          continue;
        }
        setMe(null);
        setServerError(requestError);
        setLoading(false);
        return null;
      }
    }
    setLoading(false);
    return null;
  }, [authenticated, client]);

  useEffect(() => {
    if (!ready) return undefined;
    if (!authenticated) {
      setMe(null);
      setServerError(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    (async () => {
      for (let attempt = 0; attempt <= WALLET_RETRY_ATTEMPTS; attempt += 1) {
        try {
          const data = await client.getMe();
          if (cancelled) return;
          setMe(data);
          setServerError(null);
          setLoading(false);
          return;
        } catch (requestError) {
          if (cancelled) return;
          if (requestError.code === "WALLET_NOT_READY" && attempt < WALLET_RETRY_ATTEMPTS) {
            await delay(WALLET_RETRY_DELAY_MS);
            continue;
          }
          setMe(null);
          setServerError(requestError);
          setLoading(false);
          return;
        }
      }
    })();

    return () => { cancelled = true; };
  }, [ready, authenticated, client, user?.id, embeddedAddress]);

  const loginWithEmail = useCallback(() => {
    login({ loginMethods: ["email"] });
  }, [login]);

  const logoutAccount = useCallback(async () => {
    await logoutRef.current();
    setMe(null);
    setServerError(null);
  }, []);

  const exportEmbeddedWallet = useCallback(async () => {
    if (!embeddedAddress) throw new Error("Your embedded wallet is not ready yet.");
    await exportWallet({ address: embeddedAddress });
  }, [exportWallet, embeddedAddress]);

  const createEmbeddedWallet = useCallback(async () => {
    await createWallet();
    await loadMe({ retries: WALLET_RETRY_ATTEMPTS });
  }, [createWallet, loadMe]);

  const linkPasskey = useCallback(async () => {
    await linkWithPasskey({ name: "Glowpet" });
  }, [linkWithPasskey]);

  const value = useMemo(() => {
    const authenticatedState = authenticated;
    const status = !ready
      ? "loading"
      : authenticatedState
        ? me
          ? "authenticated"
          : loading
            ? "loading"
            : "error"
        : "guest";

    return {
      status,
      mode: authenticatedState ? "embedded" : "guest",
      accountId: me?.accountId ?? user?.id ?? null,
      address: me?.wallet?.address ?? "",
      chainId: me?.chain?.chainId ? Number(me.chain.chainId) : null,
      email: user?.email?.address ?? me?.email ?? "",
      authAvailable: true,
      authError: "",
      walletReady: Boolean(me?.wallet?.address),
      capabilities: me?.capabilities ?? {},
      server: me,
      error: serverError?.message ?? privyError?.message ?? "",
      errorCode: serverError?.code ?? (privyError ? "AUTH_SDK_ERROR" : ""),
      login: loginWithEmail,
      logout: logoutAccount,
      getAccessToken,
      refreshMe: () => loadMe({ retries: WALLET_RETRY_ATTEMPTS }),
      exportWallet: exportEmbeddedWallet,
      createWallet: createEmbeddedWallet,
      linkPasskey,
    };
  }, [
    ready, authenticated, me, loading, user?.id, user?.email?.address,
    serverError, privyError, loginWithEmail, logoutAccount, getAccessToken,
    loadMe, exportEmbeddedWallet, createEmbeddedWallet, linkPasskey,
  ]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export default function PrivyAccountProvider({ children }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email"],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        appearance: {
          theme: "dark",
          accentColor: "#c4b5fd",
          landingHeader: "One charm, one pet.",
          loginMessage: "Use a one-time email code. We never ask for a wallet seed phrase.",
        },
      }}
    >
      <PrivyAccountBridge>{children}</PrivyAccountBridge>
    </PrivyProvider>
  );
}
