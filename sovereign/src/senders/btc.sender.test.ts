import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
const { AmbiguousBroadcastError } = await import("./types.ts");
const { quotePayment, confirmPayment } = await import("../pay.ts");
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
  broadcast?: (body: string) => Response | Promise<Response>;
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
    expect(result.error).toMatch(/do not reconcile/);
    expect(broadcastBodies).toHaveLength(0); // nothing was signed, nothing left
  });

  it("refuses to confirm when the detail is missing — re-selection is never a fallback", async () => {
    resetMock({ utxos: [utxo(utxoId("e3"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });
    db.query("UPDATE payments SET detail = NULL WHERE id = ?").run(quote.paymentId);
    const result = await confirmPayment(quote.paymentId);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no stored coin selection/);
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

  it("claims a quote atomically so concurrent confirms sign and broadcast only once", async () => {
    resetMock({ utxos: [utxo(utxoId("e7"), 0, 100_000)] });
    const accountId = makeBtcAccount();
    const quote = await quotePayment({ accountId, to: DEST, amountMinor: "50000", asset: "BTC" });

    let signalBroadcast!: () => void;
    const broadcastStarted = new Promise<void>((resolve) => {
      signalBroadcast = resolve;
    });
    let releaseBroadcast!: () => void;
    const mayFinishBroadcast = new Promise<void>((resolve) => {
      releaseBroadcast = resolve;
    });
    route.broadcast = async () => {
      signalBroadcast();
      await mayFinishBroadcast;
      return new Response("ok");
    };

    const first = confirmPayment(quote.paymentId);
    await broadcastStarted;
    await expect(confirmPayment(quote.paymentId)).rejects.toThrow(/only a fresh quote/);
    releaseBroadcast();

    const result = await first;
    expect(result.status).toBe("broadcast");
    expect(broadcastBodies).toHaveLength(1);
  });

  it("a definitive node rejection fails loud, with the spent-coins hint", async () => {
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
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/network refused/);
    expect(result.error).toMatch(/earlier payment may have spent/);
  });

  it("send() without pay.ts still enforces the seam (direct AmbiguousBroadcastError shape)", async () => {
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
    expect(caught).toBeInstanceOf(AmbiguousBroadcastError);
    expect((caught as InstanceType<typeof AmbiguousBroadcastError>).externalId).toMatch(/^[0-9a-f]{64}$/);
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
    expect(result.error).toMatch(/duplicate input/);
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
