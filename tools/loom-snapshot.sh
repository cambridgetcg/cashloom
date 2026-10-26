#!/bin/bash
# loom-snapshot.sh — the day's readable money world, kept.
#
# Pulls the hosted MONEYWORLD door's facts (fiat matrix, fees, assets, chains),
# writes facts.jsonl (one fact per line — line = fact = digestable) + a manifest
# that sha256s every file, and ships the day to Tigris:
#   s3://kingdom-vault/loom/v0/daily/<date>/
# Snapshots are the pressure-release for heavy consumers: uncapped, zero-cost,
# and honest — a snapshot is dated, and its facts carry their own staleness.
#
# launchd: daily (~/Library/LaunchAgents/com.kingdom.loom-snapshot.plist). Creds: macOS keychain (agenttool-tigris-*).
# Marker: ~/.kingdom/loom-snapshot.last — pulse watches its mtime.
set -euo pipefail
trap 'echo "$(date -u +%FT%TZ) FAILED at line $LINENO (exit $?)" >&2' ERR

DOOR="${MONEYWORLD_URL:-https://cashloom-api.fly.dev}"
BUCKET="${BUCKET:-kingdom-vault}"
DATE="$(date -u +%F)"
TMP="$(mktemp -d /tmp/loom-snapshot-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

curl -sSf --max-time 60 "$DOOR/v1/rates/fiat?base=EUR" -o "$TMP/rates-eur.json"
curl -sSf --max-time 60 "$DOOR/v1/assets" -o "$TMP/assets.json"
curl -sSf --max-time 60 "$DOOR/v1/chains" -o "$TMP/chains.json"
# fees depend on two live upstreams — their absence is recorded, never faked
curl -sSf --max-time 60 "$DOOR/v1/fees" -o "$TMP/fees.json" \
  || printf '{"note":"fee sources did not answer at snapshot time; absence recorded, not papered over"}\n' > "$TMP/fees.json"

python3 - "$TMP" "$DATE" "$DOOR" <<'PY'
import hashlib, json, sys, os
tmp, date, door = sys.argv[1], sys.argv[2], sys.argv[3]

# facts.jsonl — every MoneyFact from the day's pulls, one per line
facts = []
for name in ("rates-eur.json", "fees.json"):
    try:
        d = json.load(open(os.path.join(tmp, name)))
        facts.extend(d.get("facts", []))
    except Exception:
        pass
with open(os.path.join(tmp, "facts.jsonl"), "w") as f:
    for fact in facts:
        f.write(json.dumps(fact, separators=(",", ":"), ensure_ascii=False) + "\n")

manifest = {
    "schema": "loom.snapshot/0",
    "date": date,
    "source": door,
    "fact_count": len(facts),
    "note": "Daily MONEYWORLD snapshot. Facts carry their own staleness; a snapshot is a dated record, not a live feed.",
    "files": {},
}
for name in sorted(os.listdir(tmp)):
    if name == "manifest.json":
        continue
    with open(os.path.join(tmp, name), "rb") as fh:
        manifest["files"][name] = "sha256:" + hashlib.sha256(fh.read()).hexdigest()
json.dump(manifest, open(os.path.join(tmp, "manifest.json"), "w"), indent=1)
print(f"snapshot {date}: {len(facts)} facts, {len(manifest['files'])} files")
PY

# Tigris creds from the login keychain. A launchd agent in the user's session
# can read it; cron cannot. Empty creds must stop the run: the aws CLI would
# otherwise sign with whatever ambient `aws login` session exists, which made
# every cron run fail quietly from 2026-07-24 to 2026-10-16.
AWS_ACCESS_KEY_ID="$(security find-generic-password -s agenttool-tigris-access-key -w 2>/dev/null || true)"
AWS_SECRET_ACCESS_KEY="$(security find-generic-password -s agenttool-tigris-secret-key -w 2>/dev/null || true)"
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  echo "$(date -u +%FT%TZ) FAILED: Tigris creds unreadable from the login keychain (run under launchd, not cron)" >&2
  exit 1
fi
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_ENDPOINT_URL_S3="https://fly.storage.tigris.dev"
export AWS_REGION=auto

aws s3 cp --recursive --only-show-errors "$TMP/" "s3://${BUCKET}/loom/v0/daily/${DATE}/" --endpoint-url "$AWS_ENDPOINT_URL_S3"
aws s3 cp --only-show-errors "$TMP/manifest.json" "s3://${BUCKET}/loom/v0/latest.json" --endpoint-url "$AWS_ENDPOINT_URL_S3"

mkdir -p "$HOME/.kingdom"
date -u +%FT%TZ > "$HOME/.kingdom/loom-snapshot.last"
echo "$(date -u +%FT%TZ) shipped → s3://${BUCKET}/loom/v0/daily/${DATE}/"
