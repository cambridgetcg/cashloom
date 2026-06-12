import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import axios, { AxiosResponse } from "axios";
import AccountModel, {
  AccountStatusEnum,
  RailEnum,
} from "../models/account.model";
import TransactionModel, {
  PaymentMethodEnum,
  TransactionSourceEnum,
  TransactionStatusEnum,
  TransactionTypeEnum,
} from "../models/transaction.model";
import { registerConnector } from "../connectors";
import { esploraConnector } from "../connectors/esplora.connector";
import { alchemyConnector } from "../connectors/alchemy.connector";
import {
  syncAccountService,
  syncAllAccountsService,
} from "./sync.service";

// Crypto sync-path integration: the REAL Esplora/Alchemy connectors driven
// through the REAL sync service against a real in-memory Mongo. All chain
// data arrives via mocked axios — nothing touches the network — and the REAL
// resolveCredentialRef runs against vi.stubEnv (the ALCHEMY_* namespace is
// already widened in credentials.ts), so no credential code is mocked.
//
// The connectors are registered here through the ADDITIVE registerConnector
// seam: connectors/index.ts is deliberately untouched (P2-8 wires the
// built-ins); when it does, re-registering the same singletons is a no-op.
//
// These tests are the invariants Phase 2 lives or dies by:
//   (1) first-sync adoption of the rail's own currency/decimals report,
//   (2) the established-account decimals guard refusing a whole import,
//   (3) the ACCEPTED wei precision-skip limit, pinned as executable
//       documentation so nobody "fixes" it with floats later,
//   (4) idempotency across overlapping sync windows (externalId end-to-end),
//   (5) signed minor units → EXPENSE/INCOME,
//   (6) secret hygiene through the sweep (the connector wrap, not
//       SECRET_PATTERN, is what keeps the Alchemy key out of results),
//   (7) sequential sweep isolation — one rail failing never stops the next.
vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

const mockedGet = vi.mocked(axios.get);
const mockedPost = vi.mocked(axios.post);

registerConnector("esplora", esploraConnector);
registerConnector("alchemy", alchemyConnector);

