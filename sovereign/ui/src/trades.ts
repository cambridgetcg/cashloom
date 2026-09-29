import type { AgreementTerms, TradeRecord, TradeMutation } from "./types";
// Data-only registry shared with the server; no wallet/provider runtime imports.
import { ASSETS } from "../../src/info/assets";
import { assetRefSchema } from "../../src/wallet/domain/identities";
import { nonNegativeMoney, positiveMoney } from "../../src/wallet/domain/money";
export const TRADE_QUOTE_ASSETS = ASSETS;

export const RECORD_NOTICE = "Record only — no escrow protection.";
export const SIMULATION_NOTICE = "Simulation — no funds held or protected.";

/** No Number conversion, rounding, exponent syntax or loss of low atomic digits. */
export function tradeAtomic(value: string, decimals: number, positive = false): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Decimals must be a whole number from 0 to 18.");
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error(`Use an exact non-negative amount with at most ${decimals} decimal places.`);
  const atomic = BigInt(match[1] + (match[2] ?? "").padEnd(decimals, "0")).toString();
  if (atomic.length > 78) throw new Error("Amount is too large.");
  if (positive && atomic === "0") throw new Error("Item prices must be greater than zero.");
  return atomic;
}

export function tradeDecimal(atomic: string, decimals: number): string {
  if (!/^(0|[1-9]\d*)$/.test(atomic) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid exact amount.");
  if (decimals === 0) return atomic;
  const digits = atomic.padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

export function tradeAssetLabel(asset: AgreementTerms["quoteAsset"]): string {
  return asset.kind === "fiat" ? asset.currency : asset.asset_id;
}

export function appendTradePage<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...next.filter((entry) => !seen.has(entry.id))];
}

export function staleAcceptances(trade: TradeRecord) {
  return trade.evidence.filter((e) => e.kind === "acceptance" && e.revision !== trade.currentRevision);
}

export type TradeItemDraft = Omit<AgreementTerms["items"][number], "unitPrice" | "quantity"> & { unitPriceText: string; quantityText: string };
export type TradeDraft = Omit<AgreementTerms, "quoteAsset" | "quoteDecimals" | "items" | "shipping" | "charges" | "inspectionWindowHours"> & {
  assetKind: "fiat" | "crypto"; assetIdentifier: string; decimalsText: string;
  items: TradeItemDraft[];
  shipping: Omit<AgreementTerms["shipping"], "amount"> & { amountText: string };
  charges: Array<Omit<AgreementTerms["charges"][number], "amount"> & { amountText: string }>;
  inspectionHoursText: string;
};

export function newTradeItem(id = `item_${crypto.randomUUID()}`): TradeItemDraft {
  return { id, representation: "physical_copy", game: "", cardName: "", set: "unknown", collectorNumber: "unknown", language: "unknown", variant: "unknown", quantityText: "1", condition: { description: "", standard: "owner description" }, unitPriceText: "" };
}

export function tradeDraft(terms?: AgreementTerms): TradeDraft {
  if (!terms) return {
    kind: "shipped_sale", title: "", originChannel: "", ownerRole: "buyer", buyerLabel: "", sellerLabel: "",
    assetKind: "fiat", assetIdentifier: "GBP", decimalsText: "2", items: [newTradeItem()],
    shipping: { amountText: "0", payer: "buyer", responsibility: "" }, charges: [],
    plannedPaymentMethod: "bank", inspectionHoursText: "48", disputeTerms: "", returnTerms: "",
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  };
  const { quoteAsset, quoteDecimals, items, shipping, charges, inspectionWindowHours, ...rest } = structuredClone(terms);
  return {
    ...rest, assetKind: quoteAsset.kind, assetIdentifier: tradeAssetLabel(quoteAsset), decimalsText: String(quoteDecimals),
    items: items.map(({ unitPrice, quantity, ...item }) => ({ ...item, quantityText: String(quantity), unitPriceText: tradeDecimal(unitPrice.atomic, quoteDecimals) })),
    shipping: { payer: shipping.payer, responsibility: shipping.responsibility, amountText: tradeDecimal(shipping.amount.atomic, quoteDecimals) },
    charges: charges.map(({ amount, ...charge }) => ({ ...charge, amountText: tradeDecimal(amount.atomic, quoteDecimals) })),
    inspectionHoursText: String(inspectionWindowHours),
  };
}

function wholeNumber(value: string, label: string, min: number, max: number): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}

