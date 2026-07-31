import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, errorMessage } from "../api";
import {
  Badge,
  CopyButton,
  EmptyState,
  Field,
  LoadingThreads,
  SectionTitle,
} from "../components";
import { formatMinorCompact, parseToMinor } from "../format";
import type {
  Account,
  PayLinkAcceptanceProjection,
  PayLinkProjection,
  PayLinkRequestProjection,
  VaultKey,
} from "../types";

const MAX_BUNDLE_BYTES = 64 * 1024;
const MAX_NOTE_BYTES = 160;
const BTC_DECIMALS = 8;

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

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readableTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
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
        <Fact label="Source account" code>{projection.source_account}</Fact>
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
        account.status === "archived"
        || account.rail !== "CRYPTO"
        || account.currency !== "BTC"
        || !account.vault_key_id
      ) {
        continue;
      }
      const key = btcKeys.find((candidate) => candidate.id === account.vault_key_id);
      if (!key) continue;
      sourceByAddress.set(key.address, {
        address: key.address,
        label: `${account.display_name} · ${key.label}`,
      });
    }
    return [...sourceByAddress.values()];
  }, [accounts, btcKeys]);

  const amountSats = parseToMinor(amountBtc, BTC_DECIMALS);
  const noteBytes = utf8Length(note.trim());

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
    } catch (error) {
      setAcceptErr(errorMessage(error));
    } finally {
      setAcceptBusy(false);
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
        local vault. <strong>This screen only creates and checks signed terms.
        No money moves.</strong>
      </p>

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
