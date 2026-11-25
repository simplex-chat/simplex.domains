import { type APIRequestContext, expect } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { labelHash } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import { dateOf } from "../src/format.ts"
import {
  addNameCode, answersReserved, control, failedOrder, FIT_SIZES, keepOrder, MOCK, mockRegistration, onStep, REGISTRATION_MS, registrationOf,
  registrationView, offCentre, search, searchName, selectedToReview, sevenLetters, shot, startOrder, takenHeading, takenOrder, test, uniqueLabel, waitRegistered,
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

const phaseOf = async (request: APIRequestContext, invoiceId: string) => ((await (await request.get(`${MOCK}/control/invoice/${invoiceId}`)).json()) as { registration: { phase: { type: string } } }).registration.phase.type

test("an order another buyer's paid order took first shows no stage done, as it never committed", async ({ page }) => {
  await paidOrder(page, "outpaid", { phase: { type: "taken" }, balance: { amount: 10000, refunded: 0 } })
  await expect(onStep(page).locator(".screen-head .lead")).toHaveText("Someone has taken this name.")
  await expect(onStep(page).locator(".stage.done")).toHaveCount(0)
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Committing")
})

test("a paid order whose signature the service refused says to contact support in a whole sentence", async ({ page }) => {
  await paidOrder(page, "refused", { phase: { type: "failed", reason: "signatureRefused" }, commitTx: "0x02" })
  await expect(onStep(page).locator(".notice", { hasText: "The name could not be registered" })).toContainText("and include order reference inv-refused.")
})

test("a name taken first keeps its payment as its balance, with which a name selected for the order is registered, owned by the same code", async ({ page, request }) => {
  const label = uniqueLabel("tk")
  const { invoiceId, ownerCode } = await takenOrder(page, request, label)
  await expect(onStep(page).locator(".notice", { hasText: "What you paid is kept as your balance." })).toBeVisible()
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Taken")
  await expect(page.getByText(`Reference ${invoiceId}`)).toBeVisible()
  await shot(page, "N8-taken")
  // a browser without the order's code asks for it, and offers neither the selection nor the refund
  const elsewhere = await page.context().browser()!.newContext()
  const stranger = await elsewhere.newPage()
  await stranger.goto(`/?order=${invoiceId}`)
  await expect(stranger.getByText("This order's name code is not in this browser. Enter it to see the order.")).toBeVisible()
  await expect(onStep(stranger).getByRole("button", { name: "Choose another name" })).toHaveCount(0)
  await expect(onStep(stranger).getByText("Get a refund")).toHaveCount(0)
  await elsewhere.close()

  await page.getByRole("button", { name: "Choose another name" }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]order=${await registrationOf(request, invoiceId)}`))
  const next = uniqueLabel("tk2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .deal"), "a name of the order's price").toHaveText("Paid / 2 years")
  await selectedToReview(page, next)
  await expect(onStep(page).locator(".card.order .trow.total")).toHaveText("TotalPaid")
  await expect(onStep(page).locator(".pay-with"), "the order's payment, no other").toHaveCount(0)
  await expect(onStep(page).getByText("I have a code")).toHaveCount(0)
  await shot(page, "N8a-another-name")
  await onStep(page).getByRole("button", { name: "Register with your payment" }).click()
  await waitRegistered(page, next)
  const answer = await searchName(request, next)
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
  expect(await phaseOf(request, invoiceId), "the same order").toBe("registered")
})

test("a name selected for a taken card order is signed over a card's dispute days and registered", async ({ page, request }) => {
  await takenOrder(page, request, uniqueLabel("tcd"), "card")
  await page.getByRole("button", { name: "Choose another name" }).click()
  const next = uniqueLabel("tcd2")
  await selectedToReview(page, next)
  await onStep(page).getByRole("button", { name: "Register with your payment" }).click()
  await waitRegistered(page, next)
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
  await expect(page).toHaveURL(new RegExp(`[?&]order=${registrationId}`))
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("")
  expect(searched).toEqual([])
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
  await expect(onStep(other).locator(".screen-head .lead")).toHaveText("Your payment is kept. Write to support.")
  for (const tab of [page, other]) {
    await expect(tab.getByRole("button", { name: "Try again" })).toHaveCount(0)
    await expect(tab.getByRole("button", { name: "Choose another name" })).toHaveCount(0)
  }
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
  const view = await (await request.get(`${MOCK}/control/registration/${registrationId}`)).json() as { phase: { heldUntil: string } }
  const until = dateOf(Date.parse(view.phase.heldUntil) / 1000)
  await expect(onStep(page).locator(".notice", { hasText: "The order was not opened for 3 days" })).toHaveText(
    `The order was not opened for 3 daysYour payment is received. Until ${until}, this service accepts no other order for the name. Choose Continue to sign the registration again, or contact support via chat@simplex.chat or SimpleX, and include order reference ${invoiceId}.`)
  await expect(page.getByRole("button", { name: "Choose another name" })).toHaveCount(0)
  await page.unrouteAll({ behavior: "wait" })
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await waitRegistered(page, label)
})

// a chain that fails each transaction before it goes out, as an RPC provider down for a while, and a look half way through
const UNSENT_S = 30
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

test("a late payment to a replaced invoice is kept by a restored browser after another name was selected for the order", async ({ page, browser, request }) => {
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
  await selectedToReview(page, next)
  await onStep(page).getByRole("button", { name: "Register with your payment" }).click()
  await waitRegistered(page, next)

  // another browser restores the code, which finds the name it registered, and opens the order
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


test("a name of another price than a taken order's cannot be registered for it, and its search says the price the payment covers", async ({ page, request }) => {
  const { invoiceId } = await takenOrder(page, request, sevenLetters())
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  const register = onStep(page).getByRole("button", { name: "Register", exact: true })
  for (const [label, price] of [[uniqueLabel("cheap"), "$100"], [`q${Math.random().toString(36).slice(2, 7).padEnd(5, "q")}`, "$400"]]) {
    await page.getByLabel("Name", { exact: true }).fill(label)
    await page.getByLabel("Name", { exact: true }).press("Enter")
    await expect(page.locator(".answer .deal"), "a name of another price shows its price").toHaveText(`${price} / 2 years`)
    await expect(register).toBeDisabled()
    await expect(page.locator(".answer .hint")).toHaveText("Your payment covers names at $200 for 2 years.")
  }
  await page.getByLabel("Name", { exact: true }).fill(sevenLetters())
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .deal"), "a name of the order's price").toHaveText("Paid / 2 years")
  await expect(register).toBeEnabled()
  await expect(page.locator(".answer .hint")).toHaveCount(0)
  expect(await phaseOf(request, invoiceId), "nothing selected").toBe("taken")
})
