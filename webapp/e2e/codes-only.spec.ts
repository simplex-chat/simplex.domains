import { type APIRequestContext, expect, type Page } from "@playwright/test"
import { labelHash } from "../src/crypto/registration.ts"
import { hex } from "../src/crypto/wallet.ts"
import {
  codeField, control, MOCK, onStep, payButton, savedToReview, search, shot, startOrder, takenOrder, test, toCodeStep, toReview, uniqueLabel, useCode,
  waitRegistered,
} from "./helpers.ts"

const CODES_ONLY_LINE = "Names can be registered with an investor code for now."
const CODES_ONLY_TITLE = "Registration is by code only for now"
const REGISTER_WITH_CODE = "Register with code"
const FORBIDDEN = 403
const chip = (page: Page) => page.locator("body > header .code-chip")
const nameField = (page: Page) => page.getByLabel("Name", { exact: true })
const lens = (page: Page) => page.getByRole("button", { name: "Search", exact: true })

const setMode = (request: APIRequestContext, mode: "open" | "codes") => control(request, "mode", { mode })

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

test("the service's mode is in the page it serves: open by default, codes once the mock takes codes only", async ({ page, request }) => {
  expect(await (await request.get(`${MOCK}/control/mode`)).json()).toEqual({ mode: "open" })
  const open = await (await page.request.get("/")).text()
  expect(open).toContain('<meta name="simplex-names-mode" content="open">')
  await setMode(request, "codes")
  const codes = await (await page.request.get("/")).text()
  expect(codes).toContain('<meta name="simplex-names-mode" content="codes">')
  expect(codes).not.toContain('content="open"')
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
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: CODES_ONLY_TITLE })).toBeVisible()
  await expect(onStep(page).getByText(/can be registered with an investor code for now\. Nothing was charged\.$/)).toBeVisible()
  await shot(page, "C9-codes-only-refused")
  await onStep(page).getByRole("button", { name: "Enter a code" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
})

test("a closed invoice's page opened before codes only, refused a new invoice, says so with a way to a code", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("late"), { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await setMode(request, "codes")
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  const note = onStep(page).locator(".notice", { hasText: CODES_ONLY_TITLE })
  await expect(note).toContainText("Nothing was charged. Enter a code.")
  await expect(page).toHaveURL(new RegExp(`order=${invoiceId}`))
  await note.getByRole("link", { name: "Enter a code" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
})
