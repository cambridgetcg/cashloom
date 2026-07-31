import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiError, api, errorMessage } from "../api";
import {
  Badge,
  CopyButton,
  EmptyState,
  Field,
  LoadingThreads,
  SectionTitle,
} from "../components";
import {
  exactExecutionRecoveryKey,
  executionRecoveryKeyForReview,
  sameExecutionRecoveryKey,
  type ExecutionRecoveryKey,
} from "../execution-recovery";
import { formatMinorCompact, parseToMinor } from "../format";
import type {
  Account,
  PayLinkAcceptanceProjection,
  PayLinkExecutionResult,
  PayLinkExecutionReview,
  PayLinkExecutionSnapshot,
  PayLinkProjection,
  PayLinkRequestProjection,
  VaultKey,
} from "../types";

const MAX_BUNDLE_BYTES = 64 * 1024;
const MAX_NOTE_BYTES = 160;
const BTC_DECIMALS = 8;
const EXECUTION_RECOVERY_STORAGE_KEY = "cashloom.pay-link-execution-recovery";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_ID = /^sha256:[0-9a-f]{64}$/u;
const DEFINITIVE_PRE_SIGN_ERRORS = new Set([
  "account_source_mismatch",
  "asset_policy_rejected",
  "execution_conflict",
  "fee_limit_exceeded",
  "intent_inactive",
  "intent_not_locally_authored",
  "node_not_activated",
  "payment_not_ready",
  "review_expired",
  "wrong_bitcoin_profile",
]);

type CreatedPayLink = {
  bundle: string;
  filename: string;
  projection: PayLinkRequestProjection;
};

type AcceptedPayLink = {
  bundle: string;
  filename: string;
  projection: PayLinkAcceptanceProjection;
  reused: boolean;
};

type CreateField = "destination" | "amount" | "note";
type AcceptField = "source" | "fee";

interface BitcoinSource {
  address: string;
  label: string;
}

interface PreparedPayment {
  review: PayLinkExecutionReview;
  reused: boolean;
}

function readExecutionRecovery(): ExecutionRecoveryKey | null {
  try {
    if (typeof window === "undefined") return null;
    const value = JSON.parse(
      window.sessionStorage.getItem(EXECUTION_RECOVERY_STORAGE_KEY) ?? "null",
    ) as Partial<ExecutionRecoveryKey> | null;
    if (
      value === null
      || typeof value.payment_id !== "string"
      || !UUID.test(value.payment_id)
      || typeof value.review_id !== "string"
      || !SHA256_ID.test(value.review_id)
    ) {
      return null;
    }
    return {
      payment_id: value.payment_id,
      review_id: value.review_id,
    };
  } catch {
    return null;
  }
}

function writeExecutionRecovery(value: ExecutionRecoveryKey | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) {
      window.sessionStorage.removeItem(EXECUTION_RECOVERY_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(
        EXECUTION_RECOVERY_STORAGE_KEY,
        JSON.stringify(value),
      );
    }
  } catch {
    // The exact IDs remain in component state if session storage is unavailable.
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readableTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function remainingTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds === 0) return "expired";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function btcAndSats(sats: string): string {
  return `${formatMinorCompact(sats, BTC_DECIMALS)} BTC · ${sats} sats`;
}

function safeDownloadName(value: string, fallback: string): string {
  const name = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return name || fallback;
}

