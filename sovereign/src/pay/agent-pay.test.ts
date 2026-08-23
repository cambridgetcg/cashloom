import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  keyIdForPublicKey,
  sealSimulationReceipt,
  sealTransactionIntent,
  sealWalletCapability,
  sealWalletDescriptor,
  type RecordSigner,
  type SimulationReceipt,
  type TransactionIntent,
  type WalletCapability,
  type WalletDescriptor,
} from "@agenttool/wallet";
import vectors from "@agenttool/wallet/vectors.json";
import { encodeFunctionData, erc20Abi, keccak256, type Hex } from "viem";
import type { AgentTrustBinding } from "./agent-pay.ts";

process.env.CASHLOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "cashloom-agent-pay-test-"));

const vault = await import("../vault.ts");
const { db, newId } = await import("../db.ts");
const { confirmPayment } = await import("../pay.ts");
const { BASE_USDC_ADDRESS, createEvmSender } = await import("../senders/evm.sender.ts");
const {
  authorizeAgentPayment_wired,
  setAgentGrantRevocationNonce,
} = await import("./agent-pay.ts");

const by = Object.fromEntries(
  (vectors as { records: Array<{ kind: string; record: unknown }> }).records.map((record) => [
    record.kind,
    record.record,
  ]),
);
const base = {
  descriptorJson: by.descriptor,
  capabilityJson: by.capability,
  intentJson: by.intent,
  simulationJson: by.simulation,
};
const atVectorTime = { now: () => new Date("2026-07-21T10:02:00.000Z") };

if (!vault.isInitialized()) await vault.initialize("correct horse battery staple");
else await vault.unlock("correct horse battery staple");

