import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// cashloom.io serves the brand kit (brand/kit, built by artcraft-brand) as built, and index.html, the head of every
// route, says what the kit says. When a check fails, copy the kit's web/ files again or rebuild the kit from its
// source/brand.json; never hand-edit the kit.
const kitWeb = new URL("../../brand/kit/web/", import.meta.url);
const publicDir = new URL("../public/", import.meta.url);
const served = [
  "favicon.ico",
  "favicon.svg",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "site.webmanifest",
  "og.jpg",
];
const kitHead = readFileSync(new URL("head-snippet.html", kitWeb), "utf8");
const indexHead = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/\s*\/>/g, ">");
// Every <meta> tag's attributes, in any order, quoting or line breaks, so a second tag can't hide in other formatting.
const metaTags = (html: string) =>
  [...html.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].map(([tag]) =>
    Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)].map(m => [
        m[1].toLowerCase(),
        m[2] ?? m[3] ?? m[4],
      ]),
    ) as Record<string, string | undefined>,
  );
const metas = (html: string, key: string) =>
  metaTags(html)
    .filter(attrs => (attrs.name ?? attrs.property) === key)
    .map(attrs => attrs.content);

describe("brand kit served from atlas/public", () => {
  it.each(served)("public/%s matches the kit", name => {
    expect(readFileSync(new URL(name, publicDir)).equals(readFileSync(new URL(name, kitWeb)))).toBe(true);
  });

  it("serves every icon the manifest names", () => {
    const manifest = JSON.parse(readFileSync(new URL("site.webmanifest", publicDir), "utf8"));
    for (const icon of manifest.icons) expect(served).toContain(icon.src.replace(/^\//, ""));
  });
});

describe("index.html head from the kit", () => {
  it("links the kit's icons and manifest", () => {
    const links = kitHead.match(/<link [^>]+>/g) ?? [];
    expect(links).toHaveLength(4);
    for (const link of links) expect(indexHead).toContain(link);
  });

  it("sets the kit's color-scheme once and its one theme-color", () => {
    const [scheme] = metas(kitHead, "color-scheme");
    expect(scheme, "the kit has no color-scheme meta").toBeDefined();
    expect(metas(indexHead, "color-scheme")).toEqual([scheme]);
    const themeColours = (html: string) =>
      metaTags(html)
        .filter(attrs => attrs.name === "theme-color")
        .map(attrs => [attrs.content?.toLowerCase(), attrs.media]);
    expect(themeColours(kitHead).length, "the kit has no theme-color meta").toBeGreaterThan(0);
    expect(themeColours(indexHead)).toEqual(themeColours(kitHead));
  });

  it("names the kit's share card by an absolute URL", () => {
    expect(metas(indexHead, "og:image")).toEqual([expect.stringMatching(/^https:\/\/[^/]+\/og\.jpg$/)]);
    for (const key of ["og:image", "og:image:type", "og:image:width", "og:image:height", "og:image:alt"])
      expect(metas(indexHead, key), key).toEqual(metas(kitHead, key));
    expect(metas(indexHead, "twitter:card")).toEqual(["summary_large_image"]);
  });
});
