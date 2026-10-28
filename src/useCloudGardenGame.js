import { useEffect, useMemo, useRef, useState } from "react";
import { advanceGame, createGame, isGardenState } from "./garden-state.js";
import { randomRequestId } from "./sponsored-claim.js";

function readJson(key) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The cloud response still drives this tab; only the local cache is lost.
  }
}

function cachedSnapshot(cacheKey, now) {
  const cached = cacheKey ? readJson(cacheKey) : null;
  if (cached && isGardenState(cached.state) && /^[0-9]+$/.test(String(cached.revision ?? ""))) {
    return {
      state: cached.state,
      revision: String(cached.revision),
      rulesVersion: String(cached.rulesVersion ?? "1"),
      serverTime: cached.serverTime ?? "",
      storageStatus: "loading",
      storageError: "",
      source: "cloud",
    };
  }
  return {
    state: createGame(now),
    revision: "0",
    rulesVersion: "1",
    serverTime: "",
    storageStatus: "loading",
    storageError: "",
    source: "cloud",
  };
}

function applySnapshot(previous, response) {
  return {
    ...previous,
    state: response.state,
    revision: String(response.revision),
    rulesVersion: String(response.rulesVersion ?? previous.rulesVersion ?? "1"),
    serverTime: response.serverTime ?? "",
    storageStatus: "cloud",
    storageError: "",
    source: "cloud",
  };
}

function conflictSnapshot(error) {
  const detail = error?.details?.details ?? error?.details;
  if (detail && detail.state && detail.revision) return detail;
  return null;
}

/**
 * Cloud garden adapter. The browser never calculates rewards for this mode:
 * every action is sent with an action id and expected revision, and the server
 * returns the authoritative state. The local cache is display-only.
 */
