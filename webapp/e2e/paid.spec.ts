import { expect, test } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import { channelLink, contactLink, control, registrationOf, searchName, shot, startOrder, uniqueLabel, waitRegistered } from "./helpers.ts"

test("a Bitcoin order pays in two parts, registers on chain with its links, and the code owns it", async ({ page, request }) => {
  const label = uniqueLabel("btc")
  const contact = contactLink("A1")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc", contact, shots: "N3" })
  expect(ownerCode).toMatch(/^SN-/)

  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(page.locator(".pay-body .qr svg")).toBeVisible()
  await expect(page.getByText(/Rate held \d+:\d\d/)).toBeVisible()
  await shot(page, "N4-bitcoin")

  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText("Part of the payment arrived")).toBeVisible()
  await shot(page, "N4a-partial")

  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible()
  await expect(page.locator(".stage.done", { hasText: "Committed" })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(".countdown b")).toHaveText(/\d+:\d\d/)
  await shot(page, "N6a-waiting")
  // on a public chain each transaction and the owner link to its block explorer
  const onMainnet = "**/api/invoice/**"
  await page.route(onMainnet, async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    await route.fulfill({ response, json: { ...json, registration: { ...json.registration, chainId: 1 } } })
  })
  await page.reload()
  await expect(page.locator(".txs a").first()).toHaveAttribute("href", /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/)
  await expect(page.locator(".txs a").last()).toHaveAttribute("href", /^https:\/\/etherscan\.io\/address\/0x[0-9a-fA-F]{40}$/)
  // a long poll the rewrite holds is answered before it goes, or the page would wait on it
  await page.unrouteAll({ behavior: "wait" })
  await waitRegistered(page, label)
  await expect(page.getByTestId("owner-code")).toHaveText(ownerCode)
  await shot(page, "N7-registered")

  const answer = await searchName(request, label)
  expect(answer.status).toBe("registered")
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
  expect(answer.records).toEqual({ contact, channel: "" })
  const registrationId = await registrationOf(request, invoiceId)

  await page.goto(`/#/?name=${label}`)
  await expect(page.locator(".result .entity")).toContainText("Contact A1Y8m3")
  await expect(page.locator(".result .chip", { hasText: "Yours" })).toBeVisible()
  await shot(page, "N2a-taken-own")

  // edit links: add a channel, signed in the page, sent by the mock's relayer
  await page.goto(`/#/edit/${registrationId}`)
  await expect(page.getByLabel("Address")).toHaveValue(contact)
  const channel = channelLink("B2")
  await page.getByLabel("Channel").fill(channel)
  await expect(page.locator(".link-field").nth(1).locator(".entity")).toBeVisible()
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  // Save stays off with nothing left to save, so focus goes to the answer below it, which stays in view
  const saved = page.locator(".alert", { hasText: "Links saved" })
  await expect(saved).toBeFocused()
  await expect(saved).toBeInViewport()
  await shot(page, "N12b-edit-links")
  expect((await searchName(request, label)).records).toEqual({ contact, channel })

  // a rate-limited edit keeps Save off for the wait it was given, whatever is typed meanwhile
  await page.route("**/api/name/records", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByLabel("Address").fill("")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await page.getByLabel("Address").fill(contact)
  await page.getByLabel("Address").fill("")
  await expect(page.getByRole("button", { name: "Save links" })).toBeDisabled()
  await page.unroute("**/api/name/records")
  await expect(page.getByRole("button", { name: "Save links" })).toBeEnabled({ timeout: 10_000 })

  // a second edit spends the next resolver nonce
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact: "", channel })

  // links are sent one at a time, so a refusal after the first says which one is on chain
  const nextChannel = channelLink("C3")
  let sent = 0
  await page.route("**/api/name/records", (route) => ++sent === 1 ? route.continue() : route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByLabel("Address").fill(contact)
  await page.getByLabel("Channel").fill(nextChannel)
  await expect(page.locator(".link-field").nth(1).locator(".entity")).toBeVisible()
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.locator("[aria-hidden=true]", { hasText: /^The address was saved; the channel was not\. Try again in/ })).toBeVisible({ timeout: 30_000 })
  await page.unroute("**/api/name/records")
  await expect(page.getByRole("button", { name: "Save links" })).toBeEnabled({ timeout: 10_000 })
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact, channel: nextChannel })

  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Registered")
  await shot(page, "N12-history")
  // a row's links are drawn once its reads answer, so a redraw gives focus back to them when they are
  await row.getByText("Edit links").focus()
  const other = await page.context().newPage()
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await other.goto("/")
  await other.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await expect(page.locator(".row-item", { hasText: code })).toBeVisible()
  await expect(row.getByText("Edit links")).toBeFocused()
  await other.close()
  await row.getByText("Show code").click()
  await expect(page.locator(".modal .code-display")).toHaveText(ownerCode)
})

