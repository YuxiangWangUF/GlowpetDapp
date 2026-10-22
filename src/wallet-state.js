/** Observe the injected wallet without letting a stale startup read undo events. */
export function observeWallet(ethereum, setWallet) {
  let disposed = false;
  let accountRevision = 0;
  let chainRevision = 0;

  const onAccountsChanged = (accounts) => {
    accountRevision += 1;
    if (!disposed) setWallet((previous) => ({ ...previous, address: accounts?.[0] ?? "" }));
  };
  const onChainChanged = (chainIdHex) => {
    chainRevision += 1;
    if (!disposed) setWallet((previous) => ({ ...previous, chainId: Number(chainIdHex) }));
  };
  ethereum.on?.("accountsChanged", onAccountsChanged);
  ethereum.on?.("chainChanged", onChainChanged);

  const initialAccountRevision = accountRevision;
  const initialChainRevision = chainRevision;
  (async () => {
    try {
      const accounts = await ethereum.request({ method: "eth_accounts" });
      if (disposed) return;
      const chainIdHex = await ethereum.request({ method: "eth_chainId" });
      if (disposed) return;
      setWallet((previous) => disposed ? previous : {
        address: accountRevision === initialAccountRevision ? accounts?.[0] ?? "" : previous.address,
        chainId: chainRevision === initialChainRevision ? Number(chainIdHex) : previous.chainId,
      });
    } catch {
      // A locked or unavailable wallet does not block read-only use.
    }
  })();

  return () => {
    disposed = true;
    ethereum.removeListener?.("accountsChanged", onAccountsChanged);
    ethereum.removeListener?.("chainChanged", onChainChanged);
  };
}
