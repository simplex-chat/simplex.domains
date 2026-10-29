import { expect, type Page, type Route } from "@playwright/test"
import {
  agreeToTerms, brokenNames, CHAIN, channelLink, contactLink, recordedFrames, recordFrames, CHECKOUT_KEY, checkoutOwnerCode, CODE_HEADING, codeField, control, failedOrder, FIT_SIZES, mockRegistration, onStep, payButton, REGISTRATION_MS, registrationOf, rowFit, savedToReview, search, shot,
  shownCode, startOrder, restoreOrder, test, toCodeStep, toReview, uniqueLabel, useCode, waitRegistered, keepOrder, registrationView,
} from "./helpers.ts"
import { MAX_LABEL_LENGTH } from "../src/names.ts"

test("a second tab's order survives a write from a tab opened earlier", async ({ browser, request }) => {
  const context = await browser.newContext()
  const [early, late] = [await context.newPage(), await context.newPage()]
  await early.goto("/#/code")
  const label = uniqueLabel("tab")
  await startOrder(late, label, { method: "btc" })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  // the page opened before the order keeps the code it checks
  await codeField(early).fill(code)
  await early.getByRole("button", { name: "Find a name" }).and(early.locator(":enabled")).click()
  await early.goto("/#/names")
  await expect(early.locator(".list-row", { hasText: `${label}.simplex` })).toBeVisible()
  await expect(early.locator(".list-row", { hasText: code })).toBeVisible()
  await context.close()
})

test("a slow answer to an earlier search never replaces the latest one", async ({ page }) => {
  const slow = uniqueLabel("slow")
  let delayed = false
  await page.route("**/api/name/**", async (route) => {
    if (!delayed) {
      delayed = true
      await new Promise((r) => setTimeout(r, 2000))
    }
    await route.continue()
  })
  await page.goto("/")
  const name = page.getByLabel("Name", { exact: true })
  await name.fill(slow)
  await name.press("Enter")
  await name.fill("bakery")
  await name.press("Enter")
  await expect(page.locator(".answer .row", { hasText: "Taken" })).toBeVisible()
  await page.waitForTimeout(2500)
  await expect(page.locator(".answer .row", { hasText: "Taken" })).toBeVisible()
  await expect(page.locator(".answer", { hasText: slow })).toHaveCount(0)
})

test("Back from an order page keeps it reachable with Forward", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("back"), { method: "btc" })
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
})

test("Back from the payment lands once on the search, past the checkout's steps, and Forward returns to it", async ({ page }) => {
  const label = uniqueLabel("hist")
  await search(page, label)
  const entries = await page.evaluate(() => history.length)
  await toReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  expect(await page.evaluate(() => history.length), "the checkout's entries gave way to the order").toBe(entries + 1)
  await page.goBack()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(label)
  expect(new URL(page.url()).hash).toBe(`#/?name=${label}`)
  await page.goForward()
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
})

test("a payment method is chosen with the keyboard, as one radio group", async ({ page }) => {
  await search(page, uniqueLabel("key"))
  await toReview(page)
  const method = (m: string) => page.locator(`.method[data-method="${m}"]`)
  await expect(method("btc")).toHaveAttribute("tabindex", "0")
  await expect(method("xmr")).toHaveAttribute("tabindex", "-1")
  await method("btc").focus()
  await page.keyboard.press("ArrowRight")
  await expect(method("xmr")).toHaveAttribute("aria-checked", "true")
  await expect(method("xmr")).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(method("card")).toHaveAttribute("aria-checked", "true")
  await page.keyboard.press("ArrowLeft")
  await expect(method("xmr")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.locator(".method:focus")).toHaveCount(0)
})

test("a card payment settled while its page was closed frees checkout", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("frees"), { method: "card" })
  await onStep(page).getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await page.goto("/")
  await control(request, `settle/${invoiceId}`)
  await search(page, uniqueLabel("next"))
  await toReview(page)
  await expect(page.getByText("You have an order waiting to be confirmed")).toHaveCount(0)
  await expect(payButton(page)).toBeEnabled()
})

test("an unpaid invoice is pointed at from checkout without blocking a new order", async ({ page }) => {
  const first = uniqueLabel("open")
  const { invoiceId } = await startOrder(page, first, { method: "btc" })
  await search(page, uniqueLabel("second"))
  await toReview(page)
  await expect(page.getByText("Another order is waiting for its payment.")).toBeVisible()
  await expect(page.getByRole("link", { name: "Open that order" })).toHaveAttribute("href", `/?order=${invoiceId}`)
  await expect(payButton(page)).toBeEnabled()
  await shot(page, "N3e2-open-invoice")
})

test("the line on another order follows it, saying when it is confirming and going once it is paid", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("follow"), { method: "btc" })
  await search(page, uniqueLabel("after"))
  // the terms left unticked, so focus stays where the review put it
  await toReview(page, false)
  const line = onStep(page).locator(".pay-with > .note")
  await expect(line).toHaveText("Another order is waiting for its payment. Open that order")
  await control(request, `confirming/${invoiceId}`)
  await expect(line).toHaveText("Another order is confirming its payment. Open that order")
  await control(request, `settle/${invoiceId}`)
  await expect(line).toHaveCount(0)
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeFocused()
})