test("the owner code restores an order in another browser, and a bad code is refused", async ({ page, browser, request }) => {
  const label = uniqueLabel("rest")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "xmr" })
  await expect(page.getByRole("heading", { name: "Pay with Monero" })).toBeVisible()
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByText("Waiting for 1 confirmation")).toBeVisible()
  await shot(page, "N5-confirming")
  // the buying browser goes away before the payment settles, so nothing reveals the name
  await page.close()
  await control(request, `settle/${invoiceId}`)

  const other = await browser.newContext()
  const page2 = await other.newPage()
  await page2.goto(`/?order=${invoiceId}`)
  await expect(page2.getByRole("heading", { name: "The name code is not in this browser" })).toBeVisible({ timeout: 60_000 })
  await shot(page2, "N7b-not-here")
  await page2.getByRole("button", { name: "Enter your name code" }).click()

  await page2.getByLabel("Name code").fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
  await page2.getByRole("button", { name: "Restore" }).click()
  await expect(page2.getByText("This code is not valid")).toBeVisible()
  await shot(page2, "N7c-restore-invalid")

  await page2.getByLabel("Name code").fill(ownerCode.toLowerCase().replaceAll("-", " "))
  await page2.getByRole("button", { name: "Restore" }).click()
  await page2.waitForURL(/\?order=/)
  await waitRegistered(page2, label)
  await expect(page2.getByTestId("owner-code")).toHaveText(ownerCode)
  await other.close()
})

test("a card order waits for Stripe, blocks a second card order meanwhile, then registers", async ({ page, request }) => {
  const label = uniqueLabel("card")
  const { invoiceId } = await startOrder(page, label, { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await shot(page, "N10-card")
  await page.getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await shot(page, "N10b-card-confirming")

  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("second"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText("You have an order waiting to be confirmed")).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled()
  await shot(page, "N3e-open-card-order")
  await page.getByRole("button", { name: "Open the waiting order" }).click()

  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
})

test("a cancelled invoice leads back to its name to order again, and expired invoices are replaced and say what arrived", async ({ page, request }) => {
  const label = uniqueLabel("exp")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  const cancels: string[] = []
  page.on("request", (r) => { if (r.url().endsWith("/cancel")) cancels.push(r.url()) })
  await page.getByText("Cancel this invoice").dblclick()
  await expect(page.getByRole("heading", { name: "Invoice cancelled" })).toBeVisible()
  expect(cancels).toHaveLength(1)
  await shot(page, "N4b-cancelled")

  // nothing is ordered again until the buyer chooses, from the name, how to pay
  await page.getByRole("button", { name: "Order the name again" }).click()
  await expect(page.locator(".result", { hasText: `${label}.simplex` }).getByRole("button", { name: "Register" })).toBeVisible()
  expect(cancels).toHaveLength(1)
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Invoice cancelled")
  const { invoiceId: second } = await startOrder(page, label, { method: "btc" })
  expect(second).not.toBe(invoiceId)
  await control(request, `expire/${second}`)
  await expect(page.getByRole("heading", { name: "Invoice expired" })).toBeVisible()
  await expect(page.getByText("Nothing was received")).toBeVisible()
  await shot(page, "N4c-expired")

  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== second)
  const third = new URL(page.url()).searchParams.get("order")!
  await control(request, `partial/${third}`)
  await control(request, `expire/${third}`)
  await expect(page.getByText(/BTC arrived, which is not the full amount/)).toBeVisible()
  await shot(page, "N4d-expired-partial")

  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` }).first().locator(".chip")).toHaveText(/Invoice (expired|cancelled)/)
})

test("a replaced invoice leads to its new order until a late payment reaches it", async ({ page, browser, request }) => {
  const label = uniqueLabel("late")
  const row = (p: typeof page) => p.locator(".row-item:visible", { hasText: `${label}.simplex` })
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "xmr" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await page.goto(`/?order=${invoiceId}`)
  await page.waitForURL((url) => url.searchParams.get("order") === second)
  await page.goto("/#/names")
  await expect(row(page).locator(".chip")).toHaveText(["Waiting for payment"])

  // a browser restored with the code knows only the new order
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restored.goto("/#/restore")
  await restored.getByLabel("Name code").fill(ownerCode)
  await restored.getByRole("button", { name: "Restore" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)

  // the service has forgotten the old invoice; this browser still knows what replaced it
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.goto(`/?order=${invoiceId}`)
  await page.waitForURL((url) => url.searchParams.get("order") === second)
  await page.unroute(`**/api/invoice/${invoiceId}*`)

  await control(request, `settle/${invoiceId}`)
  for (const p of [page, restored]) {
    await p.goto(`/?order=${invoiceId}`)
    await expect(p.getByRole("heading", { name: "Paid after the invoice closed" })).toBeVisible()
    expect(new URL(p.url()).searchParams.get("order")).toBe(invoiceId)
    await p.goto("/#/names")
    await expect(row(p).locator(".chip")).toHaveText(["Waiting for payment", "Paid late"])
    await expect(row(p).nth(1)).toContainText(`reference ${invoiceId}`)
    await p.goto(`/?order=${invoiceId}`)
    await p.getByRole("button", { name: "Open the new invoice" }).click()
    await p.waitForURL((url) => url.searchParams.get("order") === second)
  }
  await other.close()
})

test("an invoice that received part of its payment and was replaced leads on to the new one once the rest arrives", async ({ page, request }) => {
  const label = uniqueLabel("part")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `partial/${invoiceId}`)
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${invoiceId}`)
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Paid after the invoice closed" })).toBeVisible()
  await page.goto("/#/names")
  await expect(page.locator(".row-item:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Waiting for payment", "Paid late"])
  await page.goto(`/?order=${invoiceId}`)
  await page.getByRole("button", { name: "Open the new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") === second)
})

