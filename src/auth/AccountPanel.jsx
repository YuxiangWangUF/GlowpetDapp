import { useEffect, useState } from "react";
import { AUTH_MODE } from "./config.js";

function shortAddress(value) {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "";
}

function Modal({ open, onClose, labelledBy, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">×</button>
        {children}
      </section>
    </div>
  );
}

export function AccountMenu({ account, onSignIn, onOpenAccount }) {
  if (account.status === "loading") {
    return <span className="account-chip is-loading">Preparing account…</span>;
  }
  if (account.mode === "embedded" || account.status === "error") {
    return (
      <button type="button" className="account-chip" onClick={onOpenAccount}>
        <span className="account-dot" aria-hidden="true" />
        {account.email || shortAddress(account.address) || "Account"}
      </button>
    );
  }
  if (account.authAvailable) {
    return (
      <button type="button" className="primary small" onClick={onSignIn}>
        Sign in
      </button>
    );
  }
  return null;
}

export function SignInDialog({ account, open, onClose, onUseExistingWallet }) {
  const [email, setEmail] = useState("");
  const [localError, setLocalError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) {
      setLocalError("");
      setPending(false);
    }
  }, [open]);

  async function submit(event) {
    event.preventDefault();
    setLocalError("");
    setPending(true);
    try {
      await account.login({ email });
      onClose();
    } catch (error) {
      setLocalError(error.message || "We could not start sign-in.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="signin-title">
      <p className="eyebrow">YOUR GLOWPET ACCOUNT</p>
      <h2 id="signin-title">Sign in with email</h2>
      <p className="dialog-copy">
        A one-time code creates a free wallet for you. You do not need MetaMask,
        Sepolia ETH or a seed phrase, and the platform pays the claim gas.
      </p>

      {!account.authAvailable ? (
        <>
          <div className="status error">{account.authError || "Email sign-in is not configured."}</div>
          <button type="button" className="ghost" onClick={() => { onClose(); onUseExistingWallet?.(); }}>
            Use an existing wallet
          </button>
        </>
      ) : AUTH_MODE === "mock" ? (
        <form onSubmit={submit} className="dialog-form">
          <label htmlFor="mock-email">Test email</label>
          <input
            id="mock-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <p className="hint">
            Local mock mode. The same email always restores the same test wallet
            on this development server.
          </p>
          <button type="submit" className="primary" disabled={pending}>
            {pending ? "Signing in…" : "Continue with email"}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="primary"
          onClick={() => { onClose(); account.login(); }}
        >
          Continue with email
        </button>
      )}

      {localError && <div className="status error">{localError}</div>}
      {account.error && !localError && <div className="status error">{account.error}</div>}

      {account.authAvailable && (
        <button type="button" className="account-secondary" onClick={() => { onClose(); onUseExistingWallet?.(); }}>
          I already have a wallet
        </button>
      )}
      <p className="dialog-footnote">
        Email is used for sign-in only. It is not stored in the claim transaction,
        and Glowpet never sees your wallet private key.
      </p>
    </Modal>
  );
}

export function AccountDialog({ account, open, onClose, onUseExistingWallet }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (!open) {
      setMessage("");
      setError("");
      setBusy("");
    }
  }, [open]);

  async function run(label, action) {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(`${label} opened.`);
    } catch (actionError) {
      setError(actionError.message || `${label} could not be opened.`);
    } finally {
      setBusy("");
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="account-title">
      <p className="eyebrow">ACCOUNT</p>
      <h2 id="account-title">Your Glowpet wallet</h2>

      <dl className="account-details">
        <div>
          <dt>Email</dt>
          <dd>{account.email || "—"}</dd>
        </div>
        <div>
          <dt>Wallet</dt>
          <dd className="mono">
            {account.address ? shortAddress(account.address) : "Preparing your wallet…"}
          </dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>
            {account.server?.chain?.chainId
              ? `Chain ${account.server.chain.chainId}`
              : account.chainId ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Cloud garden</dt>
          <dd>{account.capabilities?.cloudGarden ? "Enabled" : "Not available"}</dd>
        </div>
        <div>
          <dt>Sponsored claim</dt>
          <dd>{account.capabilities?.sponsoredClaim ? "Enabled" : "Not available"}</dd>
        </div>
      </dl>

      {account.address && (
        <p className="account-address mono" title={account.address}>{account.address}</p>
      )}

      {account.status === "error" && (
        <div className="status error">
          {account.error || "The account service is unavailable."}
          {account.errorCode === "WALLET_NOT_READY" && " Your wallet is still being prepared."}
        </div>
      )}

      {!account.walletReady && account.authAvailable && account.accountId && (
        <div className="account-wallet-wait">
          <p>Your wallet is being created. This usually takes a few seconds.</p>
          {account.createWallet && (
            <button
              type="button"
              className="ghost small"
              disabled={Boolean(busy)}
              onClick={() => run("Wallet creation", account.createWallet)}
            >
              {busy === "Wallet creation" ? "Creating…" : "Create wallet now"}
            </button>
          )}
        </div>
      )}

      <div className="account-actions">
        <button
          type="button"
          className="ghost small"
          disabled={Boolean(busy) || !account.refreshMe}
          onClick={() => run("Account refresh", account.refreshMe)}
        >
          Refresh account
        </button>
        {account.exportWallet && account.walletReady && (
          <button
            type="button"
            className="ghost small"
            disabled={Boolean(busy)}
            onClick={() => run("Wallet export", account.exportWallet)}
          >
            Export wallet
          </button>
        )}
        {account.linkPasskey && account.walletReady && (
          <button
            type="button"
            className="ghost small"
            disabled={Boolean(busy)}
            onClick={() => run("Passkey setup", account.linkPasskey)}
          >
            Add a passkey
          </button>
        )}
      </div>

      {message && <div className="status success">{message}</div>}
      {error && <div className="status error">{error}</div>}

      <div className="account-warning">
        <strong>Keep a backup sign-in method.</strong>
        <p>
          Your wallet is protected by your login. Add a passkey before changing
          devices or losing access to this email. Export only through the
          provider&apos;s protected panel; Glowpet never receives the private key.
        </p>
      </div>

      <div className="account-footer">
        <button type="button" className="ghost small" onClick={() => { onClose(); onUseExistingWallet?.(); }}>
          Use an existing wallet instead
        </button>
        <button type="button" className="danger-link" onClick={async () => { await account.logout(); onClose(); }}>
          Sign out
        </button>
      </div>
    </Modal>
  );
}
