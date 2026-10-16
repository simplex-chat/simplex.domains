import { expect, test } from "@playwright/test"
import { contactLink, control, search, shot, startOrder, uniqueLabel, waitRegistered } from "./helpers.ts"

test("a second tab's order survives a write from a tab opened earlier", async ({ browser, request }) => {
  const context = await browser.newContext()
  const [early, late] = [await context.newPage(), await context.newPage()]
  await early.goto("/#/names")
  const label = uniqueLabel("tab")
  await startOrder(late, label, { method: "btc" })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await early.getByRole("button", { name: "Add a code" }).click()
  await early.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await early.getByRole("button", { name: "Add to your codes" }).click()
  await early.reload()
  await expect(early.locator(".row-item", { hasText: `${label}.simplex` })).toBeVisible()
  await expect(early.locator(".row-item", { hasText: code })).toBeVisible()
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
  await expect(page.locator(".result .chip", { hasText: "Taken" })).toBeVisible()
  await page.waitForTimeout(2500)
  await expect(page.locator(".result .chip", { hasText: "Taken" })).toBeVisible()
  await expect(page.locator(".result", { hasText: slow })).toHaveCount(0)
})

test("Back from an order page keeps it reachable with Forward", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("back"), { method: "btc" })
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Own your name" })).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
})

test("a payment method is chosen with the keyboard, as one radio group", async ({ page }) => {
  await search(page, uniqueLabel("key"))
  await page.getByRole("button", { name: "Register" }).click()
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

test("Escape closes the code popup and returns focus to what opened it", async ({ page }) => {
  await page.goto("/")
  await page.getByText("Check a code").focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByText("Check a code")).toBeFocused()
})

test("a card payment settled while its page was closed frees checkout", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("frees"), { method: "card" })
  await page.getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await page.goto("/")
  await control(request, `settle/${invoiceId}`)
  await search(page, uniqueLabel("next"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText("You have an order waiting to be confirmed")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled()
})

test("an unpaid invoice is pointed at from checkout without blocking a new order", async ({ page }) => {
  const first = uniqueLabel("open")
  const { invoiceId } = await startOrder(page, first, { method: "btc" })
  await search(page, uniqueLabel("second"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText(`${first}.simplex is waiting for its payment`)).toBeVisible()
  await expect(page.getByRole("link", { name: "Open that order" })).toHaveAttribute("href", `/?order=${invoiceId}`)
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled()
  await shot(page, "N3e2-open-invoice")
})

test("Get a new invoice keeps an invoice the service would not cancel", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("keep"), { method: "card" })
  await page.route(/\/\?order=/, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, body: (await res.text()).replace('name="stripe-publishable-key" content=""', 'name="stripe-publishable-key" content="pk_test_e2e"') })
  })
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.reload()
  await expect(page.getByRole("heading", { name: "The card form did not load" })).toBeVisible()
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
  await page.route("**/api/invoice/*/cancel", async (route) => {
    const res = await route.fetch({ method: "GET", url: route.request().url().replace("/cancel", "") })
    await route.fulfill({ status: 200, json: await res.json() })
  })
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await expect(page.getByText("This invoice was cancelled, but the service still shows it open. Do not pay it again.")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Invoice cancelled" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Load the card form again" })).toHaveCount(0)
  await shot(page, "N10a2-cancel-still-open")
})

test("a registration link of an order paid by invoice points at its payment link", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("reglink"), { method: "btc" })
  const registrationId = (await (await request.get(`http://127.0.0.1:8099/api/invoice/${invoiceId}`)).json()).registration.id
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
  await page2.getByLabel("Name code").fill(ownerCode)
  await page2.getByRole("button", { name: "Restore" }).click()
  await waitRegistered(page2, label)
  await expect(page2.getByTestId("owner-code")).toHaveText(ownerCode)
  await other.close()
})

