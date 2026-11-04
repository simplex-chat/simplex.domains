import { expect, test, type Page } from "@playwright/test"
import { readFileSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, normalize } from "node:path"
import { MODE_META, type Mode } from "../src/mode.ts"

// The production build, which has the worker, served by this spec as the store service serves it.
test.skip(!process.env.BASE_URL, "needs the production build in dist/, which runs with BASE_URL")

const DIST = new URL("../dist/", import.meta.url).pathname
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" }
// past the 3 s the worker once waited before it served its kept shell
const SLOW_ANSWER_MS = 4000

// The service's names site: the shell from memory with its mode meta rewritten in codes mode, and otherwise the
// pristine file with Last-Modified, which Warp's responseFile answers If-Modified-Since against with a 304.
class Service {
  mode: Mode = "open"
  delayMs = 0
  private server: Server | null = null
  private port = 0

  get url(): string { return `http://127.0.0.1:${this.port}` }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const path = normalize(new URL(req.url ?? "/", "http://x").pathname)
      const file = join(DIST, path === "/" ? "index.html" : path)
      const answer = () => {
        if (path.startsWith("/api/")) return void res.writeHead(404, { "Cache-Control": "no-store" }).end()
        let stat
        try { stat = statSync(file) } catch { return void res.writeHead(404).end() }
        const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" }
        if (file.endsWith("/index.html") && this.mode === "codes") {
          const shell = readFileSync(file, "utf8").replace(`name="${MODE_META}" content="open"`, `name="${MODE_META}" content="codes"`)
          return void res.writeHead(200, headers).end(shell)
        }
        const modified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000)
        const since = req.headers["if-modified-since"]
        if (since && new Date(since) >= modified) return void res.writeHead(304, headers).end()
        res.writeHead(200, { ...headers, "Last-Modified": modified.toUTCString() }).end(readFileSync(file))
      }
      if (this.delayMs) setTimeout(answer, this.delayMs)
      else answer()
    })
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve))
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  // the service stops, and its port refuses connections until it starts again
  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const pageMode = (page: Page) => page.locator(`meta[name="${MODE_META}"]`).getAttribute("content")

// A reader's page, opened once the service is in the given mode, and controlled by the worker it installed then.
async function installedIn(page: Page, service: Service, mode: Mode): Promise<void> {
  service.mode = mode
  await page.goto(service.url)
  await page.evaluate(() => navigator.serviceWorker.ready)
  const controlled = await page.reload()
  expect(controlled?.fromServiceWorker(), "the page loads through its worker").toBe(true)
  expect(await pageMode(page)).toBe(mode)
}

let service: Service
test.beforeEach(async () => {
  service = new Service()
  await service.start()
})
test.afterEach(async () => {
  await service.stop()
})

test("a reload shows the mode the service switched to, while the service answers slowly after its restart", async ({ page }) => {
  test.setTimeout(60_000)
  await installedIn(page, service, "codes")
  await service.stop()
  service.mode = "open"
  service.delayMs = SLOW_ANSWER_MS
  await service.start()
  await page.reload()
  expect(await pageMode(page), "the service's answer, not the shell the worker kept").toBe("open")
  service.mode = "codes"
  await page.reload()
  expect(await pageMode(page)).toBe("codes")
})

test("while the service is down, the page opens in the last mode the service gave, not the one it had at install", async ({ page }) => {
  await installedIn(page, service, "codes")
  await service.stop()
  service.mode = "open"
  await service.start()
  await page.reload()
  expect(await pageMode(page)).toBe("open")
  await service.stop()
  const offline = await page.reload()
  expect(offline?.fromServiceWorker(), "the kept shell").toBe(true)
  expect(await pageMode(page), "the shell the worker kept from the service's last answer").toBe("open")
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
})
