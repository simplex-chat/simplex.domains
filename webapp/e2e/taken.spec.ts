import { expect } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { labelHash } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import { dateOf } from "../src/format.ts"
import {
  addNameCode, answersReserved, agreeToTerms, control, failedOrder, FIT_SIZES, keepOrder, MOCK, mockRegistration, onStep, REGISTRATION_MS, registrationOf,
  registrationView, offCentre, search, searchName, sevenLetters, shot, startOrder, takenHeading, takenOrder, test, uniqueLabel, waitRegistered,
} from "./helpers.ts"

// an order this browser keeps, answered paid with the registration given
async function paidOrder(page: Parameters<typeof keepOrder>[0], id: string, reg: Record<string, unknown>): Promise<void> {
  const order = await keepOrder(page, `reg-${id}`, `inv-${id}`, "alicebakery")
  const invoice = { invoiceId: `inv-${id}`, status: "paid", amount: 10000, currency: "usd", expiresAt: new Date().toISOString(), kind: "name", registration: registrationView(order, reg),
    cryptoCurrency: "btc", cryptoAmount: "0.00156", cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true, address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s" }
  await page.route(`**/api/invoice/inv-${id}*`, (route) => route.fulfill({ json: invoice }))
  await page.route(`**/api/registration/reg-${id}*`, (route) => route.fulfill({ json: invoice.registration }))
  await page.goto(`/?order=inv-${id}`)
}

test("an order another buyer's paid order took first shows no stage done, as it never committed", async ({ page }) => {
  await paidOrder(page, "outpaid", { phase: { type: "taken" }, balance: { amount: 10000, refunded: 0 } })
  await expect(onStep(page).locator(".screen-head .lead")).toHaveText("Another buyer paid for it first.")
  await expect(onStep(page).locator(".stage.done")).toHaveCount(0)
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Committing")
})

test("a taken order past the month from its payment offers only a refund, and another name as a new order", async ({ page }) => {
  await paidOrder(page, "month", { phase: { type: "taken", heldUntil: new Date(Date.now() - 60_000).toISOString() }, commitTx: "0x02", balance: { amount: 10000, refunded: 0 } })
  await expect(onStep(page).locator(".notice", { hasText: "What you paid is kept as your balance." }))
    .toHaveText("What you paid is kept as your balance. You can ask for a refund. Your names shows the balance.")
  await expect(onStep(page).getByText("Get a refund")).toBeVisible()
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  expect(page.url()).not.toContain("retarget")
})

test("a paid order whose signature the service refused says to contact support in a whole sentence", async ({ page }) => {
  await paidOrder(page, "refused", { phase: { type: "failed", reason: "signatureRefused" }, commitTx: "0x02" })
  await expect(onStep(page).locator(".notice", { hasText: "The name could not be registered" })).toContainText("and include order reference inv-refused.")
})

test("a name taken first keeps its payment as its balance, with which the order moves to another name owned by the same code", async ({ page, request }) => {
  const label = uniqueLabel("tk")
  const { invoiceId, ownerCode } = await takenOrder(page, request, label)
  await expect(onStep(page).locator(".notice", { hasText: "What you paid is kept as your balance." })).toBeVisible()
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Taken")
  await expect(page.getByText(`Reference ${invoiceId}`)).toBeVisible()
  await shot(page, "N8-taken")
  // a browser without the order's code says where to add it, and offers neither the move nor the refund
  const elsewhere = await page.context().browser()!.newContext()
  const stranger = await elsewhere.newPage()
  await stranger.goto(`/?order=${invoiceId}`)
  await expect(stranger.getByText("Add it in Check your code to use the balance.")).toBeVisible()
  await expect(onStep(stranger).getByRole("button", { name: "Choose another name" })).toBeDisabled()
  await expect(onStep(stranger).getByText("Get a refund")).toHaveCount(0)
  await elsewhere.close()

  await page.getByRole("button", { name: "Choose another name" }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]retarget=${await registrationOf(request, invoiceId)}`))
  const next = uniqueLabel("tk2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .line", { hasText: "Covered by your payment" })).toBeVisible()
  await shot(page, "N8a-another-name")
  await agreeToTerms(page)
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await waitRegistered(page, next)
  const answer = await searchName(request, next)
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
})

test("a paid order whose name was reserved meanwhile says so, and keeps its payment as its balance", async ({ page, request }) => {
  const label = uniqueLabel("prs")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await answersReserved(page, label)
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `${label}.simplex is reserved` })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(onStep(page).locator(".lead")).toHaveText("It was reserved meanwhile, so it can't be registered.")
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Reserved")
  await expect(onStep(page).locator(".notice", { hasText: "What you paid is kept as your balance." })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Choose another name" })).toBeEnabled()
})

test("a taken order offers another name for it without searching its own name", async ({ page, request }) => {
  const label = uniqueLabel("fg")
  const { invoiceId } = await takenOrder(page, request, label)
  const registrationId = await registrationOf(request, invoiceId)
  const searched: string[] = []
  page.on("request", (r) => { if (r.url().includes(`/api/name/${hex(labelHash(label))}`)) searched.push(r.url()) })
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]retarget=${registrationId}`))
  await expect(page.getByText("You paid $100: choose another name at that price.")).toBeVisible()
  expect(searched).toEqual([])
})

