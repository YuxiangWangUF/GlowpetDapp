const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

export class ApiError extends Error {
  constructor(message, { code = "REQUEST_FAILED", status = 0, details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Small fetch wrapper for the account-bound API. Every private request uses the
 * identity provider's short-lived access token; no address is trusted from the
 * client for account or recipient binding.
 */
export function createApiClient({ baseUrl, getAccessToken }) {
  const root = String(baseUrl ?? "/api/v1").replace(/\/+$/, "");

  async function request(path, { method = "GET", body, idempotencyKey, signal } = {}) {
    const token = await getAccessToken?.();
    if (!token) {
      throw new ApiError("Please sign in again.", { code: "AUTH_REQUIRED", status: 401 });
    }

    const headers = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let response;
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError(
        "The Glowpet service could not be reached. Check your connection and try again.",
        { code: "NETWORK_ERROR" },
      );
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(data.message || "The request could not be completed.", {
        code: data.code || `HTTP_${response.status}`,
        status: response.status,
        details: data,
      });
    }
    return data;
  }

  return {
    getMe: (options) => request("/me", options),
    submitClaim: (body, idempotencyKey, options = {}) =>
      request("/claims", { ...options, method: "POST", body, idempotencyKey }),
    getClaim: (jobId, options = {}) => request(`/claims/${encodeURIComponent(jobId)}`, options),
    listClaims: ({ status = "active", limit = 20, offset = 0 } = {}, options = {}) =>
      request(`/claims?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`, options),
    updateClaimAuthorization: (jobId, body, idempotencyKey, options = {}) =>
      request(`/claims/${encodeURIComponent(jobId)}/authorization`, {
        ...options, method: "POST", body, idempotencyKey,
      }),
    getGarden: (tokenId, options = {}) =>
      request(`/gardens/${encodeURIComponent(String(tokenId))}`, options),
    sendGardenAction: (tokenId, body, options = {}) =>
      request(`/gardens/${encodeURIComponent(String(tokenId))}/actions`, {
        ...options, method: "POST", body,
      }),
  };
}
