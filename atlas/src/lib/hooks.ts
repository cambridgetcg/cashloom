import { useEffect, useRef, useState } from "react";
import { getHighlighter, type HighlighterCore } from "./shiki";

/** Resolve the shared highlighter once; components re-render when ready. */
export function useHighlighter(): HighlighterCore | null {
  const [hl, setHl] = useState<HighlighterCore | null>(null);
  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((h) => {
        if (alive) setHl(h);
      })
      .catch(() => {
        /* fall back to plain monospace — never break the page */
      });
    return () => {
      alive = false;
    };
  }, []);
  return hl;
}

/** Reveal-on-scroll: returns a ref and whether it has entered the viewport. */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.14, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, shown };
}

/** True when the user asked for reduced motion; reacts to changes. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Track which section id is currently in view for nav highlighting. */
export function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: [0, 0.25, 0.5] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

/** Lock body scroll while a modal/overlay is open. */
export function useBodyLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}
