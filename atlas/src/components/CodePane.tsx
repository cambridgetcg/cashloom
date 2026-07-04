import { useEffect, useMemo, useRef } from "react";
import type { LoadBearing } from "../atlas.manifest";
import { useHighlighter } from "../lib/hooks";
import { LOOM_THEME } from "../lib/shiki";
import { matchLine } from "../lib/markers";
import { sourceLabel, sourcePath } from "../sources";

interface Props {
  specifier: string;
  code: string;
  /** The module's markers; this pane spotlights only the ones it can find. */
  loadBearing: LoadBearing[];
}

/**
 * Renders the REAL sovereign source, token by token, line by line.
 * For each loadBearing marker found (case-insensitively) as a substring of a
 * line in THIS file, that line is spotlit and the note attached beneath it.
 * Markers not present here are simply left for the module to surface once.
 */
export default function CodePane({ specifier, code, loadBearing }: Props) {
  const hl = useHighlighter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstSpotRef = useRef<HTMLDivElement>(null);

  const source = useMemo(() => code.replace(/\n+$/, ""), [code]);
  const lines = useMemo(() => source.split("\n"), [source]);

  const tokenLines = useMemo(() => {
    if (!hl) return null;
    try {
      return hl.codeToTokens(source, {
        lang: "typescript",
        theme: LOOM_THEME.name!,
      }).tokens;
    } catch {
      return null;
    }
  }, [hl, source]);

  const { noteMap, firstSpot } = useMemo(() => {
    const map = new Map<number, LoadBearing[]>();
    let first = -1;
    for (const lb of loadBearing) {
      const idx = matchLine(lines, lb.marker);
      if (idx >= 0) {
        const arr = map.get(idx) ?? [];
        arr.push(lb);
        map.set(idx, arr);
        if (first < 0 || idx < first) first = idx;
      }
    }
    return { noteMap: map, firstSpot: first };
  }, [lines, loadBearing]);

  // Bring the first spotlight into view within the pane, without moving the page.
  useEffect(() => {
    const cont = scrollRef.current;
    const target = firstSpotRef.current;
    if (!cont || !target) return;
    const reduce =
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    const top = target.offsetTop - cont.clientHeight * 0.3;
    cont.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }, [tokenLines, firstSpot]);

  const gutterWidth = String(lines.length).length;

  return (
    <figure className="codepane">
      <figcaption className="codepane__bar">
        <span className="codepane__dot" aria-hidden="true" />
        <span className="codepane__file">{sourceLabel(specifier)}</span>
        <span className="codepane__path">{sourcePath(specifier)}</span>
        <span className="codepane__truth">the real source</span>
      </figcaption>

      <div className="codepane__scroll" ref={scrollRef}>
        <pre className="codepane__pre" aria-label={`Source of ${sourcePath(specifier)}`}>
          <code>
            {lines.map((lineText, i) => {
              const notes = noteMap.get(i);
              const isSpot = Boolean(notes);
              const isFirst = i === firstSpot;
              return (
                <div
                  key={i}
                  className={"cl" + (isSpot ? " cl--spot" : "")}
                  ref={isFirst ? firstSpotRef : undefined}
                >
                  <span
                    className="cl__ln"
                    style={{ width: `${gutterWidth}ch` }}
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <span className="cl__code">
                    {tokenLines && tokenLines[i]
                      ? tokenLines[i].map((t, j) => (
                          <span key={j} style={{ color: t.color }}>
                            {t.content}
                          </span>
                        ))
                      : lineText || "​"}
                  </span>
                  {isSpot && (
                    <span className="cl__ember" aria-hidden="true">
                      load-bearing
                    </span>
                  )}
                  {notes &&
                    notes.map((n, k) => (
                      <aside key={k} className="ember-note">
                        <span className="ember-note__thread" aria-hidden="true" />
                        <p>{n.note}</p>
                      </aside>
                    ))}
                </div>
              );
            })}
          </code>
        </pre>
      </div>
    </figure>
  );
}
