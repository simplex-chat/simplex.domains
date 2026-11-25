import { expect, type APIRequestContext, type Page } from "@playwright/test"
import { heldPrice } from "../src/config.ts"
import { control, mockRegistration, onStep, orderedAtMock, payButton, REGISTRATION_MS, registrationOf, search, startOrder, test, toReview, uniqueLabel, useCode } from "./helpers.ts"

const NOT_NOW = "Names can't be ordered right now. Try again later."
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

test("a name whose search answers a price below or above the one the page holds can't be ordered, unless a code registers it", async ({ page, request }) => {
  const label = uniqueLabel("price")
  const held = heldPrice(label.length)
  for (const price of [held - 5000, held + 5000]) await mismatched(request, { price }, () => notOrderable(page, label))
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
