import { expect, type Locator, type Page } from "@playwright/test"
import { MAX_LABEL_LENGTH } from "../src/names.ts"
import {
  addNameCode, control, FIT_SIZES, keepOrder, onStep, sevenLetters, shot, takenOrder, registrationView, test, uniqueLabel,
} from "./helpers.ts"

const balanceRow = (page: Page) => onStep(page).locator(".list-row[data-key^='balance-']")
const WITH_PROOF = "Copy the order reference and address proof for support"

// Your names, its rows read
async function yourNames(page: Page): Promise<void> {
  await page.goto("/#/names")
  await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(onStep(page).locator(".chip", { hasText: "Checking" })).toHaveCount(0)
}

// whether a row's actions stand beside its words rather than under them, and how far their middle is from the row's
const actionsBeside = (row: Locator) => row.evaluate((r) => {
  const [box, words, acts] = [r, r.querySelector(".main")!, r.querySelector(".acts")!].map((n) => n.getBoundingClientRect())
  return { beside: acts.left >= words.right, offMiddle: Math.round(Math.abs((acts.top + acts.bottom) / 2 - (box.top + box.bottom) / 2)) }
})

// The least room between a line of a row's words, as drawn, and a chip or action level with it; Infinity when none is.
const wordsRoom = (row: Locator) => row.evaluate((r) => {
  const range = document.createRange()
  range.selectNodeContents(r.querySelector(".main")!)
  const words = [...range.getClientRects()]
  const beside = [...r.querySelectorAll(":scope > .state, :scope > .acts > *")].map((n) => n.getBoundingClientRect()).filter((b) => b.width > 0)
  const level = words.flatMap((w) => beside.filter((b) => Math.min(w.bottom, b.bottom) > Math.max(w.top, b.top)).map((b) => b.left - w.right))
  return Math.round(Math.min(Infinity, ...level))
})
// the windows a balance row is drawn in: a laptop's and three phones', down to the narrowest
const ROW_SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 360, height: 780 }, { width: 320, height: 640 }]
// the room a list row keeps between its parts (styles.css .list-row .acts)
const ROW_GAP = 14

test("a paid order taken first keeps its price as its balance, which support refunds", async ({ page, request }) => {
  const label = sevenLetters()
  const { invoiceId } = await takenOrder(page, request, label)
  await expect(onStep(page).getByRole("button", { name: WITH_PROOF }), "the taken order's page gives support its address proof").toBeVisible()
  await yourNames(page)
  await expect(balanceRow(page)).toHaveCount(1)
  await expect(balanceRow(page).locator(".main")).toHaveText(`$200From ${label}.simplex, someone has taken this name`)
  // the order taken first is no name of this browser's: its balance alone stands for it
  await expect(onStep(page).locator(".list-row", { hasText: `${label}.simplex` })).toHaveCount(1)
  await shot(page, "B1-names-balance")
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await actionsBeside(balanceRow(page)), `Refund beside the balance's words, centred on its row, at ${size.width}x${size.height}`).toEqual({ beside: true, offMiddle: 0 })
  }
  await page.setViewportSize(FIT_SIZES[0])

  // support refunds by hand, on a message quoting the reference
  await expect(balanceRow(page).getByRole("button", { name: "Refund" })).toHaveAttribute("aria-haspopup", "dialog")
  await balanceRow(page).getByRole("button", { name: "Refund" }).click()
  const popup = page.getByRole("dialog", { name: "Refund" })
  await expect(popup).toContainText(`Contact support via chat@simplex.chat or SimpleX, and include order reference ${invoiceId}. Support refunds what is left of your balance.`)
  await expect(popup.locator(".code-text")).toHaveText(invoiceId)
  await expect(popup.getByRole("button", { name: WITH_PROOF }), "a Bitcoin order's copy holds its address proof").toBeFocused()
  await shot(page, "B2-refund")
  await popup.getByRole("button", { name: "Close" }).click()
  await expect(balanceRow(page).getByRole("button", { name: "Refund" })).toBeFocused()
})

test("the name code shows the balance in another browser, and a refund support records shows as refunded, after which no name is selected for the order", async ({ page, browser, request }) => {
  const label = uniqueLabel("bref")
  const { invoiceId, ownerCode } = await takenOrder(page, request, label)
  const kept = `$100From ${label}.simplex, someone has taken this name`
  const other = await browser.newContext()
  const restored = await other.newPage()
  await addNameCode(restored, ownerCode)
  await expect(onStep(restored).locator(".list-row[data-key^='balance-'] .main")).toHaveText(kept)
  await expect(onStep(restored).locator(".list-row[data-key^='balance-']").getByRole("button", { name: "Refund" })).toBeVisible()
  await other.close()

  await control(request, `refund/${invoiceId}`)
  await yourNames(page)
  await expect(balanceRow(page).locator(".main")).toHaveText(`$0From ${label}.simplex, someone has taken this name · refunded $100 by support`)
  await expect(balanceRow(page).getByRole("button")).toHaveCount(0)

  await page.goto(`/?order=${invoiceId}`)
  await expect(onStep(page).locator(".notice", { hasText: "What you paid went to your balance." })).toHaveText("What you paid went to your balance. It has been refunded since; Your names shows it.")
  await expect(onStep(page).getByText("Get a refund")).toHaveCount(0)
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(page.getByRole("heading", { name: "Your SimpleX domain" })).toBeVisible()
  expect(page.url()).not.toContain("order=")
})

// the service worker of a production build answers these pages before Playwright's routes in WebKit
test.describe(() => {
  test.use({ serviceWorkers: "block" })
  test(`a balance of a name of ${MAX_LABEL_LENGTH} wide letters keeps its words clear of its Refund, beside it or above, down to a 320 px phone`, async ({ page }) => {
    const order = await keepOrder(page, "reg-balrow", "inv-balrow", "w".repeat(MAX_LABEL_LENGTH))
    const view = registrationView(order, { phase: { type: "taken" }, commitTx: "0x02", balance: { amount: 10000, refunded: 0 } })
    await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { type: "not_found" } }))
    await page.route("**/api/config", (route) => route.continue())
    await page.route("**/api/registration/reg-balrow*", (route) => route.fulfill({ json: view }))
    await page.route("**/api/invoice/inv-balrow*", (route) => route.fulfill({ json: { invoiceId: "inv-balrow", status: "paid", amount: 10000, currency: "usd",
      expiresAt: new Date(Date.now() - 1000).toISOString(), kind: "name", registration: view, cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bcrt1q", paidInFull: true } }))
    for (const size of ROW_SIZES) {
      await page.setViewportSize(size)
      await page.goto("/#/trademarks")
      await page.goto("/#/names")
      await expect(balanceRow(page)).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      expect(await wordsRoom(balanceRow(page)), `the room between the words and what is level with them at ${size.width}x${size.height}`).toBeGreaterThanOrEqual(ROW_GAP)
      if (size.width >= ROW_SIZES[1].width) expect(await actionsBeside(balanceRow(page)), `Refund beside the words at ${size.width}x${size.height}`).toEqual({ beside: true, offMiddle: 0 })
    }
  })
})
