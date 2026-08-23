import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { PreparedEvmTransaction, SigningBinding } from "../vault.ts";
import type {
  EvmQuoteDetail,
  EvmRpcClient,
  EvmSenderDependencies,
} from "./evm.sender.ts";

// evm.sender imports the vault, whose DB path is fixed at module load. This
// suite only uses injected effects, but still keeps that incidental DB local.
process.env.CASHLOOM_DATA_DIR ||= mkdtempSync(join(tmpdir(), "cashloom-evm-test-"));

const { keccak256, serializeTransaction } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { hashPreparedEvmTransaction } = await import("../vault.ts");
const { AmbiguousBroadcastError } = await import("./types.ts");
const { BASE_USDC_ADDRESS, createEvmSender, parsePreparedEvmQuote } = await import(
  "./evm.sender.ts"
);

// Hardhat's public throwaway account #0. Test vector only, never funds.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);
const RECIPIENT = `0x${"2".repeat(40)}` as const;
const OTHER_ACCOUNT = `0x${"3".repeat(40)}` as const;
const KEY_ID = "evm-sender-test-key";

const bindingFor = (requestHash: `sha256:${string}`): SigningBinding => ({
  intentId: "00000000-0000-4000-8000-000000000001",
  intentHash: `sha256:${"1".repeat(64)}`,
  authorizationId: "00000000-0000-4000-8000-000000000002",
  requestHash,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const signPrepared = async (
  _keyId: string,
  request: PreparedEvmTransaction,
  binding: SigningBinding,
) => {
  expect(binding.requestHash).toBe(hashPreparedEvmTransaction(request));
  const serialized = await account.signTransaction({
    type: "eip1559",
    chainId: request.chainId,
    to: request.to,
    value: BigInt(request.valueAtomic),
    data: request.data,
    gas: BigInt(request.gasLimit),
    maxFeePerGas: BigInt(request.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas),
    nonce: request.nonce,
  });
  return { serialized, hash: keccak256(serialized), from: account.address };
};

interface HarnessOptions {
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  l1FeeUpperBound?: bigint;
  operatorFeeUpperBound?: bigint;
  sourceBlockNumber?: bigint;
  estimateBaseProtocolFees?: EvmRpcClient["estimateBaseProtocolFees"];
  resolveAddress?: `0x${string}`;
  signTransaction?: EvmSenderDependencies["signTransaction"];
  sendRaw?: (serialized: Hex) => Promise<`0x${string}`>;
}

const harness = (options: HarnessOptions = {}) => {
  const events: string[] = [];
  const estimates: Array<Parameters<EvmRpcClient["estimateGas"]>[0]> = [];
  const protocolFeeRequests: Array<
    Parameters<EvmRpcClient["estimateBaseProtocolFees"]>[0]
  > = [];
  const broadcasts: Hex[] = [];
  const requests: PreparedEvmTransaction[] = [];
  const rpc: EvmRpcClient = {
    async estimateGas(request) {
      estimates.push(request);
      return options.gas ?? 21_000n;
    },
    async estimateFeesPerGas() {
      return {
        maxFeePerGas: options.maxFeePerGas ?? 3_000_000_000n,
        maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? 1_000_000_000n,
      };
    },
    async getTransactionCount() {
      return options.nonce ?? 17;
    },
    async estimateBaseProtocolFees(request) {
      protocolFeeRequests.push(request);
      if (options.estimateBaseProtocolFees) {
        return options.estimateBaseProtocolFees(request);
      }
      return {
        l1FeeUpperBound: options.l1FeeUpperBound ?? 12_345n,
        operatorFeeUpperBound: options.operatorFeeUpperBound ?? 678n,
        sourceBlockNumber: options.sourceBlockNumber ?? 22_222_222n,
      };
    },
    async sendRawTransaction({ serializedTransaction }) {
      events.push("broadcast");
      broadcasts.push(serializedTransaction);
      if (options.sendRaw) return options.sendRaw(serializedTransaction);
      return keccak256(serializedTransaction);
    },
  };
  const delegate = options.signTransaction ?? signPrepared;
  const sender = createEvmSender({
    createRpcClient: () => rpc,
    resolveSenderAddress: async () => options.resolveAddress ?? account.address,
    signTransaction: async (keyId, request, binding) => {
      events.push("sign");
      requests.push(request);
      return delegate(keyId, request, binding);
    },
  });
  return { sender, events, estimates, protocolFeeRequests, broadcasts, requests };
};

const quoteInstruction = async (
  h: ReturnType<typeof harness>,
  amountMinor = "1000000",
  asset = "USDC",
) => {
  const instruction = { to: RECIPIENT, amountMinor, asset };
  const quote = await h.sender.quote({ vaultKeyId: KEY_ID }, instruction);
  return {
    quote,
    instruction: { ...instruction, detail: quote.detail },
    detail: JSON.parse(quote.detail!) as EvmQuoteDetail,
  };
};

describe("EVM Base sender — exact quote envelope", () => {
  it("persists every EIP-1559 field and keeps values above MAX_SAFE_INTEGER exact", async () => {
    const amount = "900719925474099312345678";
    const gas = 98_765n;
    const maxFeePerGas = 9_007_199_254_740_993_123n;
    const maxPriorityFeePerGas = 4_503_599_627_370_496_561n;
    const l1FeeUpperBound = 9_007_199_254_740_993_999n;
    const operatorFeeUpperBound = 9_007_199_254_740_994_111n;
    const sourceBlockNumber = 9_007_199_254_740_995n;
    const h = harness({
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce: 42,
      l1FeeUpperBound,
      operatorFeeUpperBound,
      sourceBlockNumber,
    });
    const { quote, instruction, detail } = await quoteInstruction(h, amount);

    expect(detail).toMatchObject({
      v: 2,
      transactionType: "eip1559",
      chainId: 8453,
      from: account.address,
      recipient: RECIPIENT,
      asset: "USDC",
      amountAtomic: amount,
      to: BASE_USDC_ADDRESS,
      value: "0",
      gas: gas.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      nonce: 42,
    });
    if (detail.v !== 2) throw new Error("new Base quote must be v2");
    expect(detail.data).toMatch(/^0xa9059cbb[0-9a-f]+$/);
    expect(detail.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const executionCap = gas * maxFeePerGas;
    const estimatedTotal = executionCap + l1FeeUpperBound + operatorFeeUpperBound;
    expect(detail.feeEstimate).toEqual({
      method: "base-gas-price-oracle-predeploy/1",
      oracleAddress: "0x420000000000000000000000000000000000000F",
      l1FeeMethod: "getL1FeeUpperBound(uint256)",
      operatorFeeMethod: "getOperatorFee(uint256)",
      sourceBlockNumber: sourceBlockNumber.toString(),
      unsignedTransactionSizeBytes: h.protocolFeeRequests[0]!.unsignedTransactionSizeBytes.toString(),
      hardExecutionCapAtomic: executionCap.toString(),
      estimatedL1UpperBoundAtomic: l1FeeUpperBound.toString(),
      estimatedOperatorUpperBoundAtomic: operatorFeeUpperBound.toString(),
      estimatedTotalAtomic: estimatedTotal.toString(),
      totalIsHardCap: false,
    });
    expect(quote.feeMinor).toBe(estimatedTotal.toString());
    expect(BigInt(quote.feeMinor)).toBeGreaterThan(executionCap);
    expect(quote.feeTerms).toEqual({
      schema_version: "cashloom.payment-fee-terms/1",
      hard_execution_cap_atomic: executionCap.toString(),
      estimated_l1_upper_bound_atomic: l1FeeUpperBound.toString(),
      estimated_operator_upper_bound_atomic: operatorFeeUpperBound.toString(),
      estimated_total_atomic: estimatedTotal.toString(),
      total_is_hard_cap: false,
      components: [
        {
          kind: "l2_execution",
          amount_atomic: executionCap.toString(),
          classification: "hard_cap",
          method: "eip1559.gas_limit_x_max_fee_per_gas",
        },
        {
          kind: "l1_data_security",
          amount_atomic: l1FeeUpperBound.toString(),
          classification: "estimated_upper_bound",
          method: "GasPriceOracle.getL1FeeUpperBound(uint256)",
          source_block: sourceBlockNumber.toString(),
        },
        {
          kind: "operator",
          amount_atomic: operatorFeeUpperBound.toString(),
          classification: "estimated_upper_bound",
          method: "GasPriceOracle.getOperatorFee(uint256)",
          source_block: sourceBlockNumber.toString(),
        },
      ],
    });
    expect(quote.summary).toContain("900719925474099312.345678 USDC");
    expect(quote.summary).toContain("estimated Base protocol fee");
    expect(quote.summary).toContain("L1 data/security upper-bound estimate");
    expect(quote.summary).toContain("operator upper-bound estimate");
    expect(quote.summary).toContain("not a hard maximum");
    expect(quote.summary).not.toContain("network fee at most");
    expect(quote.summary).not.toContain("e+");
    expect(h.estimates).toEqual([
      {
        account: account.address,
        to: BASE_USDC_ADDRESS,
        value: 0n,
        data: detail.data!,
      },
    ]);
    const serializedUnsigned = serializeTransaction({
      type: "eip1559",
      chainId: 8453,
      nonce: 42,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      to: BASE_USDC_ADDRESS,
      value: 0n,
      data: detail.data!,
      accessList: [],
    });
    expect(h.protocolFeeRequests).toEqual([
      {
        unsignedTransactionSizeBytes: BigInt((serializedUnsigned.length - 2) / 2),
        gasLimit: gas,
      },
    ]);

    const requestHash = await h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, instruction);
    expect(requestHash).toBe(detail.requestHash);
    expect(parsePreparedEvmQuote(instruction)).toEqual({
      detail,
      request: {
        kind: "cashloom.evm-transaction/1",
        chainId: 8453,
        from: account.address,
        to: BASE_USDC_ADDRESS,
        valueAtomic: "0",
        data: detail.data as `0x${string}`,
        gasLimit: gas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        nonce: 42,
      },
      requestHash,
    });
    const claims = await h.sender.reservationClaims({ vaultKeyId: KEY_ID }, instruction);
    expect(claims).toEqual([
      {
        kind: "NONCE",
        resourceKey: `eip155:8453:${account.address.toLowerCase()}:42`,
        amountAtomic: amount,
      },
    ]);
  });

  it("persists a native ETH transfer as value with empty calldata", async () => {
    const h = harness();
    const { detail, quote } = await quoteInstruction(h, "1000000000000000001", "ETH");
    expect(detail.to).toBe(RECIPIENT);
    expect(detail.value).toBe("1000000000000000001");
    expect(detail.data).toBeNull();
    expect(quote.summary).toContain("1.000000000000000001 ETH");
  });

  it("parses an exact legacy v1 envelope without fabricating v2 fee components", async () => {
    const h = harness();
    const { detail, instruction } = await quoteInstruction(h, "55", "ETH");
    if (detail.v !== 2) throw new Error("new Base quote must be v2");
    const { feeEstimate: _feeEstimate, ...v2Transaction } = detail;
    const legacyDetail = { ...v2Transaction, v: 1 as const };
    const legacyInstruction = {
      ...instruction,
      detail: JSON.stringify(legacyDetail),
    };

    const parsed = parsePreparedEvmQuote(legacyInstruction);
    expect(parsed.detail).toEqual(legacyDetail);
    expect(parsed.detail.v).toBe(1);
    expect("feeEstimate" in parsed.detail).toBe(false);
    expect(parsed.requestHash).toBe(detail.requestHash);

    const signed = await signPrepared(
      KEY_ID,
      parsed.request,
      bindingFor(parsed.requestHash),
    );
    await expect(
      h.sender.resumeBroadcast!(
        { vaultKeyId: KEY_ID },
        legacyInstruction,
        { encoding: "hex", payload: signed.serialized },
        signed.hash,
      ),
    ).resolves.toEqual({ externalId: signed.hash, status: "broadcast" });
    expect(h.events).toEqual(["broadcast"]);
  });

  it("rejects destination, amount, and asset before constructing an RPC client", async () => {
    let clients = 0;
    const sender = createEvmSender({
      createRpcClient: () => {
        clients += 1;
        throw new Error("should not run");
      },
      resolveSenderAddress: async () => account.address,
    });
    await expect(
      sender.quote({ vaultKeyId: KEY_ID }, { to: "bad", amountMinor: "1", asset: "USDC" }),
    ).rejects.toThrow(/valid EVM address/);
    for (const amountMinor of ["0", "-1", "1.5", "01", "1e6"]) {
      await expect(
        sender.quote(
          { vaultKeyId: KEY_ID },
          { to: RECIPIENT, amountMinor, asset: "USDC" },
        ),
      ).rejects.toThrow(/positive integer/);
    }
    await expect(
      sender.quote(
        { vaultKeyId: KEY_ID },
        { to: RECIPIENT, amountMinor: "1", asset: "BTC" },
      ),
    ).rejects.toThrow(/ETH and USDC/);
    await expect(
      sender.quote(
        { vaultKeyId: KEY_ID },
        { to: `0x${"0".repeat(40)}`, amountMinor: "1", asset: "ETH" },
      ),
    ).rejects.toThrow(/zero address/);
    await expect(
      sender.quote(
        { vaultKeyId: KEY_ID },
        { to: RECIPIENT, amountMinor: (1n << 256n).toString(), asset: "ETH" },
      ),
    ).rejects.toThrow(/uint256/);
    await expect(
      sender.quote(
        { vaultKeyId: KEY_ID },
        { to: account.address, amountMinor: "1", asset: "ETH" },
      ),
    ).rejects.toThrow(/own sending account/);
    expect(clients).toBe(0);
  });

  it("refuses chain, asset, contract, fee, hash, and signer substitution", async () => {
    const h = harness();
    const { instruction, detail } = await quoteInstruction(h);
    const changed = (patch: Record<string, unknown>) => ({
      ...instruction,
      detail: JSON.stringify({ ...detail, ...patch }),
    });

    await expect(
      h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, changed({ chainId: 1 })),
    ).rejects.toThrow(/invalid transaction shape/);
    await expect(
      h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, changed({ transactionType: "legacy" })),
    ).rejects.toThrow(/invalid transaction shape/);
    await expect(
      h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, changed({ asset: "ETH" })),
    ).rejects.toThrow(/no longer matches/);
    await expect(
      h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, changed({ to: RECIPIENT })),
    ).rejects.toThrow(/no longer matches/);
    await expect(
      h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, changed({ maxFeePerGas: "1" })),
    ).rejects.toThrow(/priority fee above|hash no longer matches/);
    if (detail.v !== 2) throw new Error("new Base quote must be v2");
    await expect(
      h.sender.signingRequestHash(
        { vaultKeyId: KEY_ID },
        changed({
          feeEstimate: {
            ...detail.feeEstimate,
            estimatedTotalAtomic: (BigInt(detail.feeEstimate.estimatedTotalAtomic) + 1n).toString(),
          },
        }),
      ),
    ).rejects.toThrow(/inconsistent Base fee components/);
    await expect(
      h.sender.signingRequestHash(
        { vaultKeyId: KEY_ID },
        changed({ requestHash: `sha256:${"f".repeat(64)}` }),
      ),
    ).rejects.toThrow(/hash no longer matches/);
    expect(() =>
      parsePreparedEvmQuote(changed({ unexpectedField: "not allowed" })),
    ).toThrow(/invalid transaction shape/);

    const other = harness({ resolveAddress: OTHER_ACCOUNT });
    await expect(
      other.sender.signingRequestHash({ vaultKeyId: KEY_ID }, instruction),
    ).rejects.toThrow(/different EVM signer/);
  });
});

