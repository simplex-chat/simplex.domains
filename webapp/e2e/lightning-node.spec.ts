import { expect, type Page } from "@playwright/test"
import { onStep, qrText, startOrder, test, uniqueLabel, waitRegistered } from "./helpers.ts"

const PAYER_URL = process.env.LIGHTNING_PAYER_URL
const PAYMENT_SECONDS = 60
const FEE_LIMIT_SAT = "1000"
const SUCCEEDED = "SUCCEEDED"
const PAYMENT_READ_MS = 60_000

test.skip(PAYER_URL === undefined, "needs LIGHTNING_PAYER_URL, a payer's Lightning node beside the service and its BTCPay")

const walletLink = (page: Page) => onStep(page).getByRole("link", { name: "Open in wallet" })

async function scannedInvoice(page: Page): Promise<string> {
  const link = await walletLink(page).getAttribute("href")
  expect(link, "the wallet link").toMatch(/^lightning:lnbcrt/)
  expect(await qrText(onStep(page).locator(".card.pay .qr svg")), "the QR code").toBe(link)
  return link!.slice("lightning:".length)
}

async function payAtNode(bolt11: string): Promise<void> {
  const res = await fetch(`${PAYER_URL}/v2/router/send`, {
    method: "POST",
    body: JSON.stringify({ payment_request: bolt11, timeout_seconds: PAYMENT_SECONDS, fee_limit_sat: FEE_LIMIT_SAT, no_inflight_updates: true }),
  })
  const answer = await res.text()
  const last = answer.trim().split("\n").at(-1)!
  expect((JSON.parse(last) as { result?: { status?: string } }).result?.status, answer).toBe(SUCCEEDED)
}

test("a name ordered with Lightning is registered once its invoice, scanned from the page, is paid at a Lightning node", async ({ page }) => {
  const label = uniqueLabel("lnnode")
  await startOrder(page, label, { method: "ln" })
  await expect(page.getByRole("heading", { name: "Pay with Lightning" })).toBeVisible()
  await payAtNode(await scannedInvoice(page))
  await waitRegistered(page, label)
})

test("a cancelled Lightning order, its invoice paid at a node afterwards, is shown as paid late", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("lnlate"), { method: "ln" })
  const bolt11 = await scannedInvoice(page)
  await page.getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(page.getByText(/^This invoice was cancelled and nothing was received\. Its Lightning invoice can still be paid until \d\d:\d\d: don't pay it\.$/)).toBeVisible()
  await payAtNode(bolt11)
  await expect(async () => {
    await page.goto(`/?order=${invoiceId}`)
    await expect(page.getByText("The payment arrived after this invoice had closed")).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: PAYMENT_READ_MS })
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
})
