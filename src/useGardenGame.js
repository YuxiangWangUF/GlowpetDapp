import { useEffect, useMemo, useState } from "react";
import {
  advanceGame, createGame, getGardenActionError, reduceGame, upgradeGame,
} from "./garden-state.js";

const browserStorage = () => globalThis.localStorage;
const browserLocks = () => globalThis.navigator?.locks;
const temporaryMessage = "Browser storage is unavailable. You can keep playing in this tab, but these changes will be lost when it closes.";
const damagedMessage = "Saved garden data was damaged and has been reset.";

/**
 * One key's persistence controller, also usable without a DOM in tests.
 * After a storage failure this controller remains in memory mode until reload;
 * it never overwrites another tab's saved progress with a temporary snapshot.
 */
export function createGardenStore(storageKey, {
  getStorage = browserStorage,
  getLocks = browserLocks,
  clock = Date.now,
} = {}) {
  const key = String(storageKey);
  const subscribers = new Set();
  let state = createGame(clock());
  let storageStatus = "saved";
  let storageError = "";
  let queue = Promise.resolve();

  function readLatest(now) {
    const storage = getStorage();
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      throw new Error("Storage is unavailable");
    }
    const text = storage.getItem(key);
    if (text === null) return { storage, state: createGame(now), error: "" };
    try {
      const parsed = JSON.parse(text);
      const upgraded = upgradeGame(parsed, now);
      if (!upgraded) return { storage, state: createGame(now), error: damagedMessage };
      return { storage, state: upgraded, error: "" };
    } catch {
      return { storage, state: createGame(now), error: damagedMessage };
    }
  }

  function enterMemoryMode() {
    storageStatus = "memory";
    storageError = temporaryMessage;
  }

  function getSnapshot() {
    return { key, state, storageStatus, storageError };
  }

  function notify() {
    const snapshot = getSnapshot();
    for (const subscriber of subscribers) subscriber(snapshot);
  }

  try {
    const loaded = readLatest(clock());
    state = loaded.state;
    storageError = loaded.error;
  } catch {
    enterMemoryMode();
  }

  function syncFromStorage() {
    if (storageStatus === "memory") return;
    try {
      // Read the current value instead of an older queued storage event payload.
      const loaded = readLatest(clock());
      state = loaded.state;
      storageError = loaded.error;
    } catch {
      enterMemoryMode();
    }
    notify();
  }

  function applyAction(action) {
    const now = clock();
    let storage;
    if (storageStatus === "saved") {
      try {
        const loaded = readLatest(now);
        storage = loaded.storage;
        state = loaded.state;
        storageError = loaded.error;
      } catch {
        enterMemoryMode();
      }
    }
    const current = advanceGame(state, now);
    const next = reduceGame(current, action, now);
    if (next === current) {
      state = current;
      notify();
      return { ok: false, reason: getGardenActionError(current, action, now) };
    }
    state = next;
    if (storageStatus === "saved") {
      try {
        storage.setItem(key, JSON.stringify(state));
        storageError = "";
      } catch {
        enterMemoryMode();
      }
    }
    notify();
    return { ok: true };
  }

  async function withBrowserLock(action) {
    let locks;
    try {
      locks = getLocks();
    } catch {
      return applyAction(action);
    }
    if (typeof locks?.request !== "function") return applyAction(action);
    let applied = false;
    let result;
    try {
      return await locks.request(`glowpet-garden:${key}`, { mode: "exclusive" }, () => {
        applied = true;
        result = applyAction(action);
        return result;
      });
    } catch {
      // Some browsers expose Web Locks but deny access in their privacy mode.
      // Never repeat an action if a lock implementation rejects after callback.
      return applied ? result : applyAction(action);
    }
  }

  function dispatch(action) {
    const operation = queue.then(() => withBrowserLock(action));
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    key,
    getSnapshot,
    syncFromStorage,
    dispatch,
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
}

export default function useGardenGame(storageKey) {
  const store = useMemo(() => createGardenStore(storageKey), [storageKey]);
  const [snapshot, setSnapshot] = useState(() => store.getSnapshot());
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    setSnapshot(store.getSnapshot());
    const unsubscribe = store.subscribe(setSnapshot);
    const onStorage = (event) => {
      if (event.key === store.key || event.key === null) store.syncFromStorage();
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      unsubscribe();
      globalThis.removeEventListener?.("storage", onStorage);
    };
  }, [store]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const active = snapshot.key === store.key ? snapshot : store.getSnapshot();
  const displayNow = Math.max(now, active.state.lastUpdated);
  return {
    state: advanceGame(active.state, displayNow),
    now: displayNow,
    dispatch: store.dispatch,
    storageError: active.storageError,
    storageStatus: active.storageStatus,
  };
}
