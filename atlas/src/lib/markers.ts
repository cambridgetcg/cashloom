/** Return the 0-based line index whose text contains `marker` (case-insensitive), or -1. */
export function matchLine(lines: string[], marker: string): number {
  const needle = marker.toLowerCase();
  return lines.findIndex((l) => l.toLowerCase().includes(needle));
}

/** True if `marker` appears anywhere in `code` (case-insensitive). */
export function hasMarker(code: string, marker: string): boolean {
  return code.toLowerCase().includes(marker.toLowerCase());
}
