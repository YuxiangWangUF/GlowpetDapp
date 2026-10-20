import { useEffect, useRef, useState } from "react";
import PlushCompanion from "./PlushCompanion.jsx";
import { CROPS, SEED_CAP } from "./garden-state.js";
import "./farm.css";

const PLOT_SPOTS = Object.freeze([
  Object.freeze({ x: 18, y: 64 }),
  Object.freeze({ x: 50, y: 61 }),
  Object.freeze({ x: 82, y: 64 }),
]);

const SEED_NOTES = Object.freeze({
  carrot: "Fast, dependable and always in the cupboard.",
  glowberry: "A sweet little crop with a generous harvest.",
  moonbloom: "A slow bloom for patient gardeners.",
});

const SEED_SHORT_NAMES = Object.freeze({
  carrot: "Carrot",
  glowberry: "Berry",
  moonbloom: "Bloom",
});

function initialPosition() {
  const compact = window.innerWidth <= 620;
  return {
    // Narrow screens need the companion in the foreground so it does not
    // cover the three patches or the movement controls.
    x: compact ? 52 : 34,
    y: compact ? 92 : 83,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function plotView(plot, now) {
  if (!plot) {
    return { kind: "empty", crop: null, remaining: 0, growth: 0 };
  }
  const crop = CROPS.find((item) => item.id === plot.cropId) ?? null;
  const remaining = crop ? Math.max(0, plot.readyAt - now) : 0;
  const growth = crop
    ? clamp((now - plot.plantedAt) / crop.growMs * 100, 0, 100)
    : 0;
  return {
    kind: remaining === 0 ? "ready" : "growing",
    crop,
    remaining,
    growth,
  };
}

/**
 * A small click-to-walk farm. Walking is visual only; all game state still
 * flows through the reducer in GardenView, so this scene cannot spend coins or
 * harvest a crop by itself.
 */
export default function FarmScene({
  pet = null,
  portraitSvg = "",
  companion,
  name,
  subtitle,
  careLevel,
  plots,
  now,
  coins,
  seeds,
  selectedCrop,
  pending,
  reaction,
  onSelectCrop,
  onBuy,
  onPlant,
  onHarvest,
}) {
  const sceneRef = useRef(null);
  const characterRef = useRef(null);
  const positionRef = useRef(initialPosition());
  const walkFrame = useRef(0);
  const walkRun = useRef(0);
  const walkArrival = useRef(null);
  const pickupTimer = useRef(null);
  const consumeTimer = useRef(null);
  const [walking, setWalking] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [activePlot, setActivePlot] = useState(null);
  const [cabinetOpen, setCabinetOpen] = useState(false);
  const [heldSeedId, setHeldSeedId] = useState(null);
  const [pickingSeed, setPickingSeed] = useState(null);
  const [pickupMoment, setPickupMoment] = useState(null);
  const [consumeMoment, setConsumeMoment] = useState(null);
  const [shopMessage, setShopMessage] = useState(null);
  const cabinetTrigger = useRef(null);
  const cabinetClose = useRef(null);

  useEffect(() => () => {
    walkRun.current += 1;
    window.cancelAnimationFrame(walkFrame.current);
    if (pickupTimer.current) window.clearTimeout(pickupTimer.current);
    if (consumeTimer.current) window.clearTimeout(consumeTimer.current);
  }, []);

  function consumeHeldSeed() {
    setHeldSeedId(null);
    setConsumeMoment({ id: Date.now() });
    if (consumeTimer.current) window.clearTimeout(consumeTimer.current);
    consumeTimer.current = window.setTimeout(() => setConsumeMoment(null), 750);
  }

  useEffect(() => {
    if (!cabinetOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCabinet();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const focusFrame = window.requestAnimationFrame(() => cabinetClose.current?.focus());

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
    };
  }, [cabinetOpen]);

  function openCabinet(event) {
    cabinetTrigger.current = event?.currentTarget ?? null;
    setShopMessage(null);
    setCabinetOpen(true);
  }

  function closeCabinet() {
    setCabinetOpen(false);
    const trigger = cabinetTrigger.current;
    window.requestAnimationFrame(() => trigger?.focus());
  }

  function takeOrShop(crop, event) {
    const stock = seeds?.[crop.id] ?? 0;
    if (stock < 1) {
      openCabinet(event);
      return;
    }
    if (heldSeedId === crop.id) return;
    pickUpSeed(crop.id);
  }

  function buySeed(crop) {
    if (pending) return;
    const stock = seeds?.[crop.id] ?? 0;
    if (stock >= SEED_CAP) {
      setShopMessage({ tone: "error", text: `The ${crop.name} shelf is full.` });
      return;
    }
    if (coins < crop.cost) {
      setShopMessage({
        tone: "error",
        text: `You need ${crop.cost - coins} more coins for a ${crop.name} packet.`,
      });
      return;
    }
    const outcome = onBuy?.(crop.id);
    if (!outcome || typeof outcome.then !== "function") {
      setShopMessage({ tone: "error", text: "The seed shop is unavailable right now." });
      return;
    }
    outcome.then((ok) => {
      setShopMessage(ok
        ? { tone: "success", text: `Bought 1 ${crop.name} seed. ${stock + 1} in the cupboard.` }
        : { tone: "error", text: "That packet could not be bought. Check your coins." });
    }).catch(() => {
      setShopMessage({ tone: "error", text: "That packet could not be saved." });
    });
  }

  function pickUpSeed(cropId) {
    setActivePlot(null);
    setPickingSeed(cropId);
    const compact = window.innerWidth <= 620;
    // Stand beside the shelf rather than covering the seed models.
    walkTo(compact ? 60 : 80, compact ? 90 : 89, {
      onArrive: () => {
        onSelectCrop(cropId);
        setHeldSeedId(cropId);
        setPickingSeed(null);
        setPickupMoment({ cropId, id: Date.now() });
        if (pickupTimer.current) window.clearTimeout(pickupTimer.current);
        pickupTimer.current = window.setTimeout(() => setPickupMoment(null), 950);
      },
    });
  }

  /**
   * The companion crosses the meadow in small hops. Positions are written
   * straight to the DOM inside requestAnimationFrame: this keeps the motion
   * smooth without re-rendering the whole garden every frame, and it still
   * works when the OS asks for reduced motion because it is scripted rather
   * than a CSS transition.
   */
  function walkTo(x, y, { onArrive = null } = {}) {
    const next = {
      x: clamp(x, 8, 92),
      y: clamp(y, 58, 94),
    };
    const previous = positionRef.current;
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const scene = sceneRef.current;
    const character = characterRef.current;
    if (!scene || !character) return;

    // A new instruction always replaces the previous hop path and any pending
    // arrival action, so a cancelled seed fetch cannot complete silently.
    window.cancelAnimationFrame(walkFrame.current);
    const run = ++walkRun.current;
    walkArrival.current = onArrive;
    if (!onArrive) setPickingSeed(null);

    const rect = scene.getBoundingClientRect();
    const distance = Math.hypot(dx / 100 * rect.width, dy / 100 * rect.height);
    if (distance < 4) {
      positionRef.current = next;
      character.style.left = `${next.x}%`;
      character.style.top = `${next.y}%`;
      character.style.setProperty("--farm-hop", "0px");
      character.style.setProperty("--farm-stretch", "1");
      setWalking(false);
      const arrive = walkArrival.current;
      walkArrival.current = null;
      arrive?.();
      return;
    }

    if (Math.abs(dx) > 0.2) setFacingLeft(dx < 0);

    const start = { ...previous };
    const hops = clamp(Math.round(distance / 46), 1, 12);
    const hopDuration = clamp(1500 / hops, 110, 190);
    const total = hops * hopDuration;
    const hopHeight = clamp(character.offsetWidth * 0.07, 5, 11);
    const startedAt = performance.now();
    setWalking(true);

    function frame(timestamp) {
      if (run !== walkRun.current) return;
      const elapsed = timestamp - startedAt;
      const ratio = Math.min(1, elapsed / total);
      const hopPosition = ratio * hops;
      const hopIndex = Math.min(hops - 1, Math.floor(hopPosition));
      const hopProgress = hopPosition - hopIndex;
      const eased = hopProgress * hopProgress * (3 - 2 * hopProgress);
      const progress = (hopIndex + eased) / hops;
      const currentX = start.x + dx * progress;
      const currentY = start.y + dy * progress;
      positionRef.current = { x: currentX, y: currentY };

      const outer = characterRef.current;
      if (outer) {
        outer.style.left = `${currentX}%`;
        outer.style.top = `${currentY}%`;
        const arc = Math.sin(hopProgress * Math.PI);
        outer.style.setProperty("--farm-hop", `${(arc * hopHeight).toFixed(2)}px`);
        outer.style.setProperty("--farm-stretch", (1 + arc * 0.025).toFixed(4));
      }

      if (elapsed < total) {
        walkFrame.current = window.requestAnimationFrame(frame);
        return;
      }

      positionRef.current = next;
      if (outer) {
        outer.style.left = `${next.x}%`;
        outer.style.top = `${next.y}%`;
        outer.style.setProperty("--farm-hop", "0px");
        outer.style.setProperty("--farm-stretch", "1");
      }
      setWalking(false);
      const arrive = walkArrival.current;
      walkArrival.current = null;
      arrive?.();
    }

    walkFrame.current = window.requestAnimationFrame(frame);
  }

  function walkBy(dx, dy) {
    setActivePlot(null);
    walkTo(positionRef.current.x + dx, positionRef.current.y + dy);
  }

  function plantSeed(plotIndex) {
    const outcome = onPlant(plotIndex);
    if (outcome && typeof outcome.then === "function") {
      outcome.then((ok) => {
        if (ok && heldSeedId) consumeHeldSeed();
      }).catch(() => {});
    }
  }

  function selectPlot(index) {
    setActivePlot(index);
    const spot = PLOT_SPOTS[index];
    const compact = window.innerWidth <= 620;
    // Stand beside the patch instead of directly on top of it.
    const offset = compact
      ? (index === 2 ? -26 : 26)
      : (index === 0 ? 13 : index === 2 ? -13 : 15);
    // With a seed in hand, walking onto an empty patch plants it immediately.
    const autoPlant = plots[index] === null
      && heldSeedId === selectedCrop.id
      && (seeds?.[selectedCrop.id] ?? 0) > 0;
    walkTo(spot.x + offset, spot.y + (compact ? 12 : 15), {
      onArrive: autoPlant ? () => plantSeed(index) : null,
    });
  }

  function handleSceneClick(event) {
    if (event.target.closest("button")) return;
    const rect = sceneRef.current?.getBoundingClientRect();
    if (!rect) return;
    setActivePlot(null);
    walkTo(
      (event.clientX - rect.left) / rect.width * 100,
      (event.clientY - rect.top) / rect.height * 100,
    );
  }

  function handleKeyDown(event) {
    if (event.target !== event.currentTarget) return;
    const moves = {
      ArrowLeft: [-9, 0],
      ArrowRight: [9, 0],
      ArrowUp: [0, -7],
      ArrowDown: [0, 7],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    walkBy(...move);
  }

  const active = activePlot === null ? null : plotView(plots[activePlot], now);
  const heldSeed = CROPS.find((crop) => crop.id === heldSeedId) ?? null;
  const pickingCrop = CROPS.find((crop) => crop.id === pickingSeed) ?? null;
  const pickupCrop = CROPS.find((crop) => crop.id === pickupMoment?.cropId) ?? null;
  const pickupReaction = pickupMoment ? { type: "tap", id: pickupMoment.id } : reaction;
  const selectedStock = seeds?.[selectedCrop.id] ?? 0;
  const canPlantSeed = Boolean(
    heldSeed && heldSeed.id === selectedCrop.id && selectedStock > 0,
  );

  return (
    <section className="farm-game" aria-labelledby="farm-title">
      <div className="farm-scene-heading">
        <div>
          <p className="garden-eyebrow">The meadow</p>
          <h2 id="farm-title">Where little things grow<span>.</span></h2>
        </div>
        <p className="farm-scene-hint">
          Buy seeds in the cabinet, tap a coloured jar to take one, then plant it in a patch.
        </p>
      </div>

      <div
        className="farm-scene"
        ref={sceneRef}
        role="group"
        tabIndex={0}
        aria-label="DeltaX farm. Click the meadow to walk, or use the arrow controls."
        onClick={handleSceneClick}
        onKeyDown={handleKeyDown}
      >
        <div className="farm-sky" aria-hidden="true">
          <span className="farm-sun" />
          <span className="farm-cloud farm-cloud-one" />
          <span className="farm-cloud farm-cloud-two" />
          <span className="farm-cloud farm-cloud-three" />
        </div>

        <div className="farm-hills" aria-hidden="true">
          <span className="farm-hill farm-hill-back" />
          <span className="farm-hill farm-hill-front" />
        </div>

        <div className="farm-meadow" aria-hidden="true">
          <span className="farm-path" />
          <span className="farm-flower farm-flower-one">✿</span>
          <span className="farm-flower farm-flower-two">✿</span>
          <span className="farm-flower farm-flower-three">✿</span>
          <span className="farm-flower farm-flower-four">✧</span>
          <span className="farm-flower farm-flower-five">✿</span>
        </div>

        <div className="farm-fence" aria-hidden="true">
          {Array.from({ length: 7 }).map((_, index) => <span key={index} />)}
        </div>

        <div className="farm-tree" aria-hidden="true">
          <span className="farm-tree-trunk" />
          <span className="farm-tree-crown farm-tree-crown-one" />
          <span className="farm-tree-crown farm-tree-crown-two" />
          <span className="farm-tree-crown farm-tree-crown-three" />
        </div>

        <div className="farm-cabinet-stand">
          <div className="farm-seed-shelf" role="group" aria-label="Seed models on the cabinet">
            {CROPS.map((crop) => {
              const stock = seeds?.[crop.id] ?? 0;
              const held = heldSeedId === crop.id;
              const empty = stock < 1;
              return (
                <button
                  type="button"
                  key={crop.id}
                  className={`farm-seed-model${pickingSeed === crop.id ? " is-picking" : ""}${held ? " is-held" : ""}${empty ? " is-empty" : ""}`}
                  data-crop={crop.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (empty) openCabinet(event);
                    else if (!held) pickUpSeed(crop.id);
                  }}
                  disabled={held}
                  aria-busy={pickingSeed === crop.id}
                  aria-label={empty
                    ? `Buy ${crop.name} seeds. Out of stock.`
                    : `Take ${crop.name} seed. ${stock} in stock.`}
                  title={empty ? `Buy ${crop.name} seeds` : `Take ${crop.name} (${stock} in stock)`}
                >
                  <span className="farm-seed-model-jar" aria-hidden="true">
                    <span className="farm-seed-model-emoji">{crop.icon}</span>
                  </span>
                  <span className="farm-seed-model-count" aria-hidden="true">{stock}</span>
                  <span className="farm-seed-model-label" aria-hidden="true">
                    {SEED_SHORT_NAMES[crop.id]}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="farm-cabinet"
            onClick={(event) => {
              event.stopPropagation();
              openCabinet(event);
            }}
            aria-haspopup="dialog"
            aria-expanded={cabinetOpen}
            aria-label={`Open seed cabinet. Selected seed: ${selectedCrop.name}`}
          >
            <span className="farm-cabinet-sign" aria-hidden="true">SEEDS</span>
            <span className="farm-cabinet-body" aria-hidden="true">
              <span className="farm-cabinet-door farm-cabinet-door-left">
                <span className="farm-cabinet-panel" />
                <span className="farm-cabinet-knob" />
              </span>
              <span className="farm-cabinet-door farm-cabinet-door-right">
                <span className="farm-cabinet-panel" />
                <span className="farm-cabinet-knob" />
              </span>
            </span>
          </button>
        </div>

        <div className="farm-hud">
          <span className="farm-hud-name">
            {name}
            <small>· {subtitle}</small>
          </span>
          <span className="farm-hud-level">Care Lv. {careLevel}</span>
        </div>

        {plots.map((plot, index) => {
          const spot = PLOT_SPOTS[index];
          const view = plotView(plot, now);
          const isActive = activePlot === index;
          const label = view.kind === "ready"
            ? `Plot ${index + 1}, ${view.crop?.name ?? "crop"} ready to harvest`
            : view.kind === "growing"
              ? `Plot ${index + 1}, ${view.crop?.name ?? "crop"} growing, ready in ${duration(view.remaining)}`
              : `Plot ${index + 1}, empty. Walk here to plant ${selectedCrop.name}`;
          return (
            <button
              type="button"
              key={index}
              className={`farm-plot is-${view.kind}${isActive ? " is-active" : ""}`}
              style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
              aria-label={label}
              aria-pressed={isActive}
              onClick={(event) => {
                event.stopPropagation();
                selectPlot(index);
              }}
            >
              <span className="farm-plot-tag">PLOT 0{index + 1}</span>
              <span className="farm-plot-soil">
                {view.kind === "empty" && <span className="farm-plot-plus" aria-hidden="true">+</span>}
                {view.kind === "growing" && <span className="farm-sprout" aria-hidden="true">🌱</span>}
                {view.kind === "ready" && (
                  <>
                    <span className="farm-crop-art" aria-hidden="true">{view.crop?.icon}</span>
                    <span className="farm-ready-spark" aria-hidden="true">✦</span>
                  </>
                )}
              </span>
              <span className="farm-plot-caption">
                {view.kind === "empty" ? "A little possibility" : view.crop?.name}
              </span>
              <span className="farm-plot-progress" aria-hidden="true">
                <span style={{ width: `${view.growth}%` }} />
              </span>
            </button>
          );
        })}

        <div
          ref={characterRef}
          className={`farm-character${walking ? " is-walking" : ""}`}
          style={{ left: `${positionRef.current.x}%`, top: `${positionRef.current.y}%` }}
          aria-hidden="true"
        >
          <span className="farm-character-shadow" />
          <div
            className="farm-character-inner"
            style={{ "--farm-facing": facingLeft ? -1 : 1 }}
          >
            {pet ? (
              portraitSvg ? (
                <div className="farm-pet-svg" dangerouslySetInnerHTML={{ __html: portraitSvg }} />
              ) : (
                <span className="farm-character-fallback">{name}</span>
              )
            ) : (
              <PlushCompanion
                model={companion.id}
                motion
                forceMotion
                reaction={pickupReaction}
              />
            )}

            {heldSeed && (
              <span className="farm-held-seed" data-crop={heldSeed.id} aria-hidden="true">
                <span className="farm-held-seed-jar">
                  <span className="farm-held-seed-emoji">{heldSeed.icon}</span>
                </span>
              </span>
            )}

            {consumeMoment && (
              <span className="farm-consume-puff" key={consumeMoment.id} aria-hidden="true">
                <span>✦</span><span>✦</span><span>✦</span>
              </span>
            )}

            {pickupMoment && pickupCrop && (
              <span className="farm-pickup-burst" key={pickupMoment.id} aria-hidden="true">
                <span>{pickupCrop.icon}</span>
                <small>✦</small>
              </span>
            )}
          </div>
        </div>

        <div className="farm-dpad" role="group" aria-label="Walk controls" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="farm-dpad-up" aria-label="Walk up" onClick={() => walkBy(0, -7)}>↑</button>
          <button type="button" className="farm-dpad-left" aria-label="Walk left" onClick={() => walkBy(-9, 0)}>←</button>
          <button type="button" className="farm-dpad-right" aria-label="Walk right" onClick={() => walkBy(9, 0)}>→</button>
          <button type="button" className="farm-dpad-down" aria-label="Walk down" onClick={() => walkBy(0, 7)}>↓</button>
        </div>

        <p className="farm-walk-note">
          <span aria-hidden="true">⌖</span> Click the grass to walk.{" "}
          {pickingCrop
            ? `Fetching ${pickingCrop.name} from the cabinet…`
            : activePlot !== null
              ? `Tending plot 0${activePlot + 1}.`
              : heldSeed
                ? `Carrying ${heldSeed.name}. Choose a plot to plant.`
                : selectedStock < 1
                  ? "Out of seeds. Open the cabinet to buy a packet."
                  : "Choose a plot when you arrive."}
        </p>
      </div>

      <div className="farm-console">
        <div className="farm-seed-dock">
          <div className="farm-console-heading">
            <span className="garden-eyebrow">Seed satchel</span>
            <button type="button" className="farm-cabinet-link" onClick={openCabinet}>
              Open cabinet <span aria-hidden="true">↗</span>
            </button>
          </div>
          <div className="farm-seeds" role="group" aria-label="Seed satchel">
            {CROPS.map((crop) => {
              const stock = seeds?.[crop.id] ?? 0;
              const held = heldSeedId === crop.id;
              const empty = stock < 1;
              return (
                <button
                  type="button"
                  key={crop.id}
                  className={`farm-seed${selectedCrop.id === crop.id ? " is-selected" : ""}${empty ? " is-empty" : ""}${held ? " is-held" : ""}`}
                  aria-current={selectedCrop.id === crop.id ? "true" : undefined}
                  aria-label={empty
                    ? `${crop.name}: out of stock. Open the cabinet to buy seeds.`
                    : `${crop.name}: ${stock} in stock. Take one from the cabinet.`}
                  disabled={held || Boolean(pending)}
                  onClick={(event) => takeOrShop(crop, event)}
                >
                  <span className="farm-seed-icon" aria-hidden="true">
                    {crop.icon}
                    <span className="farm-seed-stock">{stock}</span>
                  </span>
                  <span className="farm-seed-copy">
                    <strong>{crop.name}</strong>
                    <small>{empty ? "Out of stock · buy" : `${stock} in stock`}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className={`farm-action${active ? ` is-${active.kind}` : ""}`} aria-live="polite">
          <div className="farm-action-copy">
            <span className="garden-eyebrow">
              {active ? `Plot 0${activePlot + 1}` : "Choose a patch"}
            </span>
            <h3>
              {!active
                ? "Where will we grow today?"
                : active.kind === "empty"
                  ? canPlantSeed
                    ? `${selectedCrop.name}, please`
                    : selectedStock < 1
                      ? "Out of seed packets"
                      : "Pick up a seed first"
                  : active.kind === "ready"
                    ? "Ready to gather"
                    : `${active.crop?.name ?? "Crop"} is growing`}
            </h3>
            <p>
              {!active
                ? "Click a soil patch to walk over. Take a seed from the cabinet before planting."
                : active.kind === "empty"
                  ? canPlantSeed
                    ? `${selectedCrop.icon} Planting as soon as you arrive · ready in ${duration(selectedCrop.growMs)} · +${selectedCrop.xp} XP.`
                    : selectedStock < 1
                      ? `No ${selectedCrop.name} seeds in the cupboard. Open the cabinet, buy a packet, then take it from the shelf.`
                      : `Take a ${selectedCrop.name} seed from the cabinet first.`
                  : active.kind === "ready"
                    ? `+${active.crop?.coins ?? 0} coins · +${active.crop?.food ?? 0} food · +${active.crop?.xp ?? 0} Bond XP`
                    : `Ready in ${duration(active.remaining)}. Stay close and it will grow.`}
            </p>
          </div>
          {active?.kind === "ready" && (
            <button
              type="button"
              className="farm-action-button"
              onClick={() => onHarvest(activePlot)}
              disabled={Boolean(pending)}
            >
              {pending ? "Harvesting…" : `Harvest ${active.crop?.name ?? "crop"}`}
            </button>
          )}
        </div>
      </div>

      {cabinetOpen && (
        <div className="seed-cabinet-layer">
          <div className="seed-cabinet-backdrop" aria-hidden="true" onClick={closeCabinet} />
          <div
            className="seed-cabinet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="seed-cabinet-title"
            aria-describedby="seed-cabinet-description"
          >
            <div className="seed-cabinet-head">
              <div>
                <p className="garden-eyebrow">The garden cupboard</p>
                <h2 id="seed-cabinet-title">Seed shop</h2>
              </div>
              <div className="seed-cabinet-head-actions">
                <span className="seed-cabinet-balance">
                  <span aria-hidden="true">✦</span> {coins} coins
                </span>
                <button
                  type="button"
                  className="seed-cabinet-close"
                  ref={cabinetClose}
                  onClick={closeCabinet}
                  aria-label="Close seed cabinet"
                >
                  ×
                </button>
              </div>
            </div>

            <p className="seed-cabinet-description" id="seed-cabinet-description">
              Buy packets here. A coloured jar on the cabinet means you have one
              in stock; tap that jar to take a seed.
            </p>

            {shopMessage && (
              <p className={`seed-cabinet-message ${shopMessage.tone}`} role="status">
                {shopMessage.text}
              </p>
            )}

            <div className="seed-cabinet-grid" role="group" aria-label="Seed packets for sale">
              {CROPS.map((crop) => {
                const stock = seeds?.[crop.id] ?? 0;
                const full = stock >= SEED_CAP;
                const affordable = coins >= crop.cost;
                const price = crop.cost === 0 ? "Free" : `${crop.cost} coins`;
                return (
                  <button
                    type="button"
                    key={crop.id}
                    className="seed-packet"
                    onClick={() => buySeed(crop)}
                    disabled={Boolean(pending) || full || !affordable}
                    aria-label={`Buy 1 ${crop.name} seed for ${price}. ${stock} in stock.`}
                  >
                    <span className="seed-packet-head">
                      <span className="seed-packet-icon" aria-hidden="true">{crop.icon}</span>
                      <span className="seed-packet-badge">{stock} in stock</span>
                    </span>
                    <strong>{crop.name}</strong>
                    <span className="seed-packet-note">{SEED_NOTES[crop.id]}</span>
                    <span className="seed-packet-meta">
                      <span>{price}</span>
                      <span>{duration(crop.growMs)} to grow</span>
                    </span>
                    <span className="seed-packet-reward">
                      +{crop.coins} coins · +{crop.food} food · +{crop.xp} XP
                    </span>
                    <span className="seed-packet-buy">
                      {full
                        ? "Shelf full"
                        : affordable
                          ? `Buy 1 · ${price}`
                          : `Need ${crop.cost - coins} more coins`}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="seed-cabinet-foot">
              <p><span aria-hidden="true">✦ </span>Packets go into your seed stock. Only a seed you take from the cabinet can be planted.</p>
              <button type="button" className="seed-cabinet-done" onClick={closeCabinet}>
                Back to the meadow
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
