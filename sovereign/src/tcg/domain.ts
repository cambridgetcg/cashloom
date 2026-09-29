import { z } from "zod";
import { ASSETS } from "../info/assets";
import { assetRefKey, assetRefSchema } from "../wallet/domain/identities";
import { canonicalTimestampSchema } from "../wallet/domain/intent";
import { moneySchema, nonNegativeMoneySchema, positiveMoneySchema, type Money } from "../wallet/domain/money";

export const RECORD_NOTICE = "Record only — no escrow protection.";
export const SIMULATION_NOTICE = "Simulation — no funds held or protected.";
export const ownerActorSchema = z.object({ kind: z.literal("owner"), ref: z.literal("local-owner") }).strict();
export type OwnerActor = z.infer<typeof ownerActorSchema>;
export const OWNER: OwnerActor = { kind: "owner", ref: "local-owner" };
const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => [...s].every((c) => c.charCodeAt(0) >= 32 || c === String.fromCharCode(9) || c === String.fromCharCode(10) || c === String.fromCharCode(13)), "plain text required");
export const localIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const tradeIdSchema = localIdSchema.regex(/^trade_/).brand<"TradeId">();
export const simulationIdSchema = localIdSchema.regex(/^sim_/).brand<"SimulationId">();
export type TradeId = z.infer<typeof tradeIdSchema>;
export type SimulationId = z.infer<typeof simulationIdSchema>;
export const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const revisionNumberSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
export const mutationSchema = z.object({ idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), expectedVersion: versionSchema });
export const sourceReferenceSchema = z.string().max(2048).url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
}, "HTTP(S) references without credentials only; references are never fetched");
const boundedPositiveMoney = positiveMoneySchema.refine((v) => v.atomic.length <= 78, "amount too large");
const boundedNonNegativeMoney = nonNegativeMoneySchema.refine((v) => v.atomic.length <= 78, "amount too large");
const partySchema = z.enum(["buyer", "seller"]);
// Only EVM address spelling is case-insensitive; Cosmos denom/chain identifiers are not.
const registryAssetKey = (id: string): string => {
  const erc20 = id.match(/^(eip155:[0-9]+\/erc20:)(0x[0-9a-fA-F]{40})$/);
  return erc20 ? `${erc20[1]}${erc20[2]!.toLowerCase()}` : id;
};
const provenanceSchema = z.object({ source: text(240), observedAt: canonicalTimestampSchema.optional(), rights: z.enum(["unknown", "permitted", "restricted"]) }).strict();
export const lineItemSchema = z.object({
  id: localIdSchema,
  representation: z.enum(["physical_copy", "homogeneous_lot", "bundle"]),
  game: text(100), cardName: text(200), set: text(120), collectorNumber: text(100),
  language: text(80), variant: text(120), quantity: z.number().int().min(1).max(10000),
  condition: z.object({ description: text(1000), standard: text(120) }).strict(),
  grading: z.object({ company: text(100), grade: text(80), certificate: text(200).optional() }).strict().optional(),
  catalog: z.array(z.object({ source: text(120), identifier: text(240), provenance: provenanceSchema }).strict()).max(10).optional(),
  metadata: z.array(z.object({ key: text(100), value: text(500), provenance: provenanceSchema }).strict()).max(20).optional(),
  unitPrice: boundedPositiveMoney,
}).strict().superRefine((item, ctx) => {
  if (item.representation === "physical_copy" && item.quantity !== 1) ctx.addIssue({ code: "custom", path: ["quantity"], message: "one represented physical copy must have quantity one" });
});