/* --------------------------------- harness -------------------------------- */

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // Build indexes so the {userId, accountId, externalId} unique backstop is
  // actually enforced below.
  await AccountModel.init();
  await TransactionModel.init();
}, 120000); // first run downloads a mongod binary (cached locally)

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await AccountModel.deleteMany({});
  await TransactionModel.deleteMany({});
  vi.stubEnv(ALCHEMY_REF, FAKE_ALCHEMY_KEY);
  // Fail LOUD on any HTTP a test forgot to route — never silently succeed.
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedGet.mockImplementation(async (url) => {
    throw new Error(`unmocked GET in test: ${String(url)}`);
  });
  mockedPost.mockImplementation(async () => {
    throw new Error("unmocked POST in test");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ----------------------------- fixtures: shared ---------------------------- */

// Obviously-fake placeholders — never real key shapes with entropy.
const FAKE_ALCHEMY_KEY = "FAKE-alchemy-key-not-real";
const ALCHEMY_REF = "ALCHEMY_API_KEY";

const BTC_ADDRESS = "bc1qfakewatchaddress0000000000000000000000";
const OTHER_BTC = "bc1qotherparty00000000000000000000000000000";

// Mixed case so the connector's case-insensitive 0x compare is exercised
// through the full pipeline.
const ETH_ADDRESS = "0xAbCdEf0123456789abcdef0123456789AbCdEf01";
const OTHER_ETH = "0x2222222222222222222222222222222222222222";

const TIP_HEIGHT = 900000;

const TXID_IN = "ab".repeat(32);
const TXID_OUT = "cd".repeat(32);
const TXID_CLEAN = "11".repeat(32);
const TXID_DUST = "22".repeat(32);

const HASH_A =
  "0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff";
const HASH_B =
  "0xffffeeeeddddccccbbbbaaaa000099998888777766665555444433332222aaaa";

const daysAgo = (n: number): Date =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const unixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const weiHex = (wei: bigint): string => `0x${wei.toString(16)}`;

// Minimal-but-valid AxiosResponse so the mocks satisfy the real signature.
const httpResponse = (status: number, data: unknown): AxiosResponse =>
  ({
    status,
    statusText: status === 200 ? "OK" : "",
    data,
    headers: {},
    config: {},
  } as AxiosResponse);

const httpOk = (data: unknown): AxiosResponse => httpResponse(200, data);

/* ---------------------------- fixtures: Esplora ---------------------------- */

interface EsploraTxFixture {
  txid: string;
  status: { confirmed: boolean; block_height: number; block_time: number };
  vin: Array<{ prevout: { scriptpubkey_address: string; value: number } }>;
  vout: Array<{ scriptpubkey_address: string; value: number }>;
}

// Deeply confirmed (depth ~101 >> MIN_CONFIRMATIONS 6) — confirmation-depth
// edge cases are the connector unit suite's job, not this file's.
const confirmedTx = (
  txid: string,
  date: Date,
  io: Pick<EsploraTxFixture, "vin" | "vout">
): EsploraTxFixture => ({
  txid,
  status: {
    confirmed: true,
    block_height: TIP_HEIGHT - 100,
    block_time: unixSeconds(date),
  },
  ...io,
});

// Money TO the watched address: one vout pays it, no watched inputs.
const receivedTx = (txid: string, sats: number, date: Date): EsploraTxFixture =>
  confirmedTx(txid, date, {
    vin: [
      { prevout: { scriptpubkey_address: OTHER_BTC, value: sats + 10_000 } },
    ],
    vout: [{ scriptpubkey_address: BTC_ADDRESS, value: sats }],
  });

// Money FROM the watched address WITH change back to self: net out must be
// spent - change, the hand-computed netting the connector promises.
const sentTx = (
  txid: string,
  io: { spent: number; toOther: number; change: number },
  date: Date
): EsploraTxFixture =>
  confirmedTx(txid, date, {
    vin: [{ prevout: { scriptpubkey_address: BTC_ADDRESS, value: io.spent } }],
    vout: [
      { scriptpubkey_address: OTHER_BTC, value: io.toOther },
      { scriptpubkey_address: BTC_ADDRESS, value: io.change },
    ],
  });

// Route every Esplora GET by URL shape. The first /txs/chain page always
// serves `txPage`; continuation pages (…/txs/chain/{last_seen_txid}) are
// always empty — stateless across calls, so a SECOND sync re-fetches the SAME
// page and the dedupe layers (not an exhausted mock) must do the skipping.
const routeEsplora = (opts: {
  funded: number;
  spent: number;
  txPage?: EsploraTxFixture[];
}): void => {
  mockedGet.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith(`/address/${BTC_ADDRESS}`)) {
      return httpOk({
        chain_stats: {
          funded_txo_sum: opts.funded,
          spent_txo_sum: opts.spent,
        },
        // Present on the wire, deliberately ignored by the connector.
        mempool_stats: { funded_txo_sum: 5_000, spent_txo_sum: 0 },
      });
    }
    if (u.endsWith("/blocks/tip/height")) {
      return httpOk(TIP_HEIGHT);
    }
    if (u.includes(`/address/${BTC_ADDRESS}/txs/chain/`)) {
      return httpOk([]); // continuation page — pagination terminates
    }
    if (u.endsWith(`/address/${BTC_ADDRESS}/txs/chain`)) {
      return httpOk(opts.txPage ?? []);
    }
    throw new Error("unexpected Esplora GET in test");
  });
};

/* ---------------------------- fixtures: Alchemy ---------------------------- */

// One alchemy_getAssetTransfers row. The float `value` field is present
// because the real API sends it — and money must come ONLY from
// rawContract.value (hex wei).
const ethTransfer = (
  uniqueId: string,
  hash: string,
  wei: bigint,
  opts: { from?: string; to?: string; date?: Date } = {}
) => ({
  uniqueId,
  hash,
  blockNum: "0x14a5b3c",
  from: opts.from ?? OTHER_ETH,
  to: opts.to ?? ETH_ADDRESS.toLowerCase(),
  value: Number(wei) / 1e18, // lossy float — NEVER read for money
  asset: "ETH",
  category: "external",
  rawContract: { value: weiHex(wei), address: null, decimal: "0x12" },
  metadata: { blockTimestamp: (opts.date ?? daysAgo(3)).toISOString() },
});

const rpcResult = (result: unknown): AxiosResponse =>
  httpOk({ jsonrpc: "2.0", id: 1, result });

