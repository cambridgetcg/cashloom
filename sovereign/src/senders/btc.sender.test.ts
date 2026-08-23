import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The DB path is read at import time — point it at a throwaway dir BEFORE
// the module graph loads. ||= composes with sibling test files when bun test
// shares a module registry: the first file to import db.ts decides the dir.
process.env.CASHLOOM_DATA_DIR ||= mkdtempSync(join(tmpdir(), "cashloom-btc-test-"));

const { db, newId } = await import("../db.ts");
const vault = await import("../vault.ts");
const { btcSender } = await import("./btc.sender.ts");
const {
  quotePayment,
  confirmPayment,
  resumePaymentBroadcast,
  getWalletKernelIntent,
} = await import("../pay.ts");
const { Address, NETWORK, OutScript, RawTx, WIF } = await import("@scure/btc-signer");
const { hex } = await import("@scure/base");

const PASS = "correct horse battery staple";
if (!vault.isInitialized()) await vault.initialize(PASS);
else await vault.unlock(PASS);

// Throwaway test vector (32 bytes of 0x07) — NOT a secret. Address derived
// and pinned by the vault test below; destination is 32 bytes of 0x09.
const PRIV_HEX = "07".repeat(32);
const SELF = "bc1q50rtrmj2f8vl9tem8qpfw36ylw5jg9j29e5za5";
const DEST = "bc1qvux25709r4uw6rzc8wyl7wwecjdhrx085hm5ty";

const btcKey = await vault.importBtcKey("btc sender test key", PRIV_HEX);
const ctx = { vaultKeyId: btcKey.id };

const scriptOf = (address: string) => hex.encode(OutScript.encode(Address(NETWORK).decode(address)!));

/* ------------------------------- fetch mock ------------------------------- */

interface MockRoute {
  utxos?: unknown;
  fees?: unknown;
  tip?: string;
  broadcast?: (body: string) => Response;
}
let route: MockRoute = {};
let broadcastBodies: string[] = [];
const resetMock = (r: MockRoute = {}) => {
  route = r;
  broadcastBodies = [];
};

