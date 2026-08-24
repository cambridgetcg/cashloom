import { describe, expect, test } from "bun:test";
import { keccak256 } from "viem";
import { hashErc4337UserOperationBinding, hashHexData, hashUtf8 } from "../integrations/index.ts";
import { createErc4337Builder, type PinnedEntryPointV07 } from "./erc4337-builder.ts";

const H = (value: string) => hashUtf8(value);
const LATER = "2030-01-01T00:05:00.000Z";
const entry: PinnedEntryPointV07 = { chain_id: "eip155:8453", version: "0.7", address: "0x3333333333333333333333333333333333333333", runtime_code_hash: keccak256("0x6000") };
const request = () => {
  const operation = { sender: "0x1111111111111111111111111111111111111111", nonce: "1", init_code: "0x", factory: null, factory_data_hash: null, call_data: "0x", call_data_hash: hashHexData("0x"), account_gas_limits: `0x${"2".padStart(32, "0")}${"3".padStart(32, "0")}`, call_gas_limit: "3", verification_gas_limit: "2", pre_verification_gas: "4", gas_fees: `0x${"5".padStart(32, "0")}${"6".padStart(32, "0")}`, max_fee_per_gas: "6", max_priority_fee_per_gas: "5", paymaster_and_data: "0x", paymaster: null, paymaster_verification_gas_limit: null, paymaster_post_op_gas_limit: null, paymaster_data_hash: null, signature: "0x" } as const;
  const raw = { schema_version: "cashloom.erc4337-userop/0.7", request_id: "userop-1", intent_hash: H("intent"), authorization: { authorization_id: "authorization-1", intent_hash: H("intent"), request_hash: H("request"), expires_at: LATER }, chain_id: "eip155:8453", entry_point: entry.address, account_id: "eip155:8453:0x1111111111111111111111111111111111111111", nonce_key: "0", nonce_sequence: "1", user_operation: operation, user_operation_binding_hash: H("placeholder"), expires_at: LATER } as const;
  const bindingHash = hashErc4337UserOperationBinding(raw);
  return {
    ...raw,
    authorization: { ...raw.authorization, request_hash: bindingHash },
    user_operation_binding_hash: bindingHash,
  };
};

describe("ERC-4337 builder", () => {
  test("pins Base v0.7, revalidates exact packed fields and produces a real EntryPoint-domain hash", () => {
    const builder = createErc4337Builder({ entry_points: [entry] });
    const prepared = builder.prepare(request());
    expect(prepared.user_operation_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.user_operation_hash).not.toBe(prepared.request.user_operation_binding_hash);
    expect(() => builder.prepare({ ...request(), entry_point: "0x4444444444444444444444444444444444444444" })).toThrow();
    expect(() => builder.prepare({ ...request(), user_operation: { ...request().user_operation, call_gas_limit: "4" } })).toThrow();
    expect(() => builder.prepare({ ...request(), authorization: { ...request().authorization, request_hash: H("unbound") } })).toThrow();
  });
  test("excludes the passkey signature from both owner approval and EIP-4337 UserOperation hash", () => {
    const builder = createErc4337Builder({ entry_points: [entry] });
    const before = builder.prepare(request());
    const signed = { ...request(), user_operation: { ...request().user_operation, signature: "0x1234" } };
    expect(hashErc4337UserOperationBinding(signed)).toBe(before.request.user_operation_binding_hash);
    expect(builder.prepare(signed).user_operation_hash).toBe(before.user_operation_hash);
  });
});

export { request as erc4337TestRequest, entry as erc4337TestEntryPoint };
