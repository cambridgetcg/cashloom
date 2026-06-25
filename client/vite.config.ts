import { defineConfig } from 'vite'
import tailwindcss from "@tailwindcss/vite"
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Split heavy vendor libs into their own chunks so the app code
          // can update without forcing users to re-download everything.
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-redux": [
            "@reduxjs/toolkit",
            "react-redux",
            "redux-persist",
            "redux-persist-transform-encrypt",
          ],
          "vendor-charts": ["recharts", "react-countup"],
          "vendor-forms": ["react-hook-form", "@hookform/resolvers", "zod"],
          "vendor-table": ["@tanstack/react-table", "react-papaparse"],
          "vendor-ui": [
            "@radix-ui/react-avatar",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
          ],
        },
      },
    },
  },
})
