import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import basicSsl from "@vitejs/plugin-basic-ssl"
import framer from "vite-plugin-framer"

// https://vitejs.dev/config/
// 
// KEY INSIGHT from Framer docs:
// The plugin iframe runs on https://localhost:5173 (same origin as the dev server).
// To reach the export server (port 4000) without HTTPS cert issues, we use Vite's
// built-in proxy — all /api/* requests are forwarded server-side (no browser CORS/TLS).
export default defineConfig({
  plugins: [
    react(),
    basicSsl(),
    framer(),
  ],
  server: {
    port: 5173,
    https: {},
    proxy: {
      // All fetch("/api/...") calls in the plugin are proxied to http://localhost:4000
      // This sidesteps the HTTPS mixed-content problem entirely.
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        secure: false,
      },
    },
  },
})
