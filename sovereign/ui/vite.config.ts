import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is served by the sovereign node itself (same origin). This proxy
// exists only for `bun run dev` convenience against a locally running node.
export default defineConfig({
  plugins: [react()],
  // The SDK reads this exact expression; its default global Core cache would
  // otherwise survive within a pairing realm. Worker termination remains the
  // lifecycle boundary, independent of this build-time option.
  define: { "process.env.DISABLE_GLOBAL_CORE": JSON.stringify("true") },
  worker: { format: "es" },
  server: {
    proxy: { "/api": "http://127.0.0.1:4747" },
  },
});
