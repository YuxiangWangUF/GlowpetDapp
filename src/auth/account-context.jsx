import { createContext, useContext, useMemo } from "react";

const guestAccount = Object.freeze({
  status: "guest",
  mode: "guest",
  accountId: null,
  address: "",
  chainId: null,
  email: "",
  authAvailable: false,
  authError: "",
  walletReady: false,
  capabilities: Object.freeze({}),
  server: null,
  error: "",
  errorCode: "",
  login: async () => {},
  logout: async () => {},
  getAccessToken: async () => null,
  refreshMe: async () => null,
  exportWallet: null,
  createWallet: null,
  linkPasskey: null,
});

export const AccountContext = createContext(guestAccount);

export function useAccount() {
  return useContext(AccountContext);
}

export function GuestAccountProvider({ children, authAvailable = false, authError = "" }) {
  const value = useMemo(() => ({
    ...guestAccount,
    authAvailable,
    authError,
  }), [authAvailable, authError]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export { guestAccount };
