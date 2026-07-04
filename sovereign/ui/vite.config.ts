import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is served by the sovereign node itself (same origin). This proxy
// exists only for `bun run dev` convenience against a locally running node.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:4747" },
  },
});