export function draftTerms(draft: TradeDraft): AgreementTerms {
  const { assetKind, assetIdentifier, decimalsText, items, shipping, charges, inspectionHoursText, ...rest } = draft;
  const decimals = wholeNumber(decimalsText, "Decimals", 0, 18);
  const identifier = assetIdentifier.trim();
  if (assetKind === "fiat" && !/^[A-Z]{3}$/.test(identifier)) throw new Error("Use a three-letter uppercase fiat currency code.");
  if (assetKind === "crypto" && !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}(?:\/[-.%a-zA-Z0-9]{1,78})?$/.test(identifier)) throw new Error("Use an explicit CAIP-19 crypto asset ID including the chain.");
  const registered = TRADE_QUOTE_ASSETS.find((asset) => asset.id === (assetKind === "fiat" ? `iso4217:${identifier}` : identifier));
  if (!registered || registered.decimals !== decimals) throw new Error("Select a supported quote asset and its fixed decimal scale.");
  // This is a request, not validation authority. The server validates canonical
  // identities and all claims before assigning immutable revisions and hashes.
  const asset = assetRefSchema.parse(assetKind === "fiat" ? { kind: "fiat", currency: identifier } : { kind: "crypto", asset_id: identifier });
  const money = (text: string) => nonNegativeMoney(asset, tradeAtomic(text, decimals));
  return {
    ...rest, expiresAt: tradeTimestamp(rest.expiresAt), quoteAsset: asset, quoteDecimals: decimals,
    inspectionWindowHours: wholeNumber(inspectionHoursText, "Inspection window", 1, 2160),
    items: items.map(({ unitPriceText, quantityText, ...item }) => {
      const quantity = wholeNumber(quantityText, "Quantity", 1, 10000);
      if (item.representation === "physical_copy" && quantity !== 1) throw new Error("A physical copy has quantity 1. Select homogeneous lot or bundle for multiple copies.");
      const canonicalProvenance = <T extends { provenance: { observedAt?: string } }>(entries: T[]) => entries.map((entry) => ({ ...entry, provenance: { ...entry.provenance, ...(entry.provenance.observedAt ? { observedAt: tradeTimestamp(entry.provenance.observedAt) } : {}) } }));
      return {
        ...item, quantity, unitPrice: positiveMoney(asset, tradeAtomic(unitPriceText, decimals, true)),
        ...(item.catalog ? { catalog: canonicalProvenance(item.catalog) } : {}),
        ...(item.metadata ? { metadata: canonicalProvenance(item.metadata) } : {}),
      };
    }),
    shipping: { payer: shipping.payer, responsibility: shipping.responsibility, amount: money(shipping.amountText) },
    charges: charges.map(({ amountText, ...charge }) => ({ ...charge, amount: money(amountText) })),
  };
}

export function previewTradeTotal(terms: AgreementTerms): string {
  let total = terms.items.reduce((sum, item) => sum + BigInt(item.unitPrice.atomic) * BigInt(item.quantity), 0n);
  if (terms.shipping.payer === "buyer") total += BigInt(terms.shipping.amount.atomic);
  for (const charge of terms.charges) if (charge.payer === "buyer") total += BigInt(charge.amount.atomic);
  return tradeDecimal(total.toString(), terms.quoteDecimals);
}

export function tradeTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("Use an ISO date-time with an explicit timezone, for example 2026-09-14T12:00:00.000Z.");
  const date = new Date(value);
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error("Enter a valid date and time.");
  return date.toISOString();
}

export function tradeReferences(text: string): string[] {
  const references = text.split("\n").map((v) => v.trim()).filter(Boolean);
  if (references.length > 10) throw new Error("At most 10 source references are allowed.");
  for (const ref of references) {
    let url: URL;
    try { url = new URL(ref); } catch { throw new Error("References must be HTTP(S) URLs."); }
    if (ref.length > 2048 || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("References must be HTTP(S) URLs without credentials.");
  }
  return references;
}

/** In-memory, immutable request bytes. A retry never adopts a newer version or
 * edited form values. The synchronous flight guard also covers rapid clicks. */
export function createTradeAttempt<B extends { expectedVersion: number }, T>(
  body: B,
  send: (body: B & TradeMutation) => Promise<T>,
  key = crypto.randomUUID(),
) {
  const serialized = JSON.stringify({ ...body, idempotencyKey: key });
  let inFlight: Promise<T> | null = null;
  return {
    key,
    run(): Promise<T> {
      if (inFlight) return inFlight;
      inFlight = Promise.resolve().then(() => send(JSON.parse(serialized) as B & TradeMutation)).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
