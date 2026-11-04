import { expect } from "@playwright/test"
import { test } from "./helpers.ts"

// The service worker is in the production build only: run with BASE_URL at `npx vite preview`.
test.skip(!process.env.BASE_URL, "needs the production build, as BASE_URL")

test("the production build opens offline: the page, an order's link and Your names, with a note while the network is gone", async ({ page, context }) => {
  const OFFLINE_NOTE = "You are offline. Searches, payments and order updates need the connection."
  await page.goto("/")
  await page.evaluate(() => localStorage.setItem("simplex-names:code:SN6-OFFLINE", JSON.stringify({ code: "SN6-Z6VPA-7YPF0-XN8B4-9S1ZD", minLength: 6, years: 2, addedAt: new Date().toISOString() })))
  // the worker takes no page it did not load, so it is active once the next load comes through it
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect(page.locator(".offline-note")).toBeHidden()
  await context.setOffline(true)
  try {
    const reload = await page.reload()
    expect(reload?.fromServiceWorker()).toBe(true)
    await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: OFFLINE_NOTE })).toBeVisible()
    // the service's answers are never kept: a search offline says it could not check, rather than an old answer
    await page.getByLabel("Name", { exact: true }).fill("offlinename")
    await page.getByLabel("Name", { exact: true }).press("Enter")
    await expect(page.getByText("This name could not be checked")).toBeVisible()
    await page.goto("/?order=abc")
    await expect(page.getByRole("heading", { name: "This order could not be loaded" })).toBeVisible()
    await page.goto("/#/names")
    await expect(page.getByText("SN6-Z6VPA-7YPF0-XN8B4-9S1ZD")).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
  await page.getByRole("link", { name: "SimpleX names" }).click()
  await expect(page.locator(".offline-note")).toBeHidden()
})

test("the production build installs as an app: a manifest whose icons load, and the browser finds nothing missing", async ({ page, request, browserName }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json() as { display: string; start_url: string; icons: { src: string; sizes: string; purpose: string }[] }
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/" })
  expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(["192x192 any", "512x512 any", "512x512 maskable"])
  for (const icon of manifest.icons) expect((await request.get(icon.src)).headers()["content-type"], icon.src).toBe("image/png")
  // only Chromium says whether a page installs
  test.skip(browserName !== "chromium", "installability is Chromium's to tell")
  await page.goto("/")
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  const cdp = await page.context().newCDPSession(page)
  expect((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([])
})
