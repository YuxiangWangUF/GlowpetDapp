import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { describeError, padSerial, SPECIES_NAMES, stageName } from "./contract.js";
import "./pendant.css";

const SYNC_INTERVAL_MS = 5_000;
const READ_TIMEOUT_MS = 12_000;

function matchesToken(pet, tokenKey) {
  return Boolean(pet && String(pet.tokenId) === tokenKey);
}

function sanitizePortrait(svg) {
  if (!svg) return "";
  // Preserve the gradient from older deployments without disabling
  // DOMPurify's protection against IDs that shadow document properties.
  const normalized = String(svg)
    .replace(/id="head"/g, 'id="gp-pendant-head-fill"')
    .replace(/url\(#head\)/g, "url(#gp-pendant-head-fill)");
  return DOMPurify.sanitize(normalized, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed", "style"],
  });
}

/**
 * Read-only pendant simulation. fetchPet(tokenId) returns the same normalized
 * { tokenId, owner, metadata, svg, traits } object used by App's pet view.
 */
export default function PendantView({
  tokenId,
  fetchPet,
  initialPet = null,
  allowMotion = true,
  onClose,
}) {
  const tokenKey = tokenId == null ? "" : String(tokenId);
  const initialPetRef = useRef(initialPet);
  initialPetRef.current = initialPet;
  const refreshRef = useRef(() => {});
  const [snapshot, setSnapshot] = useState(() =>
    matchesToken(initialPet, tokenKey) ? initialPet : null,
  );
  const [syncState, setSyncState] = useState("connecting");
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [syncError, setSyncError] = useState("");
  const [motionEnabled, setMotionEnabled] = useState(allowMotion);

  useEffect(() => {
    setMotionEnabled(allowMotion);
  }, [allowMotion]);

  useEffect(() => {
    let disposed = false;
    let requestVersion = 0;
    let reading = false;
    let timeoutId;
    const seed = initialPetRef.current;
    setSnapshot(matchesToken(seed, tokenKey) ? seed : null);
    setLastSyncedAt(null);
    setSyncError("");
    setSyncState("connecting");

    if (!/^\d+$/.test(tokenKey) || typeof fetchPet !== "function") {
      setSyncState("offline");
      setSyncError("Choose a pet to start the pendant preview.");
      refreshRef.current = () => {};
      return undefined;
    }

    async function refresh() {
      // Polls never overlap. Slow reads get a bounded timeout so one stalled
      // RPC cannot block all later attempts.
      if (disposed || reading) return;
      if (navigator.onLine === false) {
        setSyncState("offline");
        setSyncError("Your browser is offline. Reconnect to sync again.");
        return;
      }
      reading = true;
      const version = ++requestVersion;
      setSyncState((previous) =>
        previous === "offline" ? "retrying" : "syncing",
      );

      try {
        const next = await Promise.race([
          Promise.resolve().then(() => fetchPet(tokenKey)),
          new Promise((_, reject) => {
            timeoutId = window.setTimeout(
              () => reject(new Error("The chain did not respond in time.")),
              READ_TIMEOUT_MS,
            );
          }),
        ]);
        if (disposed || version !== requestVersion) return;
        if (!matchesToken(next, tokenKey) || !next.traits || !next.svg) {
          throw new Error("This pet is not available from the chain yet.");
        }
        setSnapshot(next);
        setLastSyncedAt(new Date());
        setSyncError("");
        setSyncState("synced");
      } catch (error) {
        if (disposed || version !== requestVersion) return;
        // Keep the last successful image and ownership data visible, with
        // an explicit offline label; never replace it with fabricated data.
        setSyncState("offline");
        setSyncError(describeError(error));
      } finally {
        if (version === requestVersion) {
          window.clearTimeout(timeoutId);
          reading = false;
        }
      }
    }

    function markOffline() {
      ++requestVersion;
      reading = false;
      window.clearTimeout(timeoutId);
      setSyncState("offline");
      setSyncError("Your browser is offline. Reconnect to sync again.");
    }

    refreshRef.current = refresh;
    refresh();
    const intervalId = window.setInterval(refresh, SYNC_INTERVAL_MS);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", markOffline);

    return () => {
      disposed = true;
      ++requestVersion;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", markOffline);
      refreshRef.current = () => {};
    };
  }, [tokenKey, fetchPet]);

  // A token change must hide the old portrait even before the effect resets
  // its state. Late requests are also ignored by the effect's version guard.
  const pet = matchesToken(snapshot, tokenKey) ? snapshot : null;
  const safeSvg = useMemo(() => sanitizePortrait(pet?.svg), [pet?.svg]);
  const species = pet ? SPECIES_NAMES[pet.traits.species] ?? "Glowpet" : "Glowpet";
  const isReading = ["connecting", "syncing", "retrying"].includes(syncState);
  const isOffline = syncState === "offline" || syncState === "retrying";
  const statusLabel = {
    connecting: "Connecting to chain",
    syncing: "Syncing",
    retrying: "Offline · retrying",
    offline: "Offline · will retry",
    synced: "Synced from chain",
  }[syncState];

  return (
    <section className="pendant-view" aria-labelledby="pendant-title">
      <div className="pendant-heading">
        <div>
          <p className="pendant-eyebrow">A little closer</p>
          <h1 id="pendant-title">Your pocket companion.</h1>
          <p className="pendant-intro">
            A browser preview of your Glowpet pendant, following its life on-chain.
          </p>
        </div>
        <button type="button" className="pendant-back" onClick={onClose}>
          <span aria-hidden="true">← </span>Back to pet
        </button>
      </div>

      <div className="pendant-layout">
        <div className="pendant-showcase">
          <div className="pendant-device">
            <div className="pendant-ring" aria-hidden="true" />
            <div className="pendant-shell">
              <div
                className={`pendant-screen ${motionEnabled ? "pendant-motion-on" : "pendant-motion-off"}`}
                role="img"
                aria-label={
                  pet
                    ? `${species} number ${padSerial(pet.traits.serial)}, ${stageName(pet.traits.stage)}, on the pendant screen`
                    : "Pendant screen waiting for a pet"
                }
              >
                {safeSvg ? (
                  <div
                    className="pendant-portrait"
                    dangerouslySetInnerHTML={{ __html: safeSvg }}
                  />
                ) : (
                  <div className="pendant-screen-empty">
                    <span aria-hidden="true">✧</span>
                    {isOffline ? "Waiting to reconnect" : "Meeting your Glowpet…"}
                  </div>
                )}
              </div>
              <div className="pendant-device-label" aria-hidden="true">
                <span className={isOffline ? "pendant-light offline" : "pendant-light"} />
                glowpet
              </div>
            </div>
          </div>
          <p className="pendant-caption">Browser simulation · 240 × 240 display</p>
        </div>

        <div className="pendant-details">
          <p className="pendant-eyebrow">One charm. One companion.</p>
          <h2>
            {species}
            {pet && <span> #{padSerial(pet.traits.serial)}</span>}
          </h2>
          <p className="pendant-token">Token {tokenKey || "—"}</p>

          <dl className="pendant-facts">
            <div>
              <dt>Life stage</dt>
              <dd>{pet ? stageName(pet.traits.stage) : "Awaiting sync"}</dd>
            </div>
            <div>
              <dt>Level</dt>
              <dd>{pet ? pet.traits.level : "—"}</dd>
            </div>
            <div className="pendant-owner">
              <dt>Current owner</dt>
              <dd>{pet?.owner || "Awaiting sync"}</dd>
            </div>
          </dl>

          <div className={`pendant-sync${isOffline ? " is-offline" : ""}`}>
            <p className="pendant-sync-title" role="status" aria-live="polite">
              <span className="pendant-sync-dot" aria-hidden="true" />
              {statusLabel}
            </p>
            <p className="pendant-sync-time">
              {lastSyncedAt ? (
                <>
                  Last synced{" "}
                  <time dateTime={lastSyncedAt.toISOString()}>
                    {lastSyncedAt.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                  .{" "}
                </>
              ) : (
                "Waiting for the first live sync. "
              )}
              Checks every 5 seconds.
            </p>
            {isOffline && (
              <p className="pendant-sync-error">
                {syncError}{" "}
                {pet && "Showing the last available portrait and owner."}
              </p>
            )}
          </div>

          <div className="pendant-actions">
            <button
              type="button"
              className="pendant-refresh"
              onClick={() => refreshRef.current()}
              disabled={isReading}
            >
              {isReading ? "Syncing…" : isOffline ? "Retry now" : "Refresh now"}
            </button>
            <button
              type="button"
              className="pendant-motion"
              aria-pressed={!motionEnabled}
              onClick={() => setMotionEnabled((enabled) => !enabled)}
            >
              {motionEnabled ? "Pause motion" : "Play motion"}
            </button>
          </div>
          <p className="pendant-note">
            Read-only preview. Changes to your pet’s stage and owner appear
            automatically. No wallet or physical Bluetooth device is connected
            by this preview.
          </p>
        </div>
      </div>
    </section>
  );
}