// a wait on moving the payment that ends while the search gone back to is still out, and that search's answer
const MOVE_WAIT_S = 3
const SEARCH_RTT_MS = 5_000

test("a wait on moving the payment that ends while Back checks the name again sends no second search", async ({ page, request }) => {
  const { invoiceId } = await takenOrder(page, request, uniqueLabel("tw"))
  await page.goto(`/#/?retarget=${await registrationOf(request, invoiceId)}`)
  const next = uniqueLabel("tw2")
  // an order this browser made for the name before, which has Back check the name again
  await page.evaluate(({ label, hash }) => localStorage.setItem("simplex-names:order:reg-before", JSON.stringify({
    registrationId: "reg-before", invoiceId: null, label, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    contact: "", channel: "", method: "code", paid: 0, years: 2, tld: "simplex", createdAt: new Date().toISOString(),
    request: { labelHash: hash, length: label.length, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: "0x01", sealed: "sealed" },
  })), { label: next, hash: hex(labelHash(next)) })
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Covered by your payment")).toBeVisible()
  await page.route("**/name", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": String(MOVE_WAIT_S) }, json: { type: "rate_limited" } }) : route.continue())
  await agreeToTerms(page)
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  let searches = 0
  await page.route("**/api/name/**", async (route) => {
    searches++
    await new Promise((answered) => setTimeout(answered, SEARCH_RTT_MS))
    await route.continue()
  })
  await page.locator("body > footer").getByRole("link", { name: "Trademark owners" }).click()
  await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
  await page.goBack()
  await expect(page.locator(".answer .line", { hasText: "Checking the name…" })).toBeVisible()
  await expect(page.getByText("Covered by your payment")).toBeVisible({ timeout: 2 * SEARCH_RTT_MS })
  expect(searches, "searches sent since Back").toBe(1)
})

test("a name an order holds is searched as that order in its browser, and as taken with nothing more in another", async ({ page, browser, request }) => {
  const label = uniqueLabel("hd")
  const { invoiceId } = await failedOrder(page, request, label)
  await search(page, label)
  const own = page.locator(".answer .line", { hasText: "You already have an order for this name." })
  await expect(own).toBeVisible()
  await expect(own.getByRole("link", { name: "Open that order" })).toHaveAttribute("href", new RegExp(`order=${invoiceId}`))
  await expect(page.locator(".answer").getByText("Taken", { exact: true })).toHaveCount(0)
  const other = await browser.newContext()
  const stranger = await other.newPage()
  await search(stranger, label)
  await expect(stranger.locator(".answer .card.row")).toContainText("Taken")
  await expect(stranger.locator(".answer .line")).toHaveCount(0)
  await other.close()
})

test("a failed registration keeps its payment for support, also in another tab", async ({ page, request }) => {
  const label = uniqueLabel("fl")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `fail/${await registrationOf(request, invoiceId)}`)
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 60_000 })
  // the page's sentence for the service's reason, then what the buyer can do, with support's address for the reference below
  const alert = onStep(page).locator(".notice", { hasText: "The name could not be registered" })
  // the lead above already says the payment is kept
  await expect(onStep(page).locator(".screen-head .lead")).toHaveText("Your payment is kept. Write to support.")
  await expect(alert).toHaveText(`The name could not be registeredContact support via chat@simplex.chat or SimpleX, and include order reference ${invoiceId}.`)
  await expect(alert.getByRole("link", { name: "chat@simplex.chat" })).toHaveAttribute("href", "mailto:chat@simplex.chat")
  await expect(alert.getByRole("link", { name: "SimpleX", exact: true })).toHaveAttribute("href", /^https:\/\/smp6\.simplex\.im\/a#/)
  // the order's line centred under the heading and its lead, as it is when it is the lead
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await offCentre(onStep(page).locator(".screen-body > .note").first()), `the order's line at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, "N9-failed")
  const other = await page.context().newPage()
  await other.goto(`/?order=${invoiceId}`)
  await expect(other.getByRole("heading", { name: "Paid, not registered" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Choose another name" })).toHaveCount(0)
})

test("an order whose commitment lapses before its page signs is committed again by that page, which signs it then", async ({ page, request }) => {
  const label = uniqueLabel("lps")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await page.route("**/api/registration/*/reveal", (route) => route.abort())
  await control(request, `stale/${await registrationOf(request, invoiceId)}`)
  await control(request, `settle/${invoiceId}`)
  await expect.poll(async () => (await mockRegistration(request, invoiceId)).phase, { timeout: REGISTRATION_MS }).toBe("committed")
  const retried = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/retry"))
  await control(request, `lapse/${await registrationOf(request, invoiceId)}`)
  await retried
  await page.unrouteAll({ behavior: "wait" })
  await waitRegistered(page, label)
})

test("an order failed while its page was not read says until when the name stays its, and Continue signs it again and registers it", async ({ page, request }) => {
  const label = uniqueLabel("unr")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  const registrationId = await registrationOf(request, invoiceId)
  await page.route("**/api/registration/*/reveal", (route) => route.abort())
  await control(request, `stale/${registrationId}`)
  await control(request, `settle/${invoiceId}`)
  await expect.poll(async () => {
    const { phase, label: revealed } = await mockRegistration(request, invoiceId)
    return phase === "committed" && revealed === null
  }, { timeout: REGISTRATION_MS }).toBe(true)
  await control(request, `unread/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: REGISTRATION_MS })
  const view = await (await request.get(`${MOCK}/api/registration/${registrationId}`)).json() as { phase: { heldUntil: string } }
  const until = dateOf(Date.parse(view.phase.heldUntil) / 1000)
  await expect(onStep(page).locator(".notice", { hasText: "The order was not opened for 3 days" })).toHaveText(
    `The order was not opened for 3 daysYour payment is received. Until ${until}, this service accepts no other order for the name. Choose Continue to sign the registration again, or contact support via chat@simplex.chat or SimpleX, and include order reference ${invoiceId}.`)
  await expect(page.getByRole("button", { name: "Choose another name" })).toHaveCount(0)
  await page.unrouteAll({ behavior: "wait" })
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await waitRegistered(page, label)
})

