import { type APIRequestContext, expect, type Page } from "@playwright/test"
import { labelHash } from "../src/crypto/registration.ts"
import { hex } from "../src/crypto/wallet.ts"
import {
  AGREE, agreeToTerms, CHECKOUT_KEY, codeField, control, MOCK, onStep, payButton, recordedFrames, recordFrames, savedToReview, search, shot, startOrder, takenOrder, test, toCodeStep, toFullReview, toReview,
  uniqueLabel, useCode, waitRegistered,
} from "./helpers.ts"

const CODES_ONLY_LINE = "Names can be registered with an investor code for now."
const CODES_ONLY_TITLE = "Registration is by code only for now"
const REGISTER_WITH_CODE = "Register with code"
const FORBIDDEN = 403
const chip = (page: Page) => page.locator("body > header .code-chip")
const nameField = (page: Page) => page.getByLabel("Name", { exact: true })
const lens = (page: Page) => page.getByRole("button", { name: "Search", exact: true })

const setMode = (request: APIRequestContext, mode: "open" | "codes") => control(request, "mode", { mode })
// the tab coming back into view, as a reader switching back to it; headless browsers keep every tab in view
const becomeVisible = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
// the page loaded again, in the mode the service gives, as the tab comes back into view
const reloadedOnView = (page: Page) => Promise.all([page.waitForEvent("load"), becomeVisible(page)])
// the page's own check of the service's mode, answered
const modeChecked = (page: Page) => page.waitForResponse((r) => new URL(r.url()).pathname === "/api/config")
// Every document the page loads from now on, counted as it fires load: a page loaded again runs the service's mode.
function loads(page: Page): { count: number } {
  const seen = { count: 0 }
  page.on("load", () => { seen.count += 1 })
  return seen
}
// long enough for a load the check started to have finished
const RELOAD_MS = 1000
// long enough for several frames to paint before the page knows its mode
const SLOW_CONFIG_MS = 400
const checkoutKept = (page: Page) => page.evaluate((key) => {
  const { label, contact, channel, ownerCode, saved, agreed, step } = JSON.parse(sessionStorage.getItem(key)!)
  return { label, contact, channel, ownerCode, saved, agreed, step }
}, CHECKOUT_KEY)

// the mock of this worker's slot goes back to open, whatever a test left, for the specs after it
test.afterEach(async ({ request }) => {
  await setMode(request, "open")
})

// Every request the page makes to the service's API from now on, by method and path.
function apiCalls(page: Page): string[] {
  const calls: string[] = []
  page.on("request", (r) => {
    const url = new URL(r.url())
    if (url.pathname.startsWith("/api/")) calls.push(`${r.method()} ${url.pathname}`)
  })
  return calls
}

const PAYMENT_CALL = /^POST \/api\/(invoice$|registration\/[^/]+\/spend$)/

// No control of the page's that pays or chooses how: methods, Pay, a new invoice, Pay with ETH or a balance to use.
async function noPaymentUi(page: Page): Promise<void> {
  const main = page.locator("body > main")
  await expect(main.getByRole("radio")).toHaveCount(0)
  await expect(main.getByRole("button", { name: /^Pay |^Get a new invoice$|^Register with your balance$|^Order the name again$/ })).toHaveCount(0)
  await expect(main.locator(".balance-row").getByRole("button", { name: "Use", exact: true })).toHaveCount(0)
  await expect(main.getByRole("link", { name: /^Pay with / })).toHaveCount(0)
  await expect(main.getByRole("button", { name: /^Pay with / })).toHaveCount(0)
  await expect(chip(page).filter({ hasText: "Balance" })).toHaveCount(0)
}

test("the service's mode is at /api/config: open by default, codes once the mock takes codes only, the page the same in both", async ({ page, request }) => {
  expect(await (await request.get(`${MOCK}/control/mode`)).json()).toEqual({ mode: "open" })
  expect(await (await page.request.get("/api/config")).json()).toEqual({ mode: "open", stripePublishableKey: null })
  const open = await (await page.request.get("/")).text()
  await setMode(request, "codes")
  expect(await (await page.request.get("/api/config")).json()).toEqual({ mode: "codes", stripePublishableKey: null })
  expect(await (await page.request.get("/")).text()).toBe(open)
})

