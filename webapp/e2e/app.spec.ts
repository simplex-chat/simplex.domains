import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { randomBytes } from "node:crypto"
import { durationFor, registerIntentDigest, type Registration } from "../src/crypto/registration.ts"
import { checksumAddress, fromHex, hex, signDigest, walletFromEntropy, type Wallet } from "../src/crypto/wallet.ts"
import { control, REGISTRATION_MS, searchName, shot, uniqueLabel } from "./helpers.ts"

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:8099"
const APP_SIGNS = "Waiting for SimpleX to sign the registration with your app's wallet."

async function orderFromApp(page: Page, app: Wallet, label: string, shots = false): Promise<string> {
  await page.goto(`/#/?name=${label}&owner=${checksumAddress(app.address)}`)
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  if (shots) await shot(page, "L1-from-app")
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByText("Point it at your SimpleX")).toHaveCount(0)
  await expect(page.getByText("I have a code")).toHaveCount(0)
  await expect(page.locator(".crumb", { hasText: "Name code" })).toHaveCount(0)
  if (shots) await shot(page, "L2-checkout-from-app")
  await page.getByRole("button", { name: "Continue" }).click()
  await page.waitForURL(/\?order=/)
  return new URL(page.url()).searchParams.get("order")!
}

// The app's part: sign RegisterName with its own key, using the secret the page kept and the order's current nonce.
async function appSigns(page: Page, request: APIRequestContext, app: Wallet, label: string, invoiceId: string): Promise<number> {
  const record = await page.evaluate((l) => Object.keys(localStorage).filter((k) => k.startsWith("simplex-names:order:"))
    .map((k) => JSON.parse(localStorage.getItem(k)!)).find((o: { label: string }) => o.label === l), label)
  const view = (await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json()).registration
  const r: Registration = {
    label, tld: view.tld, owner: app.address, duration: durationFor(view.years), secret: fromHex(record.secret),
    resolver: fromHex(view.resolver), contactLinks: [], channelLinks: [],
  }
  const digest = registerIntentDigest(BigInt(view.chainId), fromHex(view.sponsor), r, BigInt(view.intentNonce), BigInt(view.revealBefore))
  const res = await request.post(`${MOCK}/api/registration/${view.id}/reveal`, {
    data: { label, secret: record.secret, records: { contact: [], channel: [] }, nonce: view.intentNonce, deadline: view.revealBefore, signature: hex(signDigest(app.privateKey, digest)) },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return view.intentNonce
}

test("an order opened from the app registers to the app's wallet once the app signs", async ({ page, request }) => {
  const app = walletFromEntropy(randomBytes(16))
  const label = uniqueLabel("app")
  const invoiceId = await orderFromApp(page, app, label, true)
  await page.goBack()
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goForward()
  // another browser knows the order only from the service, which seals nothing for an app's order
  const elsewhere = await page.context().browser()!.newContext()
  const stranger = await elsewhere.newPage()
  await stranger.goto(`/?order=${invoiceId}`)
  await expect(stranger.locator(".crumb.on")).toHaveText("3Payment")
  await expect(stranger.getByText("The name shows once it is registered")).toBeVisible()
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByText(APP_SIGNS)).toBeVisible({ timeout: 60_000 })
  await expect(stranger.getByText("Keep this page open while SimpleX finishes it.")).toBeVisible()
  await expect(stranger.getByText("Enter your name code")).toHaveCount(0)
  await elsewhere.close()
  await page.goto("/#/names")
  await expect(page.locator(".row-item", { hasText: `${label}.simplex` })).toContainText("Waiting for SimpleX to sign it")
  await page.goto(`/?order=${invoiceId}`)
  await appSigns(page, request, app, label, invoiceId)
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(page.getByRole("button", { name: "Back to SimpleX" })).toBeVisible()
  await shot(page, "L3-registered-to-app")
  expect((await searchName(request, label)).owner).toBe(checksumAddress(app.address))
})

test("an order opened from the app that meets a rate limit stays held and stays the app's", async ({ page }) => {
  const app = walletFromEntropy(randomBytes(16))
  const label = uniqueLabel("apphold")
  await page.goto(`/#/?name=${label}&owner=${checksumAddress(app.address)}`)
  await page.getByRole("button", { name: "Register" }).click()
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": "20" }, json: { error: "rate_limited" } }) : route.continue())
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByText("ordering is paused")).toBeVisible()
  // Back keeps the search opened from the app
  await page.getByRole("button", { name: "Back" }).click()
  await expect(page.getByText("Opened from SimpleX.")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled()
  await expect(page.getByText("Too many attempts")).toBeVisible()
})

test("two orders signed with one wallet's nonce both register: the second is signed again with the next nonce", async ({ browser, request }) => {
  const app = walletFromEntropy(randomBytes(16))
  const context = await browser.newContext()
  const [first, second] = [await context.newPage(), await context.newPage()]
  const labels = [uniqueLabel("appa"), uniqueLabel("appb")]
  const invoices = [await orderFromApp(first, app, labels[0]), await orderFromApp(second, app, labels[1])]
  await control(request, `settle/${invoices[0]}`)
  await control(request, `settle/${invoices[1]}`)
  await expect(first.getByText(APP_SIGNS)).toBeVisible({ timeout: 60_000 })
  await expect(second.getByText(APP_SIGNS)).toBeVisible({ timeout: 60_000 })
  const nonces = [await appSigns(first, request, app, labels[0], invoices[0]), await appSigns(second, request, app, labels[1], invoices[1])]
  expect(nonces[0]).toBe(nonces[1])
  await expect(first.getByRole("heading", { name: `${labels[0]}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
  // the second register reverts with the spent nonce, and the order waits for a new signature
  await expect.poll(async () => {
    const view = (await (await request.get(`${MOCK}/api/invoice/${invoices[1]}`)).json()).registration
    return view.phase === "committed" && view.label === null ? view.intentNonce : null
  }, { timeout: REGISTRATION_MS }).toBe(nonces[0] + 1)
  await expect(second.getByText(APP_SIGNS)).toBeVisible()
  expect(await appSigns(second, request, app, labels[1], invoices[1])).toBe(nonces[0] + 1)
  await expect(second.getByRole("heading", { name: `${labels[1]}.simplex is yours` })).toBeVisible({ timeout: REGISTRATION_MS })
  await context.close()
})
