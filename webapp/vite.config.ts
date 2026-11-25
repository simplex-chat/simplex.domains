/// <reference types="vitest/config" />
import { createHash } from "node:crypto"
import { defineConfig, loadEnv, type Plugin } from "vite"
import { type Deployment, LOCAL, MAINNET } from "./src/config.ts"
import { serviceWorker } from "./sw/plugin.ts"

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8099"

const siteOf = (mode: string): Deployment => mode === "production" ? MAINNET : { ...LOCAL, apiOrigin: loadEnv(mode, process.cwd(), "VITE_").VITE_API_ORIGIN ?? "" }

const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g
const hashOf = (script: string) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`

export const policyOf = (html: string, site: Deployment) => [
  "default-src 'self'",
  `script-src 'self' ${[...html.matchAll(INLINE_SCRIPT)].map((m) => hashOf(m[1])).join(" ")}`,
  `frame-src ${site.cardOrigin}`,
  `connect-src 'self'${site.apiOrigin ? ` ${site.apiOrigin}` : ""}`,
  "img-src 'self' data:",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

function sitePage(site: Deployment): Plugin {
  return {
    name: "site-page",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const page = html.replace('href="/api/config"', `href="${site.apiOrigin}/api/config"`)
        if (!ctx.bundle) return page
        return page.replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${policyOf(page, site)}">\n<meta name="referrer" content="strict-origin-when-cross-origin">`)
      },
    },
  }
}

export default defineConfig(({ mode }) => ({
  define: { __MAINNET__: JSON.stringify(mode === "production") },
  server: { port: 5173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK } },
  preview: { port: 4173, strictPort: true, proxy: { "/api": MOCK, "/control": MOCK } },
  build: { target: "es2022" },
  plugins: [sitePage(siteOf(mode)), serviceWorker(siteOf(mode).apiOrigin)],
  // e2e/ holds Playwright's tests, which need the browser and the dev backend
  test: { include: ["test/**/*.test.ts"] },
}))
