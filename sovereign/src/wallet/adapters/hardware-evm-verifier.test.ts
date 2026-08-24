import { describe, expect, test } from "bun:test";
import { keccak256, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashBoundSignRequest } from "../domain/signing.ts";
import {
  IntegrationContractError,
  hardwareSigningHandoffSchema,
  hashUtf8,
} from "../integrations/index.ts";
import {
  hardwareEvmProviderEvidenceSchema,
  verifyHardwareEvmSignedTransaction,
  type HardwareEvmProviderEvidence,
} from "./hardware-evm-verifier.ts";

const PRIVATE_KEY = `0x${"01".repeat(32)}` as const;
const OTHER_PRIVATE_KEY = `0x${"02".repeat(32)}` as const;
const signer = privateKeyToAccount(PRIVATE_KEY);
const otherSigner = privateKeyToAccount(OTHER_PRIVATE_KEY);
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const OTHER_RECIPIENT = "0x3333333333333333333333333333333333333333" as const;
const NOW = new Date("2029-12-31T23:55:00.000Z");
const EXPIRES = "2030-01-01T00:00:00.000Z";

const accountId = (address: string) =>
  `eip155:8453:${address.toLowerCase()}` as const;

const makeRequest = (requestId = "request-1") => ({
  schema_version: "cashloom.sign-request/1",
  request_id: requestId,
  intent_hash: hashUtf8("intent-1"),
  authorization_id: "authorization-1",
  expires_at: EXPIRES,
  kind: "evm-transaction",
  chain_id: "eip155:8453",
  signer_account_id: accountId(signer.address),
  to_account_id: accountId(RECIPIENT),
  nonce: "7",
  value_atomic: "11",
  data: "0x",
  gas_limit: "21000",
  fee: {
    kind: "eip1559",
    max_fee_per_gas_atomic: "2000000000",
    max_priority_fee_per_gas_atomic: "1000000000",
  },
} as const);

type Request = ReturnType<typeof makeRequest>;

const transactionFor = (request: Request): TransactionSerializableEIP1559 => ({
  type: "eip1559",
  chainId: 8453,
  nonce: Number(request.nonce),
  to: RECIPIENT,
  value: BigInt(request.value_atomic),
  data: request.data,
  gas: BigInt(request.gas_limit),
  maxFeePerGas: BigInt(request.fee.max_fee_per_gas_atomic),
  maxPriorityFeePerGas: BigInt(
    request.fee.max_priority_fee_per_gas_atomic,
  ),
  accessList: [],
});

const sign = (
  request: Request,
  overrides: Partial<TransactionSerializableEIP1559> = {},
  account = signer,
) => account.signTransaction({ ...transactionFor(request), ...overrides });

const fixture = async (request = makeRequest()) => {
  const requestHash = hashBoundSignRequest(request);
  const handoff = hardwareSigningHandoffSchema.parse({
    schema_version: "cashloom.hardware-signing-handoff/1",
    handoff_id: `handoff.${request.request_id}`,
    signer_id: "hardware-signer-1",
    device_binding_hash: hashUtf8("device-public-binding"),
    transport: "usb",
    authorization: {
      authorization_id: request.authorization_id,
      intent_hash: request.intent_hash,
      request_hash: requestHash,
      expires_at: request.expires_at,
    },
    request,
    request_hash: requestHash,
    expires_at: request.expires_at,
  });
  const raw = await sign(request);
  const evidence = hardwareEvmProviderEvidenceSchema.parse({
    schema_version: "cashloom.hardware-evm-evidence/1",
    handoff_id: handoff.handoff_id,
    signer_id: handoff.signer_id,
    device_binding_hash: handoff.device_binding_hash,
    transport: handoff.transport,
    authorization_id: request.authorization_id,
    request_id: request.request_id,
    request_hash: requestHash,
    chain_id: request.chain_id,
    account_id: request.signer_account_id,
    serialized_transaction: raw,
    transaction_hash: keccak256(raw),
  });
  return { request, requestHash, handoff, raw, evidence };
};

const evidenceWithRaw = (
  evidence: HardwareEvmProviderEvidence,
  raw: `0x${string}`,
): HardwareEvmProviderEvidence => hardwareEvmProviderEvidenceSchema.parse({
  ...evidence,
  serialized_transaction: raw,
  transaction_hash: keccak256(raw),
});

