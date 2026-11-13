// The dev server's index.html in the mock's mode, as the service rewrites the page in its own.
import type { Plugin } from "vite"
import { type Mode, MODE_META, modeOf } from "../src/mode.ts"

const OPEN_META = `<meta name="${MODE_META}" content="open">`
// the dev server answers the page in open mode when the mock does not answer in this time
const MODE_READ_MS = 1000

export const withMode = (html: string, mode: Mode) => html.replace(OPEN_META, `<meta name="${MODE_META}" content="${mode}">`)

async function mockMode(mock: string): Promise<Mode> {
  try {
    const res = await fetch(`${mock}/control/mode`, { signal: AbortSignal.timeout(MODE_READ_MS) })
    return modeOf(res.ok ? ((await res.json()) as { mode?: string }).mode : null)
  } catch {
    return "open"
  }
}

export const modeFromMock = (mock: string): Plugin => ({
  name: "names-mode-from-mock",
  apply: "serve",
  transformIndexHtml: async (html) => withMode(html, await mockMode(mock)),
})