test("Get a new invoice keeps an invoice the service would not cancel", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("keep"), { method: "card" })
  await page.route(/\/\?order=/, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, body: (await res.text()).replace('name="stripe-publishable-key" content=""', 'name="stripe-publishable-key" content="pk_test_e2e"') })
  })
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.reload()
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  const answers = [
    { status: 409, body: { error: "funded" }, text: "A payment has reached this invoice, so it is kept." },
    { status: 503, body: { error: "provider_unavailable" }, text: "The invoice could not be cancelled now." },
  ]
  for (const answer of answers) {
    await page.route("**/api/invoice/*/cancel", (route) => route.fulfill({ status: answer.status, json: answer.body }))
    await page.getByRole("button", { name: "Get a new invoice" }).click()
    await expect(page.getByText(answer.text)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
    await page.unroute("**/api/invoice/*/cancel")
  }
  await page.route("**/api/invoice/*/cancel", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await expect(page.locator("[aria-hidden=true]", { hasText: /^The invoice is still open\. Try again in/ })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
})

test("a registration link of an order paid by invoice points at its payment link", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("reglink"), { method: "btc" })
  const registrationId = await registrationOf(request, invoiceId)
  await page.goto(`/?registration=${registrationId}`)
  await expect(page.getByRole("heading", { name: "This order is paid by invoice" })).toBeVisible()
  await page.getByRole("button", { name: "Open its payment" }).click()
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
})

test("a registered order opened in a browser without its code offers restore", async ({ page, browser, request }) => {
  const label = uniqueLabel("else")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  const other = await browser.newContext()
  const page2 = await other.newPage()
  await page2.goto(`/?order=${invoiceId}`)
  await expect(page2.getByText("Its name code is not in this browser.")).toBeVisible()
  await page2.getByRole("button", { name: "Restore with your name code" }).click()
  await codeField(page2).fill(ownerCode)
  await page2.getByRole("button", { name: "Add to Your names" }).click()
  // back on the order's page, which now has the code
  await page2.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await waitRegistered(page2, label)
  await expect(await shownCode(page2), "the restored browser holds the code").toHaveText(ownerCode)
  await other.close()
})

test("a failed retarget shows one message below the result, however often it is tried", async ({ page, request }) => {
  const { registrationId } = await failedOrder(page, request, uniqueLabel("rtf"))
  await page.goto(`/#/?retarget=${registrationId}`)
  await page.route("**/api/registration/*/name", (route) => route.fulfill({ status: 503, json: { error: "provider_unavailable" } }))
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("rtf2"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await agreeToTerms(page)
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Register with your payment" }).click()
    await expect(page.getByText("That did not go through")).toHaveCount(1)
  }
  await expect(page.locator(".answer .row .notice"), "the message stays out of the name's row").toHaveCount(0)
  // the name whole on its own line where the long button leaves it too little room beside it
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await brokenNames(page), `the names broken at ${size.width}x${size.height}`).toEqual([])
    const { spill, clipped } = await rowFit(page)
    expect({ spill, clipped }, `the row's parts past it or too narrow at ${size.width}x${size.height}`).toEqual({ spill: 0, clipped: [] })
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, "N8a2-retarget-failed")
})

test("a retarget refused for a name taken meanwhile says the name is no longer available", async ({ page, request }) => {
  const { registrationId } = await failedOrder(page, request, uniqueLabel("rtt"))
  await page.goto(`/#/?retarget=${registrationId}`)
  await page.route("**/api/registration/*/name", (route) => route.fulfill({ status: 409, json: { error: "name_taken" } }))
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("rtt2"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await agreeToTerms(page)
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await expect(page.getByText("This name is no longer available. Search another one.")).toBeVisible()
})

test("a move refused for its code says what happened to the code and where to write, never to try again", async ({ page, request }) => {
  const { registrationId } = await failedOrder(page, request, uniqueLabel("rtc"))
  const cases: [string, number, string][] = [
    ["code_used", 409, "This code was already used"], ["code_reserved", 409, "This code is being used for a name now"],
    ["code_expired", 409, "This code has expired"], ["code_invalid", 400, "This code is not valid: SimpleX withdrew it"],
  ]
  for (const [error, status, title] of cases) {
    await page.unrouteAll({ behavior: "wait" })
    await page.route("**/api/registration/*/name", (route) => route.fulfill({ status, json: { error } }))
    await page.goto(`/#/?retarget=${registrationId}`)
    await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("rtc2"))
    await page.getByLabel("Name", { exact: true }).press("Enter")
    await agreeToTerms(page)
    await page.getByRole("button", { name: "Register with your payment" }).click()
    const note = page.locator(".answer .notice", { hasText: title })
    await expect(note, error).toContainText(`Write to SimpleX support with this order's reference, chat@simplex.chat: `)
    await expect(note.getByRole("link", { name: "chat@simplex.chat" })).toHaveAttribute("href", "mailto:chat@simplex.chat")
    await expect(page.getByText("Try again in a moment"), error).toHaveCount(0)
  }
})

test("a partly paid invoice offers no cancel", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("part"), { method: "btc" })
  await expect(page.getByText("Cancel this invoice")).toBeVisible()
  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText("Part of the payment arrived")).toBeVisible()
  await expect(page.getByText("Cancel this invoice")).toHaveCount(0)
})

