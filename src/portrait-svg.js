import DOMPurify from "dompurify";

const ANIMATED_PARTS = new Set([
  "gp-root", "gp-head", "gp-ears", "gp-mane", "gp-face", "gp-eyes",
  "gp-eyewear", "gp-accessory-front",
]);

/** Give each inline portrait its own paint servers and clip paths. */
export function namespacePortraitSvg(svg, scope) {
  if (!svg) return "";
  if (!scope) throw new Error("A portrait scope is required.");
  const prefix = `glowpet-${String(scope).replace(/[^a-z0-9_-]/gi, "-")}-`;
  const ids = new Map();
  const idAttribute = /\sid\s*=\s*(["'])([A-Za-z_][\w:.-]*)\1/g;
  const source = String(svg);
  for (const match of source.matchAll(idAttribute)) ids.set(match[2], prefix + match[2]);
  return source
    .replace(idAttribute, (_, quote, id) =>
      ` id=${quote}${ids.get(id)}${quote}` +
      (ANIMATED_PARTS.has(id) ? ` data-glowpet-part="${id}"` : ""),
    )
    .replace(/url\(\s*(["']?)#([A-Za-z_][\w:.-]*)\1\s*\)/g, (reference, quote, id) =>
      ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : reference,
    )
    .replace(/(\s(?:xlink:)?href\s*=\s*)(["'])#([A-Za-z_][\w:.-]*)\2/g,
      (reference, attribute, quote, id) => ids.has(id)
        ? `${attribute}${quote}#${ids.get(id)}${quote}` : reference,
    );
}

export function sanitizePortrait(svg, scope) {
  // Scoping first also preserves legacy id="head" gradients, which the
  // sanitizer otherwise removes as a document-clobbering ID. DOMPurify remains
  // the security boundary; rewriting IDs is only for reference isolation.
  return DOMPurify.sanitize(namespacePortraitSvg(svg, scope), {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed", "style"],
  });
}