// Route every Alchemy JSON-RPC POST by method + direction. No pageKey is ever
// returned, so each direction is a single page.
const routeAlchemy = (opts: {
  balanceWei: bigint;
  sent?: unknown[];
  received?: unknown[];
}): void => {
  mockedPost.mockImplementation(async (_url, body) => {
    const req = body as {
      method: string;
      params: Array<Record<string, unknown>>;
    };
    if (req.method === "eth_getBalance") {
      return rpcResult(weiHex(opts.balanceWei));
    }
    if (req.method === "eth_getBlockByNumber") {
      // The connector resolves the finalized head once per fetchTransactions
      // and pins its hex height as the transfers toBlock (the tag itself is
      // not a documented toBlock form for alchemy_getAssetTransfers).
      return rpcResult({ number: "0x14a5b40" });
    }
    if (req.method === "alchemy_getAssetTransfers") {
      const direction = req.params[0];
      return rpcResult({
        transfers:
          direction.fromAddress !== undefined
            ? opts.sent ?? []
            : opts.received ?? [],
      });
    }
    throw new Error("unexpected Alchemy JSON-RPC method in test");
  });
};

/* ------------------------------ account helpers ---------------------------- */

const makeEsploraAccount = (
  userId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {}
) =>
  AccountModel.create({
    userId,
    rail: RailEnum.CRYPTO,
    connectorType: "esplora",
    displayName: "BTC watch wallet",
    // Onboarding defaults unless a test overrides them — the GBP/2 guess the
    // first sync is expected to correct.
    currency: "GBP",
    decimals: 2,
    externalAccountId: BTC_ADDRESS,
    status: AccountStatusEnum.ACTIVE,
    ...overrides,
  });

const makeAlchemyAccount = (
  userId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {}
) =>
  AccountModel.create({
    userId,
    rail: RailEnum.CRYPTO,
    connectorType: "alchemy",
    displayName: "ETH wallet",
    currency: "GBP",
    decimals: 2,
    externalAccountId: ETH_ADDRESS,
    credentialRef: ALCHEMY_REF, // pointer to the env var — never a value
    status: AccountStatusEnum.ACTIVE,
    ...overrides,
  });

/* ---------------------------------- tests ---------------------------------- */

describe("(1) first-sync adoption — onboarding defaults corrected from the rail's own report", () => {
  it("esplora: a GBP/2-defaulted CRYPTO account adopts BTC/8 with warnings, balance string-copied verbatim", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeEsploraAccount(userId); // GBP/2 onboarding guess

    // Number.MAX_SAFE_INTEGER sats — the largest value Esplora's own
    // safe-integer guard admits (sat fields are JSON numbers ≤ 2^53-1 by
    // construction; the strictly-above-2^53 verbatim pin is the Alchemy test
    // below, where wei arrives as hex).
    routeEsplora({ funded: 9007199254740991, spent: 0, txPage: [] });

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.warnings?.join(" ")).toMatch(/corrected from GBP to BTC/i);
    expect(result.warnings?.join(" ")).toMatch(/decimals corrected from 2 to 8/i);
    expect(result.balanceMinor).toBe("9007199254740991");
    expect(result.imported).toBe(0);

    const saved = await AccountModel.findById(account._id);
    expect(saved?.currency).toBe("BTC");
    expect(saved?.decimals).toBe(8);
    // Verbatim string copy — balanceMinor never touched a float.
    expect(saved?.balanceMinor).toBe("9007199254740991");
    expect(saved?.balanceAsOf).toBeTruthy();
  });

  it("alchemy: adoption lands an 18-decimal wei balance ABOVE Number.MAX_SAFE_INTEGER verbatim", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAlchemyAccount(userId); // GBP/2 onboarding guess

    // 123456789012345678901 wei ≈ 123.46 ETH — far beyond 2^53. A single
    // float hop anywhere in the pipeline would corrupt the tail digits; the
    // exact string surviving end-to-end proves there is none.
    const WEI = 123456789012345678901n;
    routeAlchemy({ balanceWei: WEI, sent: [], received: [] });

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.warnings?.join(" ")).toMatch(/corrected from GBP to ETH/i);
    expect(result.warnings?.join(" ")).toMatch(
      /decimals corrected from 2 to 18/i
    );
    expect(result.balanceMinor).toBe("123456789012345678901");
    expect(result.imported).toBe(0);

    const saved = await AccountModel.findById(account._id);
    expect(saved?.currency).toBe("ETH");
    expect(saved?.decimals).toBe(18);
    expect(saved?.balanceMinor).toBe(WEI.toString());
    expect(BigInt(saved!.balanceMinor)).toBe(WEI);
  });
});