test("the mock refuses every payment in codes-only mode, as the service does", async ({ request }) => {
  await setMode(request, "codes")
  const invoice = await request.post(`${MOCK}/api/invoice`, { data: { kind: "name" } })
  expect(invoice.status()).toBe(FORBIDDEN)
  expect(await invoice.json()).toEqual({ error: "codes_only" })
  const spend = await request.post(`${MOCK}/api/registration/reg-none/spend`, { data: {} })
  expect(spend.status()).toBe(FORBIDDEN)
  expect(await spend.json()).toEqual({ error: "codes_only" })
  await setMode(request, "open")
  expect((await request.post(`${MOCK}/api/invoice`, { data: { kind: "name" } })).status(), "open mode takes the order to its checks").not.toBe(FORBIDDEN)
})

test("each mode's home is drawn from its first frame, never the other mode's first, however slowly the config answers", async ({ page, request }) => {
  await page.route("**/api/config", async (route) => {
    await new Promise((answered) => setTimeout(answered, SLOW_CONFIG_MS))
    await route.continue()
  })
  await recordFrames(page, () => {
    const field = document.querySelector<HTMLInputElement>("body > main input")
    return { header: document.querySelector("body > header .brand") !== null, field: field === null ? "none" : field.disabled ? "codes" : "open" }
  }, true)
  for (const mode of ["codes", "open"] as const) {
    await setMode(request, mode)
    for (const route of ["/", "/#/?name=bakery"]) {
      await page.goto("about:blank")
      await page.goto(route)
      await expect(nameField(page)).toBeVisible()
      await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))))
      const frames = await recordedFrames<{ header: boolean; field: string }>(page)
      const what = `${mode}, ${route}: ${frames.map((f) => f.field).join(" ")}`
      expect(frames.every((f) => f.header), `the header in every frame; ${what}`).toBe(true)
      expect(frames.some((f) => f.field === "none"), `frames before the slow answer show no search; ${what}`).toBe(true)
      expect(new Set(frames.map((f) => f.field)), `only this mode's search, once drawn; ${what}`).toEqual(new Set(["none", mode]))
      expect(frames.at(-1)!.field, what).toBe(mode)
    }
  }
})

test("a load asks the service's mode once, as the preload's answer is the one the page reads", async ({ page, request }) => {
  await setMode(request, "codes")
  const asked: string[] = []
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/config") asked.push(r.resourceType()) })
  await page.goto("/")
  await expect(nameField(page)).toBeDisabled()
  await page.waitForTimeout(RELOAD_MS)
  expect(asked, "one request, the preload's").toHaveLength(1)
})

