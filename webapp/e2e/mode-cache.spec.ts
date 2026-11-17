import { chromium, expect, test, type Page } from "@playwright/test"
import { readFileSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, normalize } from "node:path"
import type { Mode } from "../src/mode.ts"

// The production build, which has the worker, served by this spec as the store service serves it.
test.skip(!process.env.BASE_URL, "needs the production build in dist/, which runs with BASE_URL")

const DIST = new URL("../dist/", import.meta.url).pathname
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" }
// past the 3 s the worker once waited before it served its kept shell
const SLOW_ANSWER_MS = 4000
// long enough for a page to have checked its mode and loaded again, had it gone on doing so
const SETTLE_MS = 3000
// long enough for a load the check started to have finished
const RELOAD_MS = 1000
const OTHER: Record<Mode, Mode> = { open: "codes", codes: "open" }
// Playwright turns Chromium's back/forward cache off by its flag, and its headless shell has none; Firefox's and WebKit's stay off
const CHROMIUM_WITH_BFCACHE = { channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] }

// The service's names site: its mode at /api/config, and each file as built with Last-Modified, which Warp's
// responseFile answers If-Modified-Since against with a 304.
class Service {
  mode: Mode = "open"
  delayMs = 0
  // the mode turns over with each config it answers, as a service restarted again and again
  flips = false
  private server: Server | null = null
  private port = 0

  get url(): string { return `http://127.0.0.1:${this.port}` }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const path = normalize(new URL(req.url ?? "/", "http://x").pathname)
      const file = join(DIST, path === "/" ? "index.html" : path)
      const answer = () => {
        if (path === "/api/config") {
          const mode = this.mode
          if (this.flips) this.mode = OTHER[mode]
          return void res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ mode, stripePublishableKey: null }))
        }
        if (path.startsWith("/api/")) return void res.writeHead(404, { "Cache-Control": "no-store" }).end()
        let stat
        try { stat = statSync(file) } catch { return void res.writeHead(404).end() }
        const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" }
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

const nameField = (page: Page) => page.getByLabel("Name", { exact: true })
// the mode the home was drawn in: in codes mode its search waits for a code
async function pageMode(page: Page): Promise<Mode> {
  await expect(nameField(page)).toBeVisible()
  return (await nameField(page).isDisabled()) ? "codes" : "open"
}
const expectMode = (page: Page, mode: Mode) => mode === "codes" ? expect(nameField(page)).toBeDisabled() : expect(nameField(page)).toBeEnabled()

// the tab coming back into view, as a reader switching back to it; headless browsers keep every tab in view
const becomeVisible = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
// the page's own check of the service's mode, answered
const modeChecked = (page: Page) => page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config")

// Every document the page loads from now on, counted as it fires load.
function loads(page: Page): { count: number } {
  const seen = { count: 0 }
  page.on("load", () => { seen.count += 1 })
  return seen
}

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
  expect(await pageMode(page), "the service's answer, not the one the worker kept").toBe("open")
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
  expect(await pageMode(page), "the worker's copy of the service's last answer").toBe("open")
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  // the page's check finds no service, so the page offline stays as it opened
  const seen = loads(page)
  await becomeVisible(page)
  await page.waitForTimeout(SETTLE_MS)
  expect(seen.count).toBe(0)
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
})

test("a tab open across the switch loads again in the service's mode as it comes back into view, both ways", async ({ page }) => {
  await installedIn(page, service, "open")
  service.mode = "codes"
  await becomeVisible(page)
  await expect(nameField(page), "the search waits for a code").toBeDisabled()
  service.mode = "open"
  await becomeVisible(page)
  await expect(nameField(page)).toBeEnabled()
})

test("a page restored by Back loads again in the service's mode", async ({ page, browserName }) => {
  if (browserName !== "chromium") {
    await installedIn(page, service, "codes")
    service.mode = "open"
    // the restore's own event stands for the cache Playwright keeps off in Firefox and WebKit
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expectMode(page, "open")
    return
  }
  const browser = await chromium.launch(CHROMIUM_WITH_BFCACHE)
  try {
    const restoring = await browser.newPage()
    await installedIn(restoring, service, "codes")
    const restored: boolean[] = []
    restoring.on("console", (m) => { if (m.text().startsWith("pageshow ")) restored.push(m.text() === "pageshow true") })
    await restoring.evaluate(() => addEventListener("pageshow", (e) => console.log(`pageshow ${e.persisted}`)))
    service.mode = "open"
    await restoring.goto(`${service.url}/robots.txt`)
    // a restored page fires no load
    await restoring.goBack({ waitUntil: "commit" })
    await expectMode(restoring, "open")
    expect(restored, "Chromium restored the page from its back/forward cache").toEqual([true])
  } finally {
    await browser.close()
  }
})

test("a name typed and not searched is kept: the page loads again only as the reader leaves the screen", async ({ page }) => {
  await installedIn(page, service, "open")
  await nameField(page).fill("halftyped")
  service.mode = "codes"
  const checked = modeChecked(page)
  await becomeVisible(page)
  await checked
  await page.waitForTimeout(SETTLE_MS)
  await expect(nameField(page)).toHaveValue("halftyped")
  expect(await pageMode(page)).toBe("open")
  const seen = loads(page)
  await page.locator("body > header").getByRole("link", { name: "Check your code" }).click()
  await expect(page.getByRole("heading", { name: "Check your code" })).toBeVisible()
  expect(seen.count, "leaving the screen loads the page again, in the service's mode").toBe(1)
  await page.goBack()
  await expectMode(page, "codes")
})

test("no reload loop: a service whose mode flips with every answer loads the page again at most once", async ({ page }) => {
  await installedIn(page, service, "open")
  service.flips = true
  const seen = loads(page)
  await page.goto(service.url)
  await page.waitForTimeout(SETTLE_MS)
  expect(seen.count, "the page and at most one load again").toBeLessThanOrEqual(2)
  for (let i = 0; i < 3; i++) {
    await Promise.all([modeChecked(page), becomeVisible(page)])
    await page.waitForTimeout(RELOAD_MS)
  }
  await page.waitForTimeout(SETTLE_MS)
  expect(seen.count, "each return to the tab loads it again at most once").toBeLessThanOrEqual(5)
})

test("no reload while the service keeps answering the page's own mode", async ({ page }) => {
  await installedIn(page, service, "codes")
  const seen = loads(page)
  for (let i = 0; i < 3; i++) {
    const checked = modeChecked(page)
    await becomeVisible(page)
    await checked
  }
  await page.waitForTimeout(SETTLE_MS)
  expect(seen.count).toBe(0)
  expect(await pageMode(page)).toBe("codes")
})
