/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import { serviceWorker } from "./sw/plugin.ts"

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8099"

export default defineConfig({
  server: { port: 5173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK } },
  preview: { port: 4173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK } },
  build: { target: "es2022" },
  plugins: [serviceWorker()],
  // e2e/ holds Playwright's tests, which need the browser and the dev backend
  test: { include: ["test/**/*.test.ts"] },
})