describe("EVM Base sender — sign, persist, broadcast", () => {
  it("signs the persisted request and calls onSigned before raw broadcast", async () => {
    const h = harness();
    const { instruction, detail } = await quoteInstruction(h, "1234567");
    const requestHash = await h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, instruction);
    let signedHash: `0x${string}` | null = null;
    let signedPayload: Hex | null = null;
    const receipt = await h.sender.send(
      { vaultKeyId: KEY_ID, signingBinding: bindingFor(requestHash) },
      instruction,
      {
        onSigned(hash, envelope) {
          h.events.push("onSigned");
          signedHash = hash as `0x${string}`;
          signedPayload = envelope.payload;
          expect(envelope.encoding).toBe("hex");
          expect(h.broadcasts).toHaveLength(0);
        },
      },
    );

    expect(h.events).toEqual(["sign", "onSigned", "broadcast"]);
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatch(/^0x02/);
    expect(h.broadcasts[0]).toBe(signedPayload as unknown as Hex);
    expect(keccak256(h.broadcasts[0]!)).toBe(signedHash as unknown as `0x${string}`);
    expect(receipt).toEqual({
      externalId: signedHash as unknown as `0x${string}`,
      status: "broadcast",
    });
    expect(h.requests).toEqual([
      {
        kind: "cashloom.evm-transaction/1",
        chainId: 8453,
        from: account.address,
        to: detail.to,
        valueAtomic: "0",
        data: detail.data as `0x${string}`,
        gasLimit: detail.gas,
        maxFeePerGas: detail.maxFeePerGas,
        maxPriorityFeePerGas: detail.maxPriorityFeePerGas,
        nonce: 17,
      },
    ]);
  });

  it("requires an authorization and rejects a malformed signer result before persistence", async () => {
    const h = harness();
    const { instruction } = await quoteInstruction(h);
    await expect(h.sender.send({ vaultKeyId: KEY_ID }, instruction)).rejects.toThrow(
      /bound payment authorization/,
    );
    expect(h.events).toEqual([]);

    const serialized = (await account.signTransaction({
      type: "eip1559",
      chainId: 8453,
      to: RECIPIENT,
      value: 1n,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      nonce: 0,
    })) as Hex;
    const bad = harness({
      signTransaction: async () => ({
        serialized,
        // Internally consistent hash, but the decoded transaction is not the
        // quote. The adapter must inspect signed bytes, not trust metadata.
        hash: keccak256(serialized),
        from: account.address,
      }),
    });
    const quoted = await quoteInstruction(bad);
    const hash = await bad.sender.signingRequestHash({ vaultKeyId: KEY_ID }, quoted.instruction);
    let hookCalled = false;
    await expect(
      bad.sender.send(
        { vaultKeyId: KEY_ID, signingBinding: bindingFor(hash) },
        quoted.instruction,
        { onSigned: () => { hookCalled = true; } },
      ),
    ).rejects.toThrow(/signer returned an envelope/);
    expect(hookCalled).toBe(false);
    expect(bad.broadcasts).toHaveLength(0);
  });

  it("treats an RPC hash mismatch as ambiguous and retains the signed hash", async () => {
    const h = harness({ sendRaw: async () => `0x${"f".repeat(64)}` });
    const { instruction } = await quoteInstruction(h);
    const hash = await h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, instruction);
    let persisted: string | null = null;
    const error = await h.sender
      .send(
        { vaultKeyId: KEY_ID, signingBinding: bindingFor(hash) },
        instruction,
        { onSigned: (value) => { persisted = value; } },
      )
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AmbiguousBroadcastError);
    expect((error as InstanceType<typeof AmbiguousBroadcastError>).externalId).toBe(persisted);
    expect(h.events).toEqual(["sign", "broadcast"]);
  });

  it("resumes only the exact persisted signed bytes, without signing again", async () => {
    const h = harness();
    const { instruction } = await quoteInstruction(h, "99", "ETH");
    const prepared = parsePreparedEvmQuote(instruction);
    const signed = await signPrepared(KEY_ID, prepared.request, bindingFor(prepared.requestHash));
    const envelope = { encoding: "hex" as const, payload: signed.serialized };

    const receipt = await h.sender.resumeBroadcast!(
      { vaultKeyId: KEY_ID },
      instruction,
      envelope,
      signed.hash,
    );
    expect(receipt).toEqual({ externalId: signed.hash, status: "broadcast" });
    expect(h.events).toEqual(["broadcast"]);
    expect(h.requests).toHaveLength(0);
    expect(h.broadcasts).toEqual([signed.serialized]);

    await expect(
      h.sender.resumeBroadcast!(
        { vaultKeyId: KEY_ID },
        instruction,
        envelope,
        `0x${"f".repeat(64)}`,
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      h.sender.resumeBroadcast!(
        { vaultKeyId: KEY_ID },
        instruction,
        { encoding: "hex", payload: signed.serialized.toUpperCase() as Hex },
        signed.hash,
      ),
    ).rejects.toThrow(/malformed|recovery/);
    const { instruction: changedPreparedRequest } = await quoteInstruction(h, "100", "ETH");
    await expect(
      h.sender.resumeBroadcast!(
        { vaultKeyId: KEY_ID },
        changedPreparedRequest,
        envelope,
        signed.hash,
      ),
    ).rejects.toThrow(/does not match the prepared/);
    expect(h.broadcasts).toHaveLength(1);
  });

  it("redacts provider details from quote and ambiguous-broadcast errors", async () => {
    const secret = "SUPER-SECRET-RPC-TOKEN";
    let protocolFeeCalled = false;
    const quoteSender = createEvmSender({
      createRpcClient: () => ({
        estimateGas: async () => 21_000n,
        estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
        getTransactionCount: async () => 0,
        estimateBaseProtocolFees: async () => {
          protocolFeeCalled = true;
          throw new Error(`https://rpc.example/${secret}`);
        },
        sendRawTransaction: async () => `0x${"1".repeat(64)}`,
      }),
      resolveSenderAddress: async () => account.address,
    });
    const quoteMessage = await quoteSender
      .quote(
        { vaultKeyId: KEY_ID },
        { to: RECIPIENT, amountMinor: "1", asset: "ETH" },
      )
      .then(() => "", (error: Error) => error.message);
    expect(quoteMessage).toContain("Base RPC could not prepare");
    expect(quoteMessage).not.toContain(secret);
    expect(quoteMessage).not.toContain("rpc.example");
    expect(protocolFeeCalled).toBe(true);

    const h = harness({
      sendRaw: async () => { throw new Error(`https://rpc.example/${secret}`); },
    });
    const { instruction } = await quoteInstruction(h);
    const requestHash = await h.sender.signingRequestHash({ vaultKeyId: KEY_ID }, instruction);
    const broadcastMessage = await h.sender
      .send(
        { vaultKeyId: KEY_ID, signingBinding: bindingFor(requestHash) },
        instruction,
        { onSigned: () => {} },
      )
      .then(() => "", (error: Error) => error.message);
    expect(broadcastMessage).toContain("Broadcast outcome unknown");
    expect(broadcastMessage).not.toContain(secret);
    expect(broadcastMessage).not.toContain("rpc.example");
  });
});
