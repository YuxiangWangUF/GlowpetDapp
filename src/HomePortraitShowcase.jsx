import { useState } from "react";
import { ARTWORK_VERSION, decodeAppearance, HEADWEAR, NECKWEAR, PALETTES, SPECIES } from "../shared/deltax-traits.js";
import { HOME_APPEARANCES } from "../shared/deltax-home-preview.js";
import "./home-portrait-showcase.css";

// Display copies of the verified edition, independent of the connected NFT.
const PREVIEWS = HOME_APPEARANCES.map((appearanceId) => {
  const traits = decodeAppearance(appearanceId);
  return {
    ...SPECIES[traits.speciesIndex],
    appearanceId,
    src: `/pets/${ARTWORK_VERSION}/${appearanceId}.webp`,
    headwear: HEADWEAR[traits.headwear],
    neckwear: NECKWEAR[traits.neckwear],
    palette: PALETTES[traits.palette],
  };
});

export default function HomePortraitShowcase() {
  const [selected, setSelected] = useState(0);
  const [failedSources, setFailedSources] = useState([]);
  const preview = PREVIEWS[selected];
  const unavailable = failedSources.includes(preview.src);

  return (
    <section className="home-portrait-showcase" aria-label="New collection artwork preview">
      <div className="home-portrait-heading">
        <span>CHINESE WARDROBE</span>
        <span className="home-portrait-badge">Collection preview</span>
      </div>
      <div className="home-portrait-stage">
        <span className="home-portrait-character" aria-hidden="true">{preview.label}</span>
        {unavailable ? (
          <p className="home-portrait-unavailable" role="status">This portrait is unavailable. Try another companion.</p>
        ) : (
          <img
            key={preview.src}
            className="home-portrait-image"
            src={preview.src}
            width="900"
            height="900"
            alt={`${preview.name} wearing ${preview.headwear} and ${preview.neckwear} in ${preview.palette}`}
            fetchPriority="high"
            onError={() => setFailedSources((sources) => [...sources, preview.src])}
          />
        )}
      </div>
      <div className="home-portrait-caption" aria-live="polite" aria-atomic="true">
        <h2>{preview.name} <span>· {preview.label}</span></h2>
        <p>{preview.headwear} · {preview.neckwear}{preview.headwear === "Lion Cap" ? " · Cat exclusive" : ""}</p>
      </div>
      <div className="home-portrait-options" role="group" aria-label="Choose a preview companion">
        {PREVIEWS.map((item, index) => (
          <button
            type="button"
            key={item.id}
            aria-label={`Preview ${item.name}`}
            aria-pressed={selected === index}
            onClick={() => setSelected(index)}
          >
            <img src={item.src} alt="" width="900" height="900" />
            <span>{item.name}</span>
          </button>
        ))}
      </div>
      <p className="home-portrait-note">A first look at our next collection. These previews have not been minted.</p>
    </section>
  );
}