test("Your names tells part-paid and confirming orders from unpaid ones, and a new invoice replaces an unpaid one", async ({ page, request }) => {
  const [part, seen, plain] = [uniqueLabel("pp"), uniqueLabel("cf"), uniqueLabel("np")]
  const partOrder = await startOrder(page, part, { method: "btc" })
  await control(request, `partial/${partOrder.invoiceId}`)
  const seenOrder = await startOrder(page, seen, { method: "xmr" })
  await control(request, `confirming/${seenOrder.invoiceId}`)
  const plainOrder = await startOrder(page, plain, { method: "btc" })
  await control(request, `expire/${plainOrder.invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== plainOrder.invoiceId)
  await page.goto("/#/names")
  const chipOf = (label: string) => page.locator(".list-row:visible", { hasText: `${label}.simplex` }).locator(".chip")
  await expect(chipOf(part)).toHaveText("Waiting for the rest")
  await expect(chipOf(seen)).toHaveText("Confirming payment")
  await expect(chipOf(plain)).toHaveText("Waiting for payment")
  await shot(page, "N12e-history-phases")
})

test("full storage that still reads is warned about on the name code step, which shows the only copy of the code", async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage && key.startsWith("simplex-names")) throw new DOMException("full", "QuotaExceededError")
      return setItem.call(this, key, value)
    }
  })
  const page = await context.newPage()
  await search(page, uniqueLabel("full"))
  await toCodeStep(page)
  await expect(onStep(page).getByText("This code could not be saved in this browser")).toBeVisible()
  await expect(onStep(page).getByText("Save a copy now: it will be the only one.")).toBeVisible()
  await expect(await shownCode(page)).toHaveText(await checkoutOwnerCode(page))
  await savedToReview(page)
  await payButton(page).click()
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(onStep(page).getByTestId("owner-code"), "the code was saved before paying, so the payment page leaves it out").toHaveCount(0)
  await context.close()
})

test("Forget everything also drops the tab's unfinished checkout", async ({ page }) => {
  await search(page, uniqueLabel("forget"))
  await toCodeStep(page)
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").click()
  await page.getByRole("button", { name: "Forget everything" }).click()
  await page.goto("/#/checkout")
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  // each step's address leads to the search once its checkout is gone
  await page.goto("/#/checkout/code")
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  await page.goto("/#/names")
  await expect(page.getByText("No names in this browser yet", { exact: true })).toBeVisible()
})

test("a payment that arrives after expiry turns the open page into the late page, whose balance buys another name, and no new invoice is made", async ({ page, request }) => {
  const label = uniqueLabel("late")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await expect(page.getByText("Nothing was received before it closed.")).toBeVisible()
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByText("The payment arrived after this invoice had closed")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  // credited to the order's balance, the late money offers another name and a refund, as a taken order's does
  await expect(onStep(page).getByRole("button", { name: "Get a refund" })).toBeVisible()
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(page.locator(".code-chip")).toContainText("Balance: $100")
  await page.goto("/#/names")
  const order = page.locator(".list-row:not([data-key^='balance-'])", { hasText: `${label}.simplex` })
  await expect(order).toHaveCount(1)
  await expect(order.locator(".sub")).toContainText("Paid after the invoice closed; kept as your balance")
  await expect(page.locator(".list-row[data-key^='balance-'] .main")).toHaveText(`$100From ${label}.simplex, paid after its invoice closed`)
})

test("money paid after the close that the service cannot credit by itself sends the buyer to support, and the page stops reading it", async ({ page, request }) => {
  const label = uniqueLabel("latesup")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await control(request, `late/${invoiceId}`, { waiting: "support" })
  await control(request, `settle/${invoiceId}`)
  await expect(onStep(page).getByText("It is not credited to your balance by itself: write to chat@simplex.chat with the reference below.")).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Get a refund" })).toHaveCount(0)
  const reads: string[] = []
  page.on("request", (r) => { if (r.url().includes(`/api/invoice/${invoiceId}`)) reads.push(r.url()) })
  await page.waitForTimeout(7_000)
  expect(reads, "no reads once only support can credit it").toEqual([])
  await page.goto("/#/names")
  await expect(page.locator(".list-row:not([data-key^='balance-'])", { hasText: `${label}.simplex` }).locator(".sub")).toContainText("Paid after the invoice closed; write to support to have it credited")
})

test("an order left before its wait ends asks for this browser in Your names", async ({ page, request }) => {
  const label = uniqueLabel("left")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await page.goto("/#/")
  await control(request, `settle/${invoiceId}`)
  await expect.poll(async () => {
    const { phase, revealAfter } = await mockRegistration(request, invoiceId)
    return phase === "committed" && revealAfter !== null && Date.now() / 1000 >= revealAfter
  }, { timeout: REGISTRATION_MS }).toBe(true)
  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Open to finish")
  await row.getByRole("button", { name: "Open", exact: true }).click()
  await waitRegistered(page, label)
})

test("a name typed with .simplex is searched without it, and the field shows the name searched with its caret at the end", async ({ page }) => {
  await search(page, "Bakery.simplex")
  await expect(page.locator(".answer .chat")).toHaveCount(2)
  const field = page.getByLabel("Name", { exact: true })
  await expect(field).toHaveValue("bakery")
  expect(await field.evaluate((n: HTMLInputElement) => [n.selectionStart, n.selectionEnd])).toEqual([6, 6])
})

// past the row's retry after a failed read, UNREAD_RETRY_MS in views/names.ts, with the read it starts
const UNREAD_ROUND_MS = 8_000
test("a row Your names could not read is read again while the page stays open", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("unread"), { method: "btc" })
  let refused = true
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => refused ? route.fulfill({ status: 503, json: { error: "provider_unavailable" } }) : route.continue())
  await page.goto("/#/names")
  const chip = page.locator(".list-row .chip")
  await expect(chip).toHaveText("Not checked")
  refused = false
  await expect(chip, "the row read again by itself").toHaveText("Waiting for payment", { timeout: UNREAD_ROUND_MS })
})

test("a code Your names could not check is checked again while the page stays open", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/")
  await page.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  let refused = true
  await page.route("**/api/code/check", (route) => refused ? route.fulfill({ status: 503, json: { error: "provider_unavailable" } }) : route.continue())
  await page.goto("/#/names")
  const chip = page.locator(".list-row", { hasText: code }).locator(".chip")
  await expect(chip).toHaveText("Not checked")
  refused = false
  await expect(chip, "the code checked again by itself").toHaveText("Unused", { timeout: UNREAD_ROUND_MS })
})

test("Forget everything asks over the records stored now, another tab's included", async ({ page, request }) => {
  await search(page, uniqueLabel("fgt"))
  await toCodeStep(page)
  await page.goto("/#/names")
  await expect(page.locator(".list-row")).toHaveCount(1)
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const other = await page.context().newPage()
  await other.goto("/")
  await other.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await other.close()
  // the list was read when opened, so the other tab's code shows only once the question is asked
  await expect(page.locator(".list-row", { hasText: code })).toHaveCount(0)
  await page.getByText("Forget everything in this browser").click()
  await expect(page.getByRole("button", { name: "Keep them" })).toBeFocused()
  await expect(page.locator(".list-row", { hasText: code })).toBeVisible()
})

test("search points at this browser's open order for a name instead of a second one", async ({ page }) => {
  const label = uniqueLabel("own")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await search(page, label)
  await expect(page.getByText("You already have an order for this name.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Register" })).toBeDisabled()
  await expect(page.getByRole("link", { name: "Open that order" })).toHaveAttribute("href", `/?order=${invoiceId}`)
  await shot(page, "N2f-own-order")
})

test("an old invoice link leads to the invoice that replaced it", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("old"), { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const replacement = new URL(page.url()).searchParams.get("order")
  await page.goto(`/?order=${invoiceId}`)
  await expect(page).toHaveURL(new RegExp(`order=${replacement}`))
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
})

test("the checkout and the payment page fit a tablet's width rather than scroll sideways", async ({ page }) => {
  const width = () => page.evaluate(() => document.documentElement.scrollWidth)
  await page.setViewportSize({ width: 700, height: 900 })
  await search(page, uniqueLabel("tab"))
  await toReview(page)
  expect(await width()).toBeLessThanOrEqual(700)
  await page.goto("/")
  await startOrder(page, uniqueLabel("tab2"), { method: "btc" })
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(700)
})

test("Your names keeps a long name clear of its row's chip at every width", async ({ page }) => {
  const short = uniqueLabel("ell")
  const label = `${short}${"x".repeat(63 - short.length)}`
  await startOrder(page, label, { method: "btc" })
  for (const width of [600, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/#/names")
    const title = page.locator(".list-row .main .name", { hasText: label })
    await expect(title).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    // beside the chip on a wide screen, above it once the row stacks: the name never runs under it
    // read once the row's state is in, as the chip widens from "Checking" and the name gives way to it
    const chip = page.locator(".list-row", { hasText: label }).locator(".chip")
    await expect(chip).toHaveText("Waiting for payment")
    // read together, once the brand font is in: the fallback's widths differ a little, and a page under load swaps late
    await page.evaluate(() => document.fonts.ready)
    const [t, c] = await page.evaluate((label) => {
      const row = [...document.querySelectorAll(".list-row")].find((r) => r.textContent!.includes(label))!
      return [row.querySelector(".main .name")!.getBoundingClientRect(), row.querySelector(".chip")!.getBoundingClientRect()].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
    }, label)
    expect(t.x + t.width <= c.x || t.y + t.height <= c.y, `${width}px: name ${JSON.stringify(t)}, chip ${JSON.stringify(c)}`).toBe(true)
    await expect(title, "the whole name, as it wraps rather than being cut").toHaveText(`${label}.simplex`)
  }
})

test("paying by card during an outage keeps the order on screen", async ({ page }) => {
  await startOrder(page, uniqueLabel("offpay"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await page.route("**/api/**", (route) => route.abort())
  await onStep(page).getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByRole("heading", { name: "Paying by card" })).toBeVisible()
  await page.waitForTimeout(4000)
  await expect(page.getByRole("heading", { name: "This order could not be loaded" })).toHaveCount(0)
  await page.unroute("**/api/**")
})

test("a rate-limited cancel holds, and the hold outlives the page drawing itself again", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("hold"), { method: "btc" })
  let cancels = 0
  await page.route("**/cancel", (route) => { cancels++; return route.fulfill({ status: 429, headers: { "retry-after": "20" }, json: { error: "rate_limited" } }) })
  await page.getByText("Cancel this invoice").click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await page.getByText("Cancel this invoice").click()
  expect(cancels).toBe(1)
  // the invoice closes and the page draws its expired state: the new button starts held
  await control(request, `expire/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toBeDisabled()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  // the other actions of the tab wait too: search is paused, and adding a name code would wait
  await page.getByRole("link", { name: "SimpleX names" }).click()
  await expect(page.getByText(/Searching is paused: try again in \d+ seconds/).first()).toBeVisible()
  await page.locator("body > header").getByRole("link", { name: "Check your code" }).click()
  await codeField(page).fill(await page.evaluate(() => Object.values(localStorage).map((v) => { try { return JSON.parse(v).ownerCode as string } catch { return "" } }).find(Boolean)!))
  await expect(page.getByRole("button", { name: "Add to Your names" })).toBeDisabled()
})

test("Back from a paused order keeps the order paused", async ({ page }) => {
  await search(page, uniqueLabel("pause"))
  await toReview(page)
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "20" }, json: { error: "rate_limited" } }) : route.continue())
  await payButton(page).click()
  await expect(page.locator(".outcome .notice span[aria-hidden=true]")).toHaveText(/^Too many orders were tried from here\. Try again in \d+ seconds\.$/)
  await page.goBack()
  await expect(page.getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(payButton(page)).toBeDisabled()
  await expect(page.getByText("Too many attempts")).toBeVisible()
})