// Hardhat's public throwaway account #0. Test vector only, never funds.
const LOCAL_EVM_KEY = await vault.importEvmKey(
  "agent-payment-binding",
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const BASE_CHAIN = "eip155:8453";
const BASE_ETH_ASSET = `${BASE_CHAIN}/slip44:60`;
const BASE_USDC_ASSET = `${BASE_CHAIN}/erc20:${BASE_USDC_ADDRESS.toLowerCase()}`;
const BENEFICIARY = `0x${"2".repeat(40)}` as const;
const OTHER_BENEFICIARY = `0x${"3".repeat(40)}` as const;
const OTHER_SOURCE = `0x${"4".repeat(40)}` as const;
const EMPTY_PAYLOAD_HASH = `sha256:${Buffer.from(sha256(new Uint8Array())).toString("hex")}` as const;
let nextFixtureNonce = 4_000;

const caipAccount = (address: string): string => `${BASE_CHAIN}:${address.toLowerCase()}`;
const at = (origin: Date, offsetMs: number): string =>
  new Date(origin.getTime() + offsetMs).toISOString();
const bytesHash = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${Buffer.from(sha256(bytes)).toString("hex")}`;

const makeRecordSigner = async (fill: number): Promise<RecordSigner> => {
  const privateKey = new Uint8Array(32).fill(fill);
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);
  return {
    public_key: Buffer.from(publicKey).toString("base64url"),
    sign_digest: async (digest) =>
      Buffer.from(await ed25519.signAsync(digest, privateKey)).toString("base64url"),
  };
};

const [ownerSigner, delegateSigner, adapterSigner] = await Promise.all([
  makeRecordSigner(21),
  makeRecordSigner(22),
  makeRecordSigner(23),
]);
const authority = (signer: RecordSigner) => ({
  algorithm: "Ed25519" as const,
  key_id: keyIdForPublicKey(signer.public_key),
  public_key: signer.public_key,
});

interface PaymentFixture {
  paymentId: string;
  accountId: string;
  asset: "ETH" | "USDC";
  assetId: string;
  amount: string;
  fee: string;
  recipient: `0x${string}`;
  detail: {
    data: `0x${string}` | null;
    to: `0x${string}`;
  };
}

/**
 * Create the exact quote envelope with the injectable sender, then persist it
 * as a v1 quote. A deliberately absent agent authorization asks confirm() to
 * lazily create the v2 intent/quote/reservation projection and must stop before
 * signing. No test in this setup contacts an RPC endpoint.
 */
const createPaymentFixture = async (
  asset: "ETH" | "USDC" = "ETH",
  recipient: `0x${string}` = BENEFICIARY,
  amount = asset === "ETH" ? "1000000000000000" : "1000000",
): Promise<PaymentFixture> => {
  const nonce = nextFixtureNonce++;
  const quoteSender = createEvmSender({
    resolveSenderAddress: async () => LOCAL_EVM_KEY.address as `0x${string}`,
    createRpcClient: () => ({
      estimateGas: async () => 21_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getTransactionCount: async () => nonce,
      estimateBaseProtocolFees: async () => ({
        l1FeeUpperBound: 0n,
        operatorFeeUpperBound: 0n,
        sourceBlockNumber: 25_000_000n,
      }),
      sendRawTransaction: async () => {
        throw new Error("quote-only fixture must never broadcast");
      },
    }),
  });
  const quoted = await quoteSender.quote(
    { vaultKeyId: LOCAL_EVM_KEY.id },
    { to: recipient, amountMinor: amount, asset },
  );
  const paymentId = newId();
  const accountId = newId();
  const assetId = asset === "ETH" ? BASE_ETH_ASSET : BASE_USDC_ASSET;
  db.query(
    `INSERT INTO accounts
       (id, rail, display_name, currency, decimals, balance_minor,
        external_account_id, chain_id, asset_id, account_ref, vault_key_id)
     VALUES (?, 'CRYPTO', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    `Agent ${asset} fixture`,
    asset,
    asset === "ETH" ? 18 : 6,
    (BigInt(amount) * 100n).toString(),
    LOCAL_EVM_KEY.address,
    BASE_CHAIN,
    assetId,
    caipAccount(LOCAL_EVM_KEY.address!),
    LOCAL_EVM_KEY.id,
  );
  db.query(
    `INSERT INTO payments
       (id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status, detail, created_at)
     VALUES (?, ?, 'evm-base', ?, ?, ?, ?, 'quoted', ?, ?)`,
  ).run(
    paymentId,
    accountId,
    recipient,
    asset,
    amount,
    quoted.feeMinor,
    quoted.detail ?? null,
    new Date().toISOString(),
  );

  // This is the networkless migration seam: exact envelope parsing and v2
  // projection happen, then the kernel-wide Base proposal-only boundary
  // aborts before any delegation can reach signing or execution.
  await expect(
    confirmPayment(paymentId, { agentAuthorizationId: newId() }),
  ).rejects.toThrow(/proposal-only.*max_fee.*hard bound.*not transaction-hard-capped/i);
  expect(
    (db.query("SELECT status FROM payments WHERE id=?").get(paymentId) as { status: string }).status,
  ).toBe("quoted");
  expect(db.query("SELECT 1 FROM wk_payment_intents WHERE id=?").get(paymentId)).not.toBeNull();
  expect(db.query("SELECT 1 FROM wk_authorizations WHERE intent_id=?").get(paymentId)).toBeNull();
  expect(db.query("SELECT 1 FROM wk_executions WHERE intent_id=?").get(paymentId)).toBeNull();

  const detail = JSON.parse(quoted.detail!) as PaymentFixture["detail"];
  return {
    paymentId,
    accountId,
    asset,
    assetId,
    amount,
    fee: quoted.feeMinor,
    recipient,
    detail,
  };
};

interface BundleOptions {
  source?: `0x${string}`;
  beneficiary?: `0x${string}`;
  assetId?: string;
  amount?: string;
  maxFee?: string;
  usdcCalldataBeneficiary?: `0x${string}`;
  now?: Date;
}

interface AgentBundle {
  descriptorJson: WalletDescriptor;
  capabilityJson: WalletCapability;
  intentJson: TransactionIntent;
  simulationJson: SimulationReceipt;
  paymentId: string;
  now: Date;
}

