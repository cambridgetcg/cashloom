/**
 * The truth layer. Each entry is the ACTUAL source of a sovereign node,
 * imported raw at build time via Vite `?raw`. The keys are the exact
 * specifier strings used in atlas.manifest.ts's `MODULES[].sources`, so a
 * module can look up its own real code by the same string it declares.
 *
 * Because these are static imports of ../../sovereign/src, the atlas can
 * never drift from the code it explains — it renders the code itself.
 */
import s_index from "../../sovereign/src/index.ts?raw";
import s_vault from "../../sovereign/src/vault.ts?raw";
import s_pay from "../../sovereign/src/pay.ts?raw";
import s_senders_types from "../../sovereign/src/senders/types.ts?raw";
import s_evm from "../../sovereign/src/senders/evm.sender.ts?raw";
import s_btc from "../../sovereign/src/senders/btc.sender.ts?raw";
import s_conn_types from "../../sovereign/src/connectors/types.ts?raw";
import s_agenttool from "../../sovereign/src/connectors/agenttool.connector.ts?raw";
import s_sync from "../../sovereign/src/sync.ts?raw";
import s_db from "../../sovereign/src/db.ts?raw";

export const SOURCES: Record<string, string> = {
  "../../sovereign/src/index.ts?raw": s_index,
  "../../sovereign/src/vault.ts?raw": s_vault,
  "../../sovereign/src/pay.ts?raw": s_pay,
  "../../sovereign/src/senders/types.ts?raw": s_senders_types,
  "../../sovereign/src/senders/evm.sender.ts?raw": s_evm,
  "../../sovereign/src/senders/btc.sender.ts?raw": s_btc,
  "../../sovereign/src/connectors/types.ts?raw": s_conn_types,
  "../../sovereign/src/connectors/agenttool.connector.ts?raw": s_agenttool,
  "../../sovereign/src/sync.ts?raw": s_sync,
  "../../sovereign/src/db.ts?raw": s_db,
};

/** A short, human file label derived from a raw-import specifier. */
export function sourceLabel(specifier: string): string {
  const m = specifier.match(/([^/]+\.ts)\?raw$/);
  return m ? m[1] : specifier;
}

/** The repo-relative path a reader could open, derived from the specifier. */
export function sourcePath(specifier: string): string {
  return specifier.replace(/^\.\.\/\.\.\//, "").replace(/\?raw$/, "");
}