describe("(2) established-account decimals guard", () => {
  it("a decimals mismatch withholds the balance AND refuses the entire import, loudly", async () => {
    const userId = new mongoose.Types.ObjectId();
    // ESTABLISHED (balanceAsOf set) BTC account stored at 9 decimals; the
    // connector hard-codes 8 — past the first-sync window nothing may be
    // silently corrected, and importing 8-decimal amounts into a 9-decimal
    // account would misread every row 10x.
    const account = await makeEsploraAccount(userId, {
      currency: "BTC",
      decimals: 9,
      balanceMinor: "999",
      balanceAsOf: daysAgo(1),
    });

    routeEsplora({
      funded: 150_000_000,
      spent: 0,
      txPage: [receivedTx(TXID_IN, 25_000_000, daysAgo(2))],
    });

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.balanceMinor).toBe("999"); // untouched
    expect(result.warnings?.join(" ")).toMatch(/balance not written/i);
    expect(result.warnings?.join(" ")).toMatch(/transactions not imported/i);

    // The rail was asked ONLY for the balance — tip height and the
    // transaction pages were never fetched, because nothing they returned
    // could have been stored at the wrong scale.
    expect(mockedGet).toHaveBeenCalledTimes(1);

    const saved = await AccountModel.findById(account._id);
    expect(saved?.decimals).toBe(9);
    expect(saved?.balanceMinor).toBe("999");
    expect(
      await TransactionModel.countDocuments({ accountId: account._id })
    ).toBe(0);
  });
});

describe("(3) the accepted Phase 2 precision limit, pinned as executable documentation", () => {
  // TransactionModel stores float CENTS at fixed scale 2. For an 18-decimal
  // asset that is a TOTAL import block, not a partial one: any non-zero ETH
  // amount that is cents-exact must be a multiple of 10^16 wei, which already
  // exceeds Number.MAX_SAFE_INTEGER (9007199254740991) — so even a "clean"
  // 0.25 ETH transfer (2.5e17 wei) fails minorToMajorIsSafe and skips. The
  // Phase 2 plan's hope that 0.25 ETH would import is arithmetically
  // impossible against this model; the clean-row contrast lives on the BTC
  // side below, where 8 decimals leave room. Crypto transaction HISTORY is
  // therefore sparse (empty, for ETH) while BALANCES land verbatim as exact
  // minor-unit strings — the user-visible truth. Nobody "fixes" this with
  // floats: the real fix is a Phase 3 schema migration to minor-unit string
  // amounts on Transaction.
  it("ETH: every non-zero wei row skips with a precision warning while the balance lands exactly", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeAlchemyAccount(userId, {
      currency: "ETH",
      decimals: 18,
    });

    const BALANCE_WEI = 2250000000000000001n; // > 2^53, survives verbatim
    const idA = `${HASH_A}:external`; // 1.000000000000000001 ETH
    const idB = `${HASH_B}:external`; // 0.25 ETH — "clean", still > 2^53 wei
    routeAlchemy({
      balanceWei: BALANCE_WEI,
      sent: [],
      received: [
        ethTransfer(idA, HASH_A, 10n ** 18n + 1n, { date: daysAgo(3) }),
        ethTransfer(idB, HASH_B, 25n * 10n ** 16n, { date: daysAgo(2) }),
      ],
    });

    const result = await syncAccountService(String(userId), String(account._id));

    // Exact counts: both rows refused on the FIRST float leg (minor→major),
    // each named in a warning — loud, never silently rounded in.
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(2);
    const joined = result.warnings?.join(" ") ?? "";
    expect(joined).toContain(idA);
    expect(joined).toContain(idB);
    expect(joined).toMatch(/cannot be represented exactly/i);

    expect(
      await TransactionModel.countDocuments({ accountId: account._id })
    ).toBe(0);

    // The balance is untouched by the import limit — exact wei string.
    const saved = await AccountModel.findById(account._id);
    expect(saved?.balanceMinor).toBe(BALANCE_WEI.toString());
  });

  it("BTC: a cents-exact 0.25 BTC row imports while a satoshi-precision row skips loudly", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeEsploraAccount(userId, {
      currency: "BTC",
      decimals: 8,
    });

    routeEsplora({
      funded: 37_345_678,
      spent: 0,
      txPage: [
        // 0.12345678 BTC: survives the minor→major float leg but not the
        // model's 2-decimal cents setter — must SKIP, never store 0.12.
        receivedTx(TXID_DUST, 12_345_678, daysAgo(2)),
        // 0.25 BTC: exact at 2 decimals → imports.
        receivedTx(TXID_CLEAN, 25_000_000, daysAgo(4)),
      ],
    });

    const result = await syncAccountService(String(userId), String(account._id));

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.warnings?.join(" ")).toContain(TXID_DUST);
    expect(result.warnings?.join(" ")).toMatch(/cannot be stored exactly/i);

    const raws = await TransactionModel.collection
      .find({ accountId: account._id })
      .toArray();
    expect(raws).toHaveLength(1);
    expect(raws[0].externalId).toBe(TXID_CLEAN);
    expect(raws[0].amount).toBe(25); // 0.25 BTC major → 25 model-cents, exact
  });
});

