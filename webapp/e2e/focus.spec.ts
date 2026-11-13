import { expect, type Page } from "@playwright/test"
import { codeField, control, onStep, payButton, REGISTRATION_MS, search, startOrder, test, toCodeStep, toReview, uniqueLabel, useCode } from "./helpers.ts"

// the name code step makes a name code as it opens, which Your names lists as pending
async function openCodeStep(page: Page, label: string): Promise<void> {
  await search(page, label)
  await toCodeStep(page)
}

const DRAWN_BEFORE = "data-drawn-before"

// The screen in view is marked, and the redraw puts a new one in its place.
async function drawnAgain(page: Page, invoiceId: string, redraw: () => Promise<void>): Promise<void> {
  await onStep(page).evaluate((n, mark) => n.setAttribute(mark, ""), DRAWN_BEFORE)
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/invoice/${invoiceId}` && !r.url().includes("?"))
  await redraw()
  await read
  await expect(page.locator("main[aria-busy]")).toHaveCount(0)
  await expect(page.locator(`section.screen[${DRAWN_BEFORE}]`), "the screen drawn before the change").toHaveCount(0)
  await expect(onStep(page)).toHaveCount(1)
}

// another tab writes the same record again with a space more or less, which this tab hears as a change
async function touchRecord(other: Page, key: string): Promise<void> {
  await other.evaluate((k) => {
    const value = localStorage.getItem(k)!
    localStorage.setItem(k, value.endsWith(" ") ? value.trimEnd() : `${value} `)
  }, key)
}

// a redraw of the same screen moves focus only back to the control it was on, which is gone here
const focusOnPage = (page: Page) => expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true)

test("removing a pending name code leaves focus on the page, so a second Enter removes nothing", async ({ page }) => {
  const older = uniqueLabel("rmold")
  const newer = uniqueLabel("rmnew")
  await openCodeStep(page, older)
  await openCodeStep(page, newer)
  await page.goto("/#/names")
  const newest = page.locator(".list-row").first()
  await expect(newest).toContainText(`${newer}.simplex`)
  await newest.getByText("Remove", { exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".list-row", { hasText: `${newer}.simplex` })).toHaveCount(0)
  await focusOnPage(page)
  await page.keyboard.press("Enter")
  await expect(page.locator(".list-row", { hasText: `${older}.simplex` })).toHaveCount(1)
})

test("an order's page keeps focus when another tab changes the order", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("ordfocus"), { method: "btc" })
  const key = await page.evaluate((id) => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:order:") && localStorage.getItem(k)!.includes(id))!, invoiceId)
  const other = await page.context().newPage()
  await other.goto("/")
  await page.getByRole("button", { name: "Cancel this invoice" }).focus()
  await drawnAgain(page, invoiceId, () => touchRecord(other, key))
  await expect(page.getByRole("button", { name: "Cancel this invoice" })).toBeFocused()
  await other.close()
})

test("a checkout drawn again for the tab's open order keeps focus on its heading", async ({ page }) => {
  await startOrder(page, uniqueLabel("headopen"), { method: "btc" })
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await search(page, uniqueLabel("headnext"))
  // the terms left unticked, so focus stays where the review put it
  await toReview(page, false)
  await expect(page.getByText(/is waiting for its payment/)).toBeVisible()
  await expect(page.getByRole("heading", { name: "Check your order" })).toBeFocused()
})

test("Enter in Check your code's field does what its button does: a prepaid code finds a name, a name code is added", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.goto("/#/code")
  await expect(codeField(page), "the field takes focus as the screen opens").toBeFocused()
  await codeField(page).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await expect(page.locator("body > header .code-chip")).toBeVisible()
})

test("a name code the service finds no order for says so as its verdict, offers no Add, and keeps focus in the code's field", async ({ page }) => {
  await openCodeStep(page, uniqueLabel("noorder"))
  const ownerCode = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:pending:"))!.split(":").pop()!)
  await page.goto("/#/code")
  await codeField(page).fill(ownerCode)
  await expect(page.locator(".code-entry .verdict.bad")).toHaveText("No order was found for this code. The service has no order registered to its wallet.")
  await expect(page.getByRole("button", { name: "Add to Your names" })).toHaveCount(0)
  await expect(codeField(page)).toBeFocused()
})

test("a pending code with no order leaves focus on the page when its Find link goes", async ({ page }) => {
  await openCodeStep(page, uniqueLabel("nofind"))
  // another tab, which does not hold this checkout, looks for its order
  const other = await page.context().newPage()
  await other.goto("/#/names")
  const row = other.locator(".list-row").first()
  await row.getByText("Find the order").focus()
  await other.keyboard.press("Enter")
  await expect(row.getByText("No order was made")).toBeVisible()
  await focusOnPage(other)
})

test("Forget everything asks first with focus on Keep them, and keeping them gives focus back to the link", async ({ page }) => {
  await openCodeStep(page, uniqueLabel("forget"))
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Keep them" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Forget everything in this browser")).toBeFocused()
  await expect(page.locator(".list-row")).not.toHaveCount(0)
})

test("an order refused for its method draws the checkout again in place, with focus kept on Pay", async ({ page }) => {
  await search(page, uniqueLabel("unav"))
  await toReview(page)
  await page.getByRole("radio", { name: "Card" }).click()
  await page.route("**/api/invoice", (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "provider_unavailable" } }) : route.continue())
  const entries = await page.evaluate(() => history.length)
  await payButton(page).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Card is temporarily unavailable")).toBeVisible()
  await expect(payButton(page)).toBeFocused()
  expect(await page.evaluate(() => history.length)).toBe(entries)
})

test("a well-formed code the service does not know is not called a typo", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.route("**/api/code/check", (route) => route.fulfill({ status: 400, json: { error: "code_invalid" } }))
  await page.goto("/#/code")
  await codeField(page).fill(code)
  await expect(page.locator(".verdict.bad")).toHaveText("This code is not valid: SimpleX did not issue it.")
  await expect(page.getByRole("button", { name: "Find a name" })).toBeDisabled()
})

// every text the status region outside main says, from the page's first frame
const watchStatus = () => {
  const w = window as unknown as { __said: string[] }
  w.__said = []
  new MutationObserver(() => {
    const region = document.querySelector("body > .sr-only[role=status]")
    if (region?.textContent && w.__said.at(-1) !== region.textContent) w.__said.push(region.textContent)
  }).observe(document, { childList: true, subtree: true, characterData: true })
}
const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: string[] }).__said)

test("a screen reached with focus left on the header is said in the status region outside main", async ({ page }) => {
  await page.addInitScript(watchStatus)
  await page.goto("/")
  await page.locator("body > header").getByRole("link", { name: "Your names" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(page.locator("body > header").getByRole("link", { name: "Your names" })).toBeFocused()
  await expect.poll(() => said(page)).toContain("Your names")
  expect(await page.locator("body > main [role=status]", { hasText: "Your names" }).count(), "the region is outside main").toBe(0)
})

test("a registration's stages are said as each is reached, not each second of the wait", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await page.addInitScript(watchStatus)
  await useCode(page, code)
  await search(page, uniqueLabel("stages"))
  await toReview(page)
  await onStep(page).getByRole("button", { name: "Register with your code" }).click()
  await expect(page.getByRole("heading", { name: /is yours$/ })).toBeVisible({ timeout: REGISTRATION_MS })
  const stages = (await said(page)).filter((t) => ["Committing", "Waiting", "Registering"].includes(t))
  expect(stages.filter((t) => t === "Waiting"), "the wait said once").toHaveLength(1)
  expect(stages).toContain("Committing")
})
