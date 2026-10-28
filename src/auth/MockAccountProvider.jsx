import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountContext } from "./account-context.jsx";
import { API_BASE_URL } from "./config.js";
import { createApiClient } from "../api/client.js";

const MOCK_IDENTITY_KEY = "glowpet:mock-identity:v1";

function readIdentity() {
  try {
    return localStorage.getItem(MOCK_IDENTITY_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeIdentity(value) {
  try {
    if (value) localStorage.setItem(MOCK_IDENTITY_KEY, value);
    else localStorage.removeItem(MOCK_IDENTITY_KEY);
  } catch {
    // The in-memory session still works for this tab.
  }
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    throw new Error("Enter an email address for the local test account.");
  }
  return email;
}

/**
 * Development-only identity provider. The token format is understood only by
 * the equally explicit server AUTH_MODE=mock; production startup rejects it.
 */
export default function MockAccountProvider({ children }) {
  const [identity, setIdentity] = useState(readIdentity);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(Boolean(identity));
  const [error, setError] = useState(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const client = useMemo(() => createApiClient({
    baseUrl: API_BASE_URL,
    getAccessToken: async () => (identityRef.current ? `mock:${identityRef.current}` : null),
  }), []);

  const loadMe = useCallback(async () => {
    if (!identityRef.current) {
      setMe(null);
      setError(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const data = await client.getMe();
      setMe(data);
      setError(null);
      return data;
    } catch (requestError) {
      setMe(null);
      setError(requestError);
      return null;
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    if (!identity) {
      setMe(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    client.getMe()
      .then((data) => {
        if (!cancelled) {
          setMe(data);
          setError(null);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setMe(null);
          setError(requestError);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [identity, client]);

  const login = useCallback(async (options = {}) => {
    const email = normalizeEmail(options.email ?? options);
    writeIdentity(email);
    setIdentity(email);
  }, []);

  const logout = useCallback(async () => {
    writeIdentity("");
    setIdentity("");
    setMe(null);
    setError(null);
  }, []);

  const value = useMemo(() => {
    const authenticated = Boolean(identity);
    return {
      status: authenticated ? (me ? "authenticated" : loading ? "loading" : "error") : "guest",
      mode: authenticated ? "embedded" : "guest",
      accountId: me?.accountId ?? null,
      address: me?.wallet?.address ?? "",
      chainId: me?.chain?.chainId ? Number(me.chain.chainId) : null,
      email: me?.email ?? identity,
      authAvailable: true,
      authError: "",
      walletReady: Boolean(me?.wallet?.address),
      capabilities: me?.capabilities ?? {},
      server: me,
      error: error?.message ?? "",
      errorCode: error?.code ?? "",
      login,
      logout,
      getAccessToken: async () => (identity ? `mock:${identity}` : null),
      refreshMe: loadMe,
      exportWallet: null,
      createWallet: null,
      linkPasskey: null,
    };
  }, [identity, me, loading, error, login, logout, loadMe]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
