import { useCallback, useEffect, useState } from "react";
import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Weave from "./components/Weave";
import Decisions from "./components/Decisions";
import Roadmap from "./components/Roadmap";
import HowWeBuild from "./components/HowWeBuild";
import ModuleOverlay from "./components/ModuleOverlay";

/**
 * The long-form Atlas is its own route chunk. World and Onchain visitors do
 * not need to download or parse the code-story renderer before their first
 * snapshot can paint.
 */
export default function Atlas() {
  const [openId, setOpenId] = useState<string | null>(null);

  const open = useCallback((id: string) => setOpenId(id), []);
  const close = useCallback(() => setOpenId(null), []);

  useEffect(() => {
    document.title = "The Atlas — CashLoom";
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.setAttribute(
        "content",
        "The Atlas — CashLoom's open-source human door. Follow an idea, and the real code that enacts it comes with you.",
      );
  }, []);

  useEffect(() => {
    if (!openId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  return (
    <>
      <a className="skip-link" href="#weave">
        Skip to the weave
      </a>
      <Nav />
      <main>
        <Hero />
        <Weave onOpen={open} />
        <Decisions onOpen={open} />
        <Roadmap />
        <HowWeBuild />
      </main>
      {openId && (
        <ModuleOverlay moduleId={openId} onSelect={open} onClose={close} />
      )}
    </>
  );
}
