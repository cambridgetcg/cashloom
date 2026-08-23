import { describe, expect, it } from "vitest";
import {
  accountRefKey,
  assetRefKey,
  chainIdFromAccountId,
  cryptoAccountRef,
  cryptoAssetRef,
  fiatAccountRef,
  fiatAssetRef,
  parseCaip10AccountId,
  parseCaip19AssetId,
  parseChainId,
  parseIso4217Currency,
  positionId,
} from "./identities";

const EVM_ACCOUNT = "eip155:1:0xAbCDEF0123456789AbcdEF0123456789aBCDEF01";
const EVM_ETH = "eip155:1/slip44:60";
const BASE_ETH = "eip155:8453/slip44:60";

describe("Wallet Kernel identities", () => {
  it("accepts CAIP-2, CAIP-10, and CAIP-19 shapes without rewriting addresses", () => {
    expect(parseChainId("eip155:1")).toBe("eip155:1");
    expect(parseChainId("bip122:000000000019d6689c085ae165831e93")).toContain("bip122:");
    expect(parseCaip10AccountId(EVM_ACCOUNT)).toBe(EVM_ACCOUNT);
    expect(parseCaip19AssetId(EVM_ETH)).toBe(EVM_ETH);
    expect(parseCaip19AssetId("eip155:1/erc721:0xabc/42")).toContain("erc721");
    expect(chainIdFromAccountId(parseCaip10AccountId(EVM_ACCOUNT))).toBe("eip155:1");
  });

  it("rejects non-canonical or over-broad identifier syntax", () => {
    expect(() => parseChainId("EIP155:1")).toThrow();
    expect(() => parseChainId("eip155:01")).toThrow(/canonical unsigned/);
    expect(() => parseChainId("bip122:ABCDEF00000000000000000000000000")).toThrow(/lowercase/);
    expect(() => parseChainId("eip155:")).toThrow();
    expect(() => parseCaip10AccountId("eip155:1:address with spaces")).toThrow();
    expect(() => parseCaip19AssetId("USDC")).toThrow();
  });

  it("keeps fiat currency uppercase and provider account references opaque", () => {
    expect(parseIso4217Currency("USD")).toBe("USD");
    expect(() => parseIso4217Currency("usd")).toThrow();

    const account = fiatAccountRef("stripe", "acct_01HXYZ");
    const asset = fiatAssetRef("USD");
    expect(accountRefKey(account)).toBe("fiat:stripe:acct_01HXYZ");
    expect(assetRefKey(asset)).toBe("iso4217:USD");
    expect(() => fiatAccountRef("Stripe", "acct_01HXYZ")).toThrow();
    expect(() => fiatAccountRef("bank", "GB29 NWBK 6016 1331 9268 19")).toThrow();
  });

  it("derives stable, asset-qualified position ids", () => {
    const account = cryptoAccountRef(EVM_ACCOUNT);
    const eth = cryptoAssetRef(EVM_ETH);
    const first = positionId(account, eth);
    const second = positionId(account, eth);
    expect(first).toBe(second);
    expect(first).toMatch(/^position:v1:sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(account)).toBe(true);

    expect(() => positionId(account, cryptoAssetRef(BASE_ETH))).toThrow(/chain mismatch/);
    expect(() => positionId(account, fiatAssetRef("USD"))).toThrow(/cannot directly hold/);
  });
});
