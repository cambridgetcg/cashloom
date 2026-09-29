import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// CashLoom is deployed at the origin root. Absolute asset URLs keep client-side
// routes such as /world/ and /onchain/ from resolving bundles beneath the route.
export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    fs: {
      // Reuse the shared theme and bundled fonts without exposing private data.
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../ui", import.meta.url)),
        fileURLToPath(new URL("../sovereign/ui/src/assets/fonts", import.meta.url)),
      ],
    },
  },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
  },
});