// a chain that fails each transaction before it goes out, as an RPC provider down for a while, and a look half way through
const UNSENT_S = 4
const UNSENT_CHECK_MS = UNSENT_S * 1000 / 2
test("a chain that sends nothing for a moment keeps the order where it was, then registers it", async ({ page, request }) => {
  const label = uniqueLabel("ns")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: UNSENT_S })
    await control(request, `settle/${invoiceId}`)
    await page.waitForTimeout(UNSENT_CHECK_MS)
    // tried again every few seconds, the commit neither fails nor goes back to the queue
    expect((await mockRegistration(request, invoiceId)).phase).toBe("committing")
    await expect(page.locator(".stage.active", { hasText: "Committing" })).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await waitRegistered(page, label)
})

test("a chain that sends nothing for longer than its resends fails the order in plain words, leaving it to support", async ({ page, request }) => {
  test.setTimeout(240_000)
  const label = uniqueLabel("nd")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: 120 })
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText("The name could not be registered", { exact: true })).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await expect(onStep(page).locator(".screen-head .lead")).toHaveText("Your payment is kept. Write to support.")
  await expect(page.getByRole("button", { name: "Choose another name" })).toHaveCount(0)
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
  await expect(page.getByRole("heading", { name: takenHeading(label) })).toBeVisible({ timeout: REGISTRATION_MS })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole("button", { name: "Choose another name" }).click()
  const next = uniqueLabel("adopt2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await agreeToTerms(page)
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await waitRegistered(page, next)

  // another browser restores the code, which finds the name it registered, and opens the moved order
  const other = await browser.newContext()
  const restored = await other.newPage()
  await addNameCode(restored, ownerCode)
  await restored.goto(`/?order=${second}`)
  await waitRegistered(restored, next)
  await control(request, `partial/${invoiceId}`)
  await restored.goto(`/?order=${invoiceId}`)
  await expect(restored.getByText(/BTC arrived, which is not the full amount/)).toBeVisible()
  await restored.goto("/#/names")
  // the taken order and the replaced one that the money reached each have a row of the name
  await expect(restored.locator(".list-row:visible", { hasText: `${label}.simplex` }).filter({ hasText: "Part of the payment arrived; kept as your balance" })).toHaveCount(1)
  await restored.goto(`/?order=${invoiceId}`)
  await restored.getByRole("button", { name: "Open the new invoice" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await other.close()

  // the name someone else registered, searched at phone width, wraps inside its card
  await page.goto(`/#/?name=${label}`)
  await expect(page.getByText("Taken", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})


test("a taken order is offered no name of another price, cheaper or dearer", async ({ page, request }) => {
  const { invoiceId } = await takenOrder(page, request, sevenLetters())
  await page.goto(`/#/?retarget=${await registrationOf(request, invoiceId)}`)
  await expect(page.getByText("You paid $200: choose another name at that price.")).toBeVisible()
  for (const [label, words] of [[uniqueLabel("cheap"), "less"], [`q${Math.random().toString(36).slice(2, 7).padEnd(5, "q")}`, "more"]]) {
    await page.getByLabel("Name", { exact: true }).fill(label)
    await page.getByLabel("Name", { exact: true }).press("Enter")
    await expect(page.locator(".answer .line", { hasText: "This name costs" })).toHaveText(`This name costs ${words} than the $200 you paid.`)
    await expect(page.getByRole("button", { name: "Register with your payment" })).toBeDisabled()
  }
})
