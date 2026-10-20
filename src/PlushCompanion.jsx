import { useState } from "react";
import PlushFace from "./PlushFace.jsx";
import "./plush-companion.css";

const ASSET_ROOT = "/pets/deltax-soft-v1";
const SOURCE_SIZE = 1254;

export const DELTAX_COMPANIONS = Object.freeze([
  {
    id: "rabbit",
    name: "Bunny",
    label: "小兔",
    speciesCode: 2,
    bounds: [86, 51, 1168, 1186],
    description: "A cream plush bunny with a folded ear, rosy cheeks, and a little golden cheek star",
  },
  {
    id: "cat",
    name: "Kitty",
    label: "小猫",
    speciesCode: 0,
    bounds: [187, 268, 1109, 1026],
    description: "A cream plush kitten with little triangular ears, rosy cheeks, and a little golden cheek star",
  },
  {
    id: "fox",
    name: "Fox",
    label: "小狐狸",
    speciesCode: 4,
    bounds: [264, 266, 1076, 1013],
    description: "An apricot plush fox with a cream face and tail tip, rosy cheeks, and a little golden cheek star",
  },
  {
    id: "mouse",
    name: "Mouse",
    label: "小鼠",
    speciesCode: 9,
    bounds: [235, 320, 1020, 969],
    description: "A soft gray plush mouse with round pink ears, a little curl of hair, and a golden cheek star",
  },
  {
    id: "sheep",
    name: "Lamb",
    label: "小羊",
    speciesCode: 7,
    bounds: [208, 331, 1048, 974],
    description: "A cream plush lamb with cloudlike wool, floppy ears, rosy cheeks, and a little golden cheek star",
  },
].map((companion) => Object.freeze({
  ...companion,
  bounds: Object.freeze(companion.bounds),
  assetSrc: `${ASSET_ROOT}/${companion.id}.png`,
})));

// Use a square relative-positioned frame. Transparent canvas can extend past
// the frame; the visible character stays centered above a shared paw baseline.
export function getCompanionImageStyle(companion) {
  const model = typeof companion === "string"
    ? DELTAX_COMPANIONS.find((entry) => entry.id === companion)
    : companion;
  const [left, top, right, bottom] = (model ?? DELTAX_COMPANIONS[0]).bounds;
  const scale = Math.min(
    0.88 * SOURCE_SIZE / (right - left),
    0.83 * SOURCE_SIZE / (bottom - top),
  );
  const percent = (value) => `${Number((value * 100).toFixed(6))}%`;
  return {
    position: "absolute",
    left: percent(0.5 - (left + right) / 2 / SOURCE_SIZE * scale),
    top: percent(0.9 - bottom / SOURCE_SIZE * scale),
    width: percent(scale),
    height: percent(scale),
    maxWidth: "none",
    maxHeight: "none",
    objectFit: "contain",
  };
}

export default function PlushCompanion({
  model = "rabbit",
  motion = true,
  forceMotion = false,
  compact = false,
  reaction = null,
}) {
  const companion = DELTAX_COMPANIONS.find((entry) => entry.id === model)
    ?? DELTAX_COMPANIONS[0];
  const [failedSource, setFailedSource] = useState(null);
  const imageFailed = failedSource === companion.assetSrc;
  const reactionType = typeof reaction === "string" ? reaction : reaction?.type;
  const activeReaction = ["feed", "play", "tap", "plant", "harvest"].includes(reactionType) ? reactionType : "";
  const reactionKey = `${activeReaction}:${typeof reaction === "object" ? reaction?.id ?? reaction?.key ?? "" : ""}`;

  return (
    <div
      className={`plush-companion${compact ? " is-compact" : ""}${imageFailed ? " has-image-error" : ""}`}
      data-model={companion.id}
      data-motion={motion ? "on" : "off"}
      data-force-motion={forceMotion ? "true" : undefined}
      data-reaction={activeReaction || undefined}
      role="img"
      aria-label={imageFailed ? `${companion.name}. Character image is unavailable.` : companion.description}
    >
      {!imageFailed && (
        <div className="plush-companion-atmosphere" aria-hidden="true">
          <span className="plush-companion-spark plush-companion-spark-one" />
          <span className="plush-companion-spark plush-companion-spark-two" />
          <span className="plush-companion-spark plush-companion-spark-three" />
          <span className="plush-companion-shadow" />
        </div>
      )}
      {imageFailed ? (
        <div className="plush-companion-fallback" aria-hidden="true">
          <span>{companion.name}</span>
          <small>Character image is unavailable</small>
        </div>
      ) : (
        <div className="plush-companion-reaction" key={`${companion.id}:${reactionKey}`}>
          <div className="plush-companion-sway">
            <div className="plush-companion-breath">
              <PlushFace
                companion={companion}
                style={getCompanionImageStyle(companion)}
                motion={motion}
                forceMotion={forceMotion}
                onError={() => setFailedSource(companion.assetSrc)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
