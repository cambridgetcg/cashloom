import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CASHLOOM_CAPABILITIES } from "../../sovereign/src/info/capabilities.ts";
import { MODULES } from "../src/atlas.manifest.ts";

const sourceRoot = join(import.meta.dir, "../src");

function filesBelow(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

describe("Atlas public boundary", () => {
  it("contains no runtime network client or payment mutation call", () => {
    const violations: string[] = [];
    for (const path of filesBelow(sourceRoot)) {
      if (!/\.(?:ts|tsx)$/u.test(path)) continue;
      // These two files deliberately carry source code as inert strings for
      // the code reader. Runtime UI modules remain network-incapable.
      if (path.endsWith("/sources.ts") || path.endsWith("/atlas.manifest.ts")) continue;
      const source = readFileSync(path, "utf8");
      for (const forbidden of [
        /\bfetch\s*\(/u,
        /\bXMLHttpRequest\b/u,
        /\bWebSocket\b/u,
        /\/api\/vault/u,
        /\/api\/pay/u,
        /\/api\/v2\/pay-links\/executions/u,
      ]) {
        if (forbidden.test(source)) violations.push(`${path}: ${forbidden}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("embeds no remote script, stylesheet, font, image, or frame", () => {
    const html = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
    expect(html).not.toMatch(
      /<(?:script|link|img|iframe)[^>]+(?:src|href)=["']https?:/iu,
    );
    expect(html).toContain("Content-Security-Policy");
  });

  it("publishes the hosted/local authority split from the shared contract", () => {
    expect(CASHLOOM_CAPABILITIES.hosted_surface.moves_money).toBe(false);
    expect(CASHLOOM_CAPABILITIES.hosted_surface.identity_authority).toBe("none");
    expect(CASHLOOM_CAPABILITIES.participant_node.default_origin).toBe(
      "http://127.0.0.1:4747",
    );
    expect(CASHLOOM_CAPABILITIES.distribution.some(
      ({ id, status }) => id === "desktop_app" && status.includes("not_released"),
    )).toBe(true);
    const bitcoin = CASHLOOM_CAPABILITIES.rails.find(
      ({ id }) => id === "bitcoin_mainnet",
    );
    const base = CASHLOOM_CAPABILITIES.rails.find(
      ({ id }) => id === "base_eth_usdc",
    );
    const stripe = CASHLOOM_CAPABILITIES.rails.find(
      ({ id }) => id === "stripe_connect",
    );
    expect(bitcoin && "local_send" in bitcoin ? bitcoin.local_send : null).toBe(
      "implemented",
    );
    expect(base && "local_send" in base ? base.local_send : null).toBe(
      "implemented",
    );
    expect(
      stripe && "live_transport" in stripe ? stripe.live_transport : null,
    ).toBe("not_released");
  });

  it("keeps essential small text above WCAG AA contrast", () => {
    const css = readFileSync(join(sourceRoot, "styles.css"), "utf8");
    const colour = (name: string) => {
      const value = css.match(
        new RegExp(`--${name}:\\s*#([0-9a-f]{6})`, "i"),
      )?.[1];
      if (!value) throw new Error(`missing --${name}`);
      return value.match(/../g)!.map((pair) => Number.parseInt(pair, 16) / 255);
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((channel) =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4
      );
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const foreground = luminance(colour("fg-3"));
    const background = luminance([0x18 / 255, 0x14 / 255, 0x1f / 255]);
    expect((foreground + 0.05) / (background + 0.05)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("fails when a load-bearing source marker drifts away from real code", () => {
    const missing: string[] = [];
    for (const module of MODULES) {
      const sourceTexts = module.sources.map((specifier) =>
        readFileSync(
          join(sourceRoot, specifier.replace("?raw", "")),
          "utf8",
        )
      );
      for (const { marker } of module.loadBearing) {
        if (!sourceTexts.some((source) => source.includes(marker))) {
          missing.push(`${module.id}: ${marker}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
