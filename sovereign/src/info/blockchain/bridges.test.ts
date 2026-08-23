import { describe, expect, it } from "vitest";
import { parseCctpAllowanceResponse, parseCctpFeeResponse } from "./bridges.ts";

describe("Circle CCTP exact reference parsers", () => {
  it("preserves decimal fee lexemes without binary floating point", () => {
    const fees = parseCctpFeeResponse('[{"finalityThreshold":1000,"minimumFee":1.30},{"minimumFee":0,"finalityThreshold":2000}]');
    expect(fees).toEqual([
      expect.objectContaining({ mode: "fast", finality_threshold: "1000", fee_bps: expect.objectContaining({ raw: "130", decimals: 2, decimal: "1.3" }) }),
      expect.objectContaining({ mode: "standard", finality_threshold: "2000", fee_bps: expect.objectContaining({ raw: "0", decimals: 0, decimal: "0" }) }),
    ]);
  });

  it("preserves the global fast-burn allowance and timestamp", () => {
    expect(parseCctpAllowanceResponse('{"allowance":53275506.114817,"lastUpdated":"2026-08-20T18:00:00Z"}')).toEqual({
      allowance: {
        raw: "53275506114817",
        decimal: "53275506.114817",
        decimals: 6,
        unit: "USDC",
        display: "53275506.114817 USDC",
      },
      last_updated: "2026-08-20T18:00:00.000Z",
    });
  });

  it("refuses negative and malformed fees", () => {
    expect(() => parseCctpFeeResponse('[{"finalityThreshold":2000,"minimumFee":-1}]')).toThrow();
    expect(() => parseCctpFeeResponse('{"minimumFee":0}')).toThrow();
    expect(() => parseCctpFeeResponse('[{"finalityThreshold":2000,"minimumFee":0,"minimumFee":1}]')).toThrow();
    expect(() => parseCctpAllowanceResponse('{"allowance":1,"allowance":2}')).toThrow();
  });
});
