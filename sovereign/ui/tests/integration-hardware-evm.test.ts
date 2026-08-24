import { describe, expect, test } from "bun:test";
import {
  executeHardwareEvmHandoff,
  hashEvmSignRequest,
  type HardwareEvmHandoff,
  type HardwareEvmTransport,
  type Sha256Digest,
} from "../src/integrations";

const HASH = (character: string) => `sha256:${character.repeat(64)}` as Sha256Digest;
const ACCOUNT = `eip155:8453:0x${"1".repeat(40)}`;
const NOW = new Date("2026-08-24T12:00:00.000Z");

const request = () => ({
  schema_version: "cashloom.sign-request/1" as const,
  request_id: "request-1",
  intent_hash: HASH("a"),
  authorization_id: "authorization-1",
  expires_at: "2026-08-24T12:05:00.000Z",
  kind: "evm-transaction" as const,
  chain_id: "eip155:8453" as const,
  signer_account_id: ACCOUNT,
  to_account_id: `eip155:8453:0x${"2".repeat(40)}`,
  nonce: "7",
  value_atomic: "1000000000000000",
  data: "0x" as const,
  gas_limit: "21000",
  fee: {
    kind: "eip1559" as const,
    max_fee_per_gas_atomic: "2000000000",
    max_priority_fee_per_gas_atomic: "1000000000",
  },
});

const handoff = async (): Promise<HardwareEvmHandoff> => {
  const body = request();
  const requestHash = await hashEvmSignRequest(body);
  return {
    schema_version: "cashloom.hardware-signing-handoff/1",
    handoff_id: "handoff-1",
    signer_id: "ledger-owner-key",
    device_binding_hash: HASH("d"),
    transport: "usb",
    authorization: {
      authorization_id: body.authorization_id,
      intent_hash: body.intent_hash,
      request_hash: requestHash,
      expires_at: body.expires_at,
    },
    request: body,
    request_hash: requestHash,
    expires_at: body.expires_at,
  };
};

describe("vendor-neutral hardware EVM bridge", () => {
  test("passes only an exact structured request and returns bounded public evidence", async () => {
    const value = await handoff();
    let received: unknown;
    const transport: HardwareEvmTransport = {
      kind: "usb",
      async confirmAndSignExactEvm(input) {
        received = input;
        return {
          account_id: ACCOUNT,
          device_binding_hash: HASH("d"),
          request_hash: value.request_hash,
          serialized_transaction: "0x1234",
          transaction_hash: `0x${"e".repeat(64)}`,
          user_confirmed: true,
          device_serial: "SERIAL-CANARY",
          apdu: "APDU-CANARY",
          pin: "1234",
        } as never;
      },
    };
    const evidence = await executeHardwareEvmHandoff(value, transport, { now: NOW });
    expect(received).toEqual({
      handoff_id: "handoff-1",
      signer_id: "ledger-owner-key",
      device_binding_hash: HASH("d"),
      request_hash: value.request_hash,
      request: value.request,
    });
    expect(evidence).toEqual({
      schema_version: "cashloom.hardware-evm-evidence/1",
      handoff_id: "handoff-1",
      signer_id: "ledger-owner-key",
      device_binding_hash: HASH("d"),
      transport: "usb",
      authorization_id: "authorization-1",
      request_id: "request-1",
      request_hash: value.request_hash,
      chain_id: "eip155:8453",
      account_id: ACCOUNT,
      serialized_transaction: "0x1234",
      transaction_hash: `0x${"e".repeat(64)}`,
    });
    expect(JSON.stringify(evidence)).not.toContain("SERIAL-CANARY");
    expect(JSON.stringify(evidence)).not.toContain("APDU-CANARY");
    expect(JSON.stringify(evidence)).not.toContain("pin");
  });

  test("refuses request mutation, arbitrary signing shape, and wrong device binding before evidence", async () => {
    const value = await handoff();
    let calls = 0;
    const transport: HardwareEvmTransport = {
      kind: "usb",
      async confirmAndSignExactEvm() {
        calls += 1;
        return {
          account_id: ACCOUNT,
          device_binding_hash: HASH("x"),
          request_hash: value.request_hash,
          serialized_transaction: "0x1234",
          transaction_hash: `0x${"e".repeat(64)}`,
          user_confirmed: true,
        };
      },
    };
    await expect(executeHardwareEvmHandoff({
      ...value,
      request: { ...value.request, nonce: "8" },
    }, transport, { now: NOW })).rejects.toMatchObject({ code: "hardware_refused" });
    await expect(executeHardwareEvmHandoff({
      ...value,
      request: { ...value.request, kind: "arbitrary-bytes" },
    } as never, transport, { now: NOW })).rejects.toMatchObject({ code: "hardware_refused" });
    await expect(executeHardwareEvmHandoff({
      ...value,
      request: { ...value.request, chain_id: "eip155:1" },
    } as never, transport, { now: NOW })).rejects.toMatchObject({ code: "hardware_refused" });
    await expect(executeHardwareEvmHandoff({
      ...value,
      request: { ...value.request, fee: { kind: "legacy", gas_price_atomic: "1" } },
    } as never, transport, { now: NOW })).rejects.toMatchObject({ code: "hardware_refused" });
    expect(calls).toBe(0);

    await expect(executeHardwareEvmHandoff(value, transport, { now: NOW }))
      .rejects.toMatchObject({ code: "hardware_refused" });
    expect(calls).toBe(1);
  });

  test("honors cancellation without touching the transport", async () => {
    const value = await handoff();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(executeHardwareEvmHandoff(value, {
      kind: "usb",
      async confirmAndSignExactEvm() {
        calls += 1;
        throw new Error("should not run");
      },
    }, { now: NOW, signal: controller.signal })).rejects.toMatchObject({
      code: "integration_cancelled",
    });
    expect(calls).toBe(0);
  });
});
