import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { makeRevision } from "../../src/tcg/agreement";
import { OWNER, simulationIdSchema, tradeIdSchema } from "../../src/tcg/domain";
import { initialSimulationState, permittedActions } from "../../src/tcg/simulation";
import { draftTerms, tradeDraft } from "../src/trades";
import type { SimulationRun, TradeRecord } from "../src/types";
import { TradeNotice, TradeRecordPanel, TradeSimulationPanel } from "../src/views/Trades";
import { TradeTermsEditor } from "../src/views/TradeTermsEditor";

function fixture() {
  const draft = tradeDraft();
  Object.assign(draft, { title: "<script>not HTML</script>", originChannel: "manual", buyerLabel: "Buyer", sellerLabel: "Seller", disputeTerms: "Inspect evidence", returnTerms: "Full refund after return", expiresAt: "2099-01-01T00:00:00.000Z" });
  Object.assign(draft.items[0], { cardName: "Synthetic card", game: "Synthetic game", unitPriceText: "1.000000000000000001", condition: { standard: "manual", description: "Corner wear" }, grading: { company: "Reported grader", grade: "9", certificate: "claim-only" }, catalog: [{ source: "Example", identifier: "https://example.invalid/not-fetched", provenance: { source: "manual", rights: "unknown" } }] });
  draft.assetKind = "crypto"; draft.assetIdentifier = "eip155:8453/slip44:60"; draft.decimalsText = "18";
  draft.shipping.responsibility = "Seller ships";
  const revision = makeRevision(tradeIdSchema.parse("trade_fixture"), 1, draftTerms(draft), "2026-09-14T00:00:00.000Z", OWNER);
  const state = initialSimulationState(revision);
  const simulation: SimulationRun = {
    mode: "simulation", id: simulationIdSchema.parse("sim_fixture"), version: 1, protection: "unavailable", notice: "Simulation — no funds held or protected.", snapshot: revision, state,
    permittedActions: permittedActions({ state, snapshot: revision }, revision.recordedAt), sourceCurrentRevision: 1, staleRevision: false, createdAt: revision.recordedAt, updatedAt: revision.recordedAt, actor: OWNER,
  };
  return { revision, simulation };
}

test("real records disclose stale acceptance, exact terms and inert escaped claims", () => {
  const { revision } = fixture();
  const second = makeRevision(revision.tradeId, 2, { ...revision.terms, title: "New terms" }, revision.recordedAt, OWNER);
  const record: TradeRecord = {
    mode: "record", id: revision.tradeId, version: 3, currentRevision: 2, protection: "unavailable", notice: "Record only — no escrow protection.", current: second, revisions: [revision, second],
    evidence: [{ mode: "record", id: "evidence_1", tradeId: revision.tradeId, revision: 1, agreementHash: revision.hash, kind: "acceptance", text: "<img src=x onerror=alert(1)>", references: ["https://example.invalid/report"], recordedAt: revision.recordedAt, provenance: "owner_reported", actor: OWNER }],
    createdAt: revision.recordedAt, updatedAt: revision.recordedAt,
  };
  const html = renderToStaticMarkup(<TradeRecordPanel trade={record} revisionNumber={1} onRevision={() => undefined} />);
  expect(html).toContain("Record only — no escrow protection.");
  expect(html).toContain("Stale acceptance");
  expect(html).toContain("Historical terms");
  expect(html).toContain("1.000000000000000001");
  expect(html).toContain("1000000000000000001 atomic");
  expect(html).toContain("Not authentication");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img");
  expect(html).not.toMatch(/<(img|script|iframe)\b/);
  expect(html).not.toContain("href=");
});

test("simulation is continuously labeled, same-owner, and only renders server actions", () => {
  const { simulation } = fixture();
  const html = renderToStaticMarkup(<TradeSimulationPanel simulation={simulation} disabled={true} onCommand={() => undefined} />);
  expect(html.split("Simulation — no funds held or protected.").length).toBeGreaterThan(2);
  expect(html).toContain("One local owner is playing every simulated role");
  expect(html).toContain("Simulate buyer acceptance");
  expect(html).toContain("Simulate seller acceptance");
  expect(html).not.toContain("Simulate funding</button>");
  expect(html).toContain("disabled=\"\"");
  expect(html).toContain("aria-busy=\"true\"");
  expect(html).toContain("Never included in wallet balances");
});

test("unknown operations show stable-ID reconciliation, source mismatch and dispute hold", () => {
  const { simulation } = fixture();
  simulation.staleRevision = true; simulation.sourceCurrentRevision = 2;
  simulation.state.dispute = "open";
  simulation.state.operation = { id: "op_stable", kind: "release", status: "unknown", createdAt: simulation.createdAt, updatedAt: simulation.updatedAt };
  simulation.state.settlement = "unknown";
  simulation.permittedActions = [{ command: { type: "reconcile_operation", operationId: "op_stable" }, label: "Simulate reconciliation by operation ID", simulatedRole: "system" }];
  const html = renderToStaticMarkup(<TradeSimulationPanel simulation={simulation} disabled={false} onCommand={() => undefined} />);
  expect(html).toContain("Source-revision mismatch");
  expect(html).toContain("Unknown outcome");
  expect(html).toContain("op_stable");
  expect(html).toContain("Dispute hold");
  expect(html).toContain("ordinary release is blocked");
  expect(html).toContain("Simulate reconciliation by operation ID");
  expect(html).not.toContain("Simulate pending full release</button>");
  expect(html).not.toContain("Simulate pending full refund</button>");
});

test("native form labels, frozen registry metadata and conflict saving block are explicit", () => {
  const { revision } = fixture();
  const html = renderToStaticMarkup(<TradeTermsEditor initial={revision.terms} busy={false} stale={true} onSave={() => undefined} onCancel={() => undefined} />);
  for (const label of ["Quote asset type", "Quote asset", "Crypto asset ID (CAIP-19)", "Decimals", "Condition description", "Shipping responsibility", "Inspection window (hours)", "Dispute terms", "Return terms"]) expect(html).toContain(label);
  expect(html).toMatch(/readonly=""/i);
  expect(html).toContain("Saving is blocked");
  expect(html).toMatch(/autocomplete="off"/i);
  expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Save new revision/);
  expect(html).not.toContain("<img");
  expect(renderToStaticMarkup(<TradeNotice />)).toContain("no escrow protection");
});