const buildAgentBundle = async (
  payment: PaymentFixture,
  options: BundleOptions = {},
): Promise<AgentBundle> => {
  const now = options.now ?? new Date();
  const source = options.source ?? (LOCAL_EVM_KEY.address as `0x${string}`);
  const beneficiary = options.beneficiary ?? payment.recipient;
  const assetId = options.assetId ?? payment.assetId;
  const amount = options.amount ?? payment.amount;
  const maxFee = options.maxFee ?? payment.fee;
  const sourceAccount = caipAccount(source);
  const beneficiaryAccount = caipAccount(beneficiary);
  const owner = authority(ownerSigner);
  const delegate = authority(delegateSigner);
  const adapter = authority(adapterSigner);
  const walletId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const intentId = crypto.randomUUID();

  const descriptor = await sealWalletDescriptor(
    {
      schema: "agent-wallet/descriptor/0.1",
      wallet_id: walletId,
      owner_identity_id: `did:cashloom:test:${walletId}`,
      authority: owner,
      custody_mode: "self_custodied",
      accounts: [{ account_id: sourceAccount, account_kind: "eoa" }],
      recovery_mode: "owner_rotation",
      created_at: at(now, -10 * 60_000),
    },
    ownerSigner,
  );

  const isUsdc = payment.asset === "USDC";
  const calldata = isUsdc
    ? encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [options.usdcCalldataBeneficiary ?? beneficiary, BigInt(amount)],
      })
    : "0x";
  const payload = isUsdc ? Buffer.from(calldata.slice(2), "hex") : Buffer.alloc(0);
  const contractAccount = caipAccount(BASE_USDC_ADDRESS);
  const rules = isUsdc
    ? [
        {
          target_account: contractAccount,
          actions: ["call" as const],
          methods: ["transfer"],
          requires_approval: false,
        },
        {
          target_account: beneficiaryAccount,
          actions: ["transfer" as const],
          methods: [],
          requires_approval: false,
        },
      ].sort((left, right) =>
        `${left.target_account}\0${left.actions.join(",")}\0${left.methods.join(",")}`.localeCompare(
          `${right.target_account}\0${right.actions.join(",")}\0${right.methods.join(",")}`,
        ),
      )
    : [
        {
          target_account: beneficiaryAccount,
          actions: ["transfer" as const],
          methods: [],
          requires_approval: false,
        },
      ];

  const capability = await sealWalletCapability(
    {
      schema: "agent-wallet/capability/0.1",
      grant_id: grantId,
      wallet_id: walletId,
      descriptor_id: descriptor.record_id,
      issuer: owner,
      delegate,
      accounts: [sourceAccount],
      call_rules: rules,
      spend_limits: [
        { asset_id: assetId, max_per_intent: amount, max_total: (BigInt(amount) * 3n).toString() },
      ],
      fee_limits: [{ asset_id: BASE_ETH_ASSET, max_per_intent: "1000000000000000" }],
      max_intents: 3,
      approval_threshold: 0,
      issued_at: at(now, -5 * 60_000),
      not_before: at(now, -5 * 60_000),
      expires_at: at(now, 60 * 60_000),
      revocation_nonce: 0,
      policy_hash: `sha256:${"a".repeat(64)}`,
      purpose: `Networkless ${payment.asset} payment binding regression`,
    },
    ownerSigner,
  );

  const intent = await sealTransactionIntent(
    {
      schema: "agent-wallet/intent/0.1",
      intent_id: intentId,
      wallet_id: walletId,
      descriptor_id: descriptor.record_id,
      grant_id: grantId,
      capability_record_id: capability.record_id,
      delegate,
      chain_id: BASE_CHAIN,
      source_account: sourceAccount,
      calls: isUsdc
        ? [
            {
              action: "call",
              target_account: contractAccount,
              method: "transfer",
              payload_b64u: payload.toString("base64url"),
              payload_hash: bytesHash(payload),
              native_value: null,
            },
          ]
        : [
            {
              action: "transfer",
              target_account: beneficiaryAccount,
              method: null,
              payload_b64u: "",
              payload_hash: EMPTY_PAYLOAD_HASH,
              native_value: { asset_id: assetId, amount_atomic: amount },
            },
          ],
      declared_spends: [{ asset_id: assetId, amount_atomic: amount }],
      max_fee: { asset_id: BASE_ETH_ASSET, amount_atomic: maxFee },
      issued_at: at(now, -60_000),
      expires_at: at(now, 4 * 60_000),
      nonce: `cashloom-agent-test:${intentId}`,
    },
    delegateSigner,
  );

  const effects = isUsdc
    ? [
        {
          action: "transfer" as const,
          target_account: beneficiaryAccount,
          method: null,
          asset_id: assetId,
          amount_atomic: amount,
        },
      ]
    : [
        {
          action: "transfer" as const,
          target_account: beneficiaryAccount,
          method: null,
          asset_id: assetId,
          amount_atomic: amount,
        },
      ];
  const simulation = await sealSimulationReceipt(
    {
      schema: "agent-wallet/simulation/0.1",
      simulation_id: crypto.randomUUID(),
      intent_id: intentId,
      intent_record_id: intent.record_id,
      chain_id: BASE_CHAIN,
      source_account: sourceAccount,
      adapter,
      block_ref: "base:networkless-fixture",
      block_hash: `sha256:${"b".repeat(64)}`,
      success: true,
      effects,
      estimated_fee: { asset_id: BASE_ETH_ASSET, amount_atomic: maxFee },
      simulated_at: at(now, -30_000),
      valid_until: at(now, 90_000),
    },
    adapterSigner,
  );

  return {
    descriptorJson: descriptor,
    capabilityJson: capability,
    intentJson: intent,
    simulationJson: simulation,
    paymentId: payment.paymentId,
    now,
  };
};

