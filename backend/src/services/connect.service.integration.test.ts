import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import RequisitionModel from "../models/requisition.model";
import AccountModel, { RailEnum } from "../models/account.model";
import {
  createRequisitionService,
  getRequisitionService,
} from "./connect.service";
import { importGoCardlessAccountsService } from "./sync.service";
import { createRequisition, getRequisition } from "../connectors/gocardless.connector";

// Real-DB proof of requisition OWNERSHIP — the IDOR closure for the GoCardless
// onboarding dance. Requisitions are integration-wide upstream (one secret
// pair for the whole deployment), so the user binding only exists in our
// RequisitionModel: created at step 2, enforced on every poll/import. All
// GoCardless traffic is mocked at the connector boundary; nothing touches the
// network.

vi.mock("../connectors/gocardless.connector", () => ({
  // The registry in connectors/index imports this singleton — a stub keeps
  // that import sound without ever reaching the network.
  gocardlessConnector: {
    type: "gocardless",
    fetchBalance: vi.fn(),
    fetchTransactions: vi.fn(),
  },
  listInstitutions: vi.fn(),
  createRequisition: vi.fn(),
  getRequisition: vi.fn(),
  resetGoCardlessTokenCache: vi.fn(),
}));

const mockedCreateRequisition = vi.mocked(createRequisition);
const mockedGetRequisition = vi.mocked(getRequisition);

const REQ_ID = "req-uuid-FAKE-0001";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await RequisitionModel.init();
  await AccountModel.init();
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await RequisitionModel.deleteMany({});
  await AccountModel.deleteMany({});
  vi.clearAllMocks();
  mockedCreateRequisition.mockResolvedValue({
    id: REQ_ID,
    link: `https://gocardless.example/psd2/start/${REQ_ID}`,
  });
  mockedGetRequisition.mockResolvedValue({
    id: REQ_ID,
    status: "LN",
    accounts: ["gc-acct-FAKE-1", "gc-acct-FAKE-2"],
  });
});

describe("createRequisitionService", () => {
  it("binds the requisition to its creator before the id is handed back", async () => {
    const userId = new mongoose.Types.ObjectId();

    const requisition = await createRequisitionService(
      String(userId),
      "FAKEBANK_GB",
      "https://app.example/connected"
    );

    expect(requisition).toEqual({
      id: REQ_ID,
      link: `https://gocardless.example/psd2/start/${REQ_ID}`,
    });

    const binding = await RequisitionModel.findOne({ requisitionId: REQ_ID });
    expect(binding).toBeTruthy();
    expect(String(binding?.userId)).toBe(String(userId));
    expect(binding?.institutionId).toBe("FAKEBANK_GB");
  });
});

describe("getRequisitionService (ownership)", () => {
  it("lets the creator poll their requisition", async () => {
    const owner = new mongoose.Types.ObjectId();
    await createRequisitionService(String(owner), "FAKEBANK_GB", "https://app.example");

    const requisition = await getRequisitionService(String(owner), REQ_ID);

    expect(requisition.status).toBe("LN");
    expect(requisition.accounts).toEqual(["gc-acct-FAKE-1", "gc-acct-FAKE-2"]);
  });

  it("another user's requisition id looks like NotFound — and GoCardless is never asked (no IDOR)", async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    await createRequisitionService(String(owner), "FAKEBANK_GB", "https://app.example");

    await expect(
      getRequisitionService(String(stranger), REQ_ID)
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockedGetRequisition).not.toHaveBeenCalled();
  });

  it("a requisition that was never created here is NotFound, even if it exists upstream", async () => {
    const user = new mongoose.Types.ObjectId();

    await expect(
      getRequisitionService(String(user), "req-uuid-FAKE-unknown")
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mockedGetRequisition).not.toHaveBeenCalled();
  });
});

describe("importGoCardlessAccountsService (ownership)", () => {
  it("refuses to import another user's requisition: 404, no accounts created, no upstream call", async () => {
    const owner = new mongoose.Types.ObjectId();
    const stranger = new mongoose.Types.ObjectId();
    await createRequisitionService(String(owner), "FAKEBANK_GB", "https://app.example");

    await expect(
      importGoCardlessAccountsService(String(stranger), REQ_ID)
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mockedGetRequisition).not.toHaveBeenCalled();
    expect(await AccountModel.countDocuments({})).toBe(0);
  });

  it("imports the linked accounts for the creating user", async () => {
    const owner = new mongoose.Types.ObjectId();
    await createRequisitionService(String(owner), "FAKEBANK_GB", "https://app.example");

    const { accounts, skipped } = await importGoCardlessAccountsService(
      String(owner),
      REQ_ID
    );

    expect(accounts).toHaveLength(2);
    expect(skipped).toBe(0);

    const saved = await AccountModel.find({ userId: owner }).sort({
      externalAccountId: 1,
    });
    expect(saved).toHaveLength(2);
    expect(saved[0].rail).toBe(RailEnum.BANK);
    expect(saved[0].connectorType).toBe("gocardless");
    expect(saved.map((a) => a.externalAccountId)).toEqual([
      "gc-acct-FAKE-1",
      "gc-acct-FAKE-2",
    ]);
  });
});
