/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import { LOCAL } from "./src/config.ts"
import { serviceWorker } from "./sw/plugin.ts"

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8099"
// README.md's production policy, so the e2e tests run with BASE_URL at the preview meet it
const CSP = "default-src 'self'; script-src 'self' 'sha256-i5ar+ITNdQiucbmin4/AN6DAY5LbAWeq3at+RiFoUoY=' 'sha256-lxURZtAGLIPkeIfIfFjl4UIJp4ElJWSbFqE1ktKB8hk=' 'sha256-1Ndcay9CHjgCYZ4KB68lGn4DaXXT+Iu/MO4V6hrX8uU='; "
  + `frame-src ${LOCAL.cardOrigin}; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`

export default defineConfig(({ mode }) => ({
  define: { __MAINNET__: JSON.stringify(mode === "production") },
  server: { port: 5173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK } },
  preview: { port: 4173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK }, headers: { "Content-Security-Policy": CSP } },
  build: { target: "es2022" },
  plugins: [serviceWorker()],
  // e2e/ holds Playwright's tests, which need the browser and the dev backend
  test: { include: ["test/**/*.test.ts"] },
}))
