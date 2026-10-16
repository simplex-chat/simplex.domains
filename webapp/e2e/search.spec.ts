import { expect, test } from "@playwright/test"
import { contactLink, control, savedCode, search, shot, startOrder, uniqueLabel, waitRegistered } from "./helpers.ts"

test.afterEach(async ({ request }) => {
  await control(request, "search", { chainDown: false, limitSeconds: 0, invoiceError: null, cancelStillOpen: false, findLimitSeconds: 0 })
})

test("search answers every kind of name", async ({ page, request }) => {
  await page.goto("/")
  await shot(page, "N1-home")
  await page.getByLabel("Name", { exact: true }).pressSequentially("BaKery")
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bakery")
  await expect(page.getByText("Press")).toBeVisible()
  await shot(page, "N1a-typed")

  await search(page, "abc")
  await expect(page.getByText(/3 letters\. A name has 6 letters or more/)).toBeVisible()
  await shot(page, "N1b-short")
  await search(page, "bad_name")
  await expect(page.getByText(/^Use only a\W+z, 0\W+9 and single hyphens between them\.$/)).toBeVisible()
  await shot(page, "N1c-chars")

  await search(page, "bakery")
  await expect(page.locator(".result .entity")).toHaveCount(2)
  await expect(page.getByText("Alice's Bakery").or(page.getByText("Alice’s Bakery")).first()).toBeVisible()
  await shot(page, "N2a-taken")
  await search(page, "harbour")
  await expect(page.getByText("Registered, and not pointing at any address or channel that we know of yet.")).toBeVisible()
  await shot(page, "N2b-unlinked")
  await search(page, "support")
  await expect(page.locator(".result .chip", { hasText: "Reserved" })).toBeVisible()
  await shot(page, "N2c-reserved")
  await page.getByRole("button", { name: "Contact the SimpleX team" }).click()
  await expect(page.locator(".modal")).toBeVisible()
  await page.keyboard.press("Escape")

  const label = uniqueLabel("free")
  await search(page, label)
  await expect(page.locator(".result .chip", { hasText: "Available" })).toBeVisible()
  await shot(page, "N2-available")

  await control(request, "search", { chainDown: true })
  await search(page, uniqueLabel("down"))
  await expect(page.getByText(/could not be checked/i)).toBeVisible()
  await shot(page, "N2d-unchecked")
  await control(request, "search", { chainDown: false, limitSeconds: 30 })
  await search(page, uniqueLabel("lim"))
  await expect(page.locator("b[aria-hidden=true]", { hasText: /Try again in \d+ seconds/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Search" })).toBeDisabled()
  await shot(page, "N2e-rate-limited")
})

test("the checkout explains every refusal and keeps the order", async ({ page, request }) => {
  const label = uniqueLabel("ref")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const pay = async () => {
    await page.getByRole("button", { name: "Continue" }).click()
    await savedCode(page)
    await page.getByRole("button", { name: "Continue to payment" }).click()
  }

  await page.getByLabel("Address").fill("https://smp8.simplex.im/c#notacontact")
  await expect(page.getByText("This is a channel link: paste it in the Channel field.")).toBeVisible()
  await shot(page, "N3g-link-wrong-kind")
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await page.getByLabel("Address").fill(contactLink("R1"))
  await expect(page.locator(".link-field .entity")).toBeVisible()

  await control(request, "search", { invoiceError: "provider_unavailable" })
  await pay()
  await expect(page.getByText("Bitcoin is temporarily unavailable")).toBeVisible()
  await shot(page, "N3a-method-unavailable")
  await page.locator(".method", { hasText: "Monero" }).click()

  await control(request, "search", { invoiceError: "rate_limited" })
  await pay()
  await expect(page.getByRole("heading", { name: "Too many attempts" })).toBeVisible()
  await shot(page, "N3c-rate-limited")
  await page.goto("/#/checkout")

  await control(request, "search", { invoiceError: "internal" })
  await pay()
  await expect(page.getByRole("heading", { name: "That did not go through" })).toBeVisible()
  await shot(page, "N3d-failed")
  // Try again sends the same order again, which meets the next refusal
  await control(request, "search", { invoiceError: "catalog_changed" })
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "The price changed" })).toBeVisible()
  await shot(page, "N3b-price-changed")
})

test("without storage the page warns that the code is kept nowhere else", async ({ browser, request }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError") } })
  })
  const page = await context.newPage()
  const label = uniqueLabel("nos")
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText("This browser will not keep your name code")).toBeVisible()
  await shot(page, "N3f-no-storage")
  await page.goto("/")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await expect(page.getByText("This code could not be saved in this browser")).toBeVisible()
  await shot(page, "N7a-not-saved")
  await context.close()
})

