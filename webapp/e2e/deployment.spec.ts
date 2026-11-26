import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { heldPrice } from "../src/config.ts"
import { dollars } from "../src/format.ts"
import { REVEAL_ATTEMPTS } from "../src/screens/order.ts"
import {
  control, MOCK, mockRegistration, onStep, orderedAtMock, payButton, REGISTRATION_MS, registrationOf, restoreOrder, search, startOrder, test, toReview, uniqueLabel, useCode, waitRegistered,
} from "./helpers.ts"

const NOT_NOW = "Names can't be ordered right now. Try again later."
const UNCHECKED = "The payment details of this order could not be checked, so they are not shown. Contact support with the order reference."
const SUPPORT_COPY = "Copy the order reference and address proof for support"
const COIN = { btc: "Bitcoin", xmr: "Monero" } as const
const UNHELD_TERMS = "# SimpleX Names Conditions of Use\n\nNot the terms the page holds.\n"

async function mismatched<T>(request: APIRequestContext, mismatch: Record<string, unknown>, f: () => Promise<T>): Promise<T> {
  await control(request, "mismatch", mismatch)
  try {
    return await f()
  } finally {
    await control(request, "mismatch", {})
  }
}

async function notOrderable(page: Page, label: string): Promise<void> {
  await search(page, label)
  await expect(onStep(page).locator(".answer .line", { hasText: NOT_NOW })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Register" })).toBeDisabled()
}

test("a name whose search answers a price below or above the one the page holds can't be ordered, and shows the held price, unless a code registers it", async ({ page, request }) => {
  const label = uniqueLabel("price")
  const held = heldPrice(label.length)
  for (const price of [held - 5000, held + 5000]) {
    await mismatched(request, { price }, async () => {
      await notOrderable(page, label)
      await expect(onStep(page).locator(".answer .price")).toHaveText(dollars(held))
    })
  }
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await useCode(page, code)
  await mismatched(request, { price: held + 5000 }, async () => {
    await search(page, label)
    await expect(onStep(page).locator(".answer .price")).toHaveText("Free")
    await expect(onStep(page).getByRole("button", { name: "Register" })).toBeEnabled()
    await expect(onStep(page).locator(".answer .line", { hasText: NOT_NOW })).toHaveCount(0)
  })
})

test("a name whose terms on chain are not the terms the page holds can't be ordered", async ({ page, request }) => {
  await control(request, "general-terms", { text: UNHELD_TERMS })
  try {
    await notOrderable(page, uniqueLabel("terms"))
  } finally {
    await control(request, "general-terms", { text: null })
  }
})

for (const [what, mismatch] of [["under another policy", { policy: true }], ["of other terms", { termsHash: true }]] as const) {
  test(`an order whose sign answer asks for the acceptance ${what} is not sent, and Check your order says names can't be ordered now`, async ({ page, request }) => {
    const label = uniqueLabel("sign")
    await search(page, label)
    await toReview(page)
    await mismatched(request, mismatch, async () => {
      await payButton(page).click()
      await expect(onStep(page).getByRole("heading", { name: "Names can't be ordered right now" })).toBeVisible()
    })
    expect(await orderedAtMock(request, label), "no order made").toBe(false)
  })
}

test("an open invoice of another payment than its order asked for is drawn without its payment details, which could not be checked", async ({ page, request }) => {
  await mismatched(request, { method: true }, () => startOrder(page, uniqueLabel("method"), { method: "btc" }))
  await expect(onStep(page).getByText(UNCHECKED)).toBeVisible()
  await expect(onStep(page).getByText("Monero address")).toHaveCount(0)
  await expect(onStep(page).locator(".qr")).toHaveCount(0)
})

for (const [what, mismatch] of [["an address of a key the page does not hold", (method: string) => ({ address: method })], ["an amount other than its name's price", () => ({ amount: true })]] as const) {
  for (const method of ["btc", "xmr"] as const) {
    test(`an open ${COIN[method]} invoice with ${what} is drawn without its payment details, which could not be checked`, async ({ page, request }) => {
      await mismatched(request, mismatch(method), () => startOrder(page, uniqueLabel("payee"), { method }))
      await expect(onStep(page).getByText(UNCHECKED)).toBeVisible()
      await expect(onStep(page).getByText(`${COIN[method]} address`)).toHaveCount(0)
      await expect(onStep(page).locator(".qr")).toHaveCount(0)
    })
  }
}

test("an order's page gives support its address proof with its reference, as the service sent it, also when the address could not be checked", async ({ page, context, request, browserName }) => {
  test.skip(browserName !== "chromium", "reads the clipboard, which Playwright grants in Chromium")
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const { invoiceId } = await mismatched(request, { address: "xmr" }, () => startOrder(page, uniqueLabel("proof"), { method: "xmr" }))
  await expect(onStep(page).getByText(UNCHECKED)).toBeVisible()
  const { addressProof } = await (await request.get(`${MOCK}/control/invoice/${invoiceId}`)).json() as { addressProof: unknown }
  await onStep(page).getByRole("button", { name: SUPPORT_COPY }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Order reference ${invoiceId}, address proof ${JSON.stringify(addressProof)}`)
  await control(request, `expire/${invoiceId}`)
  await expect(onStep(page).getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: SUPPORT_COPY }), "the closed invoice's page").toBeVisible()
})

test("a card order reopened with its name code in another browser signs its reveal over a card's dispute days, whatever payment the service reports", async ({ page, browser, request }) => {
  const label = uniqueLabel("sealed")
  const { invoiceId, ownerCode } = await mismatched(request, { method: true }, () => startOrder(page, label, { method: "card" }))
  await page.goto("about:blank")
  await control(request, `stale/${await registrationOf(request, invoiceId)}`)
  await control(request, `settle/${invoiceId}`)
  await expect.poll(async () => {
    const { phase, label: revealed } = await mockRegistration(request, invoiceId)
    return phase === "committed" && revealed === null
  }, { timeout: REGISTRATION_MS }).toBe(true)
  const elsewhere = await (await browser.newContext()).newPage()
  await restoreOrder(elsewhere, ownerCode, label)
  await waitRegistered(elsewhere, label)
})

test("a committed order whose view asks for the acceptance under another policy is not signed, and after three tries its page says the name could not be signed", async ({ page, request }) => {
  const label = uniqueLabel("reveal")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  const reveals: string[] = []
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/registration\/[^/]+\/reveal$/.test(new URL(r.url()).pathname)) reveals.push(r.url()) })
  await control(request, `stale/${await registrationOf(request, invoiceId)}`)
  await mismatched(request, { policy: true }, async () => {
    await control(request, `settle/${invoiceId}`)
    await expect(onStep(page).getByText("The name could not be signed")).toBeVisible({ timeout: REGISTRATION_MS })
    expect(reveals, "no reveal sent").toEqual([])
    expect((await mockRegistration(request, invoiceId)).label, "no reveal recorded").toBeNull()
  })
})

test("a committed order whose reveal the service answers as another signer's, not_found, says after three tries that the name could not be signed", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("signer"), { method: "btc" })
  let reveals = 0
  await page.route("**/api/registration/*/reveal", (route) => {
    reveals += 1
    return route.fulfill({ status: 404, json: { type: "not_found" } })
  })
  await control(request, `stale/${await registrationOf(request, invoiceId)}`)
  await control(request, `settle/${invoiceId}`)
  await expect(onStep(page).getByText("The name could not be signed")).toBeVisible({ timeout: REGISTRATION_MS })
  expect(reveals).toBe(REVEAL_ATTEMPTS)
})
