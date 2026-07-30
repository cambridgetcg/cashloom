import { describe, expect, it } from "bun:test";
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createEvmSender,
  type EvmSenderDependencies,
} from "./evm.sender.ts";
import { AmbiguousBroadcastError } from "./types.ts";

// Public Anvil fixture keys; these tests never connect to a network.
const TEST_ACCOUNT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const OTHER_ACCOUNT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const FROM = TEST_ACCOUNT.address;
const DEST = "0x2222222222222222222222222222222222222222" as Address;
const OTHER = "0x3333333333333333333333333333333333333333" as Address;
const SERIALIZED = await TEST_ACCOUNT.signTransaction({
  chainId: 8453,
  type: "eip1559",
  to: DEST,
  value: 123_456_789n,
  data: "0x",
  gas: 55_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
  nonce: 17,
});
const LOCAL_HASH = keccak256(SERIALIZED);

const instruction = {
  to: DEST,
  amountMinor: "123456789",
  asset: "ETH",
};

const makeHarness = () => {
  const state = {
    gas: 55_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    estimatedTotalFeeWei: 115_000_000_000_000n,
    acceptedFeeMinor: "115000000000000",
    nonce: 17,
    signFailure: null as Error | null,
    dispatchFailure: null as Error | null,
    markSignedFailure: null as Error | null,
    markSubmittingFailure: null as Error | null,
    markSubmittedFailure: null as Error | null,
    mutateSignedRequest: null as
      | ((
          request: Parameters<EvmSenderDependencies["signTransaction"]>[2],
        ) => Parameters<EvmSenderDependencies["signTransaction"]>[2])
      | null,
    wrongSigner: false,
    serializedOverride: null as Hex | null,
    submittedHash: LOCAL_HASH as Hex,
  };
  const calls = {
    estimates: [] as Array<{
      from: Address;
      request: { to: Address; value: bigint; data: Hex };
    }>,
    signed: [] as Array<{
      expectedFrom: Address;
      request: Parameters<EvmSenderDependencies["signTransaction"]>[2];
    }>,
    dispatched: [] as Hex[],
    order: [] as string[],
  };

  const dependencies: EvmSenderDependencies = {
    async getSenderAddress() {
      return FROM;
    },
    async getAcceptedFeeMinor() {
      return state.acceptedFeeMinor;
    },
    async getAcceptedExecutionFeeCeilingMinor() {
      return (55_000n * 2_000_000_000n).toString();
    },
    async estimateGas(from, request) {
      calls.estimates.push({ from, request });
      return state.gas;
    },
    async estimateFeesPerGas() {
      return {
        maxFeePerGas: state.maxFeePerGas,
        maxPriorityFeePerGas: state.maxPriorityFeePerGas,
      };
    },
    async estimateTotalFee() {
      return state.estimatedTotalFeeWei;
    },
    async getPendingNonce() {
      return state.nonce;
    },
    async reserveNonce(_ctx, _address, pendingNonce) {
      calls.order.push(`reserve:${pendingNonce}`);
      return state.nonce;
    },
    async markNonceSigned() {
      calls.order.push("nonce:signed");
      if (state.markSignedFailure) throw state.markSignedFailure;
    },
    async markNonceSubmitting() {
      calls.order.push("nonce:submitting");
      if (state.markSubmittingFailure) throw state.markSubmittingFailure;
    },
    async markNonceSubmitted() {
      calls.order.push("nonce:submitted");
      if (state.markSubmittedFailure) throw state.markSubmittedFailure;
    },
    async markNonceSubmissionUnknown() {
      calls.order.push("nonce:unknown");
    },
    async releaseNoncePreSubmit() {
      calls.order.push("nonce:released");
    },
    async signTransaction(_ctx, expectedFrom, request) {
      calls.order.push("sign");
      calls.signed.push({ expectedFrom, request });
      if (state.signFailure) throw state.signFailure;
      const signedRequest = state.mutateSignedRequest
        ? state.mutateSignedRequest(request)
        : request;
      if (state.serializedOverride) return state.serializedOverride;
      return (state.wrongSigner ? OTHER_ACCOUNT : TEST_ACCOUNT).signTransaction(
        signedRequest,
      );
    },
    async sendRawTransaction(serializedTransaction) {
      calls.order.push("dispatch");
      calls.dispatched.push(serializedTransaction);
      if (state.dispatchFailure) throw state.dispatchFailure;
      return state.submittedHash;
    },
  };

  return {
    sender: createEvmSender(dependencies),
    state,
    calls,
    ctx: { vaultKeyId: "test-evm-key", paymentId: "test-payment" },
  };
};

