import { useEffect, useRef, useState } from "react";
import { createPlushFaceRenderer } from "./plush-face-renderer.js";
import { getPlushIdlePose } from "./plush-idle-motion.js";
import { PLUSH_RIGS } from "./plush-rigs.js";

const REST = { blink: 0, leftEar: 0, rightEar: 0 };

/** Animate only the eyes and ears; the original PNG remains the fallback. */
export default function PlushFace({ companion, style, motion, forceMotion, onError }) {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const elapsedRef = useRef(0);
  const [surface, setSurface] = useState({ source: "", ready: false });
  const [reducedMotion, setReducedMotion] = useState(
    () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const ready = surface.source === companion.assetSrc && surface.ready;
  const playing = motion && (forceMotion || !reducedMotion) && visible;

  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onPreference = () => setReducedMotion(media?.matches ?? false);
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    media?.addEventListener?.("change", onPreference);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      media?.removeEventListener?.("change", onPreference);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const source = companion.assetSrc;
    elapsedRef.current = 0;
    setSurface({ source, ready: false });
    const renderer = createPlushFaceRenderer(canvasRef.current, {
      onReady: () => {
        if (mounted) setSurface({ source, ready: true });
      },
      onError: () => {
        if (mounted) setSurface({ source, ready: false });
      },
    });
    rendererRef.current = renderer;
    renderer.load(source, PLUSH_RIGS[companion.id]);
    return () => {
      mounted = false;
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [companion.id, companion.assetSrc]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !ready) return;
    if (!playing) {
      renderer.draw(REST);
      return;
    }
    let frame;
    let previous = performance.now();
    let lastDraw = -Infinity;
    const draw = (timestamp) => {
      elapsedRef.current += Math.min(0.1, Math.max(0, timestamp - previous) / 1_000);
      previous = timestamp;
      // Thirty frames per second keeps the short blink smooth while avoiding
      // unnecessary texture draws on high-refresh-rate displays.
      if (timestamp - lastDraw >= 1_000 / 30) {
        renderer.draw(getPlushIdlePose(elapsedRef.current, companion.id));
        lastDraw = timestamp;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [ready, playing, companion.id]);

  return (
    <>
      <img
        className="plush-companion-image"
        src={companion.assetSrc}
        alt={companion.description}
        style={{ ...style, visibility: ready ? "hidden" : undefined }}
        draggable={false}
        decoding="async"
        onError={onError}
      />
      <canvas
        ref={canvasRef}
        className="plush-companion-image plush-companion-face"
        style={{ ...style, visibility: ready ? "visible" : "hidden" }}
        width={1254}
        height={1254}
        aria-hidden="true"
        data-face-status={ready ? "ready" : "fallback"}
      />
    </>
  );
}