const authorizeBundle = (bundle: AgentBundle) => {
  const trust = trustFor(bundle);
  return authorizeAgentPayment_wired(bundle, {
    now: () => bundle.now,
    expectedDelegateKeyId: trust.delegateKeyId,
    expectedTrust: trust,
  });
};

const unboundRequestFor = (bundle: AgentBundle) => ({
  descriptorJson: bundle.descriptorJson,
  capabilityJson: bundle.capabilityJson,
  intentJson: bundle.intentJson,
  simulationJson: bundle.simulationJson,
});

const authorizeUnboundBundle = (bundle: AgentBundle) => {
  const trust = trustFor(bundle);
  return authorizeAgentPayment_wired(unboundRequestFor(bundle), {
    now: () => bundle.now,
    expectedDelegateKeyId: trust.delegateKeyId,
    expectedTrust: trust,
  });
};

const trustFor = (bundle: AgentBundle): AgentTrustBinding => ({
  walletId: bundle.descriptorJson.wallet_id,
  descriptorRecordId: bundle.descriptorJson.record_id,
  ownerKeyId: bundle.descriptorJson.authority.key_id,
  grantId: bundle.capabilityJson.grant_id,
  capabilityRecordId: bundle.capabilityJson.record_id,
  delegateKeyId: bundle.capabilityJson.delegate.key_id,
  trustedSimulationAdapterKeyIds: [bundle.simulationJson.adapter.key_id],
});

