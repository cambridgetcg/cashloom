import { agreementTermsSchema, OWNER, type AgreementTerms } from "./domain";

export const TEST_NOW = "2026-09-14T12:00:00.000Z";
export { OWNER };
export function fixtureTerms(): AgreementTerms {
  const asset = { kind: "fiat", currency: "GBP" } as const;
  return agreementTermsSchema.parse({
    kind: "shipped_sale", title: "Synthetic card bundle", originChannel: "Off-platform discussion", ownerRole: "buyer",
    buyerLabel: "Buyer claim", sellerLabel: "Seller claim", quoteAsset: asset, quoteDecimals: 2,
    items: [{ id: "item-one", representation: "homogeneous_lot", game: "Unknown game", cardName: "Synthetic card", set: "Unknown", collectorNumber: "Unknown", language: "Unknown", variant: "Unknown", quantity: 3,
      condition: { description: "Owner-reported near mint", standard: "Manual description" }, unitPrice: { asset, atomic: "101" } }],
    shipping: { payer: "buyer", amount: { asset, atomic: "50" }, responsibility: "Seller packs and dispatches; buyer pays postage" },
    charges: [{ label: "Disclosed packing", payer: "buyer", amount: { asset, atomic: "7" } }, { label: "Seller's postage materials", payer: "seller", amount: { asset, atomic: "11" } }],
    plannedPaymentMethod: "bank", inspectionWindowHours: 48, disputeTerms: "Record condition disagreement", returnTerms: "Buyer returns after simulated authorization; seller pays return shipping", expiresAt: "2027-01-01T00:00:00.000Z",
  });
}
export function ids(): () => string { let n = 0; return () => String(++n); }