test("an invoice that closed while its payment was confirming says a payment reached it, on its page and in Your names", async ({ page, request }) => {
  const label = uniqueLabel("late")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `confirming/${invoiceId}`)
  await control(request, `expire/${invoiceId}`)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Invoice expired" })).toBeVisible()
  await expect(page.getByText("A payment did not complete before the invoice closed.")).toBeVisible()
  await shot(page, "N4e-expired-confirming")
  await page.goto("/#/names")
  const row = page.locator(".row-item:visible", { hasText: `${label}.simplex` })
  await expect(row).toContainText("A payment did not complete before the invoice closed")
  await expect(row.locator(".chip")).toHaveText(["Invoice expired"])
  await shot(page, "N12f-history-expired-paid")
})

test("a browser restored before another browser made a new invoice carries on with that invoice", async ({ page, browser, request }) => {
  const label = uniqueLabel("sib")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restored.goto("/#/restore")
  await restored.getByLabel("Name code").fill(ownerCode)
  await restored.getByRole("button", { name: "Restore" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await page.close()

  await restored.goto(`/?order=${second}`)
  await expect(restored.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  // the adopted order carries the service's time of making it, which later searches for a newer order compare against
  const state = await (await request.get("http://127.0.0.1:8099/control/state")).json() as { registrations: { id: string; invoiceId: string; createdAt: string }[] }
  const made = state.registrations.find((r) => r.invoiceId === second)!.createdAt
  const adopted = await restored.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith("simplex-names:order:"))
    .map((k) => JSON.parse(localStorage.getItem(k)!)).find((o: { invoiceId: string }) => o.invoiceId === id), second)
  expect(adopted.createdAt).toBe(made)
  await restored.goto("/#/names")
  await expect(restored.locator(".row-item:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Waiting for payment"])
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await control(request, `settle/${second}`)
  await waitRegistered(restored, label)
  await other.close()
})

test("Cancel this invoice reads as working while its request runs, and as itself again once the request fails", async ({ page }) => {
  await startOrder(page, uniqueLabel("cxl"), { method: "btc" })
  let answer!: () => void
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await page.route("**/cancel", async (route) => {
    await answered
    await route.fulfill({ status: 503, json: { error: "provider_unavailable" } })
  })
  const link = page.locator("a:has(.swap)")
  const hiddenLabel = page.locator(".swap > [aria-hidden=true]")
  await link.click()
  await expect(link).toHaveAccessibleName("Cancelling…")
  await expect(hiddenLabel).toHaveText("Cancel this invoice")
  answer()
  await expect(link).toHaveAccessibleName("Cancel this invoice")
  await expect(hiddenLabel).toHaveText("Cancelling…")
  await expect(hiddenLabel).toHaveCSS("opacity", "0")
})

test("a cancel the service answers with the invoice still open warns not to send more, after a reload too", async ({ page, request }) => {
  const label = uniqueLabel("still")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, "search", { cancelStillOpen: true })
  await page.getByText("Cancel this invoice").click()
  const warning = page.getByText("This invoice was cancelled, but the service still shows it open. Do not send anything more to the address.")
  await expect(warning).toBeVisible()
  await control(request, "search", { cancelStillOpen: false })
  await page.reload()
  await expect(warning).toBeVisible()
  await expect(page.getByText("Cancel this invoice")).toHaveCount(0)
  // money that reached it after the cancel does not make it payable again
  await control(request, `partial/${invoiceId}`)
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: label }).locator(".chip")).toHaveText("Invoice cancelled")

  // a browser without the order's record keeps nothing, so it warns at once
  const fresh = await page.context().browser()!.newContext()
  const stranger = await fresh.newPage()
  const { invoiceId: other } = await startOrder(page, uniqueLabel("still2"), { method: "xmr" })
  await stranger.goto(`/?order=${other}`)
  await control(request, "search", { cancelStillOpen: true })
  await stranger.getByText("Cancel this invoice").click()
  await expect(stranger.getByText("This invoice was cancelled, but the service still shows it open. Do not send anything more to the address.")).toBeVisible()
  await control(request, "search", { cancelStillOpen: false })
  await fresh.close()
})