const withNetworklessBroadcast = async <T>(work: () => Promise<T>): Promise<{
  value: T;
  broadcasts: Hex[];
}> => {
  const originalFetch = globalThis.fetch;
  const broadcasts: Hex[] = [];
  globalThis.fetch = (async (input, init) => {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
    if (typeof raw !== "string") throw new Error("Unexpected Base JSON-RPC request body.");
    const request = JSON.parse(raw) as
      | { id: string | number; method: string; params: unknown[] }
      | Array<{ id: string | number; method: string; params: unknown[] }>;
    const respond = (entry: { id: string | number; method: string; params: unknown[] }) => {
      if (entry.method !== "eth_sendRawTransaction") {
        throw new Error(`Unexpected network method ${entry.method}`);
      }
      const payload = entry.params[0];
      if (typeof payload !== "string" || !/^0x[0-9a-f]+$/i.test(payload)) {
        throw new Error("Malformed networkless transaction payload.");
      }
      broadcasts.push(payload as Hex);
      return { jsonrpc: "2.0", id: entry.id, result: keccak256(payload as Hex) };
    };
    const body = Array.isArray(request) ? request.map(respond) : respond(request);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return { value: await work(), broadcasts };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

describe("agent payment authorization — host-owned usage", () => {
  it("binds a delegated session principal to the signed delegate key id", async () => {
    await expect(authorizeAgentPayment_wired(base, {
      ...atVectorTime,
      expectedDelegateKeyId: `sha256:${"f".repeat(64)}`,
    })).rejects.toThrow(/delegated session principal/);
  });

  it("refuses internally valid records outside the owner's pinned trust root", async () => {
    const payment = await createPaymentFixture("ETH");
    const bundle = await buildAgentBundle(payment);
    const request = unboundRequestFor(bundle);
    const trust = trustFor(bundle);
    const runtime = {
      now: () => bundle.now,
      expectedDelegateKeyId: trust.delegateKeyId,
      expectedTrust: trust,
    };

    await expect(authorizeAgentPayment_wired(request, {
      ...runtime,
      expectedTrust: { ...trust, ownerKeyId: `sha256:${"f".repeat(64)}` },
    })).rejects.toThrow(/owner-pinned/);
    await expect(authorizeAgentPayment_wired(request, {
      ...runtime,
      expectedTrust: {
        ...trust,
        trustedSimulationAdapterKeyIds: [`sha256:${"e".repeat(64)}`],
      },
    })).rejects.toThrow(/owner-pinned/);
    expect(
      db.query("SELECT 1 FROM wk_agent_authorizations WHERE intent_record_id=?").get(
        bundle.intentJson.record_id,
      ),
    ).toBeNull();

    const authorized = await authorizeAgentPayment_wired(request, runtime);
    expect(authorized.attestation.delegate_key_id).toBe(trust.delegateKeyId);
    expect(authorized.attestation.payment_intent_id).toBeNull();
  });

  it("enforces the owner-pinned root through the delegated HTTP session", async () => {
    const trustedPayment = await createPaymentFixture("ETH");
    const trustedBundle = await buildAgentBundle(trustedPayment);
    const foreignPayment = await createPaymentFixture("ETH", OTHER_BENEFICIARY);
    const foreignBundle = await buildAgentBundle(foreignPayment);
    const trust = trustFor(trustedBundle);
    const ownerToken = await vault.unlock("correct horse battery staple");
    const { app } = await import("../index.ts");
    const sessionResponse = await app.request("/api/vault/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        trust,
        scopes: ["accounts:read", "payments:quote", "agent:authorize"],
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json() as { token: string };
    const authorizeThroughSession = (bundle: AgentBundle) => app.request(
      "/api/pay/agent/authorize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          descriptorJson: bundle.descriptorJson,
          capabilityJson: bundle.capabilityJson,
          intentJson: bundle.intentJson,
          simulationJson: bundle.simulationJson,
        }),
      },
    );

    const foreign = await authorizeThroughSession(foreignBundle);
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ authorized: false });
    expect(
      db.query("SELECT 1 FROM wk_agent_authorizations WHERE intent_record_id=?").get(
        foreignBundle.intentJson.record_id,
      ),
    ).toBeNull();

    const accepted = await authorizeThroughSession(trustedBundle);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      authorized: true,
      attestation: { delegate_key_id: trust.delegateKeyId, payment_intent_id: null },
    });
  });

  it("ignores caller usage, reserves once, signs once, and replays idempotently", async () => {
    const first = await authorizeAgentPayment_wired(
      {
        ...base,
        context: {
          now: "2099-01-01T00:00:00.000Z",
          usage: { revocation_nonce: 999, intent_count: 999, spent: [], host_verified_approval_ids: [] },
        },
      },
      atVectorTime,
    );
    expect(first.authorized).toBe(true);
    const attestation = first.attestation;
    expect(attestation.status).toBe("authorized-not-broadcast");
    const digest = new Uint8Array(Buffer.from(attestation.body_sha256.slice(7), "hex"));
    const signature = new Uint8Array(Buffer.from(attestation.signature, "base64url"));
    const publicKey = new Uint8Array(Buffer.from(attestation.host_authority, "base64url"));
    expect(await ed25519.verifyAsync(signature, digest, publicKey)).toBe(true);

    const replay = await authorizeAgentPayment_wired(base, atVectorTime);
    expect(replay.attestation.authorization_id).toBe(attestation.authorization_id);
    expect(replay.attestation.signature).toBe(attestation.signature);
    const usage = db.query(
      "SELECT intent_count, spent_json FROM wk_agent_capability_usage WHERE grant_id=?",
    ).get(attestation.grant_id) as { intent_count: number; spent_json: string };
    expect(usage.intent_count).toBe(1);
    expect(JSON.parse(usage.spent_json)).toEqual(attestation.declared_spends);
  });

  it("refuses a previously attested replay after the host revokes the grant", async () => {
    const prior = await authorizeAgentPayment_wired(base, atVectorTime);
    setAgentGrantRevocationNonce(prior.attestation.grant_id, 1);
    await expect(authorizeAgentPayment_wired(base, atVectorTime)).rejects.toThrow(/revoked/);
    const row = db.query(
      "SELECT status FROM wk_agent_authorizations WHERE id=?",
    ).get(prior.attestation.authorization_id) as { status: string };
    expect(row.status).toBe("REVOKED");
  });
});

