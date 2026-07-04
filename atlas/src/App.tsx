import { useCallback, useEffect, useState } from "react";
import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Weave from "./components/Weave";
import Decisions from "./components/Decisions";
import Roadmap from "./components/Roadmap";
import HowWeBuild from "./components/HowWeBuild";
import ModuleOverlay from "./components/ModuleOverlay";

export default function App() {
  const [openId, setOpenId] = useState<string | null>(null);

  const open = useCallback((id: string) => setOpenId(id), []);
  const close = useCallback(() => setOpenId(null), []);

  // Global Escape to close, as a safety net beyond the dialog handler.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
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
