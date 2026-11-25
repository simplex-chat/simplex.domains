import { expect, type APIRequestContext, type Page } from "@playwright/test"
import {
  AGREE, agreeToTerms, ALTERNATE_GENERAL_TERMS, CHECKOUT_KEY, control, loads, mockRegistration, onStep, orderedAtMock, payButton, REGISTRATION_MS, registrationOf, search, startOrder, takenOrder,
  test, toFullReview, toReview, uniqueLabel, waitRegistered,
} from "./helpers.ts"

const RELOAD_MS = 1000
const NEW_ORDERS = "New orders open again soon"
const UNSIGNED_MS = 15_000

const becomeVisible = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
const configRead = (page: Page) => page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config")
const readOnView = (page: Page) => Promise.all([configRead(page), becomeVisible(page)])
const reloadedOnView = (page: Page) => Promise.all([page.waitForEvent("load"), becomeVisible(page)])

async function inDowntime(page: Page, downtime: boolean): Promise<void> {
  await page.unroute("**/api/config")
  await page.route("**/api/config", (route) => route.fulfill({ json: { stripePublishableKey: null, names: { downtime } } }))
}

async function serviceInDowntime<T>(request: APIRequestContext, f: () => Promise<T>): Promise<T> {
  await control(request, "downtime", { on: true })
  try {
    return await f()
  } finally {
    await control(request, "downtime", { on: false })
  }
}

const checkoutKept = (page: Page) => page.evaluate((key) => {
  const { label, contact, channel, ownerCode, saved, agreed, step } = JSON.parse(sessionStorage.getItem(key)!)
  return { label, contact, channel, ownerCode, saved, agreed, step }
}, CHECKOUT_KEY)

test("a checkout open as a downtime ends loads again with its name, links, name code and terms", async ({ page }) => {
  await toFullReview(page, uniqueLabel("keep"))
  await page.getByRole("radio", { name: "Bitcoin" }).click()
  const before = await checkoutKept(page)
  expect(before.agreed && before.saved && before.contact && before.channel).toBeTruthy()
  await inDowntime(page, true)
  await readOnView(page)
  await inDowntime(page, false)
  await reloadedOnView(page)
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  expect(await checkoutKept(page)).toEqual(before)
  await expect(onStep(page).getByRole("checkbox", { name: AGREE })).toBeChecked()
  await expect(payButton(page)).toBeEnabled()
})

test("an order's page open as a downtime ends loads again with its invoice, and registers", async ({ page, request }) => {
  const label = uniqueLabel("paid")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await inDowntime(page, true)
  await readOnView(page)
  await inDowntime(page, false)
  await reloadedOnView(page)
  await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
})

test("a page loaded in a downtime loads again as it ends, and only then", async ({ page }) => {
  await inDowntime(page, true)
  await page.goto("/")
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  const seen = loads(page)
  await readOnView(page)
  await page.waitForTimeout(RELOAD_MS)
  expect(seen.count, "still in the downtime").toBe(0)
  await inDowntime(page, false)
  await reloadedOnView(page)
  await readOnView(page)
  await page.waitForTimeout(RELOAD_MS)
  expect(seen.count, "loaded once, as the downtime ended").toBe(1)
})

test("a closed invoice's page holding changed terms ticked again stays as a downtime ends, until the reader leaves it", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("tick"), { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await expect(onStep(page).getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await control(request, "general-terms", { text: ALTERNATE_GENERAL_TERMS })
  try {
    await onStep(page).getByRole("button", { name: "Get a new invoice" }).click()
    await agreeToTerms(page)
    await inDowntime(page, true)
    await readOnView(page)
    await inDowntime(page, false)
    const seen = loads(page)
    await readOnView(page)
    await page.waitForTimeout(RELOAD_MS)
    expect(seen.count, "the tick is in the page only, so the page stays").toBe(0)
    await expect(onStep(page).getByRole("checkbox", { name: AGREE })).toBeChecked()
    await page.locator("body > header").getByRole("link", { name: "Check your code" }).click()
    await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
    expect(seen.count, "the next screen is the page loaded again").toBe(1)
  } finally {
    await control(request, "general-terms", { text: null })
  }
})

test("in the service's downtime the home says new orders open again soon and offers no Register, and Check your order says so, with no order made", async ({ page, request }) => {
  const label = uniqueLabel("down")
  await search(page, label)
  await toReview(page)
  await serviceInDowntime(request, async () => {
    await payButton(page).click()
    await expect(onStep(page).getByRole("heading", { name: NEW_ORDERS })).toBeVisible()
    await search(page, label)
    await expect(onStep(page).locator(".answer .line", { hasText: `${NEW_ORDERS}.` })).toBeVisible()
    await expect(onStep(page).locator(".answer .row")).toBeVisible()
    await expect(onStep(page).getByRole("button", { name: "Register" })).toHaveCount(0)
  })
  expect(await orderedAtMock(request, label), "no order made").toBe(false)
})

test("in the service's downtime a taken order's search for another name offers no Register, and the order stays taken", async ({ page, request }) => {
  const { invoiceId } = await takenOrder(page, request, uniqueLabel("dtk"))
  await serviceInDowntime(request, async () => {
    await page.reload()
    await onStep(page).getByRole("button", { name: "Choose another name" }).click()
    await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("dtn"))
    await page.getByLabel("Name", { exact: true }).press("Enter")
    await expect(onStep(page).locator(".answer .row")).toBeVisible()
    await expect(onStep(page).getByRole("button", { name: "Register" })).toHaveCount(0)
  })
  expect((await mockRegistration(request, invoiceId)).phase).toBe("taken")
})

test("an open invoice's page in the service's downtime withholds its payment details, and shows them once the downtime is over", async ({ page, request }) => {
  await startOrder(page, uniqueLabel("dpay"), { method: "btc" })
  const address = onStep(page).getByText("Bitcoin address")
  await expect(address).toBeVisible()
  await serviceInDowntime(request, async () => {
    await page.reload()
    await expect(onStep(page).getByText("Payment opens again soon.")).toBeVisible()
    await expect(address).toHaveCount(0)
    await expect(onStep(page).locator(".qr")).toHaveCount(0)
  })
  await expect(address).toBeVisible({ timeout: REGISTRATION_MS })
})

test("a committed order signs no reveal in the service's downtime, and is signed and registered once the downtime is over", async ({ page, request }) => {
  const label = uniqueLabel("drev")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `stale/${await registrationOf(request, invoiceId)}`)
  await serviceInDowntime(request, async () => {
    await page.reload()
    await control(request, `settle/${invoiceId}`)
    await expect.poll(async () => (await mockRegistration(request, invoiceId)).phase, { timeout: REGISTRATION_MS }).toBe("committed")
    await page.waitForTimeout(UNSIGNED_MS)
    expect((await mockRegistration(request, invoiceId)).label, "no reveal in the downtime").toBeNull()
    await expect(onStep(page).getByText("The registration is not signed yet.")).toBeVisible()
  })
  await waitRegistered(page, label)
})