describe("agent payment authorization — Base proposal-only boundary", () => {
  it("refuses exact ETH and USDC payment bindings before durable authority or execution", async () => {
    for (const asset of ["ETH", "USDC"] as const) {
      const payment = await createPaymentFixture(asset);
      // Even a signed max_fee above the quote estimate cannot turn Base's L1
      // and operator components into a transaction-enforced hard maximum.
      const bundle = await buildAgentBundle(payment, {
        maxFee: (BigInt(payment.fee) * 2n).toString(),
      });
      const attempted = await withNetworklessBroadcast(async () => {
        try {
          await authorizeBundle(bundle);
          return null;
        } catch (error) {
          return error;
        }
      });

      expect(attempted.value).toBeInstanceOf(Error);
      expect((attempted.value as Error).message).toMatch(
        /proposal-only.*max_fee.*hard bound.*not transaction-hard-capped/i,
      );
      expect(attempted.broadcasts, asset).toHaveLength(0);
      expect(
        db.query("SELECT 1 FROM wk_agent_authorizations WHERE payment_intent_id=?")
          .get(payment.paymentId),
        asset,
      ).toBeNull();
      expect(
        db.query("SELECT 1 FROM wk_agent_capability_usage WHERE grant_id=?")
          .get(bundle.capabilityJson.grant_id),
        asset,
      ).toBeNull();
      expect(
        db.query("SELECT 1 FROM wk_authorizations WHERE intent_id=?").get(payment.paymentId),
        asset,
      ).toBeNull();
      expect(
        db.query("SELECT 1 FROM wk_executions WHERE intent_id=?").get(payment.paymentId),
        asset,
      ).toBeNull();
      expect(
        (db.query("SELECT status FROM payments WHERE id=?").get(payment.paymentId) as {
          status: string;
        }).status,
        asset,
      ).toBe("quoted");
    }
  });

  it("retains exact proposal binding checks without turning them into authority", async () => {
    const cases: Array<{
      name: string;
      bundle(payment: PaymentFixture): Promise<AgentBundle>;
    }> = [
      {
        name: "beneficiary",
        bundle: (payment) => buildAgentBundle(payment, { beneficiary: OTHER_BENEFICIARY }),
      },
      {
        name: "source",
        bundle: (payment) => buildAgentBundle(payment, { source: OTHER_SOURCE }),
      },
      {
        name: "asset",
        bundle: (payment) => buildAgentBundle(payment, { assetId: BASE_USDC_ASSET }),
      },
      {
        name: "amount",
        bundle: (payment) =>
          buildAgentBundle(payment, { amount: (BigInt(payment.amount) + 1n).toString() }),
      },
    ];

    for (const scenario of cases) {
      const payment = await createPaymentFixture("ETH");
      const bundle = await scenario.bundle(payment);
      await expect(authorizeBundle(bundle)).rejects.toThrow(/exactly match/i);
      expect(
        db.query("SELECT 1 FROM wk_agent_authorizations WHERE payment_intent_id=?").get(
          payment.paymentId,
        ),
        scenario.name,
      ).toBeNull();
      expect(
        db.query("SELECT 1 FROM wk_agent_capability_usage WHERE grant_id=?").get(
          bundle.capabilityJson.grant_id,
        ),
        scenario.name,
      ).toBeNull();
    }
  });

  it("checks the exact Circle calldata before applying the proposal-only boundary", async () => {
    const payment = await createPaymentFixture("USDC", BENEFICIARY, "2500000");
    const bundle = await buildAgentBundle(payment, {
      usdcCalldataBeneficiary: OTHER_BENEFICIARY,
    });
    const signedCall = bundle.intentJson.calls[0]!;
    expect(signedCall.target_account.toLowerCase()).toBe(caipAccount(BASE_USDC_ADDRESS));
    expect(bundle.intentJson.declared_spends).toEqual([
      { asset_id: BASE_USDC_ASSET, amount_atomic: payment.amount },
    ]);
    expect(Buffer.from(signedCall.payload_b64u, "base64url").toString("hex")).not.toBe(
      payment.detail.data!.slice(2),
    );

    await expect(authorizeBundle(bundle)).rejects.toThrow(/exactly match/i);
    expect(
      db.query("SELECT 1 FROM wk_agent_authorizations WHERE payment_intent_id=?").get(
        payment.paymentId,
      ),
    ).toBeNull();
  });
});

