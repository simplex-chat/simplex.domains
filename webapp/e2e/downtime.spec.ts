import { expect, type Page } from "@playwright/test"
import {
  AGREE, agreeToTerms, ALTERNATE_GENERAL_TERMS, CHECKOUT_KEY, control, loads, onStep, payButton, startOrder, test, toFullReview, uniqueLabel, waitRegistered,
} from "./helpers.ts"

const RELOAD_MS = 1000

const becomeVisible = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
const configRead = (page: Page) => page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config")
const readOnView = (page: Page) => Promise.all([configRead(page), becomeVisible(page)])
const reloadedOnView = (page: Page) => Promise.all([page.waitForEvent("load"), becomeVisible(page)])

async function inDowntime(page: Page, downtime: boolean): Promise<void> {
  await page.unroute("**/api/config")
  await page.route("**/api/config", (route) => route.fulfill({ json: { stripePublishableKey: null, names: { downtime } } }))
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