function DownloadButton({
  contents,
  filename,
  label,
}: {
  contents: string;
  filename: string;
  label: string;
}) {
  function download() {
    const blob = new Blob([contents], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeDownloadName(filename, "cashloom-bundle.json");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <button className="btn btn-ghost" type="button" onClick={download}>
      {label}
    </button>
  );
}

function Fact({
  label,
  children,
  code = false,
}: {
  label: string;
  children: ReactNode;
  code?: boolean;
}) {
  return (
    <div className="pay-link-fact">
      <dt>{label}</dt>
      <dd className={code ? "pay-link-code" : undefined}>{children}</dd>
    </div>
  );
}

function ExecutionRecoveryState({
  snapshot,
}: {
  snapshot: PayLinkExecutionSnapshot;
}) {
  const ambiguousCopy = snapshot.tx_hash === null
    ? {
        title: "One-time send claim outcome is unknown",
        detail:
          "The claim began, but the local record cannot prove whether signing or submission occurred. Do not retry or start a replacement payment until you reconcile this state.",
      }
    : {
        title: "Broadcast outcome is unknown",
        detail:
          "A txid was persisted, but submission was not conclusively acknowledged. Do not resend; check the txid with a Bitcoin node or explorer you choose.",
      };
  const copy = {
    awaiting_confirmation: {
      title: "Exact review was unclaimed at this check",
      detail:
        "No signed outcome was recorded in this local snapshot. Reopen the same Pay Link to review it; any confirmation still passes through the one-time claim gate.",
    },
    not_sent: {
      title: "No signed outcome is recorded",
      detail:
        "This exact review is not currently eligible for confirmation. Read the reason below and reconcile it before preparing a different payment.",
    },
    broadcast: {
      title: "Broadcast submitted",
      detail:
        "The local record says this exact payment was signed once and submitted to Bitcoin mainnet.",
    },
    broadcast_unknown: ambiguousCopy,
    failed: {
      title: "Attempt failed before broadcast",
      detail:
        "The local record contains a definitive pre-egress failure. CashLoom did not retry it.",
    },
  }[snapshot.status];

  return (
    <div
      className="pay-link-recovery-state"
      data-state={snapshot.status}
      role="status"
    >
      <p>
        <strong>{copy.title}.</strong> {copy.detail}
      </p>
      {snapshot.error && (
        <p className="pay-link-execution-result-error">{snapshot.error}</p>
      )}
      {snapshot.tx_hash && (
        <div className="pay-link-execution-tx">
          <code>{snapshot.tx_hash}</code>
          <CopyButton text={snapshot.tx_hash} label="Copy txid" />
        </div>
      )}
    </div>
  );
}

function RequestProjection({
  projection,
}: {
  projection: PayLinkRequestProjection;
}) {
  const firstContact = projection.identity_assurance === "first-contact-key";
  return (
    <article className="card pay-link-result" aria-label="Inspected payment request">
      <header className="card-head">
        <h3>Signed Bitcoin request</h3>
        <span className="pay-link-badges">
          <Badge tone="gold">signature valid</Badge>
          <Badge tone="neutral">policy accepted</Badge>
        </span>
      </header>

      <p className="pay-link-amount">
        {formatMinorCompact(projection.amount_atomic, BTC_DECIMALS)} BTC
        <span>{projection.amount_atomic} sats</span>
      </p>

      <div className="pay-link-safety" role="status">
        <strong>No money moved.</strong> This file contains signed request
        terms only.
      </div>

      <dl className="pay-link-details">
        <Fact label="Destination" code>{projection.destination}</Fact>
        <Fact label="Public note">{projection.note ?? "No note"}</Fact>
        <Fact label="Rail">{projection.rail}</Fact>
        <Fact label="Asset" code>{projection.asset_id}</Fact>
        <Fact label="Issued">
          <time dateTime={projection.issued_at} title={projection.issued_at}>
            {readableTime(projection.issued_at)}
          </time>
        </Fact>
        <Fact label="Request expires">
          <time dateTime={projection.expires_at} title={projection.expires_at}>
            {readableTime(projection.expires_at)}
          </time>
        </Fact>
        <Fact label="Usable until">
          <time dateTime={projection.usable_until} title={projection.usable_until}>
            {readableTime(projection.usable_until)}
          </time>
        </Fact>
        <Fact label="Merchant key" code>{projection.merchant_key_id}</Fact>
        <Fact label="Request record" code>{projection.request_record_id}</Fact>
        <Fact label="Bundle id" code>{projection.bundle_id}</Fact>
      </dl>

      <div className="pay-link-warning">
        <strong>
          {firstContact ? "First-seen key — not verified identity." : "Matches a key you pinned before."}
        </strong>{" "}
        The signature proves control of this key, not a person's name, company,
        or account. Verify the fingerprint through another path when identity
        matters.
      </div>
      <p className="pay-link-chain-note">
        Bitcoin addresses and payments are public and linkable on-chain.
      </p>
    </article>
  );
}

function AcceptanceProjection({
  projection,
}: {
  projection: PayLinkAcceptanceProjection;
}) {
  return (
    <article className="card pay-link-result" aria-label="Inspected acceptance evidence">
      <header className="card-head">
        <h3>Signed acceptance evidence</h3>
        <Badge tone="ember">sensitive plaintext</Badge>
      </header>

      <p className="pay-link-amount">
        {formatMinorCompact(projection.amount_atomic, BTC_DECIMALS)} BTC
        <span>{projection.amount_atomic} sats</span>
      </p>

      <div className="pay-link-safety" role="status">
        <strong>
          {projection.intent_active_at_verification
            ? "Acceptance window is active. "
            : "Acceptance window expired. "}
        </strong>
        The signed terms remain historical evidence either way. No money moved,
        and this is not proof that a payment happened.
      </div>

      <dl className="pay-link-details">
        <Fact label="Destination" code>{projection.destination}</Fact>
        <Fact label="Source address" code>{projection.source_account}</Fact>
        <Fact label="Maximum fee">
          {projection.max_fee_atomic} sats
        </Fact>
        <Fact label="Public note">{projection.note ?? "No note"}</Fact>
        <Fact label="Rail">{projection.rail}</Fact>
        <Fact label="Payment asset" code>{projection.asset_id}</Fact>
        <Fact label="Fee asset" code>{projection.fee_asset_id}</Fact>
        <Fact label="Issued">
          <time dateTime={projection.issued_at} title={projection.issued_at}>
            {readableTime(projection.issued_at)}
          </time>
        </Fact>
        <Fact label="Expires">
          <time dateTime={projection.expires_at} title={projection.expires_at}>
            {readableTime(projection.expires_at)}
          </time>
        </Fact>
        <Fact label="Merchant key" code>{projection.merchant_key_id}</Fact>
        <Fact label="Payer key" code>{projection.payer_key_id}</Fact>
        <Fact label="Intent record" code>{projection.intent_record_id}</Fact>
        <Fact label="Request record" code>{projection.request_record_id}</Fact>
        <Fact label="Pay Link id" code>{projection.pay_link_id}</Fact>
        <Fact label="Acceptance id" code>{projection.acceptance_id}</Fact>
      </dl>

      <div className="pay-link-warning">
        <strong>Pseudonymous keys are not verified identities.</strong>{" "}
        Signatures prove control of protocol keys, not a person's name, company,
        provider account, or control of the displayed Bitcoin source address.
      </div>
      <div className="pay-link-warning is-sensitive">
        This file is <strong>sensitive plaintext</strong>: anyone holding it can
        read the source, destination, amount, note, and key fingerprints. Share
        it only through a channel you choose. Stable keys and reused addresses
        can link separate files together.
      </div>
    </article>
  );
}

export function PayLinks() {
  const [keys, setKeys] = useState<VaultKey[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [destination, setDestination] = useState("");
  const [amountBtc, setAmountBtc] = useState("");
  const [note, setNote] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState(60 * 60);
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createInvalid, setCreateInvalid] = useState<CreateField | null>(null);
  const [created, setCreated] = useState<CreatedPayLink | null>(null);

  const [bundle, setBundle] = useState("");
  const [expectedMerchantKey, setExpectedMerchantKey] = useState("");
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [inspected, setInspected] = useState<PayLinkProjection | null>(null);

  const [sourceAccount, setSourceAccount] = useState("");
  const [maxFeeSats, setMaxFeeSats] = useState("10000");
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [acceptErr, setAcceptErr] = useState<string | null>(null);
  const [acceptInvalid, setAcceptInvalid] = useState<AcceptField | null>(null);
  const [accepted, setAccepted] = useState<AcceptedPayLink | null>(null);

  const [executionAccountId, setExecutionAccountId] = useState("");
  const [prepareBusy, setPrepareBusy] = useState(false);
  const [prepareErr, setPrepareErr] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirmOutcomeUnknown, setConfirmOutcomeUnknown] = useState(false);
  const [executionResult, setExecutionResult] =
    useState<PayLinkExecutionResult | null>(null);
  const [recoveryKey, setRecoveryKey] =
    useState<ExecutionRecoveryKey | null>(() => readExecutionRecovery());
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryErr, setRecoveryErr] = useState<string | null>(null);
  const [recoverySnapshot, setRecoverySnapshot] =
    useState<PayLinkExecutionSnapshot | null>(null);
  const [executionNow, setExecutionNow] = useState(() => Date.now());
  const prepareInFlight = useRef(false);
  const confirmInFlight = useRef(false);
  const recoveryKeyRef = useRef<ExecutionRecoveryKey | null>(recoveryKey);
  const recoveryRequestSerial = useRef(0);
  const activeRecoveryRequest = useRef<number | null>(null);
  const executionGeneration = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [keyResult, accountResult] = await Promise.all([
          api.keys(),
          api.accounts(),
        ]);
        if (!live) return;
        setKeys(keyResult.keys);
        setAccounts(accountResult.accounts);
        const firstBtc = keyResult.keys.find((key) => key.kind === "btc");
        if (firstBtc) {
          setDestination(firstBtc.address);
          setSourceAccount(firstBtc.address);
        }
      } catch (error) {
        if (live) setLoadErr(errorMessage(error));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const btcKeys = useMemo(
    () => (keys ?? []).filter((key) => key.kind === "btc"),
    [keys],
  );

  const btcKeyById = useMemo(
    () => new Map(btcKeys.map((key) => [key.id, key])),
    [btcKeys],
  );

  const bitcoinSources = useMemo<BitcoinSource[]>(() => {
    const sourceByAddress = new Map<string, BitcoinSource>();
    for (const key of btcKeys) {
      sourceByAddress.set(key.address, {
        address: key.address,
        label: `${key.label} · vault key`,
      });
    }
    for (const account of accounts) {
      if (
        account.status !== "ACTIVE"
        || account.rail !== "CRYPTO"
        || account.currency !== "BTC"
        || account.decimals !== BTC_DECIMALS
        || !account.vault_key_id
      ) {
        continue;
      }
      const key = btcKeyById.get(account.vault_key_id);
      if (!key) continue;
      sourceByAddress.set(key.address, {
        address: key.address,
        label: `${account.display_name} · ${key.label}`,
      });
    }
    return [...sourceByAddress.values()];
  }, [accounts, btcKeyById, btcKeys]);

  const eligibleExecutionAccounts = useMemo(() => {
    if (!accepted) return [];
    return accounts.filter((account) => {
      if (
        account.status !== "ACTIVE"
        || account.rail !== "CRYPTO"
        || account.currency !== "BTC"
        || account.decimals !== BTC_DECIMALS
        || !account.vault_key_id
      ) {
        return false;
      }
      const key = btcKeyById.get(account.vault_key_id);
      return key?.kind === "btc"
        && key.address === accepted.projection.source_account;
    });
  }, [accepted, accounts, btcKeyById]);

  useEffect(() => {
    if (!accepted) {
      setExecutionAccountId("");
      return;
    }
    setExecutionAccountId((current) =>
      eligibleExecutionAccounts.some((account) => account.id === current)
        ? current
        : (eligibleExecutionAccounts[0]?.id ?? ""),
    );
  }, [accepted, eligibleExecutionAccounts]);

  useEffect(() => {
    if (!accepted || executionResult) return;
    setExecutionNow(Date.now());
    const interval = window.setInterval(
      () => setExecutionNow(Date.now()),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, [accepted, executionResult]);

  useEffect(() => {
    if (prepared) reviewHeading.current?.focus();
  }, [prepared]);

  useEffect(() => {
    if (executionResult) resultHeading.current?.focus();
  }, [executionResult]);

  const amountSats = parseToMinor(amountBtc, BTC_DECIMALS);
  const noteBytes = utf8Length(note.trim());
  const acceptanceExpiry = accepted
    ? Date.parse(accepted.projection.expires_at)
    : Number.NaN;
  const acceptanceExpired = accepted !== null
    && (Number.isNaN(acceptanceExpiry) || executionNow >= acceptanceExpiry);
  const reviewExpiry = prepared
    ? Date.parse(prepared.review.confirm_before)
    : Number.NaN;
  const reviewExpired = prepared !== null
    && (Number.isNaN(reviewExpiry) || executionNow >= reviewExpiry);
  const reviewRemaining = prepared && !Number.isNaN(reviewExpiry)
    ? Math.max(0, reviewExpiry - executionNow)
    : 0;
  const preparedRecoveryKey = prepared
    ? exactExecutionRecoveryKey(prepared.review, recoveryKey)
    : null;
  const recoveryBlocksPrepare = recoveryKey !== null
    && (
      recoverySnapshot === null
      || recoverySnapshot.status === "broadcast_unknown"
      || recoverySnapshot.status === "not_sent"
      || (
        recoverySnapshot.status === "awaiting_confirmation"
        && recoverySnapshot.intent_record_id
          !== accepted?.projection.intent_record_id
      )
    );

  function cancelRecoveryRequest() {
    activeRecoveryRequest.current = null;
    setRecoveryBusy(false);
  }

  function rememberExecutionRecovery(key: ExecutionRecoveryKey | null) {
    cancelRecoveryRequest();
    recoveryKeyRef.current = key;
    setRecoveryKey(key);
    writeExecutionRecovery(key);
  }

  function resetExecution() {
    executionGeneration.current += 1;
    cancelRecoveryRequest();
    setExecutionAccountId("");
    setPrepareErr(null);
    setPrepared(null);
    setConfirmErr(null);
    setConfirmOutcomeUnknown(false);
    setExecutionResult(null);
    setExecutionNow(Date.now());
  }

  function forgetExecutionRecovery() {
    if (
      activeRecoveryRequest.current !== null
      || prepareInFlight.current
      || confirmInFlight.current
    ) {
      return;
    }
    const abandonsPrepared = prepared !== null;
    rememberExecutionRecovery(null);
    setRecoveryErr(null);
    setRecoverySnapshot(null);
    if (abandonsPrepared) {
      executionGeneration.current += 1;
      setPrepared(null);
      setConfirmErr(null);
      setConfirmOutcomeUnknown(false);
      setExecutionResult(null);
      setExecutionNow(Date.now());
    }
  }

  async function recoverExecutionStatus() {
    if (activeRecoveryRequest.current !== null) return;
    const key = recoveryKeyRef.current;
    if (!key) return;
    const appliesToPrepared = prepared !== null
      && exactExecutionRecoveryKey(prepared.review, key) !== null;

    const requestId = ++recoveryRequestSerial.current;
    activeRecoveryRequest.current = requestId;
    setRecoveryBusy(true);
    setRecoveryErr(null);
    try {
      const snapshot = await api.payLinkExecutionStatus(key);
      if (
        activeRecoveryRequest.current !== requestId
        || !sameExecutionRecoveryKey(recoveryKeyRef.current, key)
      ) {
        return;
      }
      if (
        snapshot.payment_id !== key.payment_id
        || snapshot.review_id !== key.review_id
      ) {
        throw new Error(
          "The local node returned a different payment binding.",
        );
      }
      setRecoverySnapshot(snapshot);

      if (appliesToPrepared) {
        setConfirmOutcomeUnknown(
          snapshot.status === "broadcast_unknown",
        );
        if (
          snapshot.status === "broadcast"
          || snapshot.status === "broadcast_unknown"
          || snapshot.status === "failed"
        ) {
          setConfirmErr(null);
          setExecutionResult({
            payment_id: snapshot.payment_id,
            review_id: snapshot.review_id,
            status: snapshot.status,
            tx_hash: snapshot.tx_hash,
            error: snapshot.error,
          });
        } else {
          setConfirmErr(null);
        }
      }
    } catch (error) {
      if (
        activeRecoveryRequest.current !== requestId
        || !sameExecutionRecoveryKey(recoveryKeyRef.current, key)
      ) {
        return;
      }
      setRecoveryErr(
        `Could not read the node's local payment state. Do not retry an uncertain confirmation. ${errorMessage(error)}`,
      );
    } finally {
      if (activeRecoveryRequest.current === requestId) {
        activeRecoveryRequest.current = null;
        setRecoveryBusy(false);
      }
    }
  }

  async function createPayLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateErr(null);
    setCreateInvalid(null);
    setCreated(null);

    if (!destination) {
      setCreateInvalid("destination");
      setCreateErr("Choose a local Bitcoin key to receive this request.");
      return;
    }
    if (!amountSats || amountSats === "0") {
      setCreateInvalid("amount");
      setCreateErr("Enter a positive BTC amount with at most 8 decimal places.");
      return;
    }
    if (noteBytes > MAX_NOTE_BYTES) {
      setCreateInvalid("note");
      setCreateErr(`The public note is ${noteBytes} bytes; keep it to ${MAX_NOTE_BYTES}.`);
      return;
    }

    setCreateBusy(true);
    try {
      const publicNote = note.trim();
      const result = await api.createPayLink({
        destination,
        amount_sats: amountSats,
        ...(publicNote ? { note: publicNote } : {}),
        ttl_seconds: ttlSeconds,
      });
      setCreated(result);
    } catch (error) {
      setCreateErr(errorMessage(error));
    } finally {
      setCreateBusy(false);
    }
  }

  function replaceBundle(value: string) {
    setBundle(value);
    setInspectErr(null);
    setInspected(null);
    setAccepted(null);
    resetExecution();
    setAcceptErr(null);
    setImportedCount(null);
    setImportErr(null);
  }

  async function chooseBundleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setInspectErr(null);
    if (file.size > MAX_BUNDLE_BYTES) {
      replaceBundle("");
      setInspectErr(`That file is larger than ${MAX_BUNDLE_BYTES / 1024} KiB.`);
      return;
    }
    try {
      const contents = await file.text();
      if (utf8Length(contents) > MAX_BUNDLE_BYTES) {
        replaceBundle("");
        setInspectErr(`That file is larger than ${MAX_BUNDLE_BYTES / 1024} KiB as UTF-8.`);
        return;
      }
      replaceBundle(contents);
    } catch {
      replaceBundle("");
      setInspectErr("The browser could not read that local file.");
    }
  }

  async function inspectBundle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInspectErr(null);
    setInspected(null);
    setAccepted(null);
    resetExecution();
    setImportedCount(null);
    if (bundle.trim() === "") {
      setInspectErr("Paste a signed bundle or choose a file first.");
      return;
    }
    if (utf8Length(bundle) > MAX_BUNDLE_BYTES) {
      setInspectErr(`Bundles are limited to ${MAX_BUNDLE_BYTES / 1024} KiB.`);
      return;
    }
    setInspectBusy(true);
    try {
      const result = await api.inspectPayLink(
        bundle,
        expectedMerchantKey.trim() || undefined,
      );
      setInspected(result.projection);
    } catch (error) {
      setInspectErr(errorMessage(error));
    } finally {
      setInspectBusy(false);
    }
  }

  async function acceptTerms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAcceptErr(null);
    setAcceptInvalid(null);
    setAccepted(null);
    resetExecution();
    if (!sourceAccount) {
      setAcceptInvalid("source");
      setAcceptErr("Choose a local Bitcoin source address.");
      return;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(maxFeeSats)) {
      setAcceptInvalid("fee");
      setAcceptErr("Maximum fee must be a whole number of satoshis, including zero.");
      return;
    }

    setAcceptBusy(true);
    try {
      const result = await api.acceptPayLink({
        bundle,
        source_account: sourceAccount,
        max_fee_sats: maxFeeSats,
      });
      setAccepted(result);
      setExecutionNow(Date.now());
    } catch (error) {
      setAcceptErr(errorMessage(error));
    } finally {
      setAcceptBusy(false);
    }
  }

  async function preparePaymentReview() {
    if (prepareInFlight.current) return;
    if (confirmInFlight.current) {
      setPrepareErr(
        "The previous one-time send request is still resolving. Wait for its local result before preparing anything else.",
      );
      return;
    }
    if (activeRecoveryRequest.current !== null) return;
    if (confirmOutcomeUnknown) {
      setPrepareErr(
        "A confirmation result is unresolved. Check the payment locally and on-chain before doing anything else.",
      );
      return;
    }
    if (recoveryBlocksPrepare) {
      setPrepareErr(
        "Resolve the last exact payment first. Check its local status above; only forget the tab marker after you have reconciled it or deliberately abandoned an unsigned review.",
      );
      return;
    }
    setPrepareErr(null);
    setConfirmErr(null);
    setExecutionResult(null);
    if (!accepted) {
      setPrepareErr("Create a local acceptance before preparing payment.");
      return;
    }
    if (acceptanceExpired) {
      setPrepareErr(
        "This acceptance window has expired. It remains evidence, but it cannot authorize payment.",
      );
      return;
    }
    const account = eligibleExecutionAccounts.find(
      (candidate) => candidate.id === executionAccountId,
    );
    if (!account) {
      setPrepareErr(
        "Choose an active 8-decimal BTC account bound to this acceptance's exact source key.",
      );
      return;
    }

    prepareInFlight.current = true;
    const generation = executionGeneration.current;
    setPrepareBusy(true);
    try {
      const result = await api.preparePayLinkExecution({
        intent_record_id: accepted.projection.intent_record_id,
        account_id: account.id,
      });
      const key = executionRecoveryKeyForReview(result.review);
      rememberExecutionRecovery(key);
      setRecoveryErr(null);
      setRecoverySnapshot(null);
      if (executionGeneration.current !== generation) return;
      setPrepared(result);
      setExecutionNow(Date.now());
    } catch (error) {
      if (executionGeneration.current !== generation) return;
      setPrepared(null);
      setPrepareErr(errorMessage(error));
    } finally {
      prepareInFlight.current = false;
      setPrepareBusy(false);
    }
  }

  async function confirmPaymentReview() {
    if (confirmInFlight.current) return;
    if (prepareInFlight.current) return;
    if (activeRecoveryRequest.current !== null) return;
    if (!prepared) {
      setConfirmErr("Prepare a payment review first.");
      return;
    }
    if (reviewExpired) {
      setConfirmErr(
        "This exact one-time review has expired. Nothing was signed. Ask the merchant for a fresh Pay Link and accept it again.",
      );
      return;
    }
    const key = exactExecutionRecoveryKey(
      prepared.review,
      recoveryKeyRef.current,
    );
    if (!key) {
      setConfirmErr(
        "This review cannot be sent because its exact recovery marker is missing. Prepare the review again before sending.",
      );
      return;
    }

    // Re-persist the exact one-time binding synchronously before any request
    // can reach the node. If the response is lost, these IDs remain the only
    // safe route back to the durable local result.
    rememberExecutionRecovery(key);
    setConfirmErr(null);
    setRecoveryErr(null);
    setRecoverySnapshot(null);

    confirmInFlight.current = true;
    const generation = executionGeneration.current;
    setConfirmBusy(true);
    try {
      const result = await api.confirmPayLinkExecution({
        payment_id: key.payment_id,
        review_id: key.review_id,
      });
      setConfirmOutcomeUnknown(result.status === "broadcast_unknown");
      setRecoverySnapshot({
        ...result,
        intent_record_id: prepared.review.intent_record_id,
        can_confirm: false,
      });
      if (executionGeneration.current !== generation) return;
      setExecutionResult(result);
    } catch (error) {
      if (executionGeneration.current !== generation) return;
      const definitivePreSignRefusal = error instanceof ApiError
        && error.code !== undefined
        && DEFINITIVE_PRE_SIGN_ERRORS.has(error.code);
      if (
        error instanceof ApiError
        && (error.code === "review_expired" || error.code === "intent_inactive")
      ) {
        setExecutionNow(Number.isNaN(reviewExpiry)
          ? Date.now()
          : Math.max(Date.now(), reviewExpiry));
      }
      setConfirmOutcomeUnknown(!definitivePreSignRefusal);
      setConfirmErr(definitivePreSignRefusal
        ? errorMessage(error)
        : `The node did not return a definitive payment result. Do not retry or prepare another payment until you check this payment on your node and on-chain. ${errorMessage(error)}`);
    } finally {
      confirmInFlight.current = false;
      setConfirmBusy(false);
    }
  }

  async function importAcceptance() {
    setImportErr(null);
    setImportedCount(null);
    setImportBusy(true);
    try {
      const result = await api.importPayLinkAcceptance(bundle);
      setInspected(result.projection);
      setImportedCount(result.inserted_count);
    } catch (error) {
      setImportErr(errorMessage(error));
    } finally {
      setImportBusy(false);
    }
  }

  if (loadErr) return <EmptyState>{loadErr}</EmptyState>;
  if (!keys) return <LoadingThreads label="Reading local Bitcoin keys…" />;

  return (
    <div className="stagger pay-links">
      <SectionTitle aside="Signed files. No hosted CashLoom account or central server.">
        Pay Links
      </SectionTitle>

      <p className="pay-links-intro">
        Create or accept portable Bitcoin terms. The files can travel by chat,
        USB, or any handoff you choose; signing still happens in your unlocked
        local vault. <strong>Creating, checking, accepting, downloading, and
        importing these files never moves money.</strong> Only a separately
        labelled payment review can expose a final send button.
      </p>

      {recoveryKey && (
        <section
          className="card pay-link-recovery"
          aria-labelledby="pay-link-recovery-title"
        >
          <p className="pay-link-step">Read-only recovery</p>
          <h3 id="pay-link-recovery-title">Last exact payment marker</h3>
          <p>
            This tab kept only two opaque local IDs—not keys, addresses, or
            payment terms. Checking reads this node's records only; it never
            contacts an indexer, signs, or broadcasts.
          </p>
          {recoveryBlocksPrepare && (
            <div className="pay-link-warning is-sensitive" role="status">
              <strong>Resolve this marker before preparing a different payment.</strong>{" "}
              Check the local state first. Forget it only after external
              reconciliation, or after deliberately abandoning an unsigned
              review; forgetting does not delete the node's durable record.
            </div>
          )}
          <dl className="pay-link-details">
            <Fact label="Payment id" code>{recoveryKey.payment_id}</Fact>
            <Fact label="Review id" code>{recoveryKey.review_id}</Fact>
            {recoverySnapshot && (
              <Fact label="Intent record" code>
                {recoverySnapshot.intent_record_id}
              </Fact>
            )}
          </dl>
          <div className="pay-link-actions">
            <button
              className="btn btn-ghost"
              type="button"
              disabled={recoveryBusy || prepareBusy || confirmBusy}
              onClick={() => void recoverExecutionStatus()}
            >
              {recoveryBusy ? "Reading local state…" : "Check local payment status"}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              disabled={recoveryBusy || prepareBusy || confirmBusy}
              onClick={forgetExecutionRecovery}
            >
              {prepared
                ? "Forget marker and abandon this review"
                : "Forget marker after reconciliation"}
            </button>
          </div>
          {recoveryErr && (
            <p className="form-error" role="alert">{recoveryErr}</p>
          )}
          {recoverySnapshot && (
            <ExecutionRecoveryState snapshot={recoverySnapshot} />
          )}
        </section>
      )}

      <div className="pay-links-workspace">
        <section className="pay-link-panel" aria-labelledby="create-pay-link-title">
          <h3 id="create-pay-link-title">Create a request</h3>
          <p>Choose one of your local Bitcoin keys, set the terms, then copy or download the signed file.</p>

          {btcKeys.length === 0 ? (
            <EmptyState>
              No Bitcoin key yet. Create one under <strong>Keys</strong>, then
              return here to make a request.
            </EmptyState>
          ) : (
            <form className="card pay-link-form" onSubmit={(event) => void createPayLink(event)}>
              <Field label="Receive to" hint="A public address from your local vault.">
                <select
                  value={destination}
                  onChange={(event) => {
                    setDestination(event.target.value);
                    setCreateErr(null);
                    setCreateInvalid(null);
                    setCreated(null);
                  }}
                  aria-invalid={createInvalid === "destination" || undefined}
                  aria-describedby={createErr ? "pay-link-create-error" : undefined}
                >
                  {btcKeys.map((key) => (
                    <option key={key.id} value={key.address}>
                      {key.label} · {key.address}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="field-row">
                <Field
                  label="Amount · BTC"
                  hint={
                    amountSats
                      ? `${amountSats} satoshis`
                      : "Up to 8 decimal places."
                  }
                >
                  <input
                    className="mono-input amt-input"
                    value={amountBtc}
                    onChange={(event) => {
                      setAmountBtc(event.target.value);
                      setCreateErr(null);
                      setCreateInvalid(null);
                      setCreated(null);
                    }}
                    placeholder="0.001"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={createInvalid === "amount" || undefined}
                    aria-describedby={createErr ? "pay-link-create-error" : undefined}
                  />
                </Field>
                <Field label="Expires">
                  <select
                    value={ttlSeconds}
                    onChange={(event) => {
                      setTtlSeconds(Number(event.target.value));
                      setCreated(null);
                    }}
                  >
                    <option value={60 * 60}>1 hour</option>
                    <option value={6 * 60 * 60}>6 hours</option>
                    <option value={24 * 60 * 60}>24 hours</option>
                  </select>
                </Field>
              </div>

              <Field
                label="Public note (optional)"
                hint={`${noteBytes}/${MAX_NOTE_BYTES} UTF-8 bytes. It travels inside the shared file; don't put secrets or identity here.`}
              >
                <input
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setCreateErr(null);
                    setCreateInvalid(null);
                    setCreated(null);
                  }}
                  placeholder="coffee, invoice 42…"
                  autoComplete="off"
                  aria-invalid={createInvalid === "note" || undefined}
                  aria-describedby={createErr ? "pay-link-create-error" : undefined}
                />
              </Field>

              {createErr && (
                <p className="form-error" id="pay-link-create-error" role="alert">
                  {createErr}
                </p>
              )}

              <div className="pay-link-actions">
                <button className="btn btn-primary" type="submit" disabled={createBusy}>
                  {createBusy ? "Signing locally…" : "Create signed Pay Link"}
                </button>
                <span>No funds are reserved or moved.</span>
              </div>
            </form>
          )}

          {created && (
            <div className="pay-link-created">
              <RequestProjection projection={created.projection} />
              <div className="pay-link-actions" aria-label="Share signed request">
                <CopyButton text={created.bundle} label="Copy signed request" big />
                <DownloadButton
                  contents={created.bundle}
                  filename={created.filename}
                  label="Download .cashloom-pay"
                />
              </div>
              <p className="pay-link-chain-note">
                Copying and downloading happen only when you press a button.
                The canonical bundle needs no hosted CashLoom server to travel.
                A fresh receive address reduces cross-file correlation, but
                Bitcoin settlement remains public.
              </p>
            </div>
          )}
        </section>

        <section className="pay-link-panel" aria-labelledby="open-pay-link-title">
          <h3 id="open-pay-link-title">Open a signed bundle</h3>
          <p>Paste canonical bundle text or choose a file. Inspect it before accepting or importing anything.</p>

          <form className="card pay-link-form" onSubmit={(event) => void inspectBundle(event)}>
            <Field
              label="Signed bundle"
              hint="Up to 64 KiB. A chosen file is read locally; nothing is sent outside your node."
            >
              <textarea
                className="mono-input pay-link-bundle-input"
                value={bundle}
                onChange={(event) => replaceBundle(event.target.value)}
                placeholder='{"schema":"cashloom/…"}'
                rows={7}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(inspectErr) || undefined}
                aria-describedby={inspectErr ? "pay-link-inspect-error" : undefined}
              />
            </Field>

            <Field label="Or choose a local file">
              <input
                className="pay-link-file"
                type="file"
                accept=".cashloom-pay,.cashloom-accept,application/json"
                onChange={(event) => void chooseBundleFile(event)}
                aria-invalid={Boolean(inspectErr) || undefined}
                aria-describedby={inspectErr ? "pay-link-inspect-error" : undefined}
              />
            </Field>

            <Field
              label="Known merchant key (optional)"
              hint="Paste a sha256 fingerprint obtained through another path. A match verifies that key, not a person or company."
            >
              <input
                className="mono-input"
                value={expectedMerchantKey}
                onChange={(event) => {
                  setExpectedMerchantKey(event.target.value);
                  setInspectErr(null);
                  setInspected(null);
                }}
                placeholder="sha256:…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(inspectErr) || undefined}
                aria-describedby={inspectErr ? "pay-link-inspect-error" : undefined}
              />
            </Field>

            {inspectErr && (
              <p className="form-error" id="pay-link-inspect-error" role="alert">
                {inspectErr}
              </p>
            )}

            <div className="pay-link-actions">
              <button className="btn btn-primary" type="submit" disabled={inspectBusy}>
                {inspectBusy ? "Checking signatures…" : "Check bundle"}
              </button>
              <span>Checking does not accept or pay.</span>
            </div>
          </form>

          {inspected?.kind === "request" && (
            <>
              <RequestProjection projection={inspected} />
              {!accepted && (
                <form className="card pay-link-form pay-link-accept-form" onSubmit={(event) => void acceptTerms(event)}>
                  <h3>Accept these exact terms</h3>
                  <p>
                    Your node will sign a private acceptance file. This records
                    consent only; no money moves. Its active intent window is
                    five minutes, then the file remains verifiable historical
                    evidence rather than live authorization.
                  </p>

                  {bitcoinSources.length === 0 ? (
                    <EmptyState>
                      No local Bitcoin source exists. Create a Bitcoin key under{" "}
                      <strong>Keys</strong> before accepting.
                    </EmptyState>
                  ) : (
                    <>
                      <Field
                        label="Bitcoin source"
                        hint="This full address will appear in sensitive plaintext evidence. Prefer a fresh local address when linkability matters."
                      >
                        <select
                          value={sourceAccount}
                          onChange={(event) => {
                            setSourceAccount(event.target.value);
                            setAcceptErr(null);
                            setAcceptInvalid(null);
                          }}
                          aria-invalid={acceptInvalid === "source" || undefined}
                          aria-describedby={acceptErr ? "pay-link-accept-error" : undefined}
                        >
                          {bitcoinSources.map((source) => (
                            <option key={source.address} value={source.address}>
                              {source.label} · {source.address}
                            </option>
                          ))}
                        </select>
                      </Field>

                      <Field
                        label="Maximum network fee · sats"
                        hint="A consent ceiling only. No fee is estimated, reserved, or paid here."
                      >
                        <input
                          className="mono-input"
                          value={maxFeeSats}
                          onChange={(event) => {
                            setMaxFeeSats(event.target.value);
                            setAcceptErr(null);
                            setAcceptInvalid(null);
                          }}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={acceptInvalid === "fee" || undefined}
                          aria-describedby={acceptErr ? "pay-link-accept-error" : undefined}
                        />
                      </Field>

                      {acceptErr && (
                        <p className="form-error" id="pay-link-accept-error" role="alert">
                          {acceptErr}
                        </p>
                      )}

                      <div className="pay-link-actions">
                        <button className="btn btn-primary" type="submit" disabled={acceptBusy}>
                          {acceptBusy ? "Signing acceptance…" : "Accept terms — no money moves"}
                        </button>
                      </div>
                    </>
                  )}
                </form>
              )}
            </>
          )}

          {accepted && (
            <div className="pay-link-created">
              <AcceptanceProjection projection={accepted.projection} />
              <p className="pay-link-import-status" role="status">
                {accepted.reused
                  ? "Your node returned the existing acceptance; it did not sign a second one."
                  : "Acceptance signed locally. No money was sent."}
              </p>
              <div className="pay-link-actions">
                <DownloadButton
                  contents={accepted.bundle}
                  filename={accepted.filename}
                  label="Download sensitive .cashloom-accept"
                />
              </div>

              <section
                className="card pay-link-execution"
                aria-labelledby="pay-link-execution-title"
              >
                <header className="pay-link-execution-head">
                  <div>
                    <p className="pay-link-step">Separate payment action</p>
                    <h3 id="pay-link-execution-title">
                      Payment · can move Bitcoin
                    </h3>
                  </div>
                  <Badge tone="ember">fresh confirmation required</Badge>
                </header>

                {!prepared && !executionResult && (
                  <>
                    <div className="pay-link-execution-disclosure">
                      <strong>Your signed acceptance did not pay.</strong>{" "}
                      Preparing a review contacts your configured Bitcoin
                      indexer with the source address and reserves the exact
                      selected coins for this short-lived quote. It signs and
                      broadcasts nothing.
                    </div>

                    {eligibleExecutionAccounts.length === 0 ? (
                      <div className="pay-link-execution-setup" role="status">
                        <strong>No execution-ready account matches this source.</strong>
                        <p>
                          Create an active <code>CRYPTO</code> account for{" "}
                          <code>BTC</code> with 8 decimals, then bind it to the
                          local Bitcoin key whose address is:
                        </p>
                        <code className="pay-link-block-code">
                          {accepted.projection.source_account}
                        </code>
                        <p>
                          The acceptance remains valid evidence. CashLoom will
                          never substitute a different source account.
                        </p>
                      </div>
                    ) : (
                      <>
                        {eligibleExecutionAccounts.length > 1 ? (
                          <Field
                            label="Pay from local account"
                            hint="Every option is active, BTC/8-decimal, and bound to the acceptance's exact source address."
                          >
                            <select
                              value={executionAccountId}
                              onChange={(event) => {
                                setExecutionAccountId(event.target.value);
                                setPrepareErr(null);
                              }}
                              aria-describedby="pay-link-prepare-disclosure"
                            >
                              {eligibleExecutionAccounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.display_name} · BTC
                                </option>
                              ))}
                            </select>
                          </Field>
                        ) : (
                          <dl className="pay-link-details pay-link-execution-source">
                            <Fact label="Pay from">
                              {eligibleExecutionAccounts[0]!.display_name}
                            </Fact>
                            <Fact label="Source address" code>
                              {accepted.projection.source_account}
                            </Fact>
                          </dl>
                        )}

                        <p
                          className="pay-link-execution-privacy"
                          id="pay-link-prepare-disclosure"
                        >
                          The indexer can observe a lookup for this public
                          source address. No CashLoom host, merchant, or
                          corporate account is required.
                        </p>

                        {prepareErr && (
                          <p className="form-error" role="alert">
                            {prepareErr}
                          </p>
                        )}
                        {recoveryBlocksPrepare && (
                          <p className="form-error" role="status">
                            The last exact payment marker above must be checked
                            or explicitly reconciled before another review can
                            be prepared.
                          </p>
                        )}

                        <div className="pay-link-actions">
                          <button
                            className="btn btn-ghost pay-link-prepare-button"
                            type="button"
                            disabled={
                              prepareBusy
                              || recoveryBusy
                              || acceptanceExpired
                              || recoveryBlocksPrepare
                            }
                            aria-describedby="pay-link-prepare-disclosure"
                            onClick={() => void preparePaymentReview()}
                          >
                            {prepareBusy
                              ? "Contacting indexer and preparing…"
                              : "Prepare payment review"}
                          </button>
                          <span>Still no signature or broadcast.</span>
                        </div>
                      </>
                    )}

                    {acceptanceExpired && (
                      <p
                        className="pay-link-execution-expired"
                        role="status"
                        aria-live="polite"
                      >
                        Acceptance window expired. The signed file remains
                        historical evidence, but cannot authorize a payment.
                      </p>
                    )}
                  </>
                )}

                {prepared && !executionResult && (
                  <div className="pay-link-execution-review">
                    <p className="pay-link-step">Final action · review before signing</p>
                    <h3 ref={reviewHeading} tabIndex={-1}>
                      Payment review · nothing signed yet
                    </h3>

                    <div className="pay-link-execution-safe" role="status">
                      <strong>No money moved.</strong> Your node derived these
                      facts from the signed intent and its persisted exact
                      Bitcoin quote. Changing any term requires a fresh Pay
                      Link, acceptance, and review.
                    </div>

                    <p className="pay-link-review-amount">
                      {formatMinorCompact(prepared.review.amount_sats, BTC_DECIMALS)} BTC
                      <span>{prepared.review.amount_sats} sats</span>
                    </p>

                    <dl className="pay-link-details pay-link-review-details">
                      <Fact label="Network">{prepared.review.network}</Fact>
                      <Fact label="Source account">
                        {prepared.review.account_label}
                      </Fact>
                      <Fact label="Source address" code>
                        {prepared.review.source_address}
                      </Fact>
                      <Fact label="Destination" code>
                        {prepared.review.destination}
                      </Fact>
                      <Fact label="Amount">
                        {btcAndSats(prepared.review.amount_sats)}
                      </Fact>
                      <Fact label="Exact network fee">
                        {btcAndSats(prepared.review.fee_sats)}
                      </Fact>
                      <Fact label="Signed fee ceiling">
                        {btcAndSats(prepared.review.max_fee_sats)}
                      </Fact>
                      <Fact label="Total from source">
                        {btcAndSats(prepared.review.total_sats)}
                      </Fact>
                      <Fact label="CashLoom fee">
                        {prepared.review.cashloom_fee_sats} sats
                      </Fact>
                      <Fact label="Quote expires">
                        <time
                          dateTime={prepared.review.quote_expires_at}
                          title={prepared.review.quote_expires_at}
                        >
                          {readableTime(prepared.review.quote_expires_at)}
                        </time>
                      </Fact>
                      <Fact label="Acceptance expires">
                        <time
                          dateTime={prepared.review.intent_expires_at}
                          title={prepared.review.intent_expires_at}
                        >
                          {readableTime(prepared.review.intent_expires_at)}
                        </time>
                      </Fact>
                      <Fact label="Send before">
                        <time
                          dateTime={prepared.review.confirm_before}
                          title={prepared.review.confirm_before}
                        >
                          {readableTime(prepared.review.confirm_before)}
                        </time>
                      </Fact>
                      <Fact label="Merchant key" code>
                        {prepared.review.merchant_key_id}
                      </Fact>
                      <Fact label="Payment id" code>
                        {prepared.review.payment_id}
                      </Fact>
                      <Fact label="Review id" code>
                        {prepared.review.review_id}
                      </Fact>
                    </dl>

                    <div
                      className={`pay-link-execution-clock${reviewExpired ? " is-expired" : ""}`}
                    >
                      <span aria-hidden="true">
                        {reviewExpired
                          ? "Review expired · nothing was signed"
                          : `Fresh confirmation available for ${remainingTime(reviewRemaining)}`}
                      </span>
                      <span className="sr-only" aria-live="polite">
                        {reviewExpired
                          ? "Payment review expired. Nothing was signed."
                          : "Payment review ready for a separate confirmation."}
                      </span>
                    </div>

                    {prepared.reused && (
                      <p className="pay-link-execution-reused" role="status">
                        Your node returned the same still-active review; it did
                        not reserve or create a second payment.
                      </p>
                    )}

                    {confirmErr && (
                      <p className="form-error" role="alert">
                        {confirmErr}
                      </p>
                    )}

                    {(confirmOutcomeUnknown
                      || recoveryErr !== null
                      || recoverySnapshot !== null) && (
                      <div className="pay-link-recovery-inline">
                        <div className="pay-link-actions">
                          <button
                            className="btn btn-ghost"
                            type="button"
                            disabled={recoveryBusy}
                            onClick={() => void recoverExecutionStatus()}
                          >
                            {recoveryBusy
                              ? "Reading local state…"
                              : "Check local payment status"}
                          </button>
                          <span>This check cannot sign or broadcast.</span>
                        </div>
                        {recoveryErr && (
                          <p className="form-error" role="alert">
                            {recoveryErr}
                          </p>
                        )}
                        {recoverySnapshot && (
                          <ExecutionRecoveryState snapshot={recoverySnapshot} />
                        )}
                      </div>
                    )}

                    <div className="pay-link-confirm-area">
                      {reviewExpired ? (
                        <button
                          className="btn btn-ghost"
                          type="button"
                          disabled
                        >
                          Fresh Pay Link required
                        </button>
                      ) : (
                        <button
                          className="btn btn-primary pay-link-send-button"
                          type="button"
                          disabled={
                            confirmBusy
                            || recoveryBusy
                            || confirmOutcomeUnknown
                            || reviewExpired
                            || preparedRecoveryKey === null
                            || recoverySnapshot?.status === "not_sent"
                          }
                          aria-describedby="pay-link-send-warning"
                          onClick={() => void confirmPaymentReview()}
                        >
                          {confirmBusy
                            ? "Signing and broadcasting once…"
                            : `Send ${formatMinorCompact(prepared.review.amount_sats, BTC_DECIMALS)} BTC now`}
                        </button>
                      )}
                      <p id="pay-link-send-warning">
                        {reviewExpired
                          ? "This intent remains historical evidence and cannot be rebound to another quote."
                          : "This is the only button here that signs and broadcasts. It makes one Bitcoin mainnet broadcast attempt; CashLoom never retries automatically."}
                      </p>
                    </div>
                  </div>
                )}

                {executionResult && prepared && (
                  <div
                    className="pay-link-execution-result"
                    data-state={executionResult.status}
                    role="status"
                  >
                    <h3 ref={resultHeading} tabIndex={-1}>
                      {executionResult.status === "broadcast"
                        ? "Broadcast submitted"
                        : executionResult.status === "broadcast_unknown"
                          ? executionResult.tx_hash
                            ? "Broadcast outcome unknown"
                            : "One-time send claim outcome unknown"
                          : "Payment attempt failed"}
                    </h3>
                    <p>
                      {executionResult.status === "broadcast"
                        ? `${btcAndSats(prepared.review.amount_sats)} was signed once and submitted to Bitcoin mainnet.`
                        : executionResult.status === "broadcast_unknown"
                          ? executionResult.tx_hash
                            ? "A txid was persisted, but the network did not give a definitive answer. The transaction may be live. Do not prepare or send another payment until you check it on-chain."
                            : "The one-time claim began, but the local record cannot prove whether signing or submission occurred. Do not retry or prepare a replacement payment until you reconcile this state."
                          : "CashLoom did not retry. Read the node's error before deciding what to do next."}
                    </p>
                    {executionResult.error && (
                      <p className="pay-link-execution-result-error">
                        {executionResult.error}
                      </p>
                    )}
                    {executionResult.tx_hash && (
                      <div className="pay-link-execution-tx">
                        <code>{executionResult.tx_hash}</code>
                        <CopyButton
                          text={executionResult.tx_hash}
                          label="Copy txid"
                        />
                      </div>
                    )}
                    {executionResult.status === "broadcast_unknown" && (
                      <div className="pay-link-warning is-sensitive">
                        <strong>Do not retry.</strong>{" "}
                        {executionResult.tx_hash
                          ? "A missing or non-success response is not proof of failure; the same payment could otherwise be sent twice. Check the copied txid with a Bitcoin node or explorer you choose."
                          : "No durable txid is available, and that does not prove the signing path stopped before egress. Inspect the node's local records and reconcile before any replacement payment."}
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {inspected?.kind === "acceptance" && !accepted && (
            <>
              <AcceptanceProjection projection={inspected} />
              <div className="card pay-link-import">
                <h3>Import as local evidence</h3>
                <p>
                  Importing stores verified signed records only. It does not
                  move money or prove that payment happened. Expired acceptance
                  remains historical evidence; any future execution gate must
                  require fresh, active authorization.
                </p>
                {importErr && (
                  <p className="form-error" role="alert">{importErr}</p>
                )}
                <div className="pay-link-actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={importBusy}
                    onClick={() => void importAcceptance()}
                  >
                    {importBusy ? "Importing evidence…" : "Import signed evidence"}
                  </button>
                </div>
                {importedCount !== null && (
                  <p className="pay-link-import-status" role="status">
                    {importedCount === 0
                      ? "Already present. No duplicate evidence was added."
                      : `${importedCount} canonical record${importedCount === 1 ? "" : "s"} imported.`}{" "}
                    No money moved.
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
