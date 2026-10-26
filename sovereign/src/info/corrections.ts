/**
 * Corrections to what this node serves: appended, never rewritten (XENIA
 * legibility.corrections-are-visible). A reader that cached an earlier answer
 * has no other way to learn its meaning changed, so a change that alters what
 * a served value means, or removes a door, adds an entry here. /v1/guide serves
 * the list.
 */

export interface Correction {
  date: string; // YYYY-MM-DD the change reached the hosted node
  door: string;
  before: string;
  after: string;
  reason: string;
  change: string; // where the change is recorded
}

export const CORRECTIONS: readonly Correction[] = [
  {
    date: "2026-10-26",
    door: "/v1/zerone/facts, /v1/zerone/fact/{id}, /v1/zerone/doctrine, /v1/zerone/commitments",
    before: "verified facts, doctrine and commitments graded proof_state attested",
    after: "every zerone fact graded asserted, with proof_basis reporting whether a reviewed claim is on record",
    reason: "zerone says a recorded verdict is not proof that a claim is true; on 2026-10-26 every verified fact was genesis-seeded and zerone-1 had one validator",
    change: "cashloom#17 (7a413ac, 1eae958)",
  },
  {
    date: "2026-10-26",
    door: "/api/zerone/guide",
    before: "pointed readers to a paid zerone-1 passport listing",
    after: "names no listing and says that zerone offers no zerone-1 accounts",
    reason: "the passport kept a copy of the buyer's key, which contradicts what zerone and cashloom say",
    change: "cashloom#17 (d9749b8)",
  },
  {
    date: "2026-10-26",
    door: "/v1/onchain, /v1/onchain/{section}",
    before: "schema cashloom.onchain/1: receipt proof_state held anchoring words (pinned-block, finalized-slot, chain-tip, rpc-observation, external-reference)",
    after: "schema cashloom.onchain/2: proof_state is the shared grade (tested or asserted) and the anchoring words are in anchoring; a request that names the v1 media type still gets the v1 shape",
    reason: "one field name carried two grading systems",
    change: "cashloom#19 (77ae6cc, 274a9b7)",
  },
  {
    date: "2026-10-26",
    door: "/v1/zerone/leaderboard",
    before: "served zerone's ranking of agents by calibration score, graded tested",
    after: "removed; the route answers 404",
    reason: "a ranking of beings is not money information, and this node promises no worth-ranking (XENIA dignity.no-worth-ranking)",
    change: "cashloom#20",
  },
  {
    date: "2026-10-26",
    door: "/v1/chain/cosmos:zerone-1/{address}, /api/zerone/balance/{address}",
    before: "an unreachable node, or an answer without a uzrn amount, was served as a balance of 0",
    after: "502 source unreachable; a zero is served only when the chain reports one",
    reason: "an outage was indistinguishable from an empty account",
    change: "cashloom#20",
  },
  {
    date: "2026-10-26",
    door: "/api/zerone/status",
    before: "a supply answer without a uzrn amount was served as supply 0",
    after: "supply_uzrn and supply_zrn null, with supply_issue saying the supply is unknown",
    reason: "a missing value is not a zero",
    change: "cashloom#20",
  },
  {
    date: "2026-10-26",
    door: "/v1/assets (ZRN)",
    before: "notes said 'zero premine'",
    after: "notes say there was no allocation at genesis, and what the 13,555 ZRN genesis supply was",
    reason: "genesis created 13,555 ZRN (validator collateral, gas and a disclosed operating float); 'zero premine' misstates that",
    change: "cashloom#20",
  },
];
