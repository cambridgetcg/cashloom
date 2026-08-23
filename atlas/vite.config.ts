import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CashLoom is deployed at the origin root. Absolute asset URLs keep client-side
// routes such as /world/ and /onchain/ from resolving bundles beneath the route.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
  },
});
