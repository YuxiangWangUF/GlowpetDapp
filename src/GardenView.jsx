import { useEffect, useId, useMemo, useRef, useState } from "react";
import { sanitizePortrait } from "./portrait-svg.js";
import useGardenGame from "./useGardenGame.js";
import FarmScene from "./FarmScene.jsx";
import { DELTAX_COMPANIONS, getCompanionImageStyle } from "./PlushCompanion.jsx";
import { CROPS, FEED_FULLNESS_LIMIT, PLAY_COOLDOWN_MS, getCareProgress } from "./garden-state.js";
import { padSerial, SPECIES_NAMES, stageName } from "./contract.js";
import "./garden.css";

const MILESTONES = [150, 400, 900];
const COMPANION_PREFERENCE = "glowpet:preview:deltax-soft-v1";

function readCompanionPreference() {
  try {
    const saved = localStorage.getItem(COMPANION_PREFERENCE);
    return DELTAX_COMPANIONS.some((companion) => companion.id === saved) ? saved : "rabbit";
  } catch {
    return "rabbit";
  }
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function NeedMeter({ label, value, tone, detail }) {
  const amount = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`garden-need garden-need-${tone}`}>
      <div className="garden-need-label">
        <span>{label}</span><span>{amount}<small>/100</small></span>
      </div>
      <div
        className="garden-meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={amount}
      >
        <span style={{ width: `${amount}%` }} />
      </div>
      <p>{detail}</p>
    </div>
  );
}