const utxo = (txid: string, vout: number, value: number, confirmed = true) => ({
  txid,
  vout,
  value,
  status: { confirmed },
});
const T1 = "aa".repeat(32);
const T2 = "bb".repeat(32);
const T3 = "cc".repeat(32);
// Coins committed to a live payment are RESERVED for later quotes, so every
// test that creates a payments row gets its own txids — reuse would make
// one test's broadcast starve the next test's selection.
const utxoId = (tag: string) => tag.repeat(32);

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/fee-estimates")) {
      return Response.json(route.fees ?? { "1": 20, "3": 5, "6": 3 });
    }
    if (url.includes("/utxo")) {
      return Response.json(route.utxos ?? []);
    }
    if (url.endsWith("/blocks/tip/height")) {
      return new Response(route.tip ?? "903000");
    }
    if (url.endsWith("/tx") && init?.method === "POST") {
      broadcastBodies.push(String(init.body));
      return route.broadcast ? route.broadcast(String(init.body)) : new Response("ok");
    }
    throw new Error(`unmocked fetch in test: ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/* --------------------------------- helpers -------------------------------- */

const makeBtcAccount = (): string => {
  const id = newId();
  db.query(
    `INSERT INTO accounts (id, rail, display_name, currency, decimals, connector_type, external_account_id, vault_key_id)
     VALUES (?, 'CRYPTO', 'btc wallet', 'BTC', 8, 'esplora', ?, ?)`
  ).run(id, SELF, btcKey.id);
  return id;
};

interface DetailShape {
  v: number;
  to: string;
  amountSat: string;
  inputs: Array<{ txid: string; vout: number; sat: string }>;
  changeSat: string;
  feeSat: string;
  feeRateSatVb: string;
  lockTime: number;
}

/* ---------------------------------- quote --------------------------------- */

describe("btc sender — quote discipline", () => {
  it("pins the vault key's address (vector check for everything below)", () => {
    expect(btcKey.address).toBe(SELF);
    expect(btcKey.kind).toBe("btc");
  });

  it("quotes an EXACT fee and persists the full selection as detail", async () => {
    resetMock({ utxos: [utxo(T1, 0, 100_000), utxo(T2, 1, 250_000), utxo(T3, 0, 500_000, false)] });
    const quote = await btcSender.quote(ctx, { to: DEST, amountMinor: "150000", asset: "BTC" });
    expect(quote.feeAsset).toBe("BTC");
    expect(quote.summary).toContain(`exactly ${quote.feeMinor} sats`);
    expect(quote.summary).toContain("5 sat/vB"); // target-3-blocks estimate
    expect(quote.summary).toContain("never raise it");

    const detail = JSON.parse(quote.detail!) as DetailShape;
    expect(detail.v).toBe(1);
    expect(detail.to).toBe(DEST);
    expect(detail.amountSat).toBe("150000");
    expect(detail.lockTime).toBe(903000); // anti-fee-sniping: tip height
    expect(detail.feeSat).toBe(quote.feeMinor);
    // The unconfirmed 500k UTXO must never be selected.
    for (const input of detail.inputs) expect(input.txid).not.toBe(T3);
    // The implicit-fee equation, the invariant everything else hangs on.
    const totalIn = detail.inputs.reduce((s, i) => s + BigInt(i.sat), 0n);
    expect(totalIn - 150_000n - BigInt(detail.changeSat)).toBe(BigInt(detail.feeSat));
  });

  it("refuses a sub-dust destination amount at QUOTE time, per script type", async () => {
    resetMock({ utxos: [utxo(T1, 0, 100_000)] });
    await expect(
      btcSender.quote(ctx, { to: DEST, amountMinor: "200", asset: "BTC" })
    ).rejects.toThrow(/294-sat dust floor/);
  });

  it("refuses a self-pay", async () => {
    resetMock({ utxos: [utxo(T1, 0, 100_000)] });
    await expect(
      btcSender.quote(ctx, { to: SELF, amountMinor: "50000", asset: "BTC" })
    ).rejects.toThrow(/own address/);
  });

  it("refuses testnet, EVM, and garbage destinations before any network read", async () => {
    for (const bad of ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "0x" + "1".repeat(40), "not-an-address"]) {
      await expect(
        btcSender.quote(ctx, { to: bad, amountMinor: "50000", asset: "BTC" })
      ).rejects.toThrow(/not a valid mainnet Bitcoin address/);
    }
  });

  it("refuses zero, negative, and decimal amounts", async () => {
    for (const bad of ["0", "-5", "1.5", "", "01"]) {
      await expect(
        btcSender.quote(ctx, { to: DEST, amountMinor: bad, asset: "BTC" })
      ).rejects.toThrow(/positive integer satoshi/);
    }
  });

  it("states spendable, pending, and max-sendable when funds are short", async () => {
    resetMock({ utxos: [utxo(T1, 0, 100_000), utxo(T2, 1, 250_000), utxo(T3, 0, 500_000, false)] });
    const err = await btcSender
      .quote(ctx, { to: DEST, amountMinor: "1000000", asset: "BTC" })
      .then(() => null, (e: Error) => e.message);
    expect(err).toContain("350000 sats spendable");
    expect(err).toContain("500000 more sats await confirmation");
    expect(err).toContain("Max sendable now");
  });

  it("finds the changeless near-sweep shape instead of refusing it", async () => {
    resetMock({ utxos: [utxo(T1, 0, 100_000)], fees: { "3": 1 } });
    const quote = await btcSender.quote(ctx, { to: DEST, amountMinor: "99880", asset: "BTC" });
    const detail = JSON.parse(quote.detail!) as DetailShape;
    expect(detail.changeSat).toBe("0");
    expect(BigInt(detail.feeSat)).toBe(100_000n - 99_880n); // surplus folds into fee
    expect(quote.summary).toContain("folded into the fee");
  });

  it("refuses a manipulated fee rate past the sanity ceiling", async () => {
    resetMock({ utxos: [utxo(T1, 0, 100_000)], fees: { "3": 5000 } });
    await expect(
      btcSender.quote(ctx, { to: DEST, amountMinor: "50000", asset: "BTC" })
    ).rejects.toThrow(/sanity ceiling/);
  });

  it("excludes uneconomical dust UTXOs from selection and the spendable figure", async () => {
    // At 100 sat/vB an input costs ~6800 sats to spend; the 200-sat UTXO can
    // only grow the deficit and must not appear anywhere.
    resetMock({ utxos: [utxo(T1, 0, 200), utxo(T2, 1, 300_000)], fees: { "3": 100 } });
    const quote = await btcSender.quote(ctx, { to: DEST, amountMinor: "250000", asset: "BTC" });
    const detail = JSON.parse(quote.detail!) as DetailShape;
    expect(detail.inputs).toHaveLength(1);
    expect(detail.inputs[0]!.txid).toBe(T2);
  });
});

/* ---------------------------------- send ---------------------------------- */

describe("btc sender + pay — the quote→confirm rite, end to end", () => {
  it("signs EXACTLY the quoted selection, persists the txid BEFORE broadcast, records the true outflow", async () => {
    resetMock({ utxos: [utxo(utxoId("d1"), 0, 100_000), utxo(utxoId("d2"), 1, 250_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "150000", asset: "BTC" });

    const stored = db.query("SELECT detail, fee_minor FROM payments WHERE id = ?").get(quote.paymentId) as {
      detail: string | null;
      fee_minor: string;
    };
    expect(stored.detail).not.toBeNull();
    expect(stored.fee_minor).toBe(quote.feeMinor);

    // The broadcast mock reads the payments row MID-FLIGHT: the txid must
    // already be there — signed-before-heard is the crash/ambiguity guard.
    let txHashAtBroadcast: string | null = null;
    route.broadcast = () => {
      const row = db.query("SELECT tx_hash FROM payments WHERE id = ?").get(quote.paymentId) as {
        tx_hash: string | null;
      };
      txHashAtBroadcast = row.tx_hash;
      return new Response("ok");
    };

    const result = await confirmPayment(quote.paymentId);
    expect(result.status).toBe("broadcast");
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(txHashAtBroadcast as string | null).toBe(result.txHash);

    // Decode what actually left the box.
    const raw = RawTx.decode(hex.decode(broadcastBodies[0]!));
    expect(raw.lockTime).toBe(903000);
    for (const input of raw.inputs) expect(input.sequence).toBe(0xfffffffd); // RBF signalled
    expect(raw.outputs[0]!.amount).toBe(150_000n);
    expect(hex.encode(raw.outputs[0]!.script)).toBe(scriptOf(DEST));
    const detail = JSON.parse(stored.detail!) as DetailShape;
    if (BigInt(detail.changeSat) > 0n) {
      expect(raw.outputs[1]!.amount).toBe(BigInt(detail.changeSat));
      expect(hex.encode(raw.outputs[1]!.script)).toBe(scriptOf(SELF)); // change comes home
    }
    // fee = inputs − outputs, exactly as disclosed
    const inSum = detail.inputs.reduce((s, i) => s + BigInt(i.sat), 0n);
    const outSum = raw.outputs.reduce((s, o) => s + o.amount, 0n);
    expect(inSum - outSum).toBe(BigInt(quote.feeMinor));

    // The ledger row records amount + fee — the SAME number the esplora read
    // rail would derive for this txid, so the dedupe skip is harmless.
    const ledger = db
      .query("SELECT amount_minor, source FROM transactions WHERE external_id = ?")
      .get(result.txHash) as { amount_minor: string; source: string };
    expect(ledger.source).toBe("PAYMENT");
    expect(BigInt(ledger.amount_minor)).toBe(-(150_000n + BigInt(quote.feeMinor)));

    // The compatibility facade is backed by a complete v2 audit spine.
    const intent = db.query(
      "SELECT state, intent_hash FROM wk_payment_intents WHERE id=?",
    ).get(quote.paymentId) as { state: string; intent_hash: string };
    expect(intent.state).toBe("submitted");
    expect(intent.intent_hash).toBe(quote.intentHash);
    const authorization = db.query(
      "SELECT status, request_hash FROM wk_authorizations WHERE intent_id=?",
    ).get(quote.paymentId) as { status: string; request_hash: string };
    expect(authorization.status).toBe("CONSUMED");
    expect(authorization.request_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const execution = db.query(
      `SELECT state, network_tx_id, signed_artifact_id, response_json
       FROM wk_executions WHERE intent_id=?`,
    ).get(quote.paymentId) as {
      state: string;
      network_tx_id: string;
      signed_artifact_id: string;
      response_json: string;
    };
    expect(execution.state).toBe("submitted");
    expect(execution.network_tx_id).toBe(result.txHash!);
    expect(JSON.parse(execution.response_json)).toMatchObject({
      signed_artifact: {
        id: execution.signed_artifact_id,
        encoding: "hex",
        external_tx_id: result.txHash,
      },
      recovery: "explicit-exact-rebroadcast-only",
    });
    const artifact = db.query(
      `SELECT payload, external_tx_id, envelope_hash
       FROM wk_signed_artifacts WHERE id=?`,
    ).get(execution.signed_artifact_id) as {
      payload: string;
      external_tx_id: string;
      envelope_hash: string;
    };
    expect(artifact).toMatchObject({
      payload: `0x${broadcastBodies[0]}`,
      external_tx_id: result.txHash,
    });
    expect(artifact.envelope_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const postings = db.query(
      `SELECT direction, amount_atomic FROM wk_postings
       WHERE journal_entry_id=? ORDER BY posting_index`,
    ).all(`journal.${quote.paymentId}.submitted`) as Array<{
      direction: string;
      amount_atomic: string;
    }>;
    expect(postings).toEqual([
      { direction: "DEBIT", amount_atomic: (150_000n + BigInt(quote.feeMinor)).toString() },
      { direction: "CREDIT", amount_atomic: (150_000n + BigInt(quote.feeMinor)).toString() },
    ]);
  });

  it("treats a doctored detail as hostile — reconciliation failure refuses to sign", async () => {
    resetMock({ utxos: [utxo(utxoId("e1"), 0, 100_000), utxo(utxoId("e2"), 1, 250_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "150000", asset: "BTC" });
    const stored = db.query("SELECT detail FROM payments WHERE id = ?").get(quote.paymentId) as {
      detail: string;
    };
    const doctored = JSON.parse(stored.detail) as DetailShape;
    doctored.feeSat = (BigInt(doctored.feeSat) + 100_000n).toString(); // silent miner overpay attempt
    db.query("UPDATE payments SET detail = ? WHERE id = ?").run(JSON.stringify(doctored), quote.paymentId);

    const result = await confirmPayment(quote.paymentId);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/immutable Wallet Kernel intent/);
    expect(broadcastBodies).toHaveLength(0); // nothing was signed, nothing left
  });

  it("refuses a coherent recipient+detail rewrite that no longer matches the immutable quote", async () => {
    resetMock({ utxos: [utxo(utxoId("ee"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const stored = db.query("SELECT detail FROM payments WHERE id = ?").get(quote.paymentId) as {
      detail: string;
    };
    const rewritten = JSON.parse(stored.detail) as DetailShape;
    rewritten.to = SELF;
    db.query("UPDATE payments SET to_addr=?, detail=? WHERE id=?").run(
      SELF,
      JSON.stringify(rewritten),
      quote.paymentId,
    );

    const result = await confirmPayment(quote.paymentId);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/immutable Wallet Kernel intent/);
    expect(broadcastBodies).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM wk_authorizations WHERE intent_id=?").get(
      quote.paymentId,
    )).toEqual({ n: 0 });
  });

  it("refuses to confirm when the detail is missing — re-selection is never a fallback", async () => {
    resetMock({ utxos: [utxo(utxoId("e3"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    db.query("UPDATE payments SET detail = NULL WHERE id = ?").run(quote.paymentId);
    const result = await confirmPayment(quote.paymentId);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/immutable Wallet Kernel intent/);
    expect(broadcastBodies).toHaveLength(0);
  });

  it("an unanswered broadcast is AMBIGUOUS: unresendable, txid recorded, no ledger row", async () => {
    resetMock({
      utxos: [utxo(utxoId("e4"), 0, 100_000)],
      broadcast: () => new Response("gateway grief", { status: 502 }),
    });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const result = await confirmPayment(quote.paymentId);

    expect(result.status).toBe("confirmed"); // NOT failed — the tx may be live
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.error).toMatch(/outcome unknown/i);

    const row = db.query("SELECT status, tx_hash, error FROM payments WHERE id = ?").get(quote.paymentId) as {
      status: string;
      tx_hash: string;
      error: string;
    };
    expect(row.status).toBe("confirmed"); // only 'quoted' rows confirm — unresendable
    expect(row.tx_hash).toBe(result.txHash!);
    const ledger = db.query("SELECT id FROM transactions WHERE external_id = ?").get(result.txHash);
    expect(ledger).toBeNull(); // the read rail decides, by txid, if it landed

    // And the rite holds: a second confirm cannot resurrect it.
    await expect(confirmPayment(quote.paymentId)).rejects.toThrow(/only a fresh quote/);
  });

  it("recovers a signed-before-broadcast crash by rebroadcasting the exact durable bytes", async () => {
    resetMock({ utxos: [utxo(utxoId("e8"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const deferred = await confirmPayment(quote.paymentId, { deferBroadcastAfterSigning: true });
    expect(deferred.intentState).toBe("signed");
    expect(broadcastBodies).toHaveLength(0);
    const durable = db.query(
      `SELECT artifact.payload
       FROM wk_executions execution
       JOIN wk_signed_artifacts artifact ON artifact.id=execution.signed_artifact_id
       WHERE execution.intent_id=?`,
    ).get(quote.paymentId) as { payload: string };
    const envelope = durable.payload;
    const audit = getWalletKernelIntent(quote.paymentId)!;
    expect(JSON.stringify(audit)).not.toContain(envelope);
    expect(audit.signed_artifact).toMatchObject({
      byte_length: (envelope.length - 2) / 2,
      recovery_available: true,
    });

    const recovered = await resumePaymentBroadcast(quote.paymentId);
    expect(recovered.status).toBe("broadcast");
    expect(recovered.txHash).toBe(deferred.txHash);
    expect(broadcastBodies).toEqual([envelope.slice(2)]);
    expect(db.query("SELECT state FROM wk_executions WHERE intent_id=?").get(
      quote.paymentId,
    )).toEqual({ state: "submitted" });
  });

  it("cryptographically refuses invalid or non-SIGHASH_ALL recovery witnesses", async () => {
    resetMock({ utxos: [utxo(utxoId("e0"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const deferred = await confirmPayment(quote.paymentId, { deferBroadcastAfterSigning: true });
    const stored = db.query(
      `SELECT payment.detail, artifact.payload
       FROM payments payment
       JOIN wk_signed_artifacts artifact ON artifact.intent_id=payment.id
       WHERE payment.id=?`,
    ).get(quote.paymentId) as { detail: string; payload: string };
    const instruction = {
      to: DEST,
      amountMinor: "50000",
      asset: "BTC",
      detail: stored.detail,
    } as const;
    const mutateWitness = (kind: "signature" | "sighash"): `0x${string}` => {
      const raw = RawTx.decode(hex.decode(stored.payload.slice(2)));
      const witnesses = raw.witnesses!.map((witness) => witness.map((item) => item.slice()));
      const signature = witnesses[0]![0]!;
      if (kind === "sighash") signature[signature.length - 1] = 0x02;
      else signature[signature.length - 2] ^= 0x01;
      return `0x${hex.encode(RawTx.encode({ ...raw, witnesses }))}`;
    };

    await expect(
      btcSender.resumeBroadcast!(
        ctx,
        instruction,
        { encoding: "hex", payload: mutateWitness("signature") },
        deferred.txHash!,
      ),
    ).rejects.toThrow(/invalid witness signature/);
    await expect(
      btcSender.resumeBroadcast!(
        ctx,
        instruction,
        { encoding: "hex", payload: mutateWitness("sighash") },
        deferred.txHash!,
      ),
    ).rejects.toThrow(/invalid signer or sighash policy/);
    expect(broadcastBodies).toHaveLength(0);
  });

  it("recovers a crash after atomic vault commit without re-signing or reselecting", async () => {
    resetMock({ utxos: [utxo(utxoId("e9"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });

    await expect(
      confirmPayment(quote.paymentId, { simulateCrashAfterVaultCommit: true }),
    ).rejects.toThrow(/Injected crash after durable vault signing/);
    expect(broadcastBodies).toHaveLength(0);
    expect(db.query("SELECT status, tx_hash FROM payments WHERE id=?").get(quote.paymentId)).toEqual({
      status: "confirmed",
      tx_hash: null,
    });
    expect(db.query("SELECT state FROM wk_payment_intents WHERE id=?").get(quote.paymentId)).toEqual({
      state: "prepared",
    });
    expect(db.query(
      "SELECT state, signed_artifact_id FROM wk_executions WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ state: "prepared", signed_artifact_id: null });
    expect(db.query(
      "SELECT status FROM wk_authorizations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ status: "CONSUMED" });
    const artifact = db.query(
      `SELECT payload, external_tx_id FROM wk_signed_artifacts WHERE intent_id=?`,
    ).get(quote.paymentId) as { payload: string; external_tx_id: string };
    expect(artifact.payload).toMatch(/^0x[0-9a-f]+$/);
    const audit = getWalletKernelIntent(quote.paymentId)!;
    expect(JSON.stringify(audit)).not.toContain(artifact.payload);
    expect(audit.signed_artifact).toMatchObject({
      external_tx_id: artifact.external_tx_id,
      recovery_available: true,
    });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_reservations WHERE intent_id=? AND state='CONSUMED'",
    ).get(quote.paymentId)).toEqual({ count: 1 });

    const recovered = await resumePaymentBroadcast(quote.paymentId);
    expect(recovered).toMatchObject({
      status: "broadcast",
      txHash: artifact.external_tx_id,
      intentState: "submitted",
    });
    expect(broadcastBodies).toEqual([artifact.payload.slice(2)]);
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_authorizations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 1 });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_signed_artifacts WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 1 });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_reservations WHERE intent_id=? AND state='CONSUMED'",
    ).get(quote.paymentId)).toEqual({ count: 1 });
  });

  it("finishes the same prepared authorization after a pre-artifact crash", async () => {
    resetMock({ utxos: [utxo(utxoId("eb"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const before = db.query("SELECT detail FROM payments WHERE id=?").get(quote.paymentId) as {
      detail: string;
    };

    await expect(
      confirmPayment(quote.paymentId, { simulateCrashBeforeVaultCommit: true }),
    ).rejects.toThrow(/before vault artifact commit/);
    expect(broadcastBodies).toHaveLength(0);
    const authorization = db.query(
      `SELECT id, status, request_hash FROM wk_authorizations WHERE intent_id=?`,
    ).get(quote.paymentId) as { id: string; status: string; request_hash: string };
    expect(authorization.status).toBe("ACTIVE");
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_signed_artifacts WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 0 });
    expect(db.query(
      "SELECT state, request_hash, prepared_ref FROM wk_executions WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({
      state: "prepared",
      request_hash: authorization.request_hash,
      prepared_ref: authorization.id,
    });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_reservations WHERE intent_id=? AND state='ACTIVE'",
    ).get(quote.paymentId)).toEqual({ count: 1 });

    const recovered = await resumePaymentBroadcast(quote.paymentId);
    expect(recovered).toMatchObject({ status: "broadcast", intentState: "submitted" });
    expect(broadcastBodies).toHaveLength(1);
    expect(db.query("SELECT detail FROM payments WHERE id=?").get(quote.paymentId)).toEqual(before);
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_authorizations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 1 });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_signed_artifacts WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 1 });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_reservations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 1 });
  });

  it("expires an unstarted prepared authorization and releases its claim", async () => {
    resetMock({ utxos: [utxo(utxoId("ec"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    await expect(
      confirmPayment(quote.paymentId, { simulateCrashBeforeVaultCommit: true }),
    ).rejects.toThrow(/before vault artifact commit/);

    let expired;
    try {
      setSystemTime(Date.parse(quote.expiresAt) + 1);
      expired = await resumePaymentBroadcast(quote.paymentId);
    } finally {
      setSystemTime();
    }
    expect(expired).toMatchObject({
      status: "failed",
      txHash: null,
      intentState: "expired",
      error: expect.stringMatching(/authorization expired/),
    });
    expect(broadcastBodies).toHaveLength(0);
    expect(db.query(
      "SELECT status FROM wk_authorizations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ status: "EXPIRED" });
    expect(db.query(
      "SELECT state FROM wk_payment_intents WHERE id=?",
    ).get(quote.paymentId)).toEqual({ state: "expired" });
    expect(db.query(
      "SELECT state, error_code FROM wk_executions WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({
      state: "failed",
      error_code: "SIGNING_AUTHORIZATION_EXPIRED",
    });
    expect(db.query(
      "SELECT state FROM wk_reservations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ state: "RELEASED" });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_signed_artifacts WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 0 });
  });

  it("coalesces concurrent recovery into one signing and network attempt", async () => {
    resetMock({ utxos: [utxo(utxoId("ed"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    await expect(
      confirmPayment(quote.paymentId, { simulateCrashBeforeVaultCommit: true }),
    ).rejects.toThrow(/before vault artifact commit/);

    const [first, second] = await Promise.all([
      resumePaymentBroadcast(quote.paymentId),
      resumePaymentBroadcast(quote.paymentId),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ status: "broadcast", intentState: "submitted" });
    expect(broadcastBodies).toHaveLength(1);
    expect(db.query(
      "SELECT COUNT(*) AS count FROM wk_signed_artifacts WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ count: 1 });
  });

  it("refuses coherent evidence or prepared-payment mutation during recovery", async () => {
    resetMock({ utxos: [utxo(utxoId("ea"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    await confirmPayment(quote.paymentId, { deferBroadcastAfterSigning: true });
    expect(broadcastBodies).toHaveLength(0);

    expect(() =>
      db.query(
        `UPDATE wk_signed_artifacts
         SET payload='0x0102', envelope_hash=?, external_tx_id=?
         WHERE intent_id=?`,
      ).run(`sha256:${"0".repeat(64)}`, "coherent-attacker-txid", quote.paymentId),
    ).toThrow(/append-only/);

    const stored = db.query("SELECT detail FROM payments WHERE id=?").get(quote.paymentId) as {
      detail: string;
    };
    const rewritten = JSON.parse(stored.detail) as DetailShape;
    rewritten.to = SELF;
    db.query("UPDATE payments SET to_addr=?, detail=? WHERE id=?").run(
      SELF,
      JSON.stringify(rewritten),
      quote.paymentId,
    );
    await expect(resumePaymentBroadcast(quote.paymentId)).rejects.toThrow(
      /immutable Wallet Kernel intent|own sending account/,
    );
    expect(broadcastBodies).toHaveLength(0);
  });

  it("keeps a post-sign missing/spent rejection ambiguous and the UTXO claimed", async () => {
    resetMock({
      utxos: [utxo(utxoId("e5"), 0, 100_000)],
      broadcast: () =>
        new Response('sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}', {
          status: 400,
        }),
    });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const result = await confirmPayment(quote.paymentId);
    expect(result.status).toBe("confirmed");
    expect(result.intentState).toBe("ambiguous");
    expect(result.error).toMatch(/outcome unknown/);
    expect(db.query(
      "SELECT state FROM wk_reservations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ state: "CONSUMED" });
    expect(db.query(
      "SELECT state FROM wk_executions WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ state: "ambiguous" });
  });

  it("treats an exact already-known rebroadcast as idempotently accepted", async () => {
    resetMock({ utxos: [utxo(utxoId("e7"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const deferred = await confirmPayment(quote.paymentId, { deferBroadcastAfterSigning: true });
    resetMock({
      broadcast: () => new Response("sendrawtransaction RPC error: txn-already-known", { status: 400 }),
    });

    const recovered = await resumePaymentBroadcast(quote.paymentId);
    expect(recovered).toMatchObject({
      status: "broadcast",
      txHash: deferred.txHash,
      intentState: "submitted",
    });
    expect(broadcastBodies).toHaveLength(1);
  });

  it("does not turn a possibly accepted tx into failed on missing/spent recovery", async () => {
    resetMock({ utxos: [utxo(utxoId("ef"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const deferred = await confirmPayment(quote.paymentId, { deferBroadcastAfterSigning: true });
    resetMock({
      broadcast: () =>
        new Response("sendrawtransaction RPC error: bad-txns-inputs-missingorspent", {
          status: 400,
        }),
    });

    const recovered = await resumePaymentBroadcast(quote.paymentId);
    expect(recovered).toMatchObject({
      status: "confirmed",
      txHash: deferred.txHash,
      intentState: "ambiguous",
      error: expect.stringMatching(/may already be live/),
    });
    expect(db.query(
      "SELECT state FROM wk_reservations WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ state: "CONSUMED" });
    expect(db.query(
      "SELECT state FROM wk_executions WHERE intent_id=?",
    ).get(quote.paymentId)).toEqual({ state: "ambiguous" });
  });

  it("send() without the kernel refuses before signing or broadcasting", async () => {
    resetMock({ utxos: [utxo(utxoId("e6"), 0, 100_000)] });
    const quote = await btcSender.quote(ctx, { to: DEST, amountMinor: "50000", asset: "BTC" });
    route.broadcast = () => {
      throw new Error("network ate it"); // transport-level: fetch itself rejects
    };
    let caught: unknown;
    try {
      await btcSender.send(ctx, { to: DEST, amountMinor: "50000", asset: "BTC", detail: quote.detail });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/bound payment authorization/);
    expect(broadcastBodies).toHaveLength(0);
  });

  it("refuses an evm key id — kind guard, not a mis-derived address", async () => {
    const evmKey = await vault.generateEvmKey("evm key for kind guard");
    await expect(
      btcSender.quote({ vaultKeyId: evmKey.id }, { to: DEST, amountMinor: "50000", asset: "BTC" })
    ).rejects.toThrow(/cannot sign Bitcoin/);
  });
});

/* --------------------------- review regressions --------------------------- */
// Each of these pins a defect the adversarial review confirmed empirically.

describe("btc sender — review regressions", () => {
  it("change in the (546, 1638] window comes home — the lib's dust opt is vbytes, pinned to sats", async () => {
    // Before the fix, dust: 546n was silently ×3 (dustRelayFeeRate default),
    // folding this 1000-sat change into the fee — a miner donation.
    resetMock({ utxos: [utxo(utxoId("f1"), 0, 100_000)], fees: { "3": 1 } });
    const quote = await btcSender.quote(ctx, { to: DEST, amountMinor: "98859", asset: "BTC" });
    const detail = JSON.parse(quote.detail!) as DetailShape;
    expect(BigInt(detail.feeSat)).toBe(141n); // size-based fee only
    expect(BigInt(detail.changeSat)).toBe(1000n); // NOT folded
  });

  it("refuses a doctored detail with a duplicated outpoint before signing", async () => {
    resetMock({ utxos: [utxo(utxoId("f2"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const stored = db.query("SELECT detail FROM payments WHERE id = ?").get(quote.paymentId) as {
      detail: string;
    };
    const doctored = JSON.parse(stored.detail) as DetailShape;
    // One real outpoint listed twice: totals reconcile (200000 − 50000 −
    // 149900 = 100), so only the uniqueness check can catch it pre-broadcast.
    doctored.inputs = [doctored.inputs[0]!, { ...doctored.inputs[0]! }];
    doctored.changeSat = "149900";
    doctored.feeSat = "100";
    db.query("UPDATE payments SET detail = ? WHERE id = ?").run(JSON.stringify(doctored), quote.paymentId);
    const result = await confirmPayment(quote.paymentId);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/immutable Wallet Kernel intent/);
    expect(broadcastBodies).toHaveLength(0);
  });

  it("refuses a self-pay in QR uppercase — script equality, not string equality", async () => {
    resetMock({ utxos: [utxo(utxoId("f3"), 0, 100_000)] });
    await expect(
      btcSender.quote(ctx, { to: SELF.toUpperCase(), amountMinor: "50000", asset: "BTC" })
    ).rejects.toThrow(/own address/);
  });

  it("coins held by a live quote sit out the next selection", async () => {
    resetMock({ utxos: [utxo(utxoId("f4"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" }); // fresh quote reserves f4:0
    const err = await btcSender
      .quote(ctx, { to: DEST, amountMinor: "50000", asset: "BTC" })
      .then(() => null, (e: Error) => e.message);
    expect(err).toContain("100000 sats are held by payments still in flight");
  });

  it("send refuses a coin another SIGNED payment already committed — the racing-quotes guard", async () => {
    resetMock({ utxos: [utxo(utxoId("f5"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const qA = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const stored = db.query("SELECT detail, fee_minor FROM payments WHERE id = ?").get(qA.paymentId) as {
      detail: string;
      fee_minor: string;
    };
    // Payment B with the SAME selection — the race the quote-time
    // reservation cannot see (B selected before A's row was persisted).
    const bId = newId();
    db.query(
      `INSERT INTO payments (id, account_id, rail, to_addr, asset, amount_minor, fee_minor, status, detail)
       VALUES (?, ?, 'btc', ?, 'BTC', '50000', ?, 'quoted', ?)`
    ).run(bId, accountId, DEST, stored.fee_minor, stored.detail);

    const rA = await confirmPayment(qA.paymentId);
    expect(rA.status).toBe("broadcast");
    expect(broadcastBodies).toHaveLength(1);

    const rB = await confirmPayment(bId);
    expect(rB.status).toBe("failed");
    expect(rB.error).toMatch(/already committed to another payment/);
    expect(broadcastBodies).toHaveLength(1); // B never signed, never broadcast
  });

  it("two concurrent confirms produce one signature and one broadcast", async () => {
    resetMock({ utxos: [utxo(utxoId("f6"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    const [left, right] = await Promise.allSettled([
      confirmPayment(quote.paymentId),
      confirmPayment(quote.paymentId),
    ]);
    const fulfilled = [left, right].filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof confirmPayment>>> =>
        result.status === "fulfilled",
    );
    const rejected = [left, right].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.status).toBe("broadcast");
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/already claimed|only a fresh quote/);
    expect(broadcastBodies).toHaveLength(1);
    const authorizations = db.query(
      "SELECT COUNT(*) AS count FROM wk_authorizations WHERE intent_id=?",
    ).get(quote.paymentId) as { count: number };
    expect(authorizations.count).toBe(1);
  });
});

/* ------------------------------ WIF handling ------------------------------ */

describe("btc keys — WIF import edges", () => {
  it("imports a compressed mainnet WIF to the same address as its hex form", async () => {
    const wif = WIF(NETWORK).encode(hex.decode(PRIV_HEX));
    const key = await vault.importBtcKey("wif twin", wif);
    expect(key.address).toBe(SELF);
  });

  it("refuses uncompressed WIFs, testnet WIFs, and garbage — one shaped error", async () => {
    const { base58check } = await import("@scure/base");
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const priv = hex.decode(PRIV_HEX);
    const uncompressed = base58check(sha256).encode(new Uint8Array([0x80, ...priv]));
    const testnet = base58check(sha256).encode(new Uint8Array([0xef, ...priv, 0x01]));
    for (const bad of [uncompressed, testnet, "not-a-key", "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"]) {
      await expect(vault.importBtcKey("bad", bad)).rejects.toThrow(/not a usable BTC key/);
    }
  });
});
