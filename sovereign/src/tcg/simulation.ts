import { z } from "zod";
import { canonicalTimestampSchema } from "../wallet/domain/intent";
import { money, moneySchema, type Money } from "../wallet/domain/money";
import { assetRefKey } from "../wallet/domain/identities";
import { validateRevision } from "./agreement";
import { localIdSchema, mutationSchema, SIMULATION_NOTICE, TcgError, type AgreementRevision, type OwnerActor, type SimulationId } from "./domain";

export const simulatedRoleSchema = z.enum(["buyer", "seller", "adjudicator", "system"]);
export type SimulatedRole = z.infer<typeof simulatedRoleSchema>;
const emptyCommand = <T extends string>(type: T) => z.object({ type: z.literal(type) }).strict();
export const simulationCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accept"), simulatedRole: z.enum(["buyer", "seller"]) }).strict(),
  emptyCommand("fund"), emptyCommand("dispatch"), emptyCommand("deliver"), emptyCommand("accept_inspection"),
  emptyCommand("open_dispute"), emptyCommand("authorize_return"), emptyCommand("dispatch_return"), emptyCommand("receive_return"),
  emptyCommand("authorize_refund"), emptyCommand("resolve_release"), emptyCommand("cancel"),
  emptyCommand("request_release"), emptyCommand("request_refund"),
  z.object({ type: z.literal("advance_operation"), operationId: localIdSchema, outcome: z.enum(["complete", "unknown", "fail"]) }).strict(),
  z.object({ type: z.literal("reconcile_operation"), operationId: localIdSchema }).strict(),
]);
export type SimulationCommand = z.infer<typeof simulationCommandSchema>;
export const simulationMutationSchema = mutationSchema.extend({ command: simulationCommandSchema }).strict();
export interface SimulationOperation {
  id: string; kind: "funding" | "release" | "refund"; status: "pending" | "unknown" | "completed" | "failed";
  createdAt: string; updatedAt: string;
}
export interface SimulationState {
  agreement: { buyerAccepted: boolean; sellerAccepted: boolean };
  funding: "unfunded" | "pending" | "unknown" | "funded";
  fulfilment: "not_dispatched" | "dispatched" | "delivered";
  inspection: "not_started" | "open" | "accepted" | "disputed";
  dispute: "none" | "open" | "return_authorized" | "release_authorized" | "refund_authorized";
  return: "none" | "authorized" | "dispatched" | "received";
  settlement: "none" | "release_pending" | "refund_pending" | "unknown" | "released" | "refunded";
  cancellation: "none" | "cancelled" | "refund_required";
  balances: { funded: Money; held: Money; released: Money; refunded: Money; fee: Money };
  operation: SimulationOperation | null;
}
export const simulationStateSchema = z.object({
  agreement: z.object({ buyerAccepted: z.boolean(), sellerAccepted: z.boolean() }).strict(),
  funding: z.enum(["unfunded", "pending", "unknown", "funded"]),
  fulfilment: z.enum(["not_dispatched", "dispatched", "delivered"]), inspection: z.enum(["not_started", "open", "accepted", "disputed"]),
  dispute: z.enum(["none", "open", "return_authorized", "release_authorized", "refund_authorized"]),
  return: z.enum(["none", "authorized", "dispatched", "received"]),
  settlement: z.enum(["none", "release_pending", "refund_pending", "unknown", "released", "refunded"]),
  cancellation: z.enum(["none", "cancelled", "refund_required"]),
  balances: z.object({ funded: moneySchema, held: moneySchema, released: moneySchema, refunded: moneySchema, fee: moneySchema }).strict(),
  operation: z.object({ id: localIdSchema, kind: z.enum(["funding", "release", "refund"]), status: z.enum(["pending", "unknown", "completed", "failed"]), createdAt: canonicalTimestampSchema, updatedAt: canonicalTimestampSchema }).strict().nullable(),
}).strict();
export interface SimulationAction { command: SimulationCommand; label: string; simulatedRole: SimulatedRole }
export interface SimulationRun {
  mode: "simulation"; id: SimulationId; version: number; notice: typeof SIMULATION_NOTICE; protection: "unavailable";
  snapshot: Pick<AgreementRevision, "tradeId" | "revision" | "hash" | "terms" | "totals">;
  state: SimulationState; permittedActions: SimulationAction[];
  sourceCurrentRevision: number | null; staleRevision: boolean;
  createdAt: string; updatedAt: string; actor: OwnerActor;
}
export const SIMULATION_ACTIONS = {
  fund: { label: "Simulate funding", simulatedRole: "buyer" },
  dispatch: { label: "Simulate dispatch", simulatedRole: "seller" },
  deliver: { label: "Simulate delivery confirmation", simulatedRole: "buyer" },
  accept_inspection: { label: "Simulate inspection acceptance", simulatedRole: "buyer" },
  open_dispute: { label: "Simulate condition dispute", simulatedRole: "buyer" },
  authorize_return: { label: "Simulate return authorization", simulatedRole: "adjudicator" },
  dispatch_return: { label: "Simulate return dispatch", simulatedRole: "buyer" },
  receive_return: { label: "Simulate return receipt", simulatedRole: "seller" },
  authorize_refund: { label: "Simulate full refund authorization", simulatedRole: "adjudicator" },
  resolve_release: { label: "Simulate resolution authorizing full release", simulatedRole: "adjudicator" },
  cancel: { label: "Simulate cancellation", simulatedRole: "buyer" },
  request_release: { label: "Simulate pending full release", simulatedRole: "system" },
  request_refund: { label: "Simulate pending full refund", simulatedRole: "system" },
} as const;
export function commandRole(command: SimulationCommand): SimulatedRole {
  if (command.type === "accept") return command.simulatedRole;
  if (command.type === "advance_operation" || command.type === "reconcile_operation") return "system";
  return SIMULATION_ACTIONS[command.type].simulatedRole;
}
export function initialSimulationState(revision: AgreementRevision): SimulationState {
  const source = validateRevision(revision);
  const zero = money(source.terms.quoteAsset, "0");
  return {
    agreement: { buyerAccepted: false, sellerAccepted: false }, funding: "unfunded", fulfilment: "not_dispatched",
    inspection: "not_started", dispute: "none", return: "none", settlement: "none", cancellation: "none",
    balances: { funded: zero, held: zero, released: zero, refunded: zero, fee: zero }, operation: null,
  };
}
function permittedTypes(run: Pick<SimulationRun, "state" | "snapshot">, now: string): SimulationCommand[] {
  const s = run.state;
  if (s.cancellation === "cancelled" || s.settlement === "released" || s.settlement === "refunded") return [];
  if (s.operation?.status === "unknown") return [{ type: "reconcile_operation", operationId: s.operation.id }];
  if (s.operation?.status === "pending") return (["complete", "unknown", "fail"] as const).map((outcome) => ({ type: "advance_operation", operationId: s.operation!.id, outcome }));
  const actions: SimulationCommand[] = [];
  if (s.funding === "unfunded") {
    if (Date.parse(now) < Date.parse(run.snapshot.terms.expiresAt)) {
      if (!s.agreement.buyerAccepted) actions.push({ type: "accept", simulatedRole: "buyer" });
      if (!s.agreement.sellerAccepted) actions.push({ type: "accept", simulatedRole: "seller" });
      if (s.agreement.buyerAccepted && s.agreement.sellerAccepted) actions.push({ type: "fund" });
    }
    actions.push({ type: "cancel" });
    return actions;
  }
  if (s.funding !== "funded") return [];
  if (s.cancellation === "none") actions.push({ type: "cancel" });
  if (s.cancellation === "refund_required") {
    if (s.fulfilment === "not_dispatched" && s.dispute !== "refund_authorized") actions.push({ type: "authorize_refund" });
    else if (s.fulfilment !== "not_dispatched" && s.return === "none") actions.push({ type: "authorize_return" });
  } else if (s.dispute === "none") {
    if (s.fulfilment === "not_dispatched") actions.push({ type: "dispatch" });
    if (s.fulfilment === "dispatched") actions.push({ type: "deliver" });
    if (s.fulfilment === "delivered") {
      if (s.inspection === "open") actions.push({ type: "accept_inspection" });
      actions.push({ type: "open_dispute" });
      if (s.inspection === "accepted") actions.push({ type: "request_release" });
    }
  }
  if (s.dispute === "open") {
    actions.push({ type: "authorize_return" });
    if (s.cancellation === "none") actions.push({ type: "resolve_release" });
  }
  if (s.return === "authorized") actions.push({ type: "dispatch_return" });
  if (s.return === "dispatched") actions.push({ type: "receive_return" });
  if (s.return === "received" && s.dispute !== "refund_authorized") actions.push({ type: "authorize_refund" });
  if (s.dispute === "refund_authorized") actions.push({ type: "request_refund" });
  if (s.dispute === "release_authorized" && s.cancellation === "none") actions.push({ type: "request_release" });
  return actions.filter((a, i) => actions.findIndex((b) => JSON.stringify(a) === JSON.stringify(b)) === i);
}
export function permittedActions(run: Pick<SimulationRun, "state" | "snapshot">, now: string): SimulationAction[] {
  canonicalTimestampSchema.parse(now);
  return permittedTypes(run, now).map((command) => ({
    command, simulatedRole: commandRole(command),
    label: command.type === "accept" ? `Simulate ${command.simulatedRole} acceptance`
      : command.type === "advance_operation" ? command.outcome === "unknown" ? "Simulate lost response (unknown outcome)" : command.outcome === "fail" ? "Simulate operation failure" : "Simulate operation completion"
      : command.type === "reconcile_operation" ? "Simulate reconciliation by operation ID" : SIMULATION_ACTIONS[command.type].label,
  }));
}
export function assertConservation(state: SimulationState, total: Money): void {
  simulationStateSchema.parse(state);
  const b = state.balances;
  if (Object.values(b).some((amount) => assetRefKey(amount.asset) !== assetRefKey(total.asset))) throw new Error("simulation asset mismatch");
  const f = BigInt(b.funded.atomic), h = BigInt(b.held.atomic), r = BigInt(b.released.atomic), u = BigInt(b.refunded.atomic), t = BigInt(total.atomic);
  if (f !== h + r + u || [f, h, r, u].some((v) => v < 0n) || (f !== 0n && f !== t) || (r !== 0n && r !== t) || (u !== 0n && u !== t) || (r > 0n && u > 0n) || b.fee.atomic !== "0") throw new Error("simulation conservation failure");
  if ((state.funding === "funded") !== (f === t) || (state.settlement === "released") !== (r === t) || (state.settlement === "refunded") !== (u === t) || (f > 0n && (!state.agreement.buyerAccepted || !state.agreement.sellerAccepted)) || (state.cancellation === "cancelled" && f > 0n)) throw new Error("simulation state and balances disagree");
  const op = state.operation;
  if (op?.status === "pending" || op?.status === "unknown") {
    const expected = op.kind === "funding" ? state.funding : state.settlement;
    if (expected !== (op.status === "unknown" ? "unknown" : op.kind === "funding" ? "pending" : `${op.kind}_pending`)) throw new Error("simulation operation state mismatch");
  } else if (["pending", "unknown"].includes(state.funding) || ["release_pending", "refund_pending", "unknown"].includes(state.settlement)) throw new Error("simulation requires a stable pending operation");
}
export function applySimulationCommand(run: Pick<SimulationRun, "state" | "snapshot">, input: SimulationCommand, now: string, operationId: () => string): SimulationState {
  const command = simulationCommandSchema.parse(input);
  canonicalTimestampSchema.parse(now);
  if (!permittedTypes(run, now).some((a) => JSON.stringify(a) === JSON.stringify(command))) {
    if (run.state.operation?.status === "unknown") throw new TcgError("RECONCILIATION_REQUIRED");
    if ((command.type === "accept" || command.type === "fund") && Date.parse(now) >= Date.parse(run.snapshot.terms.expiresAt)) throw new TcgError("EXPIRED");
    throw new TcgError("INVALID_TRANSITION");
  }
  const s: SimulationState = structuredClone(run.state);
  const total = run.snapshot.totals.total;
  const zero = money(total.asset, "0");
  const begin = (kind: SimulationOperation["kind"]) => {
    s.operation = { id: localIdSchema.parse(operationId()), kind, status: "pending", createdAt: now, updatedAt: now };
    if (kind === "funding") s.funding = "pending";
    else s.settlement = kind === "release" ? "release_pending" : "refund_pending";
  };
  const finish = (failed: boolean) => {
    const op = s.operation!;
    op.status = failed ? "failed" : "completed";
    op.updatedAt = now;
    if (op.kind === "funding") {
      s.funding = failed ? "unfunded" : "funded";
      if (!failed) { s.balances.funded = total; s.balances.held = total; }
    } else if (failed) s.settlement = "none";
    else {
      s.settlement = op.kind === "release" ? "released" : "refunded";
      s.balances.held = zero;
      s.balances[op.kind === "release" ? "released" : "refunded"] = total;
    }
  };
  switch (command.type) {
    case "accept": s.agreement[command.simulatedRole === "buyer" ? "buyerAccepted" : "sellerAccepted"] = true; break;
    case "fund": begin("funding"); break;
    case "dispatch": s.fulfilment = "dispatched"; break;
    case "deliver": s.fulfilment = "delivered"; s.inspection = "open"; break;
    case "accept_inspection": s.inspection = "accepted"; break;
    case "open_dispute": s.dispute = "open"; s.inspection = "disputed"; break;
    case "authorize_return": s.dispute = "return_authorized"; s.return = "authorized"; break;
    case "dispatch_return": s.return = "dispatched"; break;
    case "receive_return": s.return = "received"; break;
    case "authorize_refund": s.dispute = "refund_authorized"; break;
    case "resolve_release": s.dispute = "release_authorized"; break;
    case "cancel": s.cancellation = s.funding === "unfunded" ? "cancelled" : "refund_required"; break;
    case "request_release": begin("release"); break;
    case "request_refund": begin("refund"); break;
    case "advance_operation":
      if (command.outcome === "unknown") {
        s.operation!.status = "unknown"; s.operation!.updatedAt = now;
        if (s.operation!.kind === "funding") s.funding = "unknown";
        else s.settlement = "unknown";
        // A lost simulator response deterministically reconciles to completed. No external effect exists.
      } else finish(command.outcome === "fail");
      break;
    case "reconcile_operation": finish(false); break;
  }
  assertConservation(s, total);
  return s;
}