test("an order on its way keeps its method as sent until it is answered", async ({ page }) => {
  await search(page, uniqueLabel("lock"))
  await toReview(page)
  let answer: () => void = () => undefined
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await page.route("**/api/invoice", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await answered
    await route.fulfill({ status: 500, json: { error: "internal" } })
  })
  await payButton(page).click()
  for (const radio of await page.getByRole("radio").all()) await expect(radio).toHaveAttribute("aria-disabled", "true")
  // a click Playwright would wait on, as on any control marked disabled, comes as the page hears it
  await page.getByRole("radio", { name: "Monero" }).dispatchEvent("click")
  await expect(page.getByRole("radio", { name: "Bitcoin" })).toHaveAttribute("aria-checked", "true")
  answer()
  await expect(page.getByRole("heading", { name: "That did not go through" })).toBeVisible()
  await page.unrouteAll({ behavior: "wait" })
})

test("Find the order shows a wait met elsewhere in the tab", async ({ page, request }) => {
  await search(page, uniqueLabel("findh"))
  await toCodeStep(page)
  await control(request, "search", { findLimitSeconds: 20 })
  // another tab, which does not hold this checkout, looks for its order
  const other = await page.context().newPage()
  await other.goto("/#/code")
  // a name code's verdict looks for its orders, which the limit refuses
  await codeField(other).fill((await other.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:pending:"))!.split(":").pop()))!)
  await expect(other.locator(".code-entry .verdict")).toContainText("Too many checks just now")
  await other.getByRole("link", { name: "Your names" }).click()
  await expect(other.locator(".list-row .chip", { hasText: /Try again in \d+ seconds/ })).toBeVisible()
  await expect(other.getByText("Find the order")).toHaveAttribute("aria-disabled", "true")
  await control(request, "search", { findLimitSeconds: 0 })
})

// how far a restored place may be from the one left, as a page's height settles by a pixel or so
const PLACE_PX = 4
const scrolledNear = (page: Page, y: number) => expect.poll(() => page.evaluate((t) => Math.abs(scrollY - t), y)).toBeLessThanOrEqual(PLACE_PX)

const HOME_PLACE_PX = 150
// The page goes Back itself, as Playwright's Back from Your names here never returns in Firefox driven over WebDriver BiDi.
test("Back returns to where a page was left, a slow page included, and a reload keeps the place", async ({ page }) => {
  // The home fills one screen, so a short window leaves it room to scroll. The dev server draws a reload's first frame
  // before its styles, so the place is one that unstyled frame reaches too.
  await page.setViewportSize({ width: 1280, height: 300 })
  await page.goto("/")
  const place = await page.evaluate((most) => Math.min(most, document.documentElement.scrollHeight - innerHeight), HOME_PLACE_PX)
  expect(place).toBe(HOME_PLACE_PX)
  await page.evaluate((y) => scrollTo(0, y), place)
  // clicked from inside the page: a pointer click first scrolls the header's link into view, which WebKit does even
  // for a link always in view, moving the place it then leaves
  await page.locator("header .top-links a[href='/#/names']").dispatchEvent("click")
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  expect(await page.evaluate(() => scrollY)).toBe(0)
  await page.evaluate(() => history.back())
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  await scrolledNear(page, place)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  await scrolledNear(page, place)

  await page.setViewportSize({ width: 1280, height: 500 })
  const { invoiceId } = await startOrder(page, uniqueLabel("place"), { method: "btc" })
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  const scrollRoom = () => page.evaluate(() => Math.min(400, document.documentElement.scrollHeight - innerHeight))
  await expect.poll(scrollRoom).toBeGreaterThan(100)
  const orderPlace = await scrollRoom()
  await page.evaluate((y) => scrollTo(0, y), orderPlace)
  await page.locator("header .top-links a[href='/#/names']").dispatchEvent("click")
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await page.route(`**/api/invoice/${invoiceId}*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900))
    await route.continue()
  })
  // the page left stays in sight, out of reach, until the slow order is read
  const heldInert = page.evaluate(() => new Promise<void>((resolve) => {
    const main = document.querySelector<HTMLElement>("body > main")!
    new MutationObserver((_, watch) => {
      if (!main.inert) return
      watch.disconnect()
      resolve()
    }).observe(main, { attributes: true, attributeFilter: ["inert"] })
  }))
  await page.evaluate(() => history.back())
  await heldInert
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await scrolledNear(page, orderPlace)
  await page.unroute(`**/api/invoice/${invoiceId}*`)
})

// A copied tab pays with Monero or with a code; the first tab's Bitcoin invoice opens instead, its page saying so until it
// is left, and not when it is opened again from Your names.
for (const other of ["Monero", "a code"]) {
  test(`a checkout copied to another tab that pays with ${other} opens the first tab's invoice and says why`, async ({ page, request }) => {
    const label = uniqueLabel("copy")
    await search(page, label)
    await toReview(page)
    const checkout = await page.evaluate((key) => sessionStorage.getItem(key)!, CHECKOUT_KEY)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    const invoiceId = new URL(page.url()).searchParams.get("order")
    const copy = await page.context().newPage()
    // a duplicated tab starts with the first tab's session, the same checkout and its name code
    await copy.addInitScript(([key, value]) => { if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value) }, [CHECKOUT_KEY, checkout])
    await copy.goto("/#/checkout")
    if (other === "Monero") {
      await copy.getByRole("radio", { name: "Monero" }).click()
      await payButton(copy).click()
    } else {
      const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
      // a code checked in this tab, which the copied checkout then carries, as Register gives it
      await useCode(copy, code)
      await copy.evaluate((key) => sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)!), code: JSON.parse(sessionStorage.getItem("simplex-names-code")!) })), CHECKOUT_KEY)
      await copy.goto("/#/checkout")
      await onStep(copy).getByRole("button", { name: "Register with your code" }).click()
    }
    await copy.waitForURL(/\?order=/)
    expect(new URL(copy.url()).searchParams.get("order"), "the order's one invoice").toBe(invoiceId)
    await expect(copy.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
    const why = `This name already has a Bitcoin invoice from an earlier try, so it opened instead of ${other === "Monero" ? "a new Monero one" : "using your code"}.`
    await expect(onStep(copy).getByText(why)).toBeVisible()
    await copy.getByRole("link", { name: "Your names" }).first().click()
    await copy.locator(".list-row").getByRole("button", { name: "Open" }).first().click()
    await expect(copy.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
    expect(new URL(copy.url()).searchParams.get("order"), "the same invoice opened again").toBe(invoiceId)
    await expect(onStep(copy).locator(".note", { hasText: "earlier try" }), "the line is said once").toHaveCount(0)
    await copy.close()
  })
}

