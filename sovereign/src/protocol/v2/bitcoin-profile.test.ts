import { describe, expect, test } from "bun:test";
import {
  BITCOIN_MAINNET_ASSET_ID,
  BITCOIN_MAINNET_RAIL,
  BITCOIN_PAY_LINK_MAX_FEE_SATOSHIS,
  bitcoinMainnetTrustManifest,
  parseBitcoinPayLinkMaxFeeSatoshis,
  parseBitcoinPaymentTerms,
} from "./bitcoin-profile.ts";
import { evaluateAssetTrust } from "./asset-trust.ts";

const DESTINATION = "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty";

describe("Bitcoin Pay Link profile", () => {
  test("creates a strict local mainnet assessment accepted by fail-closed policy", () => {
    const manifest = bitcoinMainnetTrustManifest(
      "2030-01-01T00:00:00.000Z",
    );
    expect(manifest.asset_id).toBe(BITCOIN_MAINNET_ASSET_ID);
    expect(manifest.rail).toBe(BITCOIN_MAINNET_RAIL);
    expect(evaluateAssetTrust(manifest).accepted).toBe(true);
  });

  test("validates canonical mainnet destinations and their dust floor", () => {
    expect(parseBitcoinPaymentTerms(DESTINATION, "1000")).toEqual({
      destination: DESTINATION,
      amount_sats: "1000",
    });
    expect(
      parseBitcoinPaymentTerms(DESTINATION.toUpperCase(), "1000").destination,
    ).toBe(DESTINATION);
    expect(() =>
      parseBitcoinPaymentTerms("tb1qwrongnetwork", "1000"),
    ).toThrow(/mainnet address/i);
    expect(() => parseBitcoinPaymentTerms(DESTINATION, "293")).toThrow(
      /294-sat/i,
    );
  });

  test("refuses ambiguous, non-canonical, and impossible amounts", () => {
    for (const amount of ["", "0", "01", "-1", "1.0", "x"]) {
      expect(() => parseBitcoinPaymentTerms(DESTINATION, amount)).toThrow(
        /amount_sats/i,
      );
    }
    expect(() =>
      parseBitcoinPaymentTerms(DESTINATION, "2100000000000001"),
    ).toThrow(/maximum Bitcoin supply/i);
  });

  test("bounds the canonical non-negative Pay Link fee ceiling", () => {
    expect(parseBitcoinPayLinkMaxFeeSatoshis("0")).toBe("0");
    expect(
      parseBitcoinPayLinkMaxFeeSatoshis(
        BITCOIN_PAY_LINK_MAX_FEE_SATOSHIS.toString(),
      ),
    ).toBe("100000000");
    for (const amount of ["", "01", "-1", "1.0", "100000001"]) {
      expect(() => parseBitcoinPayLinkMaxFeeSatoshis(amount)).toThrow(
        /max_fee_sats/i,
      );
    }
  });
});