export default function GardenView({
  pet = null,
  storageKey,
  onBack,
  onOpenPet,
}) {
  const { state, now, dispatch, storageError, storageStatus } = useGardenGame(storageKey);
  const [stage, setStage] = useState(pet ? "farm" : "select");
  const [selectedCropId, setSelectedCropId] = useState(CROPS[0].id);
  const [companionId, setCompanionId] = useState(readCompanionPreference);
  const [reaction, setReaction] = useState(null);
  const guest = DELTAX_COMPANIONS.find((companion) => companion.id === companionId) ?? DELTAX_COMPANIONS[0];
  const [pending, setPending] = useState("");
  const [feedback, setFeedback] = useState(null);
  const actionLock = useRef(false);
  const actionVersion = useRef(0);
  const selectedCrop = CROPS.find((crop) => crop.id === selectedCropId) ?? CROPS[0];
  const care = getCareProgress(state);
  const portraitScope = useId();
  const safeSvg = useMemo(() => sanitizePortrait(pet?.svg, `${portraitScope}-garden`), [pet?.svg, portraitScope]);
  const species = pet ? SPECIES_NAMES[pet.traits.species] ?? "Glowpet" : guest.name;
  const playRemaining = state.plays > 0
    ? Math.max(0, state.lastPlayAt + PLAY_COOLDOWN_MS - now)
    : 0;
  const feedReason = state.fullness >= FEED_FULLNESS_LIMIT
    ? "A full tummy. Come back for a snack later."
    : state.food < 1
      ? "Harvest a crop to get food."
      : "1 food · +20 Bond XP";
  const canFeed = state.food >= 1 && state.fullness < FEED_FULLNESS_LIMIT;
  const nextMilestone = MILESTONES.find((target) => state.xp < target);
  const isSessionOnly = storageStatus === "memory";

  useEffect(() => {
    actionVersion.current += 1;
    actionLock.current = false;
    setPending("");
    setFeedback(null);
    setStage(pet ? "farm" : "select");
    return () => { actionVersion.current += 1; };
  }, [storageKey]);

  function chooseCompanion(id) {
    setCompanionId(id);
    try { localStorage.setItem(COMPANION_PREFERENCE, id); } catch { /* The preview remains usable without storage. */ }
  }

  function enterGarden() {
    setStage("farm");
    // The farm appears after this state update; bring it into view on the next
    // frame rather than leaving the player at the top of the summary.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.querySelector(".farm-game")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    });
  }

  function changeCompanion() {
    setStage("select");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function act(action, successMessage) {
    if (actionLock.current) return false;
    actionLock.current = true;
    const version = actionVersion.current;
    setPending(action.type);
    try {
      const result = await dispatch(action);
      if (version !== actionVersion.current) return false;
      if (result?.ok && ["feed", "play", "plant", "harvest"].includes(action.type)) {
        setReaction((previous) => ({ type: action.type, id: (previous?.id ?? 0) + 1 }));
      }
      setFeedback(result?.ok
        ? { tone: "success", text: successMessage }
        : { tone: "error", text: result?.reason || "That action is not available yet." });
      return Boolean(result?.ok);
    } catch {
      if (version === actionVersion.current) {
        setFeedback({ tone: "error", text: "That action could not be saved. Please try again." });
      }
      return false;
    } finally {
      if (version === actionVersion.current) {
        actionLock.current = false;
        setPending("");
      }
    }
  }

  if (!pet && stage === "select") {
    return (
      <section className="garden-view garden-select-view" aria-labelledby="garden-select-title">
        <div className="garden-heading">
          <div>
            <p className="garden-eyebrow">A little patch of your own</p>
            <h1 id="garden-select-title">Choose a Glowpet<span>.</span></h1>
            <p className="garden-intro">
              Pick one of the DeltaX soft friends to bring to the meadow. Your
              coins, crops and Bond XP stay with you whichever little face you choose.
            </p>
          </div>
          <button type="button" className="garden-back" onClick={onBack}>
            <span aria-hidden="true">← </span>Back home
          </button>
        </div>

        <div className="garden-select-panel">
          <div className="garden-select-heading">
            <div>
              <p className="garden-eyebrow">DELTAX · SOFT LITTLE FRIENDS</p>
              <h2>Who is coming to the garden?</h2>
            </div>
            {state.xp > 0 && (
              <span className="garden-select-progress">
                Care Lv. {care.level} · {state.xp} XP kept
              </span>
            )}
          </div>

          <div className="garden-choice-grid" role="group" aria-label="Choose a Glowpet">
            {DELTAX_COMPANIONS.map((companion) => {
              const selected = guest.id === companion.id;
              return (
                <button
                  type="button"
                  key={companion.id}
                  className={`garden-choice${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => chooseCompanion(companion.id)}
                >
                  <span className="garden-choice-art">
                    <img
                      src={companion.assetSrc}
                      style={getCompanionImageStyle(companion)}
                      alt=""
                      draggable="false"
                    />
                    {selected && <span className="garden-choice-check" aria-hidden="true">✓</span>}
                  </span>
                  <strong>{companion.name}</strong>
                  <span className="garden-choice-label">{companion.label}</span>
                </button>
              );
            })}
          </div>

          <div className="garden-select-footer">
            <div>
              <p className="garden-select-note">
                Selected: <strong>{guest.name} · {guest.label}</strong>
              </p>
              <p className="garden-select-subnote">
                Saved on this device. No wallet or blockchain transaction needed.
              </p>
            </div>
            <button type="button" className="garden-enter-button" onClick={enterGarden}>
              Enter the garden <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>

        <p className="garden-select-footnote">
          You can change companions inside the meadow without losing your progress.
        </p>
      </section>
    );
  }

  return (
    <section className="garden-view garden-force-motion" aria-labelledby="garden-title">
      <div className="garden-heading">
        <div>
          <p className="garden-eyebrow">Small rituals, growing bonds</p>
          <h1 id="garden-title">The little garden<span>.</span></h1>
          <p className="garden-intro">Plant a little sunshine. Share a snack. Make time for your companion.</p>
        </div>
        <button type="button" className="garden-back" onClick={onBack}>
          <span aria-hidden="true">← </span>Back home
        </button>
      </div>

      <div className="garden-summary">
        <div className="garden-balance">
          <span className="garden-balance-icon garden-coin-icon" aria-hidden="true">✦</span>
          <div><strong>{state.coins.toLocaleString("en-US")}</strong><span>Garden coins</span></div>
        </div>
        <div className="garden-balance">
          <span className="garden-balance-icon garden-food-icon" aria-hidden="true">✿</span>
          <div><strong>{state.food.toLocaleString("en-US")}</strong><span>Pantry food</span></div>
        </div>
        <div className="garden-balance">
          <span className="garden-balance-icon garden-bond-icon" aria-hidden="true">♡</span>
          <div><strong>{state.xp.toLocaleString("en-US")}</strong><span>Bond XP</span></div>
        </div>
        <div className="garden-save-note">
          <span className={isSessionOnly ? "garden-save-dot is-warning" : "garden-save-dot"} aria-hidden="true" />
          {isSessionOnly ? "Session only" : storageStatus === "saving" ? "Saving…" : "Saved on this device"}
        </div>
      </div>

      {storageError && (
        <p className="garden-storage-error" role="status">
          {typeof storageError === "string" ? storageError : "Device storage is unavailable."}{" "}
          {isSessionOnly && "Progress may not survive a refresh."}
        </p>
      )}

      <FarmScene
        pet={pet}
        portraitSvg={safeSvg}
        companion={guest}
        name={species}
        subtitle={pet ? `#${padSerial(pet.traits.serial)}` : "Guest practice"}
        careLevel={care.level}
        plots={state.plots}
        now={now}
        coins={state.coins}
        seeds={state.seeds}
        selectedCrop={selectedCrop}
        pending={pending}
        reaction={reaction}
        onSelectCrop={setSelectedCropId}
        onBuy={(cropId) => {
          const crop = CROPS.find((item) => item.id === cropId);
          return act(
            { type: "buy", cropId },
            crop ? `Bought 1 ${crop.name} seed packet.` : "Seed packet added.",
          );
        }}
        onPlant={(plotIndex) => act(
          { type: "plant", plotIndex, cropId: selectedCrop.id },
          `${selectedCrop.name} planted in plot 0${plotIndex + 1}. The seed packet is used up; ready in ${duration(selectedCrop.growMs)}.`,
        )}
        onHarvest={(plotIndex) => {
          const crop = CROPS.find((item) => item.id === state.plots[plotIndex]?.cropId);
          act(
            { type: "harvest", plotIndex },
            crop
              ? `${crop.name} harvested! +${crop.coins} coins, +${crop.food} food and +${crop.xp} Bond XP.`
              : "Harvested.",
          );
        }}
      />

      <div className="garden-layout">
        <section className="garden-companion-panel" aria-labelledby="garden-companion-title">
          <div className="garden-panel-heading">
            <span className="garden-eyebrow">Your companion</span>
            <span className="garden-mode-pill">{pet ? "On-chain companion" : "Guest practice"}</span>
          </div>

          <div className="garden-companion-name">
            <h2 id="garden-companion-title">
              {species}{pet && <span> #{padSerial(pet.traits.serial)}</span>}
            </h2>
            <p>{pet ? "A familiar face. A new daily ritual." : "DeltaX · Soft little friends"}</p>
          </div>

          {!pet && (
            <button type="button" className="garden-change-companion" onClick={changeCompanion}>
              <span aria-hidden="true">✦ </span>Change companion
            </button>
          )}
          <div className="garden-levels">
            <div><span>Local care level</span><strong>Lv. {care.level}</strong></div>
            <div>
              <span>On-chain stage</span>
              <strong>{pet ? stageName(pet.traits.stage) : "Guest · no NFT"}</strong>
            </div>
          </div>

          <div className="garden-care-progress">
            <div>
              <span>Growing closer</span>
              <span>{care.xpIntoLevel} / {care.xpForNextLevel} XP to next care level</span>
            </div>
            <div
              className="garden-meter"
              role="progressbar"
              aria-label="Care level progress"
              aria-valuemin={0}
              aria-valuemax={care.xpForNextLevel}
              aria-valuenow={care.xpIntoLevel}
            >
              <span style={{ width: `${Math.min(100, care.xpIntoLevel / care.xpForNextLevel * 100)}%` }} />
            </div>
          </div>

          <div className="garden-needs">
            <NeedMeter label="Fullness" value={state.fullness} tone="peach" detail="A good snack goes a long way." />
            <NeedMeter label="Happiness" value={state.happiness} tone="pink" detail="A little attention makes a difference." />
          </div>

          <div className="garden-care-actions">
            <div>
              <button
                type="button"
                className="garden-feed-button"
                onClick={() => act({ type: "feed" }, `${pet ? species : "Your guest"} enjoyed that snack. +20 Bond XP.`)}
                disabled={Boolean(pending) || !canFeed}
                aria-describedby="garden-feed-reason"
              >
                <span aria-hidden="true">♡ </span>{pending === "feed" ? "Sharing…" : "Share a snack"}
              </button>
              <p id="garden-feed-reason">{feedReason}</p>
            </div>
            <div>
              <button
                type="button"
                className="garden-play-button"
                onClick={() => act({ type: "play" }, "A happy little moment together. +5 Bond XP.")}
                disabled={Boolean(pending) || playRemaining > 0}
                aria-describedby="garden-play-reason"
              >
                <span aria-hidden="true">✧ </span>{pending === "play" ? "Playing…" : "Play together"}
              </button>
              <p id="garden-play-reason">{playRemaining > 0 ? `Ready again in ${duration(playRemaining)}.` : "Free · +5 Bond XP · every 30s"}</p>
            </div>
          </div>

          {pet && onOpenPet && (
            <button type="button" className="garden-pet-link" onClick={onOpenPet}>View on-chain pet <span aria-hidden="true">↗</span></button>
          )}
          {!pet && <p className="garden-guest-note">One practice garden, five little friends. Changing your companion keeps your progress. No wallet needed.</p>}
        </section>

        <div className="garden-growing-column">
          <section className="garden-field-notes" aria-labelledby="garden-field-notes-title">
            <div className="garden-panel-heading">
              <div>
                <p className="garden-eyebrow">Small things, counted</p>
                <h2 id="garden-field-notes-title">Field notes</h2>
              </div>
              <span className="garden-local-badge">This device</span>
            </div>
            <div className="garden-note-stats">
              <div><strong>{state.harvests}</strong><span>Harvests</span></div>
              <div><strong>{state.feeds}</strong><span>Snacks</span></div>
              <div><strong>{state.plays}</strong><span>Playtimes</span></div>
            </div>
            <p className="garden-note-copy">
              Buy packets in the seed shop, take a coloured jar from the cabinet,
              then plant it in an empty patch. Sun carrot packets are always free.
            </p>
          </section>

          <div className={`garden-feedback${feedback ? ` ${feedback.tone}` : ""}`} role="status" aria-live="polite" aria-atomic="true">
            <span aria-hidden="true">{feedback?.tone === "error" ? "!" : "✦"}</span>
            <p>{feedback?.text ?? "A seed, a snack, a moment together. Start wherever you like."}</p>
          </div>

          <section className="garden-milestones" aria-labelledby="garden-milestone-title">
            <div className="garden-panel-heading">
              <div><p className="garden-eyebrow">Good things take a little care</p><h2 id="garden-milestone-title">Your bond, growing</h2></div>
              <span className="garden-local-badge">Local progress</span>
            </div>
            <div className="garden-milestone-track">
              {MILESTONES.map((target, index) => (
                <div key={target} className={state.xp >= target ? "is-reached" : ""}>
                  <span className="garden-milestone-dot" aria-hidden="true">{state.xp >= target ? "✓" : `0${index + 1}`}</span>
                  <strong>{target} XP</strong>
                  <span>{state.xp >= target ? "Reached" : ["First bond", "Growing trust", "Kindred spirits"][index]}</span>
                </div>
              ))}
            </div>
            <p>{nextMilestone ? `${nextMilestone - state.xp} Bond XP to your next care milestone.` : "Every care milestone reached. Keep making little memories."}</p>
            <p className="garden-chain-note">
              Care milestones are saved on this device. On-chain evolution is not enabled here; your pet’s on-chain stage stays unchanged.
            </p>
          </section>
        </div>
      </div>

      <div className="garden-footer-note">
        <span aria-hidden="true">⌂</span>
        <p>A little garden, kept on this device. Garden coins and Bond XP cannot be redeemed or exchanged for tokens. Playing sends no blockchain transactions.</p>
      </div>
    </section>
  );
}
