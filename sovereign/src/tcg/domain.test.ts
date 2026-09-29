import { describe, expect, test } from "bun:test";
import { canonicalizeJson } from "../wallet/domain/intent";
import { agreementTotals, hashAgreement, makeRevision, validateRevision } from "./agreement";
import { agreementTermsSchema, evidenceInputSchema, OWNER, tradeIdSchema } from "./domain";
import { fixtureTerms, TEST_NOW } from "./fixtures";

describe("exact owner-reported agreement", () => {
  test("exact fiat totals disclose seller costs without treating them as buyer funding", () => {
    const totals = agreementTotals(fixtureTerms());
    expect(Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, String(v.atomic)]))).toEqual({ items: "303", shipping: "50", charges: "7", sellerCosts: "11", cashloomFee: "0", total: "360" });
  });
  test("18-decimal atomic units remain exact above Number safe precision", () => {
    const raw = JSON.parse(JSON.stringify(fixtureTerms()));
    const asset = { kind: "crypto", asset_id: "eip155:8453/slip44:60" };
    raw.quoteAsset = asset; raw.quoteDecimals = 18;
    raw.items[0].unitPrice = { asset, atomic: "1000000000000000001" };
    raw.shipping.amount = { asset, atomic: "0" }; raw.charges = [];
    expect(agreementTotals(agreementTermsSchema.parse(raw)).total.atomic as string).toBe("3000000000000000003");
  });
  test("canonical hashes are order-independent, version-domain separated, and bind all terms", () => {
    const terms = fixtureTerms();
    const reversed = Object.fromEntries(Object.entries(terms).reverse());
    expect(hashAgreement(agreementTermsSchema.parse(reversed))).toBe(hashAgreement(terms));
    expect(hashAgreement(agreementTermsSchema.parse({ ...terms, title: "Changed" }))).not.toBe(hashAgreement(terms));
    expect(hashAgreement(terms)).toMatch(/^tcg-agreement:v1:sha256:/);
    expect(canonicalizeJson({ z: 1, a: "1" })).toBe('{"a":"1","z":1}');
    const revision = makeRevision(tradeIdSchema.parse("trade_test"), 1, terms, TEST_NOW, OWNER);
    expect(validateRevision(revision)).toEqual(revision);
    expect(() => validateRevision({ ...revision, totals: { ...revision.totals, total: revision.totals.sellerCosts } })).toThrow();
  });
  test.each(["1.01", "-1", "01", "+1", "1e2", "0", "9".repeat(79)])("rejects invalid positive atomic quantity %s", (atomic) => {
    const raw = JSON.parse(JSON.stringify(fixtureTerms())); raw.items[0].unitPrice.atomic = atomic;
    expect(agreementTermsSchema.safeParse(raw).success).toBe(false);
  });
  test.each([0, -1, 1.5, 10001])("rejects invalid item quantity %s", (quantity) => {
    const raw = JSON.parse(JSON.stringify(fixtureTerms())); raw.items[0].quantity = quantity;
    expect(agreementTermsSchema.safeParse(raw).success).toBe(false);
  });
  test("rejects mixed assets, unknown quote metadata, negative charges, copies with many units, duplicate IDs and forged authority", () => {
    const cases = [
      (v: any) => { v.shipping.amount.asset.currency = "USD"; },
      (v: any) => { v.quoteDecimals = 18; },
      (v: any) => { v.quoteAsset.currency = "ZZZ"; },
      (v: any) => { v.charges[0].amount.atomic = "-1"; },
      (v: any) => { v.items[0].representation = "physical_copy"; },
      (v: any) => { v.items.push(v.items[0]); },
      (v: any) => { v.verified = true; },
    ];
    for (const change of cases) { const raw = JSON.parse(JSON.stringify(fixtureTerms())); change(raw); expect(agreementTermsSchema.safeParse(raw).success).toBe(false); }
  });
  test("registry lookup preserves case-sensitive chains/denoms and permits only EVM-address case variants", () => {
    const quote = (asset_id: string) => {
      const raw = JSON.parse(JSON.stringify(fixtureTerms()));
      const asset = { kind: "crypto", asset_id };
      raw.quoteAsset = asset; raw.quoteDecimals = 6;
      raw.items[0].unitPrice.asset = asset; raw.shipping.amount.asset = asset;
      raw.charges = [];
      return agreementTermsSchema.safeParse(raw).success;
    };
    expect(quote("cosmos:zerone-1/denom:uzrn")).toBe(true);
    expect(quote("cosmos:zerone-1/denom:UZRN")).toBe(false);
    expect(quote("cosmos:ZERONE-1/denom:uzrn")).toBe(false);
    expect(quote("eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toBe(true);
    expect(quote("eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(true);
  });
  test("bounded optional provenance and unrelated reference valuations never enter totals", () => {
    const terms = fixtureTerms();
    const valued = agreementTermsSchema.parse({ ...terms, referenceValuations: [{ amount: { asset: { kind: "fiat", currency: "USD" }, atomic: "99999" }, source: "Manual synthetic quote", observedAt: TEST_NOW, rights: "unknown" }] });
    expect(agreementTotals(valued)).toEqual(agreementTotals(terms));
    expect(hashAgreement(valued)).not.toBe(hashAgreement(terms));
  });
});

describe("bounded inert evidence", () => {
  test("preserves plain text and reported occurrence time", () => {
    const evidence = evidenceInputSchema.parse({ kind: "payment", text: "<b>reported, not verified</b>", occurredAt: TEST_NOW, references: ["https://example.invalid/claim"] });
    expect(evidence.text).toBe("<b>reported, not verified</b>");
  });
  test.each(["file:///tmp/secret", "javascript:alert(1)", "data:text/html,foo", "ftp://example.invalid", "https://user:secret@example.invalid"]) ("rejects non-reference URL %s", (url) => {
    expect(evidenceInputSchema.safeParse({ kind: "note", text: "x", references: [url] }).success).toBe(false);
  });
  test("bounds evidence and refuses forged provenance, actors, mode and timestamps", () => {
    for (const extra of [{ provenance: "verified" }, { actor: OWNER }, { mode: "simulation" }, { recordedAt: TEST_NOW }]) expect(evidenceInputSchema.safeParse({ kind: "note", text: "x", ...extra }).success).toBe(false);
    expect(evidenceInputSchema.safeParse({ kind: "note", text: "x".repeat(4001) }).success).toBe(false);
    expect(evidenceInputSchema.safeParse({ kind: "note", text: "x", references: Array(11).fill("https://example.invalid") }).success).toBe(false);
    expect(evidenceInputSchema.safeParse({ kind: "correction", text: "x" }).success).toBe(false);
  });
});
