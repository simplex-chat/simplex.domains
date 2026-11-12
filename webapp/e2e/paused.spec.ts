import { type BrowserContext, expect, type Page } from "@playwright/test"
import { control, failedOrder, FIT_SIZES, onStep, payButton, search, startOrder, takenOrder, test, toReview, uniqueLabel } from "./helpers.ts"

const PAUSED = "Registration is paused. A payment made now waits in the queue until it resumes."
const QUEUED_LEAD = "Your place in the queue is kept. Come back any time: once your order is committed, you have 24 hours to finish."
const KEEP_OPEN_LEAD = "Keep this page open until the name is yours, or come back within 24 hours."
const QUEUE_PAUSED = "Your order keeps its place and continues by itself. Nothing more to pay."
const ANSWER_MS = 60_000

type Fields = Record<string, unknown>

const answersInvoice = (to: Page | BrowserContext, change: (registration: Fields) => Fields) =>
  to.route((url) => /^\/api\/invoice\/[^/]+$/.test(url.pathname), async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    const response = await route.fetch().catch(() => null)
    if (!response) return route.abort().catch(() => undefined)
    const invoice = await response.json()
    await route.fulfill({ response, json: { ...invoice, registration: { ...invoice.registration, ...change(invoice.registration) } } }).catch(() => undefined)
  })

const place = (page: Page, selector: string) => onStep(page).locator(selector).first().evaluate((n) => {
  const b = n.getBoundingClientRect()
  return [Math.round(b.top), Math.round(b.bottom)]
})

test("Check your order refused while registration is paused says orders are paused and nothing was charged for the name, and Try again sends it again", async ({ page }) => {
  const label = uniqueLabel("pause")
  await page.route((url) => url.pathname === "/api/invoice", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "registration_paused" } }) : route.fallback())
  await search(page, label)
  await toReview(page)
  await page.getByRole("radio", { name: "Bitcoin" }).click()
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: "Registration is paused" })).toBeVisible()
  await expect(onStep(page).locator(".notice > div")).toHaveText(`Orders are paused for now. Nothing was charged for ${label}.simplex. Try again later.`)
  await page.unrouteAll()
  await onStep(page).getByRole("button", { name: "Try again" }).click()
  await page.waitForURL(/\?order=/)
})

for (const method of ["btc", "card"] as const) {
  test(`the ${method} pay page says a pause in its top notice from its next answer and drops it as the pause ends, with nothing under it moving`, async ({ page }) => {
    let paused = false
    await answersInvoice(page, () => ({ paused }))
    await startOrder(page, uniqueLabel("pp"), { method })
    const note = onStep(page).locator(".name-check")
    const said = note.locator("> :not(.sizer)")
    await expect(note).not.toHaveClass(/unchecked/)
    const placed = async () => [await place(page, method === "card" ? ".stripe" : ".card.pay"), await place(page, ".actions-row")]
    const before = await placed()
    paused = true
    await expect(said).toHaveText(PAUSED, { timeout: ANSWER_MS })
    await expect(note).toHaveClass(/warn/)
    expect(await placed(), "the details and the actions where they were").toEqual(before)
    paused = false
    await expect(said).not.toHaveText(PAUSED, { timeout: ANSWER_MS })
    expect(await placed(), "the details and the actions where they were").toEqual(before)
  })
}

test("a part-paid invoice's notice holds the pause's room, and leaves the pause out once its window has ended", async ({ page, request }) => {
  let paused = false
  await answersInvoice(page, () => ({ paused }))
  const { invoiceId } = await startOrder(page, uniqueLabel("pp"), { method: "btc" })
  await control(request, `partial/${invoiceId}`)
  const notice = onStep(page).locator(".screen-body > .notice").first()
  await expect(notice).toContainText("Part of the payment arrived")
  const words = notice.locator(".paused")
  await expect(words).toBeHidden()
  const placed = async () => [await place(page, ".screen-body > .notice"), await place(page, ".card.pay")]
  const before = await placed()
  paused = true
  await expect(words).toBeVisible({ timeout: ANSWER_MS })
  await expect(words).toHaveText(PAUSED)
  expect(await placed(), "the notice and the details where they were").toEqual(before)
  await control(request, `overdue/${invoiceId}`)
  await expect(onStep(page).getByText("The invoice expired before the full amount arrived.", { exact: false })).toBeVisible({ timeout: ANSWER_MS })
  await expect(words).toHaveCount(0)
})