describe("evm sender — quote-bound raw transaction", () => {
  it("persists the exact L2 ceiling separately from the uncapped current total estimate", async () => {
    const { sender, ctx } = makeHarness();
    const quote = await sender.quote(ctx, instruction);
    const detail = JSON.parse(quote.detail!) as Record<string, any>;

    expect(quote.feeMinor).toBe("115000000000000");
    expect(quote.executionFeeCeilingMinor).toBe("110000000000000");
    expect(detail).toMatchObject({
      v: 2,
      chainId: 8453,
      asset: "ETH",
      from: FROM,
      recipient: DEST,
      amountMinor: "123456789",
      request: {
        to: DEST,
        value: "123456789",
        data: "0x",
        gas: "55000",
        maxFeePerGas: "2000000000",
        maxPriorityFeePerGas: "100000000",
      },
      l2ExecutionFeeCeilingWei: "110000000000000",
      estimatedTotalFeeWei: quote.feeMinor,
    });
    expect(quote.summary).toContain("current total network-fee estimate");
    expect(quote.summary).toContain("L1 data/operator fees");
    expect(quote.summary).toContain("not capped by EIP-1559");
    expect(JSON.stringify(detail)).not.toContain("test-evm-key");
  });

  it("renders large USDC atomic amounts exactly without Number rounding", async () => {
    const { sender, ctx } = makeHarness();
    const quote = await sender.quote(ctx, {
      to: DEST,
      amountMinor: "9007199254740993123456",
      asset: "USDC",
    });

    expect(quote.summary).toContain("9007199254740993.123456 USDC");
    const detail = JSON.parse(quote.detail!) as Record<string, any>;
    expect(detail.amountMinor).toBe("9007199254740993123456");
    expect(detail.request.value).toBe("0");
    expect(detail.request.data).toMatch(/^0xa9059cbb/);
  });

  it("signs the accepted gas and fee fields, persists the local hash, then dispatches once", async () => {
    const { sender, ctx, state, calls } = makeHarness();
    const quote = await sender.quote(ctx, instruction);

    // State changed after quote: validation may observe a lower estimate, but
    // it must never substitute fresh fields for the user's accepted ceiling.
    state.gas = 40_000n;
    state.maxFeePerGas = 1n;
    calls.order.length = 0;

    const receipt = await sender.send(
      ctx,
      { ...instruction, detail: quote.detail },
      {
        onSigned(hash) {
          calls.order.push(`persist:${hash}`);
          expect(calls.dispatched).toHaveLength(0);
        },
      }
    );

    expect(receipt).toEqual({ externalId: LOCAL_HASH, status: "broadcast" });
    expect(calls.order).toEqual([
      "reserve:17",
      "sign",
      "nonce:signed",
      `persist:${LOCAL_HASH}`,
      "nonce:submitting",
      "dispatch",
      "nonce:submitted",
    ]);
    expect(calls.dispatched).toEqual([SERIALIZED]);
    expect(calls.signed).toEqual([
      {
        expectedFrom: FROM,
        request: {
          chainId: 8453,
          type: "eip1559",
          to: DEST,
          value: 123_456_789n,
          data: "0x",
          gas: 55_000n,
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 100_000_000n,
          nonce: 17,
        },
      },
    ]);
  });

  it("produces a real recoverable Base EIP-1559 transaction offline", async () => {
    const account = TEST_ACCOUNT;
    let submitted: Hex | null = null;
    const sender = createEvmSender({
      async getSenderAddress() {
        return account.address;
      },
      async getAcceptedFeeMinor() {
        return "115000000000000";
      },
      async getAcceptedExecutionFeeCeilingMinor() {
        return (55_000n * 2_000_000_000n).toString();
      },
      async estimateGas() {
        return 55_000n;
      },
      async estimateFeesPerGas() {
        return {
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 100_000_000n,
        };
      },
      async estimateTotalFee() {
        return 115_000_000_000_000n;
      },
      async getPendingNonce() {
        return 17;
      },
      async reserveNonce(_ctx, _address, pendingNonce) {
        return pendingNonce;
      },
      async markNonceSigned() {},
      async markNonceSubmitting() {},
      async markNonceSubmitted() {},
      async markNonceSubmissionUnknown() {},
      async releaseNoncePreSubmit() {},
      async signTransaction(_ctx, expectedFrom, request) {
        expect(expectedFrom).toBe(account.address);
        return account.signTransaction(request);
      },
      async sendRawTransaction(serializedTransaction) {
        submitted = serializedTransaction;
        return keccak256(serializedTransaction);
      },
    });

    const ctx = { vaultKeyId: "offline-vector", paymentId: "payment-vector" };
    const quote = await sender.quote(ctx, instruction);
    const receipt = await sender.send(ctx, { ...instruction, detail: quote.detail });

    expect(receipt.externalId).toBe(keccak256(submitted!));
    const parsed = parseTransaction(submitted!);
    expect(parsed).toMatchObject({
      chainId: 8453,
      type: "eip1559",
      nonce: 17,
      to: DEST,
      value: 123_456_789n,
      gas: 55_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    });
    expect(
      await recoverTransactionAddress({
        serializedTransaction: submitted! as `0x02${string}`,
      }),
    ).toBe(account.address);
  });

  it("rejects every altered signed field and a wrong signer before dispatch", async () => {
    const mutations: Array<
      [
        string,
        (
          request: Parameters<EvmSenderDependencies["signTransaction"]>[2],
        ) => Parameters<EvmSenderDependencies["signTransaction"]>[2],
      ]
    > = [
      ["chain", (request) => ({ ...request, chainId: 1 })],
      ["nonce", (request) => ({ ...request, nonce: request.nonce + 1 })],
      ["gas", (request) => ({ ...request, gas: request.gas + 1n })],
      [
        "maximum fee",
        (request) => ({ ...request, maxFeePerGas: request.maxFeePerGas + 1n }),
      ],
      [
        "priority fee",
        (request) => ({
          ...request,
          maxPriorityFeePerGas: request.maxPriorityFeePerGas + 1n,
        }),
      ],
      ["destination", (request) => ({ ...request, to: OTHER })],
      ["value", (request) => ({ ...request, value: request.value + 1n })],
      ["calldata", (request) => ({ ...request, data: "0x12" })],
    ];

    for (const [name, mutate] of mutations) {
      const { sender, ctx, state, calls } = makeHarness();
      const quote = await sender.quote(ctx, instruction);
      state.mutateSignedRequest = mutate;

      const error = await sender
        .send(ctx, { ...instruction, detail: quote.detail })
        .then(() => null, (caught: Error) => caught);

      expect(error, name).toBeInstanceOf(Error);
      expect(error?.message, name).toMatch(/exact accepted transaction/);
      expect(calls.dispatched, name).toHaveLength(0);
      expect(calls.order.at(-1), name).toBe("nonce:released");
    }

    const { sender, ctx, state, calls } = makeHarness();
    const quote = await sender.quote(ctx, instruction);
    state.wrongSigner = true;
    const error = await sender
      .send(ctx, { ...instruction, detail: quote.detail })
      .then(() => null, (caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/exact accepted transaction/);
    expect(calls.dispatched).toHaveLength(0);
    expect(calls.order.at(-1)).toBe("nonce:released");

    const parsed = parseTransaction(SERIALIZED);
    const secp256k1N =
      0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = `0x${(secp256k1N - BigInt(parsed.s!))
      .toString(16)
      .padStart(64, "0")}` as Hex;
    const highSSerialized = serializeTransaction(
      {
        chainId: 8453,
        type: "eip1559",
        to: DEST,
        value: 123_456_789n,
        data: "0x",
        gas: 55_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 100_000_000n,
        nonce: 17,
        accessList: [],
      },
      {
        r: parsed.r!,
        s: highS,
        yParity: (parsed.yParity === 0 ? 1 : 0) as 0 | 1,
      },
    );
    expect(
      await recoverTransactionAddress({
        serializedTransaction: highSSerialized as `0x02${string}`,
      }),
    ).toBe(FROM);

    const highSHarness = makeHarness();
    const highSQuote = await highSHarness.sender.quote(
      highSHarness.ctx,
      instruction,
    );
    highSHarness.state.serializedOverride = highSSerialized;
    const highSError = await highSHarness.sender
      .send(highSHarness.ctx, { ...instruction, detail: highSQuote.detail })
      .then(() => null, (caught: Error) => caught);
    expect(highSError).toBeInstanceOf(Error);
    expect(highSError?.message).toMatch(/exact accepted transaction/);
    expect(highSHarness.calls.dispatched).toHaveLength(0);
    expect(highSHarness.calls.order.at(-1)).toBe("nonce:released");
  });

  it("makes every dispatch error sticky ambiguity carrying the precomputed hash", async () => {
    const { sender, ctx, state, calls } = makeHarness();
    const quote = await sender.quote(ctx, instruction);
    state.dispatchFailure = new Error("RPC timed out after accepting bytes");

    let caught: unknown;
    try {
      await sender.send(ctx, { ...instruction, detail: quote.detail });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AmbiguousBroadcastError);
    expect((caught as AmbiguousBroadcastError).externalId).toBe(LOCAL_HASH);
    expect(calls.dispatched).toEqual([SERIALIZED]);
    expect(calls.order).toContain("nonce:unknown");
  });

  it("releases only failures proven to precede durable signed-payload persistence", async () => {
    {
      const { sender, ctx, state, calls } = makeHarness();
      const quote = await sender.quote(ctx, instruction);
      state.signFailure = new Error("local signer refused");
      const error = await sender
        .send(ctx, { ...instruction, detail: quote.detail })
        .then(() => null, (caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AmbiguousBroadcastError);
      expect(calls.dispatched).toHaveLength(0);
      expect(calls.order).toContain("nonce:released");
    }

    {
      const { sender, ctx, state, calls } = makeHarness();
      const quote = await sender.quote(ctx, instruction);
      state.markSignedFailure = new Error("signed-payload database write refused");
      const error = await sender
        .send(ctx, { ...instruction, detail: quote.detail })
        .then(() => null, (caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AmbiguousBroadcastError);
      expect(calls.dispatched).toHaveLength(0);
      expect(calls.order.at(-1)).toBe("nonce:released");
    }
  });

  it("keeps failures after durable signing sticky even before dispatch begins", async () => {
    {
      const { sender, ctx, calls } = makeHarness();
      const quote = await sender.quote(ctx, instruction);
      const error = await sender
        .send(ctx, { ...instruction, detail: quote.detail }, {
          onSigned() {
            throw new Error("database write refused");
          },
        })
        .then(() => null, (caught: Error) => caught);
      expect(error).toBeInstanceOf(AmbiguousBroadcastError);
      expect(calls.dispatched).toHaveLength(0);
      expect(calls.order).not.toContain("nonce:released");
    }

    {
      const { sender, ctx, state, calls } = makeHarness();
      const quote = await sender.quote(ctx, instruction);
      state.markSubmittingFailure = new Error("nonce database refused");
      const error = await sender
        .send(ctx, { ...instruction, detail: quote.detail })
        .then(() => null, (caught: Error) => caught);
      expect(error).toBeInstanceOf(AmbiguousBroadcastError);
      expect(calls.dispatched).toHaveLength(0);
      expect(calls.order).not.toContain("nonce:released");
    }
  });

  it("keeps post-egress nonce bookkeeping failures sticky and ambiguous", async () => {
    const { sender, ctx, state, calls } = makeHarness();
    const quote = await sender.quote(ctx, instruction);
    state.markSubmittedFailure = new Error("disk full after RPC acknowledgement");

    const error = await sender
      .send(ctx, { ...instruction, detail: quote.detail })
      .then(() => null, (caught: Error) => caught);

    expect(error).toBeInstanceOf(AmbiguousBroadcastError);
    expect((error as AmbiguousBroadcastError).externalId).toBe(LOCAL_HASH);
    expect(calls.dispatched).toEqual([SERIALIZED]);
    expect(calls.order).toContain("nonce:unknown");
    expect(calls.order).not.toContain("nonce:released");
  });

  it("rejects an accepted gas limit that became insufficient before signing", async () => {
    const { sender, ctx, state, calls } = makeHarness();
    const quote = await sender.quote(ctx, instruction);
    state.gas = 55_001n;

    await expect(
      sender.send(ctx, { ...instruction, detail: quote.detail })
    ).rejects.toThrow(/gas limit is no longer sufficient/);
    expect(calls.signed).toHaveLength(0);
    expect(calls.dispatched).toHaveLength(0);
  });

  it("treats destination, amount, asset, chain, request, and fee detail as hostile input", async () => {
    const cases: Array<[string, (detail: Record<string, any>) => void]> = [
      ["recipient", (detail) => (detail.recipient = OTHER)],
      ["amount", (detail) => (detail.amountMinor = "1")],
      ["asset", (detail) => (detail.asset = "USDC")],
      ["chain", (detail) => (detail.chainId = 1)],
      ["request destination", (detail) => (detail.request.to = OTHER)],
      ["request value", (detail) => (detail.request.value = "1")],
      ["request data", (detail) => (detail.request.data = "0x12")],
      ["gas", (detail) => (detail.request.gas = "0")],
      ["fee per gas", (detail) => (detail.request.maxFeePerGas = "999")],
      [
        "priority fee",
        (detail) => (detail.request.maxPriorityFeePerGas = "3000000000"),
      ],
      [
        "L2 execution fee ceiling",
        (detail) => (detail.l2ExecutionFeeCeilingWei = "1"),
      ],
      ["total fee estimate", (detail) => (detail.estimatedTotalFeeWei = "1")],
      [
        "coordinated fee fields",
        (detail) => {
          detail.request.maxFeePerGas = "3000000000";
          detail.l2ExecutionFeeCeilingWei =
            (55_000n * 3_000_000_000n).toString();
        },
      ],
    ];

    for (const [name, mutate] of cases) {
      const { sender, ctx, calls } = makeHarness();
      const quote = await sender.quote(ctx, instruction);
      const detail = JSON.parse(quote.detail!) as Record<string, any>;
      mutate(detail);

      const error = await sender
        .send(ctx, { ...instruction, detail: JSON.stringify(detail) })
        .then(() => null, (caught: Error) => caught);
      expect(error, name).toBeInstanceOf(Error);
      expect(calls.signed, name).toHaveLength(0);
      expect(calls.dispatched, name).toHaveLength(0);
    }
  });

  it("treats a provider hash mismatch as ambiguity and never trusts it over local bytes", async () => {
    const { sender, ctx, state } = makeHarness();
    const quote = await sender.quote(ctx, instruction);
    state.submittedHash = `0x${"ab".repeat(32)}`;

    let caught: unknown;
    try {
      await sender.send(ctx, { ...instruction, detail: quote.detail });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AmbiguousBroadcastError);
    expect((caught as AmbiguousBroadcastError).externalId).toBe(LOCAL_HASH);
  });
});