test("a restored browser that never opened another browser's newer invoice finds it through the code", async ({ page, browser, request }) => {
  const label = uniqueLabel("newer")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restored.goto("/#/restore")
  await restored.getByLabel("Name code").fill(ownerCode)
  await restored.getByRole("button", { name: "Restore" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await restored.goto("/#/")
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${second}`)
  await waitRegistered(page, label)

  // the service has forgotten the old invoice by now; the code still finds the order that replaced it
  await restored.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await restored.unroute(`**/api/invoice/${invoiceId}*`)
  await restored.goto("/#/names")
  await expect(restored.locator(".row-item:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Registered"])
  await other.close()
})

test("a forgotten empty invoice never leads back to the older invoice it replaced", async ({ page, request }) => {
  const label = uniqueLabel("loopb")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  const secondRegistration = await registrationOf(request, second)
  await control(request, `expire/${second}`)
  await control(request, `settle/${invoiceId}`)
  // the service forgets the empty invoice and keeps the late-paid one
  await page.route(`**/api/invoice/${second}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.route("**/api/registration/find", async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { registrations: body.registrations.filter((r: { registrationId: string }) => r.registrationId !== secondRegistration) } })
  })
  await page.goto(`/?order=${second}`)
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("order")).toBe(second)
})

test("a forgotten order whose code's lookup is refused says the link does not work", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("refuse"), { method: "btc" })
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.route("**/api/registration/find", (route) => route.fulfill({ status: 400, json: { error: "bad_request" } }))
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
})

test("a forgotten order whose code's lookup is rate limited waits as asked, then answers", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("limit"), { method: "btc" })
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await control(request, "search", { findLimitSeconds: 2 })
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: "This order could not be loaded" })).toBeVisible()
  // with nothing newer than this order, the lookup ends at the dead link once the limit is over
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible({ timeout: 10_000 })
  await control(request, "search", { findLimitSeconds: 0 })
})

test("an unknown order link says so", async ({ page }) => {
  await page.goto("/?order=nothing-here")
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
  await shot(page, "N11-unknown")
})

test("a card form that does not load says so and offers a new invoice", async ({ page }) => {
  const label = uniqueLabel("nocard")
  const { invoiceId } = await startOrder(page, label, { method: "card" })
  // a configured key makes the page load Stripe.js, which is blocked here
  await page.route(/\/\?order=/, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, body: (await res.text()).replace('name="stripe-publishable-key" content=""', 'name="stripe-publishable-key" content="pk_test_e2e"') })
  })
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.reload()
  await expect(page.getByRole("heading", { name: "The card form did not load" })).toBeVisible()
  await shot(page, "N10a-card-not-loaded")
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  await expect(page.getByRole("heading", { name: "The card form did not load" })).toBeVisible()
})
