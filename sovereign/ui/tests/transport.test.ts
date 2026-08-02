import { describe, expect, it } from "bun:test";
import {
  allowsSensitiveBrowserTransport,
  isLoopbackHostname,
} from "../src/transport";

describe("sensitive browser transport", () => {
  it("allows the default loopback origins over HTTP", () => {
    for (const hostname of ["127.0.0.1", "localhost", "[::1]", "::1"]) {
      expect(isLoopbackHostname(hostname)).toBe(true);
      expect(
        allowsSensitiveBrowserTransport({ hostname, protocol: "http:" }),
      ).toBe(true);
    }
  });

  it("allows a non-loopback origin only through HTTPS", () => {
    expect(
      allowsSensitiveBrowserTransport({
        hostname: "node.example",
        protocol: "https:",
      }),
    ).toBe(true);
    expect(
      allowsSensitiveBrowserTransport({
        hostname: "192.168.1.40",
        protocol: "http:",
      }),
    ).toBe(false);
  });
});