test("a Continue checkout drawn before its checkout ended draws the list anew rather than open a checkout that is gone", async ({ page }) => {
  await search(page, uniqueLabel("ended"))
  await toCodeStep(page)
  await page.goto("/#/names")
  const resume = page.getByRole("button", { name: "Continue checkout" })
  await expect(resume).toBeVisible()
  // the checkout ends in this tab, as its order going out ends it, while the list stays drawn
  await page.evaluate((key) => sessionStorage.removeItem(key), CHECKOUT_KEY)
  await resume.click()
  await expect(page.getByRole("button", { name: "Find the order" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/names")
})

// how long Your names waits for each order's read, long enough for frames to be drawn before the reads answer
const ROW_READ_MS = 1500
const ROW_YEAR_S = 365 * 86400

const linkedChat = (kind: "contact" | "channel") => ({ type: kind === "contact" ? "address" : "channel", kind, displayName: kind, fullName: "", image: null,
  subscribers: kind === "channel" ? 12 : null, link: kind === "contact" ? contactLink("R1") : channelLink("R2"), deepLink: "simplex:/a#x", profile: "ok" })

test("Your names moves no row once drawn as its reads answer, on a browser's first opening and in a new tab after it", async ({ browser }) => {
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: size })
    const page = await context.newPage()
    const now = Math.floor(Date.now() / 1000)
    const registered = { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt: now + ROW_YEAR_S }
    const kept = [
      [await keepOrder(page, "reg-still0", null, "studio42", { contact: contactLink("R1"), channel: channelLink("R2") }), registered],
      [await keepOrder(page, "reg-still1", "inv-still1", "bakerypaidwithbitcoin"), registered],
      [await keepOrder(page, "reg-still4", "inv-still4", "bakerypaidbycard"), registered],
      [await keepOrder(page, "reg-still2", null, "w".repeat(MAX_LABEL_LENGTH)), { phase: "committed", commitTx: "0x02" }],
      [await keepOrder(page, "reg-still3", null, "bakerycodeorder"), { phase: "queued" }],
    ] as const
    let answered = 0
    const slowly = async <T>(json: T, route: Route) => {
      await new Promise((wait) => setTimeout(wait, ROW_READ_MS))
      await route.fulfill({ json })
      answered++
    }
    for (const [order, change] of kept) {
      const view = registrationView(order, change)
      await context.route(`**/api/registration/${order.registrationId}*`, (route) => slowly(view, route))
      if (order.invoiceId) await context.route(`**/api/invoice/${order.invoiceId}*`, (route) => slowly({ invoiceId: order.invoiceId, status: "paid", amount: 10000,
        currency: "usd", expiresAt: new Date().toISOString(), kind: "name", registration: view,
        ...(order.registrationId === "reg-still4" ? { cryptoCurrency: "card", clientSecret: "pi_still_secret", amountPaid: 10000 }
          : { cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bcrt1q", cryptoAmountPaid: "0.00156", paidInFull: true }) }, route))
    }
    // the first name has its two chats, the other none
    await context.route("**/api/name/**", (route) => slowly({ status: "registered", entities: route.request().url().includes(kept[0][0].request.labelHash)
      ? [linkedChat("contact"), linkedChat("channel")] : [], owner: kept[0][0].owner, resolver: CHAIN.resolver, chainId: CHAIN.chainId,
    records: { contact: "", channel: "" }, recordsNonce: 0, expiresAt: now + ROW_YEAR_S, tld: "simplex", community: null }, route))
    const reads = kept.length + 3
    for (const [tab, opening] of [[page, "first opening"], [await context.newPage(), "new tab"]] as const) {
      const before = answered
      // once the web fonts are in, which move text by their own measure, and from the list's top
      await recordFrames(tab, () => {
        if (document.fonts.status !== "loaded") return null
        const list = document.querySelector("body > main .card.list")?.getBoundingClientRect().top ?? 0
        return [...document.querySelectorAll<HTMLElement>("body > main :is(.list-row, .end-links)")]
          .map((n) => `${n.dataset.key ?? "end-links"} ${Math.round(n.getBoundingClientRect().top - list)} ${Math.round(n.getBoundingClientRect().height)}`)
      }, true)
      // a document of its own, which the sampler starts with
      await tab.goto("about:blank")
      await tab.goto("/#/names")
      await expect.poll(() => answered, "the rows' reads").toBe(before + reads)
      await expect(tab.locator(".list-row")).toHaveCount(kept.length)
      await tab.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
      const places = new Map<string, Set<string>>()
      for (const frame of await recordedFrames<string[]>(tab)) for (const part of frame) {
        const [key, ...place] = part.split(" ")
        places.set(key, (places.get(key) ?? new Set()).add(place.join(" ")))
      }
      const moved = [...places].filter(([, seen]) => seen.size > 1).map(([key, seen]) => `${key}: ${[...seen].join(", ")}`)
      expect(moved, `${opening} at ${size.width}: each row's top and height in every frame since it was drawn`).toEqual([])
    }
    await context.close()
  }
})

// the service's added latency the press is measured under, and the most a press may take to show Your names
const ADDED_LATENCY_MS = 300
const PRESS_SHOWN_MS = 100

test("a press on Your names shows its page at once, marked in the header or the phone's menu, while its rows are read", async ({ browser }) => {
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport: size })
    const page = await context.newPage()
    await keepOrder(page, "reg-press0", null, "pressedname")
    await context.route("**/api/**", async (route) => {
      await new Promise((wait) => setTimeout(wait, ADDED_LATENCY_MS))
      await route.continue()
    })
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
    await page.evaluate(() => {
      const w = window as unknown as { __pressed: number; __shown: number }
      addEventListener("click", () => { w.__pressed = performance.now() }, { capture: true })
      const look = () => {
        const marked = document.querySelector('a[aria-current="page"][href="/#/names"]')
        if (document.querySelector("body > main h1")?.textContent === "Your names" && marked && !w.__shown) w.__shown = performance.now()
        else requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
    })
    if (size.width > 520) await page.locator("body > header .top-links").getByRole("link", { name: "Your names" }).click()
    else {
      await page.getByRole("button", { name: "Menu" }).click()
      await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Your names" }).click()
    }
    await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shown?: number }).__shown ?? null), "a frame drawn with Your names").not.toBeNull()
    const [pressed, shown] = await page.evaluate(() => [(window as unknown as { __pressed: number }).__pressed, (window as unknown as { __shown: number }).__shown])
    expect(shown - pressed, `from the press to Your names shown at ${size.width}`).toBeLessThanOrEqual(PRESS_SHOWN_MS)
    await expect(page.getByRole("navigation", { name: "Menu" })).toBeHidden()
    await expect(page.locator(".list-row", { hasText: "pressedname" })).toBeVisible()
    await context.close()
  }
})