test("without a code, the home's search is greyed, takes no pointer, focus or Enter, and Register with code leads on", async ({ page, request }) => {
  await setMode(request, "codes")
  const calls = apiCalls(page)
  // a link naming a name searches nothing either
  await page.goto("/#/?name=bakery")
  const answer = page.locator(".answer")
  await expect(answer.locator(".hint")).toHaveText(CODES_ONLY_LINE)
  await expect(nameField(page)).toBeDisabled()
  await expect(lens(page)).toBeDisabled()
  await expect(nameField(page)).toHaveAttribute("aria-describedby", await answer.locator(".hint").getAttribute("id") ?? "none")
  const cursors = await page.locator(".search-field").evaluate((box) => [box, box.querySelector("input")!, box.querySelector(".tld")!, box.querySelector("button")!]
    .map((n) => getComputedStyle(n).cursor))
  expect(cursors, "the field, its name, its TLD and its button").toEqual(["not-allowed", "not-allowed", "not-allowed", "not-allowed"])

  // a press on the field or its button, Enter or typing, and focus by script, all leave it as it is
  await page.locator(".search-field .tld").click({ force: true })
  await nameField(page).click({ force: true })
  await lens(page).click({ force: true })
  await nameField(page).focus()
  await expect(nameField(page)).not.toBeFocused()
  await page.keyboard.type("harbour")
  await page.keyboard.press("Enter")
  await expect(nameField(page)).toHaveValue("bakery")
  await expect(answer.locator(".row")).toHaveCount(0)

  // Tab passes over the field and its button to the one main action
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const stops: string[] = []
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab")
    stops.push(await page.evaluate(() => {
      const a = document.activeElement as HTMLElement
      return `${a.tagName.toLowerCase()} ${a.getAttribute("aria-label") ?? a.textContent?.trim()}`
    }))
  }
  expect(stops).not.toContain("input Name")
  expect(stops).not.toContain("button Search")
  expect(stops).toContain(`button ${REGISTER_WITH_CODE}`)
  await expect(page.locator("body > main .btn:enabled")).toHaveText([REGISTER_WITH_CODE])
  expect(calls.filter((c) => c.startsWith("GET /api/name/")), "no search reached the service").toEqual([])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await shot(page, "C1-codes-only-home")

  await page.getByRole("button", { name: REGISTER_WITH_CODE }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
  await expect(page).toHaveURL(/#\/code$/)
})

test("#/code opens Check your code from a cold load, its field ready for the code", async ({ page, request }) => {
  await setMode(request, "codes")
  await page.goto("/#/code")
  await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
  await expect(codeField(page)).toBeFocused()
  await expect(page).toHaveURL(/#\/code$/)
  await expect(onStep(page).getByRole("button", { name: "Find a name" })).toBeDisabled()
  await shot(page, "C2-codes-only-check-code")
})

test("a valid prepaid code opens the search for the names it covers and registers one as a free code order", async ({ page, request }) => {
  await setMode(request, "codes")
  const { code } = await control(request, "code", { minLength: 7, years: 2 }) as { code: string }
  const calls = apiCalls(page)
  await useCode(page, code)
  await expect(chip(page)).toHaveText("Code: 7+ letters, 2 years")
  await expect(nameField(page)).toBeEnabled()
  await expect(page.locator(".answer .hint")).toHaveCount(0)

  // a name shorter than the code covers is answered at once, without asking the service
  const short = "abcdef"
  await nameField(page).fill(short)
  await nameField(page).press("Enter")
  await expect(page.locator(".answer .line.bad")).toHaveText("6 letters. Your code covers names of 7 or more letters.")
  expect(calls).not.toContain(`GET /api/name/${hex(labelHash(short))}`)
  await shot(page, "C3-codes-only-uncovered")

  const label = uniqueLabel("cod")
  await nameField(page).fill(label)
  await nameField(page).press("Enter")
  await expect(page.locator(".answer .row .deal")).toHaveText("Free / 2 years")
  await shot(page, "C4-codes-only-covered")
  await toReview(page)
  await expect(page.locator(".card.order .trow.total")).toHaveText("Free SimpleX name")
  await noPaymentUi(page)
  await expect(onStep(page).getByText("I have a code")).toHaveCount(0)
  await expect(onStep(page).getByText("Remove code")).toHaveCount(0)
  await shot(page, "C5-codes-only-review")
  await onStep(page).getByRole("button", { name: "Register with your code" }).click()
  await page.waitForURL(/\?registration=/)
  await waitRegistered(page, label)
  expect(calls.filter((c) => PAYMENT_CALL.test(c)), "nothing was paid").toEqual([])
  expect(calls).toContain("POST /api/name/register")
})

test("a code taken off on Check your order leaves the code field in place of payment, and a code there registers", async ({ page, request }) => {
  await setMode(request, "codes")
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await useCode(page, code)
  await search(page, uniqueLabel("off"))
  await toReview(page)
  await chip(page).getByRole("button", { name: "Remove code" }).click()
  const field = codeField(page)
  await expect(field).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Register with your code" })).toBeDisabled()
  await expect(page.locator(".card.order .trow.total"), "no price where a code pays").toHaveText("Free SimpleX name")
  await noPaymentUi(page)
  await expect(onStep(page).getByText("Remove code")).toHaveCount(0)
  await shot(page, "C6-codes-only-review-without-code")

  await field.fill(code)
  await expect(onStep(page).getByRole("button", { name: "Register with your code" })).toBeEnabled()
  await expect(field, "the field stays as it took the code").toBeVisible()
  await onStep(page).getByRole("button", { name: "Register with your code" }).click()
  await page.waitForURL(/\?registration=/)
})

test("an order paid before codes only shows no new invoice or balance to spend, only Register with code and the refund", async ({ page, request }) => {
  const label = uniqueLabel("was")
  const { invoiceId } = await takenOrder(page, request, label)
  const expired = await startOrder(page, uniqueLabel("exp"), { method: "btc" })
  await control(request, `expire/${expired.invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  // the tab was paying with the taken order's balance
  await page.goto(`/?order=${invoiceId}`)
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(chip(page)).toContainText("Balance")

  await setMode(request, "codes")
  await page.reload()
  await expect(chip(page)).toBeHidden()
  await expect(page.locator("body > header").getByRole("link", { name: "Check your code" })).toBeVisible()
  await expect(nameField(page), "the balance opens no search").toBeDisabled()

  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: `${label}.simplex was taken` })).toBeVisible()
  await expect(onStep(page).getByText("What you paid is kept as your balance. You can ask for a refund. Your names shows the balance.")).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: REGISTER_WITH_CODE })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Choose another name" })).toHaveCount(0)
  await expect(onStep(page).getByRole("button", { name: "Get a refund" })).toBeVisible()
  await noPaymentUi(page)
  await shot(page, "C7-codes-only-taken")

  await page.goto(`/?order=${expired.invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(onStep(page).getByRole("checkbox")).toHaveCount(0)
  await noPaymentUi(page)
  await onStep(page).getByRole("button", { name: REGISTER_WITH_CODE }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()

  await page.goto("/#/names")
  const balance = page.locator(".balance-row")
  await expect(balance).toBeVisible()
  await expect(balance.getByRole("button", { name: "Refund" })).toBeVisible()
  await noPaymentUi(page)
  await shot(page, "C8-codes-only-names")
})

test("a page opened before codes only, refused as it pays, says registration is by code and leads to a code", async ({ page, request }) => {
  await search(page, uniqueLabel("stale"))
  await toCodeStep(page)
  await savedToReview(page)
  await page.getByRole("radio", { name: "Bitcoin" }).click()
  await setMode(request, "codes")
  const seen = loads(page)
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: CODES_ONLY_TITLE })).toBeVisible()
  await expect(onStep(page).getByText(/can be registered with an investor code for now\. Nothing was charged\.$/)).toBeVisible()
  await shot(page, "C9-codes-only-refused")
  expect(seen.count, "the refusal stays in view, in the page as it was").toBe(0)
  await onStep(page).getByRole("button", { name: "Enter a code" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
  expect(seen.count, "the screen after the refusal is the service's page again").toBe(1)
})

test("a closed invoice's page opened before codes only, refused a new invoice, says so with a way to a code", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("late"), { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await setMode(request, "codes")
  const seen = loads(page)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  const note = onStep(page).locator(".notice", { hasText: CODES_ONLY_TITLE })
  await expect(note).toContainText("Nothing was charged. Enter a code.")
  await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
  expect(seen.count, "the refusal stays in view, in the page as it was").toBe(0)
  await note.getByRole("link", { name: "Enter a code" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
  expect(seen.count, "the screen after the refusal is the service's page again").toBe(1)
})

test("a checkout open as the service takes codes only loads again in codes mode with its name, links, name code and terms", async ({ page, request }) => {
  const label = uniqueLabel("keep")
  await toFullReview(page, label)
  await page.getByRole("radio", { name: "Bitcoin" }).click()
  const before = await checkoutKept(page)
  expect(before.agreed && before.saved && before.contact && before.channel).toBeTruthy()
  await setMode(request, "codes")
  await reloadedOnView(page)
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  expect(await checkoutKept(page)).toEqual(before)
  await expect(onStep(page).getByRole("checkbox", { name: AGREE })).toBeChecked()
  await expect(codeField(page), "a code pays in place of the payment choices").toBeVisible()
  await noPaymentUi(page)
})

test("an order paid as the service takes codes only loads again with its invoice, and registers", async ({ page, request }) => {
  const label = uniqueLabel("paid")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await setMode(request, "codes")
  await reloadedOnView(page)
  await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
})

test("a codes-only page open as the service opens loads again with the search on", async ({ page, request }) => {
  await setMode(request, "codes")
  const checked = modeChecked(page)
  await page.goto("/")
  await checked
  await expect(nameField(page)).toBeDisabled()
  await setMode(request, "open")
  await reloadedOnView(page)
  await expect(nameField(page)).toBeEnabled()
})

test("a closed invoice's page holding changed terms ticked again stays as the service takes codes only, until the reader leaves it", async ({ page, request }) => {
  const label = uniqueLabel("tick")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await expect(onStep(page).getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await control(request, "general-terms", { text: `the general terms, changed for ${label}` })
  try {
    await onStep(page).getByRole("button", { name: "Get a new invoice" }).click()
    await agreeToTerms(page)
    await setMode(request, "codes")
    const seen = loads(page)
    const checked = modeChecked(page)
    await becomeVisible(page)
    await checked
    await page.waitForTimeout(RELOAD_MS)
    expect(seen.count, "the tick is in the page only, so the page stays").toBe(0)
    await expect(onStep(page).getByRole("checkbox", { name: AGREE })).toBeChecked()
    await page.locator("body > header").getByRole("link", { name: "Check your code" }).click()
    await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
    expect(seen.count, "the next screen is the service's page again").toBe(1)
  } finally {
    await control(request, "general-terms", { text: null })
  }
})