describe("hardware Base EVM verifier", () => {
  test("returns only frozen persistence-ready evidence after full local recovery", async () => {
    const { handoff, evidence, raw, requestHash } = await fixture();
    const artifact = await verifyHardwareEvmSignedTransaction({
      handoff,
      evidence,
      now: NOW,
    });

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(artifact).toEqual({
      schema_version: "cashloom.verified-external-evm-artifact/1",
      source: "external_evm_signer",
      transport_assurance: "unattested_hardware_handoff",
      handoff_id: handoff.handoff_id,
      signer_id: handoff.signer_id,
      device_binding_hash: handoff.device_binding_hash,
      claimed_transport: "usb",
      authorization_id: handoff.authorization.authorization_id,
      intent_hash: handoff.authorization.intent_hash,
      request_id: handoff.request.request_id,
      request_hash: requestHash,
      chain_id: "eip155:8453",
      signer_account_id: handoff.request.signer_account_id,
      encoding: "hex",
      payload: raw,
      external_tx_id: keccak256(raw),
      verified_at: NOW.toISOString(),
    });
  });

  test("refuses substitution of every prepared type-2 wire field", async () => {
    const { request, handoff, evidence } = await fixture();
    const substitutions: Partial<TransactionSerializableEIP1559>[] = [
      { chainId: 1 },
      { nonce: 8 },
      { to: OTHER_RECIPIENT },
      { value: 12n },
      { data: "0x1234" },
      { gas: 22000n },
      { maxFeePerGas: 2000000001n },
      { maxPriorityFeePerGas: 1000000001n },
      { accessList: [{ address: RECIPIENT, storageKeys: [] }] },
    ];

    for (const substitution of substitutions) {
      const raw = await sign(request, substitution);
      await expect(verifyHardwareEvmSignedTransaction({
        handoff,
        evidence: evidenceWithRaw(evidence, raw),
        now: NOW,
      })).rejects.toMatchObject({ code: "integration_evidence_rejected" });
    }
  });

  test("recovers the signer instead of trusting echoed account evidence", async () => {
    const { request, handoff, evidence } = await fixture();
    const raw = await sign(request, {}, otherSigner);
    await expect(verifyHardwareEvmSignedTransaction({
      handoff,
      evidence: evidenceWithRaw(evidence, raw),
      now: NOW,
    })).rejects.toMatchObject({ code: "integration_evidence_rejected" });
  });

  test("binds authorization/request identity and refuses cross-handoff replay", async () => {
    const first = await fixture(makeRequest("request-1"));
    const second = await fixture(makeRequest("request-2"));

    await expect(verifyHardwareEvmSignedTransaction({
      handoff: second.handoff,
      evidence: first.evidence,
      now: NOW,
    })).rejects.toMatchObject({ code: "external_signer_mismatch" });

    const one = await verifyHardwareEvmSignedTransaction({
      handoff: first.handoff,
      evidence: first.evidence,
      now: NOW,
    });
    const deterministicReplay = await verifyHardwareEvmSignedTransaction({
      handoff: first.handoff,
      evidence: first.evidence,
      now: NOW,
    });
    expect(deterministicReplay).toEqual(one);
  });

  test("fails closed at expiry and redacts rejected browser/provider secrets", async () => {
    const { handoff, evidence } = await fixture();
    await expect(verifyHardwareEvmSignedTransaction({
      handoff,
      evidence,
      now: new Date(EXPIRES),
    })).rejects.toMatchObject({ code: "external_signer_mismatch" });

    const secret = "https://provider.invalid/rpc?api_key=never-persist";
    try {
      await verifyHardwareEvmSignedTransaction({
        handoff,
        evidence: {
          ...evidence,
          provider_error: secret,
        } as HardwareEvmProviderEvidence,
        now: NOW,
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationContractError);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("api_key");
    }
  });

  test("has no custody, signing, sender, or broadcast dependency", async () => {
    const source = await Bun.file(
      new URL("./hardware-evm-verifier.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/from\s+["'][^"']*(?:vault|senders?|pay)[^"']*["']/);
    expect(source).not.toContain("sendRawTransaction");
    expect(source).not.toContain("confirmPayment");
    expect(source).not.toContain("resumePaymentBroadcast");
    expect(source).not.toContain("privateKeyToAccount");
  });
});