export const agreementTermsSchema = z.object({
  kind: z.literal("shipped_sale"), title: text(200), originChannel: text(200), ownerRole: partySchema,
  buyerLabel: text(120), sellerLabel: text(120),
  quoteAsset: assetRefSchema,
  // Only locally registered quote assets/scales are supported; no lookup or fetching.
  quoteDecimals: z.number().int().min(0).max(18),
  items: z.array(lineItemSchema).min(1).max(100),
  shipping: z.object({ payer: partySchema, amount: boundedNonNegativeMoney, responsibility: text(1000) }).strict(),
  charges: z.array(z.object({ label: text(120), payer: partySchema, amount: boundedNonNegativeMoney }).strict()).max(20),
  plannedPaymentMethod: z.enum(["cash", "bank", "card_processor", "crypto", "other"]),
  inspectionWindowHours: z.number().int().min(1).max(2160), disputeTerms: text(2000), returnTerms: text(2000),
  expiresAt: canonicalTimestampSchema,
  referenceValuations: z.array(z.object({ amount: boundedNonNegativeMoney, source: text(240), observedAt: canonicalTimestampSchema, rights: z.enum(["unknown", "permitted", "restricted"]) }).strict()).max(20).optional(),
}).strict().superRefine((terms, ctx) => {
  const key = assetRefKey(terms.quoteAsset);
  const registryId = terms.quoteAsset.kind === "fiat" ? `iso4217:${terms.quoteAsset.currency}` : terms.quoteAsset.asset_id;
  const registered = ASSETS.find((asset) => registryAssetKey(asset.id) === registryAssetKey(registryId));
  if (!registered || registered.decimals !== terms.quoteDecimals) ctx.addIssue({ code: "custom", path: ["quoteDecimals"], message: "quote asset and exact scale must match the local asset registry" });
  if ([...terms.items.map((i) => i.unitPrice), terms.shipping.amount, ...terms.charges.map((c) => c.amount)].some((v) => assetRefKey(v.asset) !== key)) {
    ctx.addIssue({ code: "custom", message: "all agreement prices and charges must use the one quote asset" });
  }
  if (new Set(terms.items.map((i) => i.id)).size !== terms.items.length) ctx.addIssue({ code: "custom", path: ["items"], message: "item IDs must be unique" });
});
export type AgreementTerms = z.infer<typeof agreementTermsSchema>;
export type AgreementTotals = { items: Money; shipping: Money; charges: Money; sellerCosts: Money; cashloomFee: Money; total: Money };
export const agreementHashSchema = z.string().regex(/^tcg-agreement:v1:sha256:[0-9a-f]{64}$/).brand<"AgreementHash">();
export type AgreementHash = z.infer<typeof agreementHashSchema>;
export interface AgreementRevision {
  mode: "record"; tradeId: TradeId; revision: number; hash: AgreementHash; terms: AgreementTerms; totals: AgreementTotals;
  claims: "owner_reported"; recordedAt: string; actor: OwnerActor;
}
export const evidenceInputSchema = z.object({
  kind: z.enum(["acceptance", "payment", "dispatch", "delivery", "inspection", "dispute", "return", "note", "correction"]),
  text: text(4000), occurredAt: canonicalTimestampSchema.optional(),
  references: z.array(sourceReferenceSchema).max(10).optional(), correctsEvidenceId: localIdSchema.optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.kind === "correction") !== Boolean(v.correctsEvidenceId)) ctx.addIssue({ code: "custom", message: "corrections must reference an original evidence item" });
});
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
export interface TradeEvidence extends EvidenceInput {
  mode: "record"; id: string; tradeId: TradeId; revision: number; agreementHash: AgreementHash;
  provenance: "owner_reported"; recordedAt: string; actor: OwnerActor;
}
export interface TradeRecord {
  mode: "record"; id: TradeId; version: number; currentRevision: number; protection: "unavailable"; notice: typeof RECORD_NOTICE;
  current: AgreementRevision; revisions: AgreementRevision[]; evidence: TradeEvidence[]; createdAt: string; updatedAt: string;
}
export interface ActivityEvent {
  mode: "record" | "simulation"; id: string; sequence: number; subjectId: string; revision: number;
  agreementHash: AgreementHash; type: string; actor: OwnerActor; recordedAt: string;
  data: Record<string, unknown>;
}
export interface EventPage { events: ActivityEvent[]; nextCursor: number | null }
export const createTradeSchema = mutationSchema.extend({ expectedVersion: z.literal(0), terms: agreementTermsSchema }).strict();
export const reviseTradeSchema = mutationSchema.extend({ terms: agreementTermsSchema }).strict();
export const recordEvidenceSchema = mutationSchema.extend({ revision: revisionNumberSchema, evidence: evidenceInputSchema }).strict();
export const createSimulationSchema = mutationSchema.extend({ expectedVersion: z.literal(0), tradeId: tradeIdSchema, revision: revisionNumberSchema }).strict();

export const PUBLIC_ERRORS = {
  INVALID_REQUEST: [400, "The request is invalid."], UNAUTHORIZED: [401, "An authenticated owner session is required."],
  FORBIDDEN: [403, "Only the local owner may use trades."], NOT_FOUND: [404, "The requested record was not found."],
  VERSION_CONFLICT: [409, "The record changed. Refresh before making another change."],
  IDEMPOTENCY_CONFLICT: [409, "This idempotency key was already used for a different request."],
  INVALID_TRANSITION: [409, "That action is not permitted in the current state."],
  EXPIRED: [409, "The proposal has expired. Funding cannot start."],
  RECONCILIATION_REQUIRED: [409, "Reconcile the existing operation before another action."],
  BODY_TOO_LARGE: [413, "The request body is too large."],
  INTERNAL_ERROR: [500, "The request could not be completed."],
} as const;
export type TcgErrorCode = keyof typeof PUBLIC_ERRORS;
export class TcgError extends Error {
  constructor(readonly code: TcgErrorCode) { super(PUBLIC_ERRORS[code][1]); }
}
export const agreementTotalsSchema = z.object({ items: moneySchema, shipping: moneySchema, charges: moneySchema, sellerCosts: moneySchema, cashloomFee: moneySchema, total: moneySchema }).strict();
export const agreementSnapshotSchema = z.object({ tradeId: tradeIdSchema, revision: revisionNumberSchema, hash: agreementHashSchema, terms: agreementTermsSchema, totals: agreementTotalsSchema }).strict();
export const agreementRevisionSchema = agreementSnapshotSchema.extend({ mode: z.literal("record"), claims: z.literal("owner_reported"), recordedAt: canonicalTimestampSchema, actor: ownerActorSchema }).strict();
export const tradeEvidenceSchema = z.object({
  ...evidenceInputSchema.innerType().shape,
  mode: z.literal("record"), id: localIdSchema, tradeId: tradeIdSchema, revision: revisionNumberSchema, agreementHash: agreementHashSchema,
  provenance: z.literal("owner_reported"), recordedAt: canonicalTimestampSchema, actor: ownerActorSchema,
}).strict();
export const tradeRecordSchema = z.object({
  mode: z.literal("record"), id: tradeIdSchema, version: revisionNumberSchema, currentRevision: revisionNumberSchema,
  protection: z.literal("unavailable"), notice: z.literal(RECORD_NOTICE), current: agreementRevisionSchema,
  revisions: z.array(agreementRevisionSchema), evidence: z.array(tradeEvidenceSchema), createdAt: canonicalTimestampSchema, updatedAt: canonicalTimestampSchema,
}).strict();
export interface StoreOptions { now?: () => string; id?: () => string }
