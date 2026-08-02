import { MODULES } from "../atlas.manifest";

export type Seam = "read" | "write" | "core";

/**
 * Each module's role in the read/write separation that is CashLoom's core
 * architectural idea. Read nodes only observe; write nodes move money;
 * core nodes (the Node, the Ledger) are the warp the whole cloth hangs on.
 */
export const ROLE: Record<string, Seam> = {
  "the-node": "core",
  "the-vault": "write",
  pay: "write",
  "the-outbound-seam": "write",
  "the-read-seam": "read",
  sync: "read",
  "the-ledger": "core",
};

export const SEAM: Record<
  Seam,
  { stroke: string; glow: string; soft: string; name: string; gloss: string }
> = {
  read: {
    stroke: "#57b6a9",
    glow: "#7fd8c9",
    soft: "rgba(87,182,169,0.16)",
    name: "Read seam",
    gloss: "observe connected rails · move nothing",
  },
  write: {
    stroke: "#d4502e",
    glow: "#ff7a4d",
    soft: "rgba(212,80,46,0.16)",
    name: "Write / pay seam",
    gloss: "sign locally · broadcast once",
  },
  core: {
    stroke: "#d8a24a",
    glow: "#efc880",
    soft: "rgba(216,162,74,0.14)",
    name: "The warp",
    gloss: "the frame — one process, one file",
  },
};

export function roleOf(id: string): Seam {
  return ROLE[id] ?? "core";
}

export function edgeSeam(a: string, b: string): Seam {
  const ra = roleOf(a);
  const rb = roleOf(b);
  if (ra === "write" && rb === "write") return "write";
  if (ra === "read" && rb === "read") return "read";
  return "core";
}

export interface Edge {
  a: string;
  b: string;
  seam: Seam;
}

/** Undirected, de-duplicated edge list built from every module's relatesTo. */
export function buildEdges(): Edge[] {
  const seen = new Set<string>();
  const edges: Edge[] = [];
  const known = new Set(MODULES.map((m) => m.id));
  for (const m of MODULES) {
    for (const r of m.relatesTo) {
      if (!known.has(r)) continue;
      const [a, b] = [m.id, r].sort();
      const key = `${a}~${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, seam: edgeSeam(a, b) });
    }
  }
  return edges;
}

/** Neighbours of a node (both directions), for hover dimming. */
export function neighbours(id: string, edges: Edge[]): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.a === id) out.add(e.b);
    if (e.b === id) out.add(e.a);
  }
  return out;
}
