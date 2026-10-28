import { parseClaimCode } from "./contract.js";
import { scrubClaimParameters } from "./claim-authorization.js";

let captured = null;

const CLAIM_FRAGMENT_PREFIX = "#claim=";

function sameValue(field, left, right) {
  if (left === undefined || right === undefined) return true;
  if (field === "proof") {
    return left.length === right.length && left.every((node, index) => node === right[index]);
  }
  if (field === "seriesId") {
    try {
      return BigInt(left) === BigInt(right);
    } catch {
      return false;
    }
  }
  return left === right;
}

function mergeSources(fragment, legacy) {
  const merged = { ...legacy, ...fragment };
  for (const field of ["seriesId", "serial", "secret", "proof"]) {
    if (!sameValue(field, fragment[field], legacy[field])) {
      throw new Error(
        "This link contains conflicting claim data. Ask for a fresh charm code instead of combining two links.",
      );
    }
  }
  if (fragment.source) merged.source = "claim link (fragment)";
  else if (legacy.source) merged.source = "claim link";
  return merged;
}

/**
 * Capture a charm credential before any third-party SDK loads.
 *
 * The credential lives only in this module's memory. The address bar is
 * cleaned immediately so the secret is not kept in browser history,
 * screenshots, Referer headers or the next page load.
 */
export function captureClaimBootstrap(win = globalThis.window) {
  if (captured) return captured;

  const location = win.location;
  const search = location.search ?? "";
  const hash = location.hash ?? "";
  let fragment = {};
  let fragmentError = "";
  let legacy = {};
  let legacyError = "";

  if (hash.startsWith(CLAIM_FRAGMENT_PREFIX)) {
    try {
      fragment = parseClaimCode(hash.slice(CLAIM_FRAGMENT_PREFIX.length));
      if (fragment.serial === undefined || !fragment.secret) {
        fragmentError = "This claim link is incomplete. Scan the charm again.";
      }
    } catch (error) {
      fragmentError = error.message;
    }
  }

  if (search) {
    try {
      legacy = parseClaimCode(search);
    } catch (error) {
      legacyError = error.message;
    }
  }

  let merged = {};
  let conflictError = "";
  if (!fragmentError) {
    try {
      merged = mergeSources(fragment, legacy);
    } catch (error) {
      conflictError = error.message;
    }
  }

  const publicParams = scrubClaimParameters(search);
  const publicSearch = publicParams.toString();
  win.history.replaceState({}, "", `${location.pathname}${publicSearch ? `?${publicSearch}` : ""}`);

  captured = {
    ...merged,
    error: fragmentError || conflictError || legacyError || merged.error || "",
  };
  return captured;
}

export function getBootstrapClaim() {
  return captured ?? {};
}

/** Test hook. The running app captures once before the SDK is imported. */
export function resetClaimBootstrap() {
  captured = null;
}