describe("(4) idempotency over overlapping windows", () => {
  it("a second sync re-fetching the same txids imports 0 — externalId dedupe end-to-end, no E11000 surfacing", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeEsploraAccount(userId, {
      currency: "BTC",
      decimals: 8,
    });

    // The mock routes by URL shape (not call count), so the SECOND sync
    // re-serves the identical first page: since = newest known (2d) − 3d
    // overlap = 5d ago, both rows (4d, 2d) fall inside the window and come
    // back — the dedupe layers, not an exhausted fixture, must skip them.
    routeEsplora({
      funded: 75_000_000,
      spent: 0,
      txPage: [
        sentTx(
          TXID_OUT,
          { spent: 80_000_000, toOther: 25_000_000, change: 55_000_000 },
          daysAgo(2)
        ),
        receivedTx(TXID_IN, 50_000_000, daysAgo(4)),
      ],
    });

    const first = await syncAccountService(String(userId), String(account._id));
    expect(first.imported).toBe(2);
    expect(first.skipped).toBe(0);

    // Resolving (not throwing) IS the no-E11000-surfacing assertion; the
    // pre-filter catches both rows before the unique index even has to.
    const second = await syncAccountService(String(userId), String(account._id));
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);

    expect(
      await TransactionModel.countDocuments({ accountId: account._id })
    ).toBe(2);
    // Stable ids straight from the rail: the txids, unchanged.
    const ids = (
      await TransactionModel.find({ accountId: account._id }).select(
        "externalId"
      )
    ).map((d) => d.externalId);
    expect(ids.sort()).toEqual([TXID_IN, TXID_OUT].sort());
  });
});

describe("(5) sign → type mapping", () => {
  it("negative net minor units → EXPENSE, positive → INCOME; category/source/paymentMethod pinned", async () => {
    const userId = new mongoose.Types.ObjectId();
    const account = await makeEsploraAccount(userId, {
      currency: "BTC",
      decimals: 8,
    });

    routeEsplora({
      funded: 130_000_000,
      spent: 80_000_000,
      txPage: [
        // Spend WITH change back to self: net = 55,000,000 − 80,000,000 =
        // −25,000,000 sats — the hand-computed netting, sign carried through.
        sentTx(
          TXID_OUT,
          { spent: 80_000_000, toOther: 25_000_000, change: 55_000_000 },
          daysAgo(2)
        ),
        receivedTx(TXID_IN, 50_000_000, daysAgo(4)),
      ],
    });

    const result = await syncAccountService(String(userId), String(account._id));
    expect(result.imported).toBe(2);

    const txs = await TransactionModel.find({ accountId: account._id }).sort({
      date: 1,
    });
    expect(txs).toHaveLength(2);

    const [incoming, outgoing] = txs;
    expect(incoming.externalId).toBe(TXID_IN);
    expect(incoming.type).toBe(TransactionTypeEnum.INCOME);
    expect(incoming.amount).toBe(0.5); // getter: 50 model-cents → 0.50 major
    expect(incoming.title).toBe(`BTC received · ${TXID_IN.slice(0, 12)}`);

    expect(outgoing.externalId).toBe(TXID_OUT);
    expect(outgoing.type).toBe(TransactionTypeEnum.EXPENSE);
    expect(outgoing.amount).toBe(0.25); // absolute — the sign moved into type
    expect(outgoing.title).toBe(`BTC sent · ${TXID_OUT.slice(0, 12)}`);

    for (const tx of txs) {
      expect(tx.category).toBe("uncategorized");
      expect(tx.source).toBe(TransactionSourceEnum.CONNECTOR);
      expect(tx.status).toBe(TransactionStatusEnum.COMPLETED);
      // OTHER both before P2-8 (unmapped fallback) and after it (explicit
      // esplora/alchemy → OTHER entries) — stable across that merge.
      expect(tx.paymentMethod).toBe(PaymentMethodEnum.OTHER);
    }

    // Raw driver read: exact cents, the corruption class this repo has been
    // burned by.
    const raws = await TransactionModel.collection
      .find({ accountId: account._id })
      .sort({ date: 1 })
      .toArray();
    expect(raws[0].amount).toBe(50);
    expect(raws[1].amount).toBe(25);
  });
});

