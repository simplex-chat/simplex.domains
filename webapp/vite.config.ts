/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import { modeFromMock } from "./dev/mode.ts"
import { serviceWorker } from "./sw/plugin.ts"

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8099"
// README.md's production policy, so the e2e tests run with BASE_URL at the preview meet it
const CSP = "default-src 'self'; script-src 'self' 'sha256-i5ar+ITNdQiucbmin4/AN6DAY5LbAWeq3at+RiFoUoY=' 'sha256-lxURZtAGLIPkeIfIfFjl4UIJp4ElJWSbFqE1ktKB8hk=' 'sha256-djvAKNENifE9sLU9+NrLdzdGftMgCwpvCvH/MAbkElY=' https://js.stripe.com https://*.js.stripe.com; frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

export default defineConfig({
  server: { port: 5173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK } },
  preview: { port: 4173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK }, headers: { "Content-Security-Policy": CSP } },
  build: { target: "es2022" },
  plugins: [serviceWorker(), modeFromMock(MOCK)],
  // e2e/ holds Playwright's tests, which need the browser and the dev backend
  test: { include: ["test/**/*.test.ts"] },
})
