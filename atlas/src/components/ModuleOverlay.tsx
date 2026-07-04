import { useCallback, useEffect, useMemo, useRef } from "react";
import { MODULES } from "../atlas.manifest";
import { roleOf, SEAM } from "../lib/weave";
import { useBodyLock } from "../lib/hooks";
import { hasMarker } from "../lib/markers";
import { SOURCES } from "../sources";
import CodePane from "./CodePane";

interface Props {
  moduleId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export default function ModuleOverlay({ moduleId, onSelect, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  useBodyLock(true);

  const idx = MODULES.findIndex((m) => m.id === moduleId);
  const mod = MODULES[idx];
  const prev = MODULES[(idx - 1 + MODULES.length) % MODULES.length];
  const next = MODULES[(idx + 1) % MODULES.length];
  const seam = roleOf(mod.id);
  const c = SEAM[seam];

  const related = useMemo(
    () =>
      mod.relatesTo
        .map((r) => MODULES.find((m) => m.id === r))
        .filter((m): m is (typeof MODULES)[number] => Boolean(m)),
    [mod],
  );

  // Markers not found in ANY of this module's files: still honoured, once,
  // as standalone doctrine. Never dropped, never an error.
  const unmatched = useMemo(() => {
    const all = mod.sources.map((s) => SOURCES[s] ?? "").join("\n");
    return mod.loadBearing.filter((lb) => !hasMarker(all, lb.marker));
  }, [mod]);

  // Remember & restore focus around the modal lifecycle.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement;
    const t = window.setTimeout(() => panelRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(t);
      restoreRef.current?.focus?.();
    };
  }, []);

  // Scroll the reader to top whenever the module changes.
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
    panelRef.current?.focus();
  }, [moduleId]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className={`overlay overlay--${seam}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${mod.title} — ${mod.subtitle}`}
      onKeyDown={onKeyDown}
    >
      <div className="overlay__scrim" onClick={onClose} aria-hidden="true" />

      <div className="overlay__panel" ref={panelRef} tabIndex={-1}>
        <div className="overlay__rail" aria-hidden="true">
          <span className="overlay__rail-thread" style={{ background: c.stroke }} />
        </div>

        <header className="overlay__head">
          <div className="overlay__crumbs">
            <button className="ghost-btn" onClick={onClose}>
              ← the weave
            </button>
            <span className={`seam-tag seam-tag--${seam}`}>
              <span className="seam-tag__dot" style={{ background: c.stroke }} />
              {SEAM[seam].name}
            </span>
          </div>

          <h2 className="overlay__title display">{mod.title}</h2>
          <p className="overlay__subtitle">{mod.subtitle}</p>
          <p className="overlay__idea">{mod.idea}</p>
        </header>

        <div className="overlay__body">
          <div className="doctrine">
            <h3 className="minor-head">Why it is shaped this way</h3>
            {mod.doctrine.map((p, i) => (
              <p key={i} className="doctrine__p">
                {p}
              </p>
            ))}

            {related.length > 0 && (
              <div className="relates">
                <span className="relates__label">Woven to</span>
                <div className="relates__chips">
                  {related.map((r) => (
                    <button
                      key={r.id}
                      className={`chip chip--${roleOf(r.id)}`}
                      onClick={() => onSelect(r.id)}
                    >
                      {r.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="doctrine__codes">
            <h3 className="minor-head">
              The real code
              <span className="minor-head__note">
                imported straight from the sovereign node
              </span>
            </h3>
            {mod.sources.map((spec) => {
              const code = SOURCES[spec];
              if (!code) {
                return (
                  <p key={spec} className="codepane__missing">
                    Source not bundled: {spec}
                  </p>
                );
              }
              return (
                <CodePane
                  key={spec}
                  specifier={spec}
                  code={code}
                  loadBearing={mod.loadBearing}
                />
              );
            })}

            {unmatched.length > 0 && (
              <div className="marginalia">
                <h4 className="marginalia__head">Doctrine woven through this module</h4>
                <ul>
                  {unmatched.map((n, i) => (
                    <li key={i}>
                      <span className="marginalia__marker">{n.marker}</span>
                      <span className="marginalia__note">{n.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <footer className="overlay__foot">
          <button className="pager" onClick={() => onSelect(prev.id)}>
            <span className="pager__dir">← previous thread</span>
            <span className="pager__name">{prev.title}</span>
          </button>
          <button className="pager pager--next" onClick={() => onSelect(next.id)}>
            <span className="pager__dir">next thread →</span>
            <span className="pager__name">{next.title}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