test("a failed retarget shows one message below the result, however often it is tried", async ({ page, request }) => {
  const label = uniqueLabel("rtf")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: 120_000 })
  await page.getByRole("button", { name: "Choose another name" }).click()
  await page.route("**/api/registration/*/name", (route) => route.fulfill({ status: 503, json: { error: "provider_unavailable" } }))
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("rtf2"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Register with your payment" }).click()
    await expect(page.getByText("That did not go through")).toHaveCount(1)
  }
  await expect(page.locator(".result .alert")).toHaveCount(0)
  await shot(page, "N8a2-retarget-failed")
})

test("a partly paid invoice offers no cancel, and the steps skip what an order does not have", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("part"), { method: "btc" })
  await expect(page.getByText("Cancel this invoice")).toBeVisible()
  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText("Part of the payment arrived")).toBeVisible()
  await expect(page.getByText("Cancel this invoice")).toHaveCount(0)
  await expect(page.locator(".crumb.on")).toHaveText("4Payment")
  await expect(page.locator(".crumb.done")).toHaveCount(3)
})

test("Your names tells part-paid and confirming orders from unpaid ones, and a new invoice replaces an unpaid one", async ({ page, request }) => {
  const [part, seen, plain] = [uniqueLabel("pp"), uniqueLabel("cf"), uniqueLabel("np")]
  const partOrder = await startOrder(page, part, { method: "btc" })
  await control(request, `partial/${partOrder.invoiceId}`)
  const seenOrder = await startOrder(page, seen, { method: "xmr" })
  await control(request, `confirming/${seenOrder.invoiceId}`)
  const plainOrder = await startOrder(page, plain, { method: "btc" })
  await control(request, `expire/${plainOrder.invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice expired" })).toBeVisible()
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== plainOrder.invoiceId)
  await page.goto("/#/names")
  const chipOf = (label: string) => page.locator(".row-item:visible", { hasText: `${label}.simplex` }).locator(".chip")
  await expect(chipOf(part)).toHaveText("Waiting for the rest")
  await expect(chipOf(seen)).toHaveText("Confirming payment")
  await expect(chipOf(plain)).toHaveText("Waiting for payment")
  await shot(page, "N12e-history-phases")
})

test("after taking a code, the other-name search says the payment became a code", async ({ page, request }) => {
  const label = uniqueLabel("tcode")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: 120_000 })
  const registrationId = (await (await request.get(`http://127.0.0.1:8099/api/invoice/${invoiceId}`)).json()).registration.id
  await page.getByRole("button", { name: "Take a code" }).click()
  await expect(page.getByRole("heading", { name: "Here is a code instead" })).toBeVisible()
  await page.goto(`/#/?retarget=${registrationId}`)
  await expect(page.getByText("Your payment already became a code.")).toBeVisible()
  // the search is a plain one now, so a prepaid code applies
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await page.getByRole("button", { name: "Use this code" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("tcn"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Code applied")).toBeVisible()
})

test("full storage that still reads is warned about before the name code is shown", async ({ browser }) => {
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
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText("This browser will not keep your name code")).toBeVisible()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByText("This browser will not keep your name code")).toBeVisible()
  await expect(page.getByText("Your saved copy will be the only one.")).toBeVisible()
  await context.close()
})

test("Forget everything also drops the tab's unfinished checkout", async ({ page }) => {
  await search(page, uniqueLabel("forget"))
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByTestId("owner-code")).toBeVisible()
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").click()
  await page.getByRole("button", { name: "Forget everything" }).click()
  await page.goto("/#/checkout/code")
  await expect(page.getByRole("heading", { name: "Own your name" })).toBeVisible()
  await page.goto("/#/names")
  await expect(page.getByText("No names in this browser yet.")).toBeVisible()
})

test("a payment that arrives after expiry turns the open page into the refund page, and no new invoice is made", async ({ page, request }) => {
  const label = uniqueLabel("late")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice expired" })).toBeVisible()
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Paid after the invoice closed" })).toBeVisible()
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toHaveCount(1)
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` }).locator(".sub")).toContainText("support refunds it")
})

test("an order left before its wait ends asks for this browser in Your names", async ({ page, request }) => {
  const label = uniqueLabel("left")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await page.goto("/#/")
  await control(request, `settle/${invoiceId}`)
  await page.waitForTimeout(16_000)
  await page.goto("/#/names")
  const row = page.locator(".row-item", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Open to finish")
  await row.locator(".small-btn", { hasText: /^Open$/ }).click()
  await waitRegistered(page, label)
})

test("a name typed with .simplex is searched without it", async ({ page }) => {
  await search(page, "Bakery.simplex")
  await expect(page.locator(".result .entity")).toHaveCount(2)
})

test("search points at this browser's open order for a name instead of a second one", async ({ page }) => {
  const label = uniqueLabel("own")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await search(page, label)
  await expect(page.getByText("You already have an order for this name")).toBeVisible()
  await expect(page.getByRole("button", { name: "Register" })).toBeDisabled()
  await expect(page.getByRole("link", { name: "Open that order" })).toHaveAttribute("href", `/?order=${invoiceId}`)
  await shot(page, "N2f-own-order")
})

test("a code checked from the header applies to the checkout in progress", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await search(page, uniqueLabel("hdr"))
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await page.getByRole("button", { name: "Use this code" }).click()
  await expect(page.getByText("Paid with your code")).toBeVisible()
  await expect(page.locator(".total")).toContainText("$0.00")
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

test("pages with an order card stack its columns at tablet width rather than scroll sideways", async ({ page }) => {
  const width = () => page.evaluate(() => document.documentElement.scrollWidth)
  // just above the width where the columns stack, a link preview must not push the order card off the page
  await page.setViewportSize({ width: 870, height: 900 })
  await search(page, uniqueLabel("wide"))
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByLabel("Address").fill(contactLink("wide"))
  const entity = page.locator(".link-field").first().locator(".entity")
  await expect(entity).toBeVisible()
  expect(await width()).toBeLessThanOrEqual(870)
  // the link's text gives way to the name it belongs to instead of running over it
  const who = (await entity.locator(".who").boundingBox())!
  const url = await entity.locator(".url").boundingBox()
  if (url) expect(who.x + who.width).toBeLessThanOrEqual(url.x)
  // the name keeps its line rather than wrap word by word under a squeezed column
  expect(await entity.locator(".who b").evaluate((b) => { const r = document.createRange(); r.selectNodeContents(b); return r.getClientRects().length })).toBe(1)
  await page.goto("/")
  await page.setViewportSize({ width: 700, height: 900 })
  await search(page, uniqueLabel("tab"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
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
    const title = page.locator(".row-item .main b", { hasText: label })
    await expect(title).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    // beside the chip on a wide screen, above it once the row stacks: the name never runs under it
    // read once the row's state is in, as the chip widens from "Checking" and the name gives way to it
    const chip = page.locator(".row-item", { hasText: label }).locator(".chip")
    await expect(chip).toHaveText("Waiting for payment")
    // read together, once the brand font is in: the fallback's widths differ a little, and a page under load swaps late
    await page.evaluate(() => document.fonts.ready)
    const [t, c] = await page.evaluate((label) => {
      const row = [...document.querySelectorAll(".row-item")].find((r) => r.textContent!.includes(label))!
      return [row.querySelector(".main b")!.getBoundingClientRect(), row.querySelector(".chip")!.getBoundingClientRect()].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
    }, label)
    expect(t.x + t.width <= c.x || t.y + t.height <= c.y, `${width}px: name ${JSON.stringify(t)}, chip ${JSON.stringify(c)}`).toBe(true)
    await expect(title).toHaveAttribute("title", `${label}.simplex`)
  }
})

test("paying by card during an outage keeps the order on screen", async ({ page }) => {
  await startOrder(page, uniqueLabel("offpay"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await page.route("**/api/**", (route) => route.abort())
  await page.getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByRole("heading", { name: "Paying by card" })).toBeVisible()
  await page.waitForTimeout(4000)
  await expect(page.getByRole("heading", { name: "This order could not be loaded" })).toHaveCount(0)
  await page.unroute("**/api/**")
})

test("a link preview the service cannot answer now is checked again by itself", async ({ page }) => {
  let refused = 0
  await page.route("**/api/link/preview", async (route) => {
    if (refused++ === 0) return route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } })
    return route.continue()
  })
  await search(page, uniqueLabel("prev"))
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByLabel("Address").fill(contactLink("prev"))
  await expect(page.locator(".field-error [aria-hidden=true]", { hasText: /The link could not be checked now/ })).toBeVisible()
  await expect(page.locator(".link-field").first().locator(".entity")).toBeVisible({ timeout: 10_000 })
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
  await expect(page.getByRole("heading", { name: "Invoice expired" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toBeDisabled()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  // the other actions of the tab wait too: search is paused, and a restore would wait
  await page.getByRole("link", { name: "Search" }).click()
  await expect(page.getByText("Searching is paused until then")).toBeVisible()
  await page.getByRole("link", { name: "Your names" }).click()
  await page.getByRole("button", { name: /Restore with a name code/ }).click()
  await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled()
})

test("Back from a paused order keeps the order paused", async ({ page }) => {
  await search(page, uniqueLabel("pause"))
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await page.getByText("I have saved my code").click()
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "20" }, json: { error: "rate_limited" } }) : route.continue())
  await page.getByRole("button", { name: "Continue to payment" }).click()
  await expect(page.getByText("ordering is paused")).toBeVisible()
  await page.goBack()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("button", { name: "Continue to payment" })).toBeDisabled()
  await expect(page.getByText("Too many attempts")).toBeVisible()
})

test("a popup stays open while its page draws itself again", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("pop"), { method: "btc" })
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill("SN6-")
  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText(/BTC is seen/)).toBeVisible()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Code", exact: true })).toHaveValue("SN6-")
  // typing carries on in the field: the redraw kept its focus
  await page.keyboard.type("AB")
  await expect(page.getByRole("textbox", { name: "Code", exact: true })).toHaveValue("SN6-AB")
})

test("a link still being checked is kept when a code is applied from the header popup", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.route("**/api/link/preview", async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue() })
  await search(page, uniqueLabel("keep"))
  await page.getByRole("button", { name: "Register" }).click()
  const link = contactLink("keep")
  await page.getByLabel("Address").fill(link)
  await page.getByText("Check a code").click()
  await page.getByRole("textbox", { name: "Code", exact: true }).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.getByRole("button", { name: "Use this code" }).click()
  await expect(page.getByText("Paid with your code")).toBeVisible()
  await expect(page.getByLabel("Address")).toHaveValue(link)
  await expect(page.locator(".link-field").first().locator(".entity")).toBeVisible({ timeout: 10_000 })
})

test("Find the order shows a wait met elsewhere in the tab", async ({ page, request }) => {
  await search(page, uniqueLabel("findh"))
  await page.getByRole("button", { name: "Register" }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByTestId("owner-code")).toBeVisible()
  await control(request, "search", { findLimitSeconds: 20 })
  await page.goto("/#/restore")
  await page.getByLabel("Name code").fill((await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:pending:"))!.split(":").pop()))!)
  await page.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await page.getByRole("link", { name: "Your names" }).click()
  await expect(page.locator(".row-item .chip", { hasText: /Try again in \d+ seconds/ })).toBeVisible()
  await expect(page.getByText("Find the order")).toHaveAttribute("aria-disabled", "true")
  await control(request, "search", { findLimitSeconds: 0 })
})

