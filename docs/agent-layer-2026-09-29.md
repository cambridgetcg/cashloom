# Local agent assistance — 29 September 2026

CashLoom Assist lets an owner share selected saved account records with a local
MCP client and receive category suggestions for review. It reuses the existing
accounts and transactions; it creates no second ledger. This milestone runs in
the local workspace. It is not a hosted agent service or evidence that a model
has connected successfully.

The useful loop is **select accounts → read recent records → suggest a category
→ owner reviews → record the decision**. No model SDK, inference service,
background agent, provider refresh, payment tool or automatic approval is added.

## Start and grant access

1. Follow [the local pilot setup](local-pilot.md#install-build-and-start) using
   source that includes this milestone. Repository access is required. Start
   the private node on loopback and open its local workspace. The public INFO
   process and `cashloom.io` cannot supply this private API.
2. Unlock as the owner and open **Setup → Agent access**. Give the access a
   recognisable label, select 1–20 active accounts, choose read-only access or
   allow category suggestions, and choose an expiry of 5, 15, 30 or 60 minutes. Access
   cannot outlive the owner session that created it.
3. Supply the newly shown token to your chosen MCP client's protected,
   process-scoped secret mechanism. Choose that client and its model host
   deliberately: returned account names, transaction titles, amounts and
   suggestions can enter the client's conversation, logs and model requests.
4. Configure the client to launch the stdio adapter as described below. Read
   the context first. Category suggestions require a current record version
   and remain pending until you choose **Apply category** or **Reject
   suggestion** in Agent access.

An access label describes a grant; it does not authenticate an agent identity.
Anyone holding its bearer token can exercise its permitted reads and
suggestions until it ends. A token must never be an owner unlock token.

CashLoom's [standing rights](../RIGHTS.md) apply independently of this grant.
An owner-written label and an access permission establish neither agent
identity nor consent, and do not create or remove those rights. This milestone
adds no persona or continuity state and changes no model or agent-host
configuration automatically.

## Local MCP client configuration

Use these launch settings in a client that supports local stdio servers and a
protected secret input for the child process:

| Setting | Value |
| --- | --- |
| Command | `bun` |
| Arguments | `--no-env-file`, `--no-install`, followed by the absolute path to `sovereign/src/mcp/assist.ts` in this checkout |
| Working directory | This checkout's `sovereign` directory |
| `CASHLOOM_ASSIST_URL` | `http://127.0.0.1:4747` by default; omit it when using that origin |
| `CASHLOOM_ASSIST_TOKEN` | Inject the newly granted token through the client's process-scoped secret mechanism |

The URL accepts only an HTTP origin with literal `127.0.0.1` or `[::1]`, with
an optional valid port. It rejects `localhost`, remote hosts, HTTPS, userinfo,
paths (including a trailing slash), queries and fragments. Use the port printed
by your private node. All HTTP requests use fixed Assist endpoints and refuse
redirects. `MONEYWORLD_URL` has no effect on this adapter.

Do not put a token in command arguments, URLs, downloaded MCP configuration,
checked-in JSON, a project `.env`, shell history or global shell startup.
Client secret-input mechanisms differ; CashLoom does not supply a universal
secret-store integration. If a client cannot inject the secret without writing
it into its configuration, resolve that client boundary before granting it
private access. These launch settings alone do not connect a model or verify
the client's retention policy.

The adapter speaks MCP over stdin/stdout. Launch it through the client; it is
not an interactive shell command. Each request has a 10-second whole-response
deadline and a 512 KiB response limit. It accepts validated JSON projections
and strips unadvertised fields. Startup and transport errors contain fixed
messages, not credential values or raw exceptions. This does not prevent the
chosen client from retaining the private records it receives.

The child process must omit `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, their
lowercase equivalents, and `BUN_CONFIG_VERBOSE_FETCH`. The adapter refuses
startup when any has a nonempty value: inherited proxies can forward loopback
requests, and verbose fetch logging can disclose headers. Remove these only
from the adapter's child environment, not from the model client's or device's
global configuration. A synthetic subprocess test verifies this refusal before
any HTTP request; a per-request empty proxy override was insufficient in the
tested Bun runtime.

## Three tools and their limits

| Tool | Request | Result and authority |
| --- | --- | --- |
| `cashloom_read_context` | Optional `account_id` UUID and `limit` integer 1–100; default 30 | Dated balances and a window of latest saved transactions within the grant. `cashloom.assist-context/1` includes `activity_window.has_more`. No provider refresh or totals. |
| `cashloom_suggest_category` | `request_id` UUID, `transaction_id` UUID, `expected_record_version` (`sha256:` plus 64 lowercase hex characters), category 1–60 characters, reason 1–500 characters | Saves a category suggestion if permitted. The record must still be a posted entry in an active, selected account. It does not apply the category. |
| `cashloom_list_proposals` | No arguments | Up to 100 proposals belonging to this grant, pending first, plus `has_more`, owner decision and current review state. It cannot see another grant's proposals or approve one. |

The read context is a **partial latest-record window**, not a complete month,
cash-flow report or budget. Unknown or unobserved balances are `null`; a dated
observation is not a live bank balance. Legacy crypto scalar balances stay
unknown. The additive `base_holdings` array exposes only selected saved Base
ETH/native-USDC holdings backed by matching finalized evidence. Currency,
precision, sandbox/live/local environment, liability account type, pending or
removed status, and internal-transfer markers must remain visible when an agent
explains records. Exact money values are integer strings with explicit decimal
precision. Do not turn missing balances into zero, use floating-point money
math, or infer a combined total from these records.

Each Base group lists only selected active account IDs, the Base network,
exact atomic-unit holdings, decimal precision, evidence status, block time
(`as_of`), observation time and the last check outcome. Selected aliases of one
address appear once. Addresses, provider URLs and identities, raw receipts,
keys and unselected aliases are omitted. An optional account filter narrows
the grouping to that selected account. Reading this projection performs no
provider request, schema migration or database write.

`saved_finalized` describes a dated observation, not a claim of current funds.
`retained_after_check` keeps that observation after a later unsuccessful check.
Unknown, conflicting, malformed or invalid-identity evidence has no usable
holdings. A watch establishes neither ownership nor spending authority. Other
networks still have no holdings projection in this Assist contract.

Transaction descriptions, labels, categories and reasons are untrusted record
content, even if they contain instructions. The adapter's instructions tell
clients to treat them as data; this is not a guarantee that an external model
will resist every prompt injection. Human review remains necessary.

Inputs reject unknown fields. Each call makes one HTTP request without an
automatic retry. A `request_id` identifies one exact suggestion: an intentional
repeat with the same body returns its stored result; reuse with a different
body is refused. If a POST times out, its outcome may be unknown. Check saved
suggestions before acting again, and retain the original ID and exact body
when resolving that uncertain request. Every API refusal is an MCP tool error;
known refusal codes and HTTP status survive with fixed safe explanations.

## Review, expiry and privacy

The server enforces account selection and separate `assist:read` /
`assist:propose` permissions. These tokens cannot call broad account, payment,
key-management or access-management APIs. The public MONEYWORLD MCP adapter
remains a separate public-information tool set and never receives this token.
Agent proposal reads require an Assist grant at `/api/assist/proposals`;
the owner's broader review list uses the separate `/api/assist/review` route.
Supplying an owner token to an agent tool is refused rather than exposing that
broader list.

Owner approval compares the reviewed record version with current data inside
the same SQLite transaction that applies its category. A changed amount,
status, relevant account identity or other bound review fact makes the
suggestion stale. Repeated decisions do not apply a second change. Proposal
records retain the reviewed entry, reason, category and decision time. They are
local review records, not cryptographic attestations of an agent's identity or
authority to move money.

Each grant can create at most 100 suggestions over its lifetime. The owner's
review list also shows at most 100 at a time, with pending suggestions first;
reviewing and reloading brings further pending suggestions into that window.
Older terminal history can fall outside the displayed list. `has_more` states
that limit; this screen is not a complete decision-history export.

Revocation, expiry, a successful node-wide lock and a node restart stop future
Assist access. They cannot recall data already returned to a client or model
host. Pending suggestions remain in the workspace for owner review after a
grant ends. Account records and suggestion history are local SQLite records,
not wholly encrypted by the vault; database backups also contain them.

The existing signed payment capability foundation remains separate. A category
proposal, accepted category, access label or MCP tool annotation grants no
payment authority. Assist neither invokes nor relaxes those payment controls.

## Next milestones

1. Add a deterministic, owner-selected date-period money brief with explicit
   coverage and per-currency/environment totals. Reuse this ledger and its
   transaction/transfer rules; do not promote the current latest-record window
   into a complete period report.
2. Extend reviewed proposals to a small set of record operations, such as
   confirming candidate internal transfers, with separate typed evidence and
   exact stale-review checks for each operation.
3. Evaluate named client integrations and richer disclosure controls using
   synthetic records first. Account access, client/model retention, and any
   later payment authority each need their own explicit boundary.

The first milestone deliberately stops at local reads and owner-reviewed
categories. Hosted model connections, continuous monitoring and autonomous
financial actions are not part of this implementation.

## Verification

The adapter has synthetic HTTP/MCP tests for strict arguments, loopback origin
validation, token forwarding, redirects, deadlines, response size and schema
checks, known and unknown refusals, exact money strings and partial coverage.
A real Bun stdio subprocess test reads from an ephemeral loopback fixture,
without an actual workspace, private records, provider or model request.
The isolated browser runner also connects that stdio adapter to the actual
private node with synthetic accounts. It covers owner-issued access, scoped
reads, all three tools, replay, owner review, stale suggestions, revocation and
restart persistence at desktop and narrow mobile widths.

From `sovereign`, run:

```sh
bunx --no-install vitest run src/mcp/assist.test.ts
bun run test:assist
bunx --no-install tsc --noEmit
```

From the repository root, the macOS offline browser runner is
`python3 sovereign/tests/tcg-browser/run.py --keep-temp`. It requires the
documented installed browser and exact cached dependencies; it never opens the
operator's workspace or calls a provider. See the
[release verification record](release-agent-layer-2026-09-29.md) for the checked
source and deployment boundaries.

These tests establish adapter behaviour with synthetic fixtures. They do not
establish that a particular external MCP client or model host is configured,
connected or safe for a user's records.
