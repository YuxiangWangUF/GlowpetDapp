import assert from "node:assert/strict";
import test from "node:test";
import { namespacePortraitSvg } from "../src/portrait-svg.js";

const portrait = `<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg"><stop stop-color="#ff0000"/></linearGradient>
    <radialGradient id='head'><stop stop-color="#ffffff"/></radialGradient>
    <clipPath id="hc"><ellipse rx="100" ry="80"/></clipPath>
  </defs>
  <rect fill="url(#bg)"/>
  <g id="gp-head"><ellipse fill="url('#head')" clip-path="url( #hc )"/></g>
  <g id="gp-eyes"><use href="#gp-head"/><use xlink:href='#gp-head'/></g>
  <text>测试 &amp; Glowpet</text>
</svg>`;

function definitions(svg) {
  return [...svg.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
}

test("inline gallery portraits resolve paint, clips and local links to their own definitions", () => {
  const first = namespacePortraitSvg(portrait, "gallery-1000001");
  const second = namespacePortraitSvg(portrait.replace("#ff0000", "#0000ff"), "gallery-1000002");
  const firstIds = definitions(first);
  const secondIds = definitions(second);
  assert.equal(firstIds.length, 5);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 10);
  for (const svg of [first, second]) {
    const ids = definitions(svg);
    const urls = [...svg.matchAll(/url\(["']?#([^)'"\s]+)["']?\)/g)].map((match) => match[1]);
    const links = [...svg.matchAll(/href=["']#([^"']+)["']/g)].map((match) => match[1]);
    assert.equal(urls.length, 3);
    assert.equal(links.length, 2);
    for (const reference of [...urls, ...links]) assert.ok(ids.includes(reference));
    assert.match(svg, /data-glowpet-part="gp-head"/);
    assert.match(svg, /data-glowpet-part="gp-eyes"/);
    assert.match(svg, /测试 &amp; Glowpet/);
  }
  assert.match(first, /stop-color="#ff0000"/);
  assert.match(second, /stop-color="#0000ff"/);
});

test("React instance scopes are stable, attribute-safe and mandatory", () => {
  assert.equal(namespacePortraitSvg(portrait, ":r1:"), namespacePortraitSvg(portrait, ":r1:"));
  assert.ok(definitions(namespacePortraitSvg(portrait, ":r1:")).every((id) => /^[a-z0-9_-]+$/i.test(id)));
  assert.throws(() => namespacePortraitSvg(portrait), /scope is required/);
  assert.equal(namespacePortraitSvg("", "empty"), "");
});
