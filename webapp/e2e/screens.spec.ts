import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { control, onStep, payButton, registrationOf, REGISTRATION_MS, search, startOrder, test, toReview, waitRegistered } from "./helpers.ts"

const START_S = Date.UTC(2026, 10, 2, 8) / 1000
const STEP_S = 300
const SIZES = [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const

interface Reach { page: Page; request: APIRequestContext }

function seedPageRandom(seed: string): void {
  let state = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261) || 1
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    const bytes = array ? new Uint8Array(array.buffer, array.byteOffset, array.byteLength) : new Uint8Array()
    for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff
    return array
  }
}

const countdowns = (page: Page): Locator[] => [page.locator("body > main .time"), page.locator("body > main .countdown b")]

function screen(slot: number, id: string, reach: (r: Reach) => Promise<void>): void {
  test(id, async ({ page, request }) => {
    const now = START_S + slot * STEP_S
    await control(request, "clock", { now })
    await control(request, "seed", { seed: id })
    await page.clock.install({ time: now * 1000 })
    await page.addInitScript(seedPageRandom, id)
    await reach({ page, request })
    await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined))))
    await page.mouse.move(0, 0)
    for (const [size, viewport] of SIZES) {
      await page.setViewportSize(viewport)
      await expect(page).toHaveScreenshot(`${id}-${size}.png`, { fullPage: true, mask: countdowns(page) })
    }
  })
}

screen(1, "home-empty", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
})

screen(2, "home-available", async ({ page }) => {
  await search(page, "linden")
  await expect(onStep(page).getByRole("button", { name: "Register" })).toBeVisible()
})

screen(3, "checkout-review-btc", async ({ page }) => {
  await search(page, "cedarbooks")
  await toReview(page)
  await expect(payButton(page)).toBeEnabled()
})

screen(4, "order-pay-btc-available", async ({ page }) => {
  await startOrder(page, "maplecoffee", { method: "btc" })
  await expect(onStep(page).locator(".name-check:not(.unchecked)")).toBeVisible()
})

screen(5, "order-registering-committing", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, "willowcafe", { method: "btc" })
  await control(request, "search", { unsentSeconds: 30 })
  await control(request, `settle/${invoiceId}`)
  await expect(page.locator(".stage.active", { hasText: "Committing" })).toBeVisible()
})

screen(6, "order-registered-no-links", async ({ page, request }) => {
  await control(request, "search", { unsentSeconds: 0 })
  const { invoiceId } = await startOrder(page, "aspenbikes", { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, "aspenbikes")
  expect(await registrationOf(request, invoiceId)).toBeTruthy()
})

screen(7, "names-list-registered", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, "birchyoga", { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, "birchyoga")
  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: "birchyoga" })).toContainText("Until", { timeout: REGISTRATION_MS })
})