export default function useCloudGardenGame({ enabled, tokenId, accountId, api }) {
  const cacheKey = enabled && tokenId && accountId
    ? `glowpet:cloud-garden:v1:${accountId}:${tokenId}`
    : "";
  const outboxKey = enabled && tokenId && accountId
    ? `glowpet:cloud-outbox:v1:${accountId}:${tokenId}`
    : "";

  const [snapshot, setSnapshot] = useState(() => cachedSnapshot(cacheKey, Date.now()));
  const [now, setNow] = useState(Date.now);
  const snapshotRef = useRef(snapshot);
  const queueRef = useRef(Promise.resolve());
  const mountedRef = useRef(true);
  const enabledRef = useRef(enabled);
  const apiRef = useRef(api);
  snapshotRef.current = snapshot;
  enabledRef.current = enabled;
  apiRef.current = api;

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    setSnapshot(cachedSnapshot(cacheKey, Date.now()));
  }, [cacheKey]);

  useEffect(() => {
    if (!enabled || !tokenId || !api) return undefined;
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const response = await api.getGarden(tokenId, { signal: controller.signal });
        if (cancelled) return;
        setSnapshot((previous) => {
          const next = applySnapshot(previous, response);
          writeJson(cacheKey, next);
          return next;
        });
        const outbox = outboxKey ? readJson(outboxKey) : null;
        if (outbox?.actionId) {
          try {
            const retried = await api.sendGardenAction(tokenId, outbox, { signal: controller.signal });
            if (cancelled) return;
            setSnapshot((previous) => {
              const next = applySnapshot(previous, retried);
              writeJson(cacheKey, next);
              return next;
            });
            writeJson(outboxKey, null);
          } catch (retryError) {
            if (cancelled) return;
            if (retryError.code === "REVISION_CONFLICT") {
              const detail = conflictSnapshot(retryError);
              if (detail) {
                setSnapshot((previous) => {
                  const next = applySnapshot(previous, detail);
                  writeJson(cacheKey, next);
                  return next;
                });
              }
              writeJson(outboxKey, null);
            } else if (retryError.code === "NETWORK_ERROR" || retryError.code === "CHAIN_UNAVAILABLE") {
              setSnapshot((previous) => ({
                ...previous,
                storageStatus: "offline",
                storageError: "The cloud garden is offline. Reconnect before spending or earning rewards.",
              }));
            } else {
              writeJson(outboxKey, null);
            }
          }
        }
      } catch (error) {
        if (cancelled) return;
        setSnapshot((previous) => ({
          ...previous,
          storageStatus: previous.storageStatus === "cloud" ? "offline" : "error",
          storageError: error.code === "NETWORK_ERROR" || error.code === "CHAIN_UNAVAILABLE"
            ? "The cloud garden is offline. Showing the last saved state."
            : error.message || "The cloud garden could not be loaded.",
        }));
      }
    }

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, tokenId, api, cacheKey, outboxKey]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => {
      if (!apiRef.current || !tokenId) return;
      apiRef.current.getGarden(tokenId)
        .then((response) => {
          if (!mountedRef.current) return;
          setSnapshot((previous) => {
            const next = applySnapshot(previous, response);
            writeJson(cacheKey, next);
            return next;
          });
        })
        .catch(() => {
          if (!mountedRef.current) return;
          setSnapshot((previous) => ({ ...previous, storageStatus: "offline" }));
        });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, tokenId, api, cacheKey]);

  const displayState = useMemo(() => {
    const displayNow = Math.max(now, snapshot.state.lastUpdated ?? 0);
    return advanceGame(snapshot.state, displayNow);
  }, [snapshot.state, now]);
  const displayNow = Math.max(now, snapshot.state.lastUpdated ?? 0);

  async function send(action) {
    if (!enabledRef.current || !apiRef.current || !tokenId) {
      return { ok: false, reason: "The cloud garden is not available for this pet." };
    }
    let baseRevision = snapshotRef.current.revision;
    if (snapshotRef.current.storageStatus === "offline" || snapshotRef.current.storageStatus === "error") {
      try {
        const latest = await apiRef.current.getGarden(tokenId);
        baseRevision = String(latest.revision);
        setSnapshot((previous) => {
          const next = applySnapshot(previous, latest);
          writeJson(cacheKey, next);
          return next;
        });
      } catch {
        return { ok: false, reason: "The cloud garden is offline. Reconnect before spending or earning rewards." };
      }
    }

    const actionId = randomRequestId();
    const payload = {
      actionId,
      expectedRevision: baseRevision,
      action,
    };
    setSnapshot((previous) => ({ ...previous, storageStatus: "saving", storageError: "" }));

    try {
      const response = await apiRef.current.sendGardenAction(tokenId, payload);
      if (!mountedRef.current) return { ok: true };
      setSnapshot((previous) => {
        const next = applySnapshot(previous, response);
        writeJson(cacheKey, next);
        return next;
      });
      writeJson(outboxKey, null);
      return { ok: true };
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") {
        const detail = conflictSnapshot(error);
        if (detail && mountedRef.current) {
          setSnapshot((previous) => {
            const next = applySnapshot(previous, detail);
            writeJson(cacheKey, next);
            return next;
          });
        } else if (mountedRef.current) {
          setSnapshot((previous) => ({ ...previous, storageStatus: "cloud" }));
        }
        return {
          ok: false,
          reason: "The garden changed on another device. The latest state was loaded; try the action again.",
        };
      }
      if (error.code === "NETWORK_ERROR" || error.code === "CHAIN_UNAVAILABLE") {
        writeJson(outboxKey, payload);
        if (mountedRef.current) {
          setSnapshot((previous) => ({
            ...previous,
            storageStatus: "offline",
            storageError: "The action may not have reached the server. It will be retried with the same action id.",
          }));
        }
        return {
          ok: false,
          reason: "The cloud garden is offline. The action was not applied locally and will be reconciled when connected.",
        };
      }
      if (mountedRef.current) setSnapshot((previous) => ({ ...previous, storageStatus: "cloud" }));
      return { ok: false, reason: error.message || "That action could not be saved." };
    }
  }

  function dispatch(action) {
    const operation = queueRef.current.then(() => send(action));
    queueRef.current = operation.catch(() => {});
    return operation;
  }

  return {
    state: displayState,
    now: displayNow,
    dispatch,
    storageError: snapshot.storageError,
    storageStatus: snapshot.storageStatus,
    revision: snapshot.revision,
    source: "cloud",
  };
}
