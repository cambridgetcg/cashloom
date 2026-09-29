import { describe, expect, test } from "bun:test";
import { agreementTermsSchema, OWNER, tradeIdSchema } from "../../src/tcg/domain";
import { agreementTotals, makeRevision } from "../../src/tcg/agreement";
import { appendTradePage, createTradeAttempt, draftTerms, previewTradeTotal, staleAcceptances, tradeAtomic, tradeDecimal, tradeDraft, tradeReferences, tradeTimestamp } from "../src/trades";
import type { TradeRecord } from "../src/types";

export function syntheticTerms() {
  const draft = tradeDraft();
  Object.assign(draft, { title: "Synthetic card bundle", originChannel: "manual", buyerLabel: "Buyer", sellerLabel: "Seller", disputeTerms: "Review condition evidence", returnTerms: "Return tracked; full refund after receipt", expiresAt: "2099-01-01T00:00:00.000Z" });
  Object.assign(draft.items[0], { game: "Synthetic game", cardName: "Example card", unitPriceText: "12.34", condition: { description: "Owner-reported corner wear", standard: "manual" } });
  draft.shipping.responsibility = "Seller ships; buyer pays disclosed charge";
  return draftTerms(draft);
}

describe("Trades exact amounts and shared contract", () => {
  test("appends older list pages without replacing a newer in-memory record", () => {
    expect(appendTradePage([{ id: "trade_2", version: 3 }], [{ id: "trade_2", version: 1 }, { id: "trade_1", version: 1 }])).toEqual([{ id: "trade_2", version: 3 }, { id: "trade_1", version: 1 }]);
  });
  test("preserves last atomic digit at 18 decimals and huge values", () => {
    expect(tradeAtomic("1.000000000000000001", 18)).toBe("1000000000000000001");
    expect(tradeDecimal("1000000000000000001", 18)).toBe("1.000000000000000001");
    expect(tradeAtomic("9007199254740993.01", 2)).toBe("900719925474099301");
    expect(tradeDecimal("1", 18)).toBe("0.000000000000000001");
    for (const value of ["1e3", "-1", "NaN", "0.001", "1,000", "01", "Infinity"]) expect(() => tradeAtomic(value, 2)).toThrow();
    expect(() => tradeAtomic("0", 2, true)).toThrow();
    expect(() => tradeAtomic("1", 19)).toThrow();
  });
  test("draft uses canonical server schema and round-trips metadata without loss", () => {
    const terms = syntheticTerms();
    terms.items[0].catalog = [{ source: "manual catalog", identifier: "SKU:/opaque-001", provenance: { source: "owner transcription", rights: "unknown" } }];
    terms.items[0].grading = { company: "Reported grader", grade: "9", certificate: "claim-only" };
    terms.items[0].metadata = [{ key: "format", value: "unknown", provenance: { source: "manual", rights: "restricted" } }];
    expect(agreementTermsSchema.safeParse(terms).success).toBe(true);
    expect(draftTerms(tradeDraft(terms))).toEqual(terms);
  });
  test("buyer totals exclude seller costs; all quantities stay exact in one asset", () => {
    const draft = tradeDraft(syntheticTerms());
    draft.items[0].representation = "homogeneous_lot"; draft.items[0].quantityText = "3";
    draft.shipping.amountText = "2.10"; draft.shipping.payer = "seller";
    draft.charges = [{ label: "Buyer postage", amountText: "1.01", payer: "buyer" }, { label: "Seller packaging", amountText: "0.33", payer: "seller" }];
    const terms = draftTerms(draft);
    expect(previewTradeTotal(terms)).toBe("38.03");
    expect(agreementTotals(terms).total.atomic).toBe("3803");
    expect(agreementTotals(terms).sellerCosts.atomic).toBe("243");
    draft.assetKind = "crypto"; draft.assetIdentifier = "eip155:8453/slip44:60"; draft.decimalsText = "18";
    draft.items[0].unitPriceText = "0.000000000000000001"; draft.shipping.amountText = "0"; draft.charges = [];
    const crypto = draftTerms(draft);
    expect(previewTradeTotal(crypto)).toBe("0.000000000000000003");
    expect(agreementTermsSchema.safeParse(crypto).success).toBe(true);
    draft.decimalsText = "6";
    expect(() => draftTerms(draft)).toThrow("fixed decimal scale");
  });
  test("requires explicit occurrence/expiry timezone and rejects invalid calendar dates", () => {
    expect(tradeTimestamp("2026-09-14T12:00:00+01:00")).toBe("2026-09-14T11:00:00.000Z");
    for (const value of ["2026-09-14", "2026-09-14T12:00:00", "2026-02-30T12:00:00.000Z"]) expect(() => tradeTimestamp(value)).toThrow();
  });
  test("rejects wrong representation quantities and unsafe source references", () => {
    const draft = tradeDraft(syntheticTerms()); draft.items[0].quantityText = "2";
    expect(() => draftTerms(draft)).toThrow("physical copy");
    expect(tradeReferences("https://example.invalid/evidence\nhttp://example.invalid/source")).toHaveLength(2);
    for (const value of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.invalid/"]) expect(() => tradeReferences(value)).toThrow();
  });
  test("acceptance stays stale when revision advances", () => {
    const terms = syntheticTerms();
    const first = makeRevision(tradeIdSchema.parse("trade_test"), 1, terms, "2026-09-14T00:00:00.000Z", OWNER);
    const second = makeRevision(first.tradeId, 2, { ...terms, title: "Changed terms" }, first.recordedAt, OWNER);
    const record: TradeRecord = {
      mode: "record", id: first.tradeId, version: 3, currentRevision: 2, protection: "unavailable", notice: "Record only — no escrow protection.", current: second, revisions: [first, second],
      evidence: [{ mode: "record", kind: "acceptance", text: "Reported acceptance", id: "evidence_1", tradeId: first.tradeId, revision: 1, agreementHash: first.hash, provenance: "owner_reported", recordedAt: first.recordedAt, actor: OWNER }],
      createdAt: first.recordedAt, updatedAt: second.recordedAt,
    };
    expect(staleAcceptances(record).map((e) => e.revision)).toEqual([1]);
    expect(record.evidence[0].agreementHash).toBe(first.hash);
  });
});

describe("Trades mutation identity", () => {
  test("exact retry retains key, original expectedVersion and immutable payload", async () => {
    const sent: unknown[] = [];
    const payload = { expectedVersion: 7, command: { type: "fund" } };
    const attempt = createTradeAttempt(payload, async (body) => {
      sent.push(body);
      if (sent.length === 1) throw new TypeError("Failed to fetch");
      return "saved";
    }, "synthetic-key");
    await expect(attempt.run()).rejects.toThrow();
    payload.expectedVersion = 8; payload.command.type = "cancel";
    expect(await attempt.run()).toBe("saved");
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]).toEqual({ expectedVersion: 7, command: { type: "fund" }, idempotencyKey: "synthetic-key" });
  });
  test("duplicate clicks share one in-flight request", async () => {
    let calls = 0;
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const attempt = createTradeAttempt({ expectedVersion: 0 }, async () => { calls++; await barrier; return "saved"; }, "synthetic-key");
    const first = attempt.run(); const second = attempt.run();
    expect(first).toBe(second);
    await Promise.resolve(); expect(calls).toBe(1);
    finish(); expect(await first).toBe("saved");
  });
});
