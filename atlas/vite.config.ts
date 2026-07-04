import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" makes the built dist portable: it opens by double-clicking
// dist/index.html locally, and deploys to any static host or subpath
// (Cloudflare Pages / GitHub Pages) without rewriting asset URLs.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
  },
});
