const env = import.meta.env ?? {};

export const AUTH_MODE = String(env.VITE_AUTH_MODE ?? "off").trim().toLowerCase();
export const PRIVY_APP_ID = String(env.VITE_PRIVY_APP_ID ?? "").trim();
export const API_BASE_URL = String(env.VITE_API_BASE_URL ?? "/api/v1").replace(/\/+$/, "");

const KNOWN_MODES = new Set(["off", "privy", "mock"]);

export function authAvailability() {
  if (!KNOWN_MODES.has(AUTH_MODE)) {
    return {
      available: false,
      error: `Unknown VITE_AUTH_MODE "${AUTH_MODE}". Use privy, mock (development only) or off.`,
    };
  }
  if (AUTH_MODE === "mock") {
    return env.DEV
      ? { available: true, error: "" }
      : { available: false, error: "The mock identity provider is disabled in production builds." };
  }
  if (AUTH_MODE === "privy" && !PRIVY_APP_ID) {
    return {
      available: false,
      error: "Email sign-in is not configured yet. Set VITE_PRIVY_APP_ID and restart the app.",
    };
  }
  return { available: AUTH_MODE === "privy", error: "" };
}

export const AUTH = authAvailability();
