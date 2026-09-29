import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalizeJson, canonicalTimestampSchema, type JsonValue } from "../wallet/domain/intent";
import { addMoney, compareMoney, money } from "../wallet/domain/money";
import { agreementHashSchema, agreementRevisionSchema, agreementTermsSchema, ownerActorSchema, revisionNumberSchema, tradeIdSchema, type AgreementRevision, type AgreementTerms, type AgreementTotals, type OwnerActor, type TradeId } from "./domain";

export function fingerprint(domain: string, value: unknown): string {
  // Parsed schemas omit absent fields; JSON serialization removes only absent optional properties.
  const json = JSON.parse(JSON.stringify(value)) as JsonValue;
  return bytesToHex(sha256(utf8ToBytes(`${domain}${String.fromCharCode(0)}${canonicalizeJson(json)}`)));
}
export function agreementTotals(input: AgreementTerms): AgreementTotals {
  const terms = agreementTermsSchema.parse(input);
  const zero = money(terms.quoteAsset, "0");
  let items = zero;
  for (const item of terms.items) items = addMoney(items, money(terms.quoteAsset, (BigInt(item.unitPrice.atomic) * BigInt(item.quantity)).toString()));
  const shipping = terms.shipping.payer === "buyer" ? money(terms.quoteAsset, terms.shipping.amount.atomic) : zero;
  let sellerCosts = terms.shipping.payer === "seller" ? money(terms.quoteAsset, terms.shipping.amount.atomic) : zero;
  let charges = zero;
  for (const charge of terms.charges) {
    if (charge.payer === "buyer") charges = addMoney(charges, money(terms.quoteAsset, charge.amount.atomic));
    else sellerCosts = addMoney(sellerCosts, money(terms.quoteAsset, charge.amount.atomic));
  }
  const total = addMoney(addMoney(items, shipping), charges);
  if (compareMoney(total, zero) <= 0) throw new Error("positive agreement total required");
  return { items, shipping, charges, sellerCosts, cashloomFee: zero, total };
}
export function hashAgreement(termsInput: AgreementTerms) {
  const terms = agreementTermsSchema.parse(termsInput);
  return agreementHashSchema.parse(`tcg-agreement:v1:sha256:${fingerprint("cashloom.tcg.agreement/1", { terms, totals: agreementTotals(terms) })}`);
}
export function makeRevision(tradeId: TradeId, revision: number, input: AgreementTerms, recordedAt: string, actor: OwnerActor): AgreementRevision {
  const terms = agreementTermsSchema.parse(input);
  return { mode: "record", tradeId: tradeIdSchema.parse(tradeId), revision: revisionNumberSchema.parse(revision), terms, totals: agreementTotals(terms), hash: hashAgreement(terms), claims: "owner_reported", recordedAt: canonicalTimestampSchema.parse(recordedAt), actor: ownerActorSchema.parse(actor) };
}
export function validateRevision(input: AgreementRevision): AgreementRevision {
  input = agreementRevisionSchema.parse(input);
  const expected = makeRevision(input.tradeId, input.revision, input.terms, input.recordedAt, input.actor);
  if (input.mode !== "record" || input.claims !== "owner_reported" || input.hash !== expected.hash || fingerprint("totals", input.totals) !== fingerprint("totals", expected.totals)) throw new Error("invalid immutable revision");
  return expected;
}