test("the menu opens on a phone, and the trademark page answers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByLabel("Menu").click()
  await expect(page.getByRole("link", { name: "Search" })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Your names" })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("link", { name: "Your names" })).toBeHidden()
  await expect(page.getByLabel("Menu")).toBeFocused()
  await page.getByLabel("Name", { exact: true }).fill("bakery")
  await expect(page.getByText("or Search")).toBeHidden()
  await page.getByLabel("Menu").click()
  await page.screenshot({ path: "screenshots/N0-phone-menu.png" })
  await page.getByRole("link", { name: "Trademark owners" }).click()
  await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
  await shot(page, "T1-trademarks")
})

test("without storage two expired invoices of one order do not lead to each other", async ({ browser, request }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError") } })
  })
  const page = await context.newPage()
  const { invoiceId } = await startOrder(page, uniqueLabel("loop"), { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `expire/${second}`)
  await expect(page.getByRole("heading", { name: "Invoice expired" })).toBeVisible()
  // a redirect loop would move the page off this invoice within a poll or two
  await page.waitForTimeout(3000)
  expect(new URL(page.url()).searchParams.get("order")).toBe(second)
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toBeEnabled()
  await context.close()
})

test("a new invoice for a method that is unavailable says so and offers another way", async ({ page, request }) => {
  const label = uniqueLabel("unav")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await control(request, "search", { invoiceError: "provider_unavailable" })
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await expect(page.getByText("Bitcoin is unavailable right now")).toBeVisible()
  await page.getByRole("link", { name: "order the name again" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(label)
})

test("a double click acts once, whatever the redrawn page puts under the pointer", async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 900 })
  await search(page, uniqueLabel("dbl"))
  await page.getByRole("button", { name: "Register" }).dblclick()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(page.locator(".method.on")).toContainText("Bitcoin")
  await page.getByRole("button", { name: "Continue" }).dblclick()
  await expect(page.getByRole("heading", { name: "Save your name code" })).toBeVisible()
  await expect(page.getByRole("checkbox", { name: "I have saved my code" })).not.toBeChecked()
  await page.getByText("Check a code").dblclick()
  await expect(page.getByRole("dialog")).toBeVisible()
})

test("the phone menu closes on Escape or a click outside, wherever focus went", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.getByLabel("Menu").click()
  for (let i = 0; i < 7; i++) await page.keyboard.press("Tab")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("link", { name: "Your names" })).toBeHidden()
  await page.getByLabel("Menu").click()
  await page.locator(".hero h1").click()
  await expect(page.getByRole("link", { name: "Your names" })).toBeHidden()
})

test("restore waits out a rate limit on finding a code's orders", async ({ page, request }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("rlim"), { method: "btc" })
  await control(request, "search", { findLimitSeconds: 3 })
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill(ownerCode)
  await page.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled()
  // a screen reader hears the wait once, from a still copy; the countdown itself is hidden from it
  await expect(page.locator(".sr-only", { hasText: "Your code is fine. Try again in 3 seconds." })).toHaveCount(1)
  await expect(page.locator(".alert span[aria-hidden=true]")).toBeVisible()
  // typing meanwhile does not shorten the wait
  await page.getByLabel("Name code").press("End")
  await page.getByLabel("Name code").press("Space")
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Restore" })).toBeEnabled({ timeout: 10_000 })
  await page.getByRole("button", { name: "Restore" }).click()
  await page.waitForURL(/\?order=/)
})

test("a link from the app with a damaged wallet says it does not work", async ({ page }) => {
  await page.goto("/#/?name=bakery&owner=0x123")
  await expect(page.getByRole("heading", { name: "This link from SimpleX does not work" })).toBeVisible()
  await page.getByRole("link", { name: "Search here" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bakery")
  await expect(page.getByText("Opened from SimpleX.")).toHaveCount(0)
})

test("a search link's name is shown folded to lower case", async ({ page }) => {
  await page.goto("/#/?name=Harbour.SIMPLEX")
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("harbour")
})

test("a rate limit answered by a proxy pauses search like the service's own", async ({ page }) => {
  await page.route("**/api/name/**", (route) => route.fulfill({ status: 429, headers: { "retry-after": "20" }, contentType: "text/html", body: "<html>Too Many Requests</html>" }))
  await search(page, uniqueLabel("proxy"))
  await expect(page.locator("b[aria-hidden=true]", { hasText: /Try again in \d+ seconds/ })).toBeVisible()
})