// Every frame from the first with the list's first row: its chip, its height and the end links' top, or "gone".
const rowFrames = (page: Page) => recordFrames(page, () => {
  const w = window as unknown as { __rowSeen?: boolean }
  const row = document.querySelector(".list-row")
  w.__rowSeen ||= row !== null
  if (!w.__rowSeen) return null
  const end = document.querySelector("body > main .end-links")?.getBoundingClientRect().top
  return row ? [row.querySelector(".chip")?.textContent ?? "no chip", Math.round(row.getBoundingClientRect().height), end === undefined ? null : Math.round(end)] : ["gone", 0, null]
}, true)

const SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 844 }]

test("a row drawn from the last reads stays drawn as it was, until its name registered meanwhile comes with its answer, and keeps its height", async ({ page }) => {
  for (const size of SIZES) {
    await page.setViewportSize(size)
    const order = await keepOrder(page, "reg-stays", null, "staysregistering")
    const now = Math.floor(Date.now() / 1000)
    const registering = registrationView(order, { phase: "registering", commitTx: "0x02", registerTx: "0x03" })
    await page.evaluate(([id, view]) => localStorage.setItem("simplex-names-seen", JSON.stringify({ [id]: { view, invoice: null } })), [order.registrationId, registering] as const)
    await page.route(`**/api/registration/${order.registrationId}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt: now + ROW_YEAR_S }) }))
    await page.route("**/api/name/**", async (route) => {
      await new Promise((wait) => setTimeout(wait, ROW_READ_MS))
      await route.fulfill({ json: { status: "registered", entities: [linkedChat("contact")], owner: order.owner, resolver: CHAIN.resolver, chainId: CHAIN.chainId,
        records: { contact: contactLink("R1"), channel: "" }, recordsNonce: 0, expiresAt: now + ROW_YEAR_S, tld: "simplex", community: null } })
    })
    await rowFrames(page)
    await page.goto("about:blank")
    await page.goto("/#/names")
    await expect(page.locator(".list-row .chats > *")).toHaveCount(1)
    await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
    const frames = await recordedFrames<[string, number, number | null]>(page)
    const at = `${size.width}x${size.height}`
    expect(frames.length, `${at}: frames with the row`).toBeGreaterThan(1)
    expect([...new Set(frames.map(([chip]) => chip))], `${at}: the row's chip, frame by frame`).toEqual(["Registering", "no chip"])
    expect([...new Set(frames.map(([, height, end]) => `${height} ${end}`))], `${at}: the row's height and the end links' top`).toHaveLength(1)
    await page.unrouteAll({ behavior: "wait" })
    await page.evaluate(() => localStorage.clear())
  }
})

// a name's answer later than the list's bound on reads
const LATE_ANSWER_MS = 12_000

test("a row drawn not read after the bound keeps its height on a phone when its late answer brings its chats", async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize(SIZES[1])
  const order = await keepOrder(page, "reg-late", null, "lateanswername", { contact: contactLink("R1"), channel: "" })
  const now = Math.floor(Date.now() / 1000)
  await page.route(`**/api/registration/${order.registrationId}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt: now + ROW_YEAR_S }) }))
  await page.route("**/api/name/**", async (route) => {
    await new Promise((wait) => setTimeout(wait, LATE_ANSWER_MS))
    await route.fulfill({ json: { status: "registered", entities: [linkedChat("contact")], owner: order.owner, resolver: CHAIN.resolver, chainId: CHAIN.chainId,
      records: { contact: contactLink("R1"), channel: "" }, recordsNonce: 0, expiresAt: now + ROW_YEAR_S, tld: "simplex", community: null } })
  })
  await rowFrames(page)
  await page.goto("about:blank")
  await page.goto("/#/names")
  await expect(page.locator(".list-row .chip")).toHaveText("Not checked", { timeout: 15_000 })
  await expect(page.locator(".list-row .chats > *")).toHaveCount(1, { timeout: 15_000 })
  await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
  const frames = await recordedFrames<[string, number, number | null]>(page)
  expect([...new Set(frames.map(([chip]) => chip))], "the row's chip, frame by frame").toEqual(["Not checked", "no chip"])
  expect([...new Set(frames.map(([, height, end]) => `${height} ${end}`))], "the row's height and the end links' top").toHaveLength(1)
})

// what a code's row says after "added": a long date and a short one
const CODE_DATES = ["2026-09-24T10:00:00Z", "2026-05-01T10:00:00Z"]

test("a code's row keeps its lines and height as its chip turns from Checking to Used, for a long and a short date", async ({ page }) => {
  for (const size of SIZES) for (const addedAt of CODE_DATES) {
    await page.setViewportSize(size)
    await page.goto("/#/trademarks")
    await page.evaluate((at) => {
      localStorage.clear()
      localStorage.setItem("simplex-names:code:SN6-ROWFIT", JSON.stringify({ code: "SN6-8M7E3-SF9WP-JEBEZ-VFNC9", minLength: 6, years: 2, addedAt: at }))
    }, addedAt)
    await page.route("**/api/code/check", async (route) => {
      await new Promise((wait) => setTimeout(wait, ROW_READ_MS))
      await route.fulfill({ json: { minLength: 6, years: 2, state: "used" } })
    })
    await rowFrames(page)
    await page.goto("about:blank")
    await page.goto("/#/names")
    await expect(page.locator(".list-row .chip")).toHaveText("Used")
    await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
    const frames = await recordedFrames<[string, number, number | null]>(page)
    const at = `${size.width}x${size.height}, added ${addedAt.slice(0, 10)}`
    expect([...new Set(frames.map(([chip]) => chip))], `${at}: the chip, frame by frame`).toEqual(["Checking", "Used"])
    expect([...new Set(frames.map(([, height, end]) => `${height} ${end}`))], `${at}: the row's height and the end links' top`).toHaveLength(1)
    expect(await addedApart(page), `${at}: "added" and its date on different lines`).toBe(false)
    await page.unrouteAll({ behavior: "wait" })
  }
})

// whether a code's line breaks between "added" and the date after it
const addedApart = (page: Page) => page.locator(".code-row .sub").evaluate((sub) => {
  const walker = document.createTreeWalker(sub, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf("added ")
    if (at < 0) continue
    const top = (from: number, to: number) => {
      const range = document.createRange()
      range.setStart(node!, from)
      range.setEnd(node!, to)
      return Math.round(range.getClientRects()[0].top)
    }
    return top(at, at + 5) !== top(at + 6, at + 7)
  }
  return null
})

test("a phone draws each code's chip at its actions, whatever its word", async ({ page }) => {
  await page.setViewportSize(SIZES[1])
  await page.goto("/#/trademarks")
  await page.evaluate(() => {
    localStorage.clear()
    for (const [code, at] of [["SN6-8M7E3-SF9WP-JEBEZ-VFNC9", "2026-05-01T10:00:00Z"], ["SN6-Q74DT-BX6MZ-DW6V5-83MGW", "2026-05-02T10:00:00Z"]]) {
      localStorage.setItem(`simplex-names:code:${code}`, JSON.stringify({ code, minLength: 6, years: 2, addedAt: at }))
    }
  })
  await page.route("**/api/code/check", async (route) => {
    const { code } = route.request().postDataJSON() as { code: string }
    await route.fulfill({ json: { minLength: 6, years: 2, state: code.startsWith("SN6-8M7E3") ? "used" : "unused" } })
  })
  await page.goto("/#/names")
  await expect(page.locator(".code-row .chip")).toHaveText(["Used", "Unused"])
  const gaps = await page.locator(".code-row").evaluateAll((rows) => rows.map((row) =>
    Math.round(row.querySelector(".acts > :first-child")!.getBoundingClientRect().left - row.querySelector(".chip")!.getBoundingClientRect().right)))
  expect(gaps[0], `the gap from each chip to its row's first action: ${gaps}`).toBe(gaps[1])
})

test("a read that does not answer leaves the row's place to the reading note, then draws it as last known and not read, and the list goes on", async ({ page }) => {
  // the newest row first, whose read the older one's waits behind
  await keepOrder(page, "reg-hung1", null, "neveranswered")
  await keepOrder(page, "reg-hung0", null, "answeredfirst")
  await page.route("**/api/registration/reg-hung1*", () => undefined)
  await page.goto("/#/names")
  await expect(page.locator(".list-row")).toHaveCount(1)
  await expect(page.getByRole("status").filter({ hasText: "Reading your names…" })).toBeVisible()
  await expect(page.locator("body > main .end-links")).toHaveCount(0)
  await expect(page.locator(".list-row", { hasText: "neveranswered" }).locator(".chip")).toHaveText("Not checked", { timeout: 15_000 })
  await expect(page.locator("body > main .end-links")).toBeVisible()
  await expect(page.getByText("Reading your names…")).toHaveCount(0)
})

test("a drawn order that a newer order of its name replaces keeps its place until the newer one is read, and the end links stay", async ({ page, browser, request }) => {
  const older = uniqueLabel("gapold")
  await startOrder(page, older, { method: "btc" })
  const label = uniqueLabel("gapnew")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  const replaced = await registrationOf(request, invoiceId)
  await page.goto("/#/names")
  await expect(page.locator("body > main .end-links")).toBeVisible()
  // another browser restores the order, which then expires there and is ordered again
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restoreOrder(restored, ownerCode, label)
  await control(request, `expire/${invoiceId}`)
  await restored.goto(`/?order=${invoiceId}`)
  await restored.getByRole("button", { name: "Get a new invoice" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(restored.url()).searchParams.get("order")!
  await other.close()
  await page.route(`**/api/invoice/${second}*`, async (route) => {
    await new Promise((wait) => setTimeout(wait, ROW_READ_MS))
    await route.fallback()
  })
  await recordFrames(page, () => {
    const main = document.querySelector("body > main")!
    if (main.querySelector("h1")?.textContent !== "Your names") return null
    const rows = [...main.querySelectorAll<HTMLElement>(".list-row")].map((r) => [r.dataset.key!, Math.round(r.getBoundingClientRect().top)] as const)
    return [rows, !!main.querySelector(".end-links"), !!main.querySelector(".note.reading")]
  }, true)
  await page.goto("about:blank")
  await page.goto("/#/names")
  const successor = await registrationOf(request, second)
  await expect(page.locator(`.list-row[data-key="${successor}"]`)).toBeVisible()
  await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
  const frames = await recordedFrames<[[string, number][], boolean, boolean]>(page)
  const shown = frames.findIndex(([, end]) => end)
  const after = frames.slice(shown)
  expect(after.every(([, end, reading]) => end && !reading), "the end links, and no reading note, in every frame once they were drawn").toBe(true)
  expect([...new Set(after.map(([rows]) => rows.length))], "rows in each frame").toEqual([2])
  const tops = (key: (k: string) => boolean) => [...new Set(after.flatMap(([rows]) => rows.filter(([k]) => key(k)).map(([, top]) => top)))]
  expect(tops((k) => k !== replaced && k !== successor), "the older name's row, frame by frame").toHaveLength(1)
  expect(new Set([...tops((k) => k === replaced), ...tops((k) => k === successor)]).size, "the replaced row and its successor in one place").toBe(1)
})
