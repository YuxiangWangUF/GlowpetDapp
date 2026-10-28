import { Component, Suspense, lazy } from "react";
import { GuestAccountProvider } from "./account-context.jsx";
import MockAccountProvider from "./MockAccountProvider.jsx";
import { AUTH, AUTH_MODE } from "./config.js";

const PrivyAccountProvider = lazy(() => import("./PrivyAccountProvider.jsx"));

class AuthLoadBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <GuestAccountProvider authAvailable={false} authError="Secure sign-in failed to load. Reload the page or use an existing wallet.">
          {this.props.children}
        </GuestAccountProvider>
      );
    }
    return this.props.children;
  }
}

/**
 * Chooses the identity provider once, before account-aware UI mounts. Privy is
 * code-split so a guest-only build does not download the sign-in SDK.
 */
export default function AuthRoot({ children }) {
  if (AUTH_MODE === "mock") {
    return <MockAccountProvider>{children}</MockAccountProvider>;
  }

  if (AUTH_MODE === "privy" && AUTH.available) {
    return (
      <AuthLoadBoundary>
        <Suspense
          fallback={(
            <GuestAccountProvider authAvailable={false} authError="Loading secure sign-in…">
              {children}
            </GuestAccountProvider>
          )}
        >
          <PrivyAccountProvider>{children}</PrivyAccountProvider>
        </Suspense>
      </AuthLoadBoundary>
    );
  }

  return (
    <GuestAccountProvider authAvailable={AUTH.available} authError={AUTH.error}>
      {children}
    </GuestAccountProvider>
  );
}