describe("(6+7) secret hygiene through the sweep + sequential isolation", () => {
  it("an Alchemy 401 surfaces as a clean per-account error — env var named, no key, no /v2/ URL — and the next account still syncs", async () => {
    const userId = new mongoose.Types.ObjectId();
    const ethAccount = await makeAlchemyAccount(userId, {
      currency: "ETH",
      decimals: 18,
    });
    // Distinct createdAt so the sweep's createdAt-ascending order is
    // deterministic: the failing rail runs FIRST.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const btcAccount = await makeEsploraAccount(userId, {
      currency: "BTC",
      decimals: 8,
    });

    // Every Alchemy call is rejected with HTTP 401 → the connector wraps it
    // naming only the env VARIABLE. Esplora keeps working.
    routeEsplora({
      funded: 25_000_000,
      spent: 0,
      txPage: [receivedTx(TXID_CLEAN, 25_000_000, daysAgo(2))],
    });
    mockedPost.mockImplementation(async () => httpResponse(401, {}));

    const results = await syncAllAccountsService(String(userId));

    expect(results).toHaveLength(2);
    expect(results[0].accountId).toBe(String(ethAccount._id));
    expect(results[1].accountId).toBe(String(btcAccount._id));

    // The failing rail: a clean wrapped error. SECRET_PATTERN (sk|rk_…)
    // would NEVER have matched an Alchemy key — the connector wrap that
    // names only the env variable is the defense that already removed it.
    const failed = results[0];
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeTruthy();
    expect(failed.error).toContain(ALCHEMY_REF);
    expect(failed.error).not.toContain(FAKE_ALCHEMY_KEY);
    expect(failed.error).not.toContain("/v2/");

    // Sequential isolation: the rail AFTER the failure synced normally.
    const succeeded = results[1];
    expect(succeeded.ok).toBe(true);
    expect(succeeded.imported).toBe(1);
    expect(succeeded.error).toBeUndefined();
    expect(
      await TransactionModel.countDocuments({ accountId: btcAccount._id })
    ).toBe(1);
    const savedBtc = await AccountModel.findById(btcAccount._id);
    expect(savedBtc?.balanceMinor).toBe("25000000");
  });

  it("a transport-level failure whose raw axios error carries the keyed URL is re-wrapped before the sweep sees it", async () => {
    const userId = new mongoose.Types.ObjectId();
    await makeAlchemyAccount(userId, { currency: "ETH", decimals: 18 });

    // What a real un-wrapped axios transport error looks like: message AND
    // config.url both embed the keyed /v2/ URL. If this object ever reached
    // the sweep raw, results[].error would leak the key.
    const keyedUrl = `https://eth-mainnet.g.alchemy.com/v2/${FAKE_ALCHEMY_KEY}`;
    mockedPost.mockImplementation(async () => {
      throw Object.assign(new Error(`connect ECONNRESET ${keyedUrl}`), {
        code: "ECONNRESET",
        config: { url: keyedUrl },
      });
    });

    const results = await syncAllAccountsService(String(userId));

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    // Only the JSON-RPC method + transport code survive the connector wrap.
    expect(results[0].error).toContain("eth_getBalance");
    expect(results[0].error).toContain("ECONNRESET");
    expect(results[0].error).not.toContain(FAKE_ALCHEMY_KEY);
    expect(results[0].error).not.toContain("/v2/");
  });
});