describe("agent payment authorization — durable lifecycle races", () => {
  it("refuses an unbound audit authorization after its signed validity expires", async () => {
    const payment = await createPaymentFixture("ETH");
    const bundle = await buildAgentBundle(payment, {
      now: new Date(Date.now() - 91_000),
    });
    const authorized = await authorizeUnboundBundle(bundle);
    const id = authorized.attestation.authorization_id;
    expect(authorized.attestation.payment_intent_id).toBeNull();
    expect(
      (db.query("SELECT status FROM wk_agent_authorizations WHERE id=?").get(id) as {
        status: string;
      }).status,
    ).toBe("ATTESTED");

    expect(
      Date.parse(
        (db.query("SELECT expires_at FROM wk_agent_authorizations WHERE id=?").get(id) as {
          expires_at: string;
        }).expires_at,
      ),
    ).toBeLessThanOrEqual(Date.now());

    await expect(
      authorizeAgentPayment_wired(unboundRequestFor(bundle), {
        now: () => new Date(bundle.now.getTime() + 10 * 60_000),
        expectedDelegateKeyId: trustFor(bundle).delegateKeyId,
        expectedTrust: trustFor(bundle),
      }),
    ).rejects.toThrow(/expired|revoked/i);
    expect(
      (db.query("SELECT status FROM wk_agent_authorizations WHERE id=?").get(id) as {
        status: string;
      }).status,
    ).toBe("REVOKED");
  });

  it("refuses an unbound audit authorization after host revocation", async () => {
    const payment = await createPaymentFixture("ETH");
    const bundle = await buildAgentBundle(payment);
    const authorized = await authorizeUnboundBundle(bundle);
    const { authorization_id: id, grant_id: grantId } = authorized.attestation;

    setAgentGrantRevocationNonce(grantId, 1);
    expect(
      (db.query("SELECT status FROM wk_agent_authorizations WHERE id=?").get(id) as {
        status: string;
      }).status,
    ).toBe("REVOKED");
    await expect(
      authorizeUnboundBundle(bundle),
    ).rejects.toThrow(/revoked/i);
  });

  it("atomically collapses concurrent unbound audit authorization attempts", async () => {
    const payment = await createPaymentFixture("ETH");
    const bundle = await buildAgentBundle(payment);
    const attestations = await Promise.all([
      authorizeUnboundBundle(bundle),
      authorizeUnboundBundle(bundle),
      authorizeUnboundBundle(bundle),
    ]);
    const ids = new Set(attestations.map((entry) => entry.attestation.authorization_id));
    expect(ids.size).toBe(1);
    expect(
      (db.query(
        "SELECT intent_count FROM wk_agent_capability_usage WHERE grant_id=?",
      ).get(bundle.capabilityJson.grant_id) as { intent_count: number }).intent_count,
    ).toBe(1);
    expect(
      (db.query(
        "SELECT COUNT(*) AS n FROM wk_agent_authorizations WHERE intent_record_id=?",
      ).get(bundle.intentJson.record_id) as { n: number }).n,
    ).toBe(1);
    expect(
      (db.query("SELECT status FROM wk_agent_authorizations WHERE id=?").get(
        attestations[0]!.attestation.authorization_id,
      ) as {
        status: string;
      }).status,
    ).toBe("ATTESTED");
    expect(attestations.every((entry) => entry.attestation.payment_intent_id === null)).toBe(true);
  });
});
