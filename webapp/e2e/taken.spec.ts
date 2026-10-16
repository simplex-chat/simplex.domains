import { type APIRequestContext, expect, test } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import { control, REGISTRATION_MS, registrationOf, searchName, shot, startOrder, uniqueLabel, waitRegistered } from "./helpers.ts"

test("a name taken first moves the paid order to another name, owned by the same code", async ({ page, request }) => {
  const label = uniqueLabel("tk")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await shot(page, "N8-taken")

  await page.getByRole("button", { name: "Choose another name" }).click()
  await expect(page.getByText(/Your payment is kept: \$100\.00/)).toBeVisible()
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await page.getByRole("button", { name: "Use this code" }).click()
  await expect(page.locator(".verdict.bad")).toContainText("Your paid order covers the name you move it to; no code is needed.")
  await page.getByLabel("Close").click()
  const next = uniqueLabel("tk2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Covered by your payment")).toBeVisible()
  await shot(page, "N8a-another-name")
  // a rate-limited move holds its button for the wait
  await page.route("**/name", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }) : route.continue())
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Register with your payment" })).toBeDisabled()
  // searching again during the wait says searching is paused, rather than sending anything
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Searching is paused until then")).toBeVisible()
  await page.unroute("**/name")
  await expect(page.getByText("Searching is paused until then")).toHaveCount(0, { timeout: 10_000 })
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await page.waitForURL(/\?order=/)
  await waitRegistered(page, next)
  const answer = await searchName(request, next)
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
})

test("a name taken first can become a code instead, kept under Your names", async ({ page, request }) => {
  const label = uniqueLabel("tc")
  const { invoiceId } = await startOrder(page, label, { method: "xmr" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await page.getByRole("button", { name: "Take a code" }).click()
  await expect(page.getByRole("heading", { name: "Here is a code instead" })).toBeVisible()
  const code = (await page.locator(".status .code-display").textContent())!.trim()
  expect(code).toMatch(/^SN8-/)
  await shot(page, "N8b-code-instead")

  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: code }).locator(".chip")).toHaveText("Unused")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Code taken")
})

test("a failed registration is retried without paying again, and another tab follows the retry", async ({ page, request }) => {
  const label = uniqueLabel("fl")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `fail/${await registrationOf(request, invoiceId)}`)
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 60_000 })
  await shot(page, "N9-failed")
  const other = await page.context().newPage()
  await other.goto(`/?order=${invoiceId}`)
  await expect(other.getByRole("heading", { name: "Paid, not registered" })).toBeVisible()
  // a rate-limited retry holds its button for the wait
  await page.route("**/retry", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByRole("button", { name: "Try again" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toBeDisabled()
  await page.unroute("**/retry")
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled({ timeout: 10_000 })
  // a keyboard user is back on the button once the wait is over
  await expect(page.getByRole("button", { name: "Try again" })).toBeFocused()
  await page.getByRole("button", { name: "Try again" }).click()
  // the button is gone from the redrawn page, so focus goes to its heading at once
  await expect(page.locator("main h1")).toBeFocused({ timeout: 2_000 })
  await expect(other.getByRole("heading", { name: "Paid, not registered" })).toHaveCount(0)
  await waitRegistered(page, label)
  await waitRegistered(other, label)
})

// a chain that fails each transaction before it goes out, as an RPC provider down for a while
const STATE_URL = "http://127.0.0.1:8099/control/state"
const phaseOf = async (request: APIRequestContext, invoiceId: string) =>
  ((await (await request.get(STATE_URL)).json()) as { registrations: { invoiceId: string; phase: string }[] }).registrations.find((r) => r.invoiceId === invoiceId)!.phase

test("a chain that sends nothing for a moment keeps the order where it was, then registers it", async ({ page, request }) => {
  const label = uniqueLabel("ns")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: 12 })
    await control(request, `settle/${invoiceId}`)
    await page.waitForTimeout(6000)
    // tried again every few seconds, the commit neither fails nor goes back to the queue
    expect(await phaseOf(request, invoiceId)).toBe("committing")
    await expect(page.locator(".stage.active", { hasText: "Committing" })).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await waitRegistered(page, label)
})

test("a chain that sends nothing for over a minute fails the order in plain words, and Try again sends it", async ({ page, request }) => {
  test.setTimeout(240_000)
  const label = uniqueLabel("nd")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: 120 })
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText("The blockchain did not answer")).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await page.getByRole("button", { name: "Try again" }).click()
  await waitRegistered(page, label)
})

test("a late payment to a replaced invoice is kept by a restored browser after the order moved to another name", async ({ page, browser, request }) => {
  const label = `${uniqueLabel("adopt")}-${"long-name".repeat(4)}`
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, "take", { label })
  await control(request, `settle/${second}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: REGISTRATION_MS })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole("button", { name: "Choose another name" }).click()
  const next = uniqueLabel("adopt2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await page.waitForURL(/\?order=/)
  await waitRegistered(page, next)

  const other = await browser.newContext()
  const restored = await other.newPage()
  await restored.goto("/#/restore")
  await restored.getByLabel("Name code").fill(ownerCode)
  await restored.getByRole("button", { name: "Restore" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await control(request, `partial/${invoiceId}`)
  await restored.goto(`/?order=${invoiceId}`)
  await expect(restored.getByText(/BTC arrived, which is not the full amount/)).toBeVisible()
  await restored.goto("/#/names")
  await expect(restored.locator(".row-item:visible", { hasText: `${label}.simplex` })).toContainText("Part of the payment arrived")
  await restored.goto(`/?order=${invoiceId}`)
  await restored.getByRole("button", { name: "Open the new invoice" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await other.close()

  // the name someone else registered, searched at phone width, wraps inside its card
  await page.goto(`/#/?name=${label}`)
  await expect(page.getByText("Taken", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

