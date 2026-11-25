import { expect } from "@playwright/test"
import { onStep, startOrder, test, uniqueLabel } from "./helpers.ts"

const FRAMER = "http://127.0.0.2:5998"
const API_ORIGIN = process.env.API_ORIGIN
const SKEW_MS = 20 * 60_000

test("the page in another page's frame draws one line, with a link that opens it in its own tab", async ({ page, baseURL, browserName }) => {
  if (browserName === "chromium") await page.context().grantPermissions(["local-network-access"])
  const url = new URL("/#/names", baseURL).href
  await page.route(`${FRAMER}/**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><iframe src="${url}" width="600" height="400"></iframe>` }))
  await page.goto(`${FRAMER}/`)
  const framed = page.frameLocator("iframe")
  await expect(framed.locator("p.framed")).toHaveText("This page opens only in its own tab. Open it")
  await expect(framed.getByRole("link", { name: "Open it" })).toHaveAttribute("href", url)
  await expect(framed.locator("main, header, input")).toHaveCount(0)
})

test("a build for an API on its own origin orders a name across origins, and reads the service's clock from its Date", async ({ page }) => {
  test.skip(!API_ORIGIN, "needs a build for the dev chain with VITE_API_ORIGIN, served at BASE_URL")
  const asked = new Set<string>()
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) asked.add(new URL(r.url()).origin) })
  const { invoiceId } = await startOrder(page, uniqueLabel("cors"), { method: "btc" })
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  expect([...asked], "every API request to the API's origin").toEqual([API_ORIGIN])
  await page.addInitScript((skew) => {
    const now = Date.now
    Date.now = () => now() + skew
  }, SKEW_MS)
  const reads: number[] = []
  page.on("response", (r) => { if (new URL(r.url()).pathname === `/api/invoice/${invoiceId}`) reads.push(r.status()) })
  await page.reload()
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  expect(reads.slice(0, 2), "refused for its time, then answered at the clock its Date gave").toEqual([400, 200])
})