test("the pay page of a browser without the order holds the pause's room in a notice hidden until a pause", async ({ page, browser }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("pp"), { method: "btc" })
  const elsewhere = await browser.newContext()
  const stranger = await elsewhere.newPage()
  let paused = false
  await answersInvoice(stranger, () => ({ paused }))
  await stranger.goto(`/?order=${invoiceId}`)
  await expect(onStep(stranger).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  const note = onStep(stranger).locator(".name-check")
  await expect(note).toBeHidden()
  const before = await place(stranger, ".card.pay")
  paused = true
  await expect(note).toBeVisible({ timeout: ANSWER_MS })
  await expect(note).toHaveText(PAUSED)
  expect(await place(stranger, ".card.pay"), "the details where they were").toEqual(before)
  await elsewhere.close()
})

test("a queued order shows the queue as its first stage, its place and that its place is kept, warns of a pause, and keeps its stages in place as it leaves the queue", async ({ page, request }) => {
  await page.setViewportSize(FIT_SIZES[1])
  const queued: Fields = { phase: "queued", queue: { position: 3, of: 7 }, paused: false, label: null, commitTx: null, revealAfter: null, revealBefore: null, intentNonce: null, acceptance: null }
  let change: Fields | null = queued
  await answersInvoice(page, (registration) => registration.phase === "unpaid" ? {} : change ?? {})
  const { invoiceId } = await startOrder(page, uniqueLabel("pq"), { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  const stages = onStep(page).locator(".stage")
  const lead = onStep(page).locator(".screen-head .lead .sized > :not(.sizer)")
  await expect(stages).toHaveText(["In queue", "Committing", "Waiting", "Registering"])
  await expect(onStep(page).locator(".stage.active")).toHaveText("In queue")
  await expect(onStep(page).locator(".countdown p > :not(.sizer)")).toHaveText("Your order is 3rd of 7 in the queue.")
  await expect(lead).toHaveText(QUEUED_LEAD)
  await expect(onStep(page).getByText(QUEUE_PAUSED)).toHaveCount(0)
  const stagesAt = await place(page, ".stages")

  change = { ...queued, paused: true }
  await page.reload()
  await expect(onStep(page).locator(".notice", { hasText: QUEUE_PAUSED })).toContainText("Registration is paused")
  expect(await place(page, ".stages"), "the stages where they were").toEqual(stagesAt)

  change = null
  await page.reload()
  await expect(lead).toHaveText(KEEP_OPEN_LEAD)
  await expect(onStep(page).locator(".stage.active")).not.toHaveText("In queue")
  await expect(onStep(page).locator(".stage").first()).toHaveText("Queued")
  expect(await place(page, ".stages"), "the stages where they were").toEqual(stagesAt)
})

test("a failed order's stages mark its commit failed after the queue", async ({ page, request }) => {
  await failedOrder(page, request, uniqueLabel("pf"))
  await expect(onStep(page).locator(".stage")).toHaveText(["Queued", "Committing", "Waiting", "Registering"])
  await expect(onStep(page).locator(".stage.done")).toHaveText(["Queued"])
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Committing")
})

test("a taken order's stages mark the last of four as taken", async ({ page, request }) => {
  await takenOrder(page, request, uniqueLabel("pt"))
  await expect(onStep(page).locator(".stage")).toHaveText(["Queued", "Committed", "Waiting", "Taken"])
  await expect(onStep(page).locator(".stage.done")).toHaveText(["Queued", "Committed", "Waiting"])
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Taken")
})
