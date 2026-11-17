import { expect } from "@playwright/test"
import { labelHash } from "../src/crypto/registration.ts"
import { hex } from "../src/crypto/wallet.ts"
import { dateOf } from "../src/format.ts"
import {
  agreeToTerms, checkoutOwnerCode, codeField, control, LINKS_HEADING, onStep, orderOwnerCode, payButton, recordedFrames, recordFrames, REGISTRATION_MS, search, searchName, shot, startOrder, test, toCodeStep, toReview, uniqueLabel,
  waitRegistered,
} from "./helpers.ts"

test.afterEach(async ({ request }) => {
  await control(request, "search", { chainDown: false, limitSeconds: 0, invoiceError: null, findLimitSeconds: 0 })
})

test("search answers every kind of name", async ({ page, request }) => {
  await page.goto("/")
  await shot(page, "N1-home")
  await page.getByLabel("Name", { exact: true }).pressSequentially("BaKery")
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("bakery")
  await shot(page, "N1a-typed")

  await search(page, "abc")
  await expect(page.getByText(/3 letters\. A name has 6 letters or more/)).toBeVisible()
  await shot(page, "N1b-short")
  await search(page, "bad_name")
  await expect(page.getByText(/^Use only a\W+z, 0\W+9 and single hyphens between them\.$/)).toBeVisible()
  await shot(page, "N1c-chars")

  await search(page, "bakery")
  // the chats the name opens, as the app's own pictures in its row, and whose it is
  await expect(page.locator(".answer .row .chat")).toHaveCount(2)
  await expect(page.locator(".answer .row")).toContainText("Taken")
  // the seeded links are no short links the chat core parses, so no chat's profile is read and each opens its own text
  await expect(page.locator(".answer").getByRole("button", { name: "Contact address", exact: true })).toBeVisible()
  await page.locator(".answer").getByRole("button", { name: "Channel", exact: true }).click()
  const { records } = await searchName(request, "bakery") as { records: { channel: string } }
  await expect(page.getByRole("dialog", { name: "Channel" }).getByRole("link", { name: "Open channel in SimpleX" })).toHaveAttribute("href", records.channel)
  await page.keyboard.press("Escape")
  await shot(page, "N2a-taken")
  await search(page, "harbour")
  await expect(page.locator(".answer .row")).toHaveText("harbour.simplexTaken")
  await expect(page.locator(".answer .chat")).toHaveCount(0)
  await shot(page, "N2b-unlinked")
  await search(page, "support")
  await expect(page.locator(".answer .line")).toHaveText("Reserved names are not sold here. If it is yours to use, write to chat@simplex.chat.")
  await expect(page.locator(".answer").getByRole("link", { name: "chat@simplex.chat" })).toHaveAttribute("href", "mailto:chat@simplex.chat")
  await shot(page, "N2c-reserved")

  const label = uniqueLabel("free")
  await search(page, label)
  const card = page.locator(".answer .row")
  await expect(card).toContainText(`${label}.simplex`)
  // a price and its term, without the letters counted or the bonus days
  await expect(card.locator(".deal")).toHaveText(/^\$\d+ \/ 2 years$/)
  await expect(card.locator(".price")).toHaveText(/^\$\d+$/)
  await expect(card.getByRole("button", { name: "Register" })).toBeEnabled()
  await shot(page, "N2-available")

  await control(request, "search", { chainDown: true })
  await search(page, uniqueLabel("down"))
  await expect(page.locator(".answer .line")).toHaveText("This name could not be checked. Try again")
  await shot(page, "N2d-unchecked")
  await control(request, "search", { chainDown: false, limitSeconds: 30 })
  await search(page, uniqueLabel("lim"))
  await expect(page.locator(".answer [aria-hidden=true]", { hasText: /^Searching is paused: try again in \d+ seconds\.$/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Search" })).toBeDisabled()
  await shot(page, "N2e-rate-limited")
})

test("the window holds the home down to its invest note, with the footer below the fold, as the badges store's", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto("/")
    await page.evaluate(() => document.fonts.ready)
    const fit = () => page.evaluate(() => {
      const footer = document.querySelector("body > footer")!.getBoundingClientRect()
      return { invest: Math.round(document.querySelector("body > .invest")!.getBoundingClientRect().bottom), footer: Math.round(footer.top), scroll: document.documentElement.scrollHeight - Math.round(footer.height) }
    })
    await expect.poll(fit, `${viewport.width}x${viewport.height}: the invest note's foot, the footer's top and the page above the footer`)
      .toEqual({ invest: viewport.height, footer: viewport.height, scroll: viewport.height })
  }
  await expect(page.locator("body > .invest").getByRole("link", { name: "Learn more on Wefunder" })).toHaveAttribute("href", /^https:\/\/wefunder\.com\/simplex\.chat/)
  await expect(page.locator("body > footer").getByRole("link")).toHaveText(["Trademark owners", "simplex.chat/contact"])
})

test("the search is one pill with Search inside it, and each answer is one row of one height, on a laptop and on a phone", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await search(page, uniqueLabel("height"))
    await expect(page.getByRole("button", { name: "Register" })).toBeVisible()
    const box = (await page.locator(".search-field").boundingBox())!
    const lens = (await page.getByRole("button", { name: "Search" }).boundingBox())!
    expect(Math.round(box.height), "the field's height").toBe(48)
    expect(lens.x > box.x && lens.x + lens.width < box.x + box.width && lens.y > box.y && lens.y + lens.height < box.y + box.height, "Search inside the field").toBe(true)
    const rows: number[] = []
    for (const name of ["bakery", "harbour"]) {
      await search(page, name)
      await expect(page.locator(".answer .row")).toContainText("Taken")
      rows.push(Math.round((await page.locator(".answer .row").boundingBox())!.height))
    }
    expect(rows, `${viewport.width} px: a taken name's row with its chats and without`).toEqual([72, 72])
  }
})

test("the checkout explains every refusal and keeps the order", async ({ page, request }) => {
  const label = uniqueLabel("ref")
  await search(page, label)
  await toReview(page)
  const pay = () => payButton(page).click()

  await control(request, "search", { invoiceError: "provider_unavailable" })
  await pay()
  await expect(page.getByText("Bitcoin is temporarily unavailable")).toBeVisible()
  await shot(page, "N3a-method-unavailable")
  await page.getByRole("radio", { name: "Monero" }).click()

  await control(request, "search", { invoiceError: "rate_limited" })
  await pay()
  await expect(page.getByRole("heading", { name: "Too many attempts" })).toBeVisible()
  await shot(page, "N3c-rate-limited")
  // Try again turns on once the wait is over and draws the checkout again
  await page.getByRole("button", { name: "Try again" }).click()

  await control(request, "search", { invoiceError: "internal" })
  await pay()
  await expect(page.getByRole("heading", { name: "That did not go through" })).toBeVisible()
  await shot(page, "N3d-failed")
  // Try again sends the same order again, which meets the next refusal
  await control(request, "search", { invoiceError: "catalog_changed" })
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: "The price changed" })).toBeVisible()
  await shot(page, "N3b-price-changed")
})

test("a name registered by someone else while its order is checked says so at Pay, and that nothing was charged", async ({ page, request }) => {
  const label = uniqueLabel("gone")
  await search(page, label)
  await toReview(page)
  await control(request, "take", { label })
  await expect.poll(async () => (await searchName(request, label)).status, { timeout: REGISTRATION_MS }).toBe("registered")
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: "This name is no longer available" })).toBeVisible()
  await expect(onStep(page).getByText(`${label}.simplex became unavailable after you searched for it. Nothing was charged.`)).toBeVisible()
  await shot(page, "N3g-taken-at-pay")
  await onStep(page).getByRole("button", { name: "Search another name" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("")
})

test("without storage the name code step says the code shown is the only copy, and the order still registers", async ({ browser, request }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError") } })
  })
  const page = await context.newPage()
  const label = uniqueLabel("nos")
  await search(page, label)
  await toCodeStep(page)
  await expect(onStep(page).getByText("This code could not be saved in this browser")).toBeVisible()
  await expect(onStep(page).getByText("Save a copy now: it will be the only one.")).toBeVisible()
  await shot(page, "N3f-no-storage")
  await page.goto("/")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  await context.close()
})

test("the footer's Trademark owners link opens the trademark page", async ({ page }) => {
  await page.goto("/")
  await page.locator("body > footer").getByRole("link", { name: "Trademark owners" }).click()
  await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/trademarks")
})

test("without storage two expired invoices of one order do not lead to each other", async ({ browser, request }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError") } })
  })
  const page = await context.newPage()
  const { invoiceId } = await startOrder(page, uniqueLabel("loop"), { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `expire/${second}`)
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  // a redirect loop would move the page off this invoice within a poll or two
  await page.waitForTimeout(3000)
  expect(new URL(page.url()).searchParams.get("order")).toBe(second)
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toBeEnabled()
  await context.close()
})

test("a new invoice for a method that is unavailable says so and offers another way, with the same name code", async ({ page, request }) => {
  const label = uniqueLabel("unav")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await control(request, "search", { invoiceError: "provider_unavailable" })
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await expect(page.getByText("Bitcoin is unavailable right now")).toBeVisible()
  await page.getByRole("link", { name: "order the name again" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(label)
  // the expired order's name code orders the name again, saved already
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  expect(await checkoutOwnerCode(page), "the expired order's name code").toBe(ownerCode)
  await onStep(page).getByRole("button", { name: "Skip for now" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  await agreeToTerms(page)
  await payButton(page).click()
  await page.waitForURL((url) => (url.searchParams.get("order") ?? invoiceId) !== invoiceId)
  expect(await orderOwnerCode(page, new URL(page.url()).searchParams.get("order")!), "the new order's name code").toBe(ownerCode)
})

test("a double click acts once, whatever the redrawn page puts under the pointer", async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 900 })
  await search(page, uniqueLabel("dbl"))
  await page.getByRole("button", { name: "Register" }).dblclick()
  await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  // the second click did not go on to the name code step, nor into a link field
  expect(new URL(page.url()).hash).toBe("#/checkout/links")
  await expect(onStep(page).getByRole("textbox", { name: "Link", exact: true })).not.toBeFocused()
  await expect(onStep(page).getByRole("button", { name: "Skip for now" })).toBeEnabled()
})

test("a name code's lookup refused for a rate limit counts down its wait, and the code is judged again once it is over", async ({ page, request }) => {
  const { ownerCode } = await startOrder(page, uniqueLabel("rlim"), { method: "btc" })
  await control(request, "search", { findLimitSeconds: 6 })
  await page.goto("/#/code")
  await codeField(page).fill(ownerCode)
  const count = page.locator(".code-entry .verdict [aria-hidden=true]")
  await expect(count).toHaveText(/^Too many checks just now\. Your code may be fine\. Checking again in \d seconds\.$/)
  const add = page.getByRole("button", { name: "Add to Your names" })
  await expect(add).toHaveCount(0)
  // once the wait is over, the code is judged again by itself
  await expect(add).toBeVisible({ timeout: 15_000 })
  await add.click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
})

test("a search link's name is shown folded to lower case", async ({ page }) => {
  await page.goto("/#/?name=Harbour.SIMPLEX")
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("harbour")
})

test("a rate limit answered by a proxy pauses search like the service's own", async ({ page }) => {
  await page.route("**/api/name/**", (route) => route.fulfill({ status: 429, headers: { "retry-after": "20" }, contentType: "text/html", body: "<html>Too Many Requests</html>" }))
  await search(page, uniqueLabel("proxy"))
  await expect(page.locator(".answer [aria-hidden=true]", { hasText: /try again in \d+ seconds/ })).toBeVisible()
})

test("Back to a search from the links step shows its answer at once", async ({ page }) => {
  await search(page, uniqueLabel("back"))
  await page.getByRole("button", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] }
    w.__seen = []
    new MutationObserver((records) => {
      for (const n of records.flatMap((r) => [...r.addedNodes])) {
        if (n instanceof Element && n.matches(".home") && !n.querySelector(".answer .row")) w.__seen.push("a home without the answer")
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  const rechecked = page.waitForResponse(/\/api\/name\/(0x)?[0-9a-f]{64}/)
  await page.goBack()
  await expect(page.getByRole("button", { name: "Register" })).toBeVisible()
  await rechecked
  await expect(page.getByRole("button", { name: "Register" })).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([])
})

for (const [failure, change, shown] of [
  ["the service is down", { chainDown: true }, "This name could not be checked"],
  ["searching is rate limited", { limitSeconds: 10 }, "Searching is paused"],
] as const) {
  test(`Back to a search whose check fails because ${failure} no longer offers the remembered answer`, async ({ page, request }) => {
    await search(page, uniqueLabel("backfail"))
    await page.getByRole("button", { name: "Register" }).click()
    await expect(page.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
    await control(request, "search", change)
    const rechecked = page.waitForResponse(/\/api\/name\/(0x)?[0-9a-f]{64}/)
    await page.goBack()
    await rechecked
    await expect(page.locator(".answer .line", { hasText: shown })).toBeVisible()
    await expect(page.getByRole("button", { name: "Register" })).toHaveCount(0)
    await expect(page.locator(".answer .row")).toHaveCount(0)
  })
}

test("a search pause reads the same after leaving the page and coming back", async ({ page, request }) => {
  await page.goto("/")
  await control(request, "search", { limitSeconds: 30 })
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("pauseback"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  const notice = page.locator(".answer .line")
  await expect(notice).toContainText("Searching is paused: try again in")
  const before = (await notice.innerText()).replace(/try again in \d+ seconds?/g, "")
  await page.getByRole("link", { name: "Your names" }).first().click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await page.goBack()
  await expect(notice).toBeVisible()
  expect((await notice.innerText()).replace(/try again in \d+ seconds?/g, "")).toBe(before)
})

// an expiry ten days ago, well inside the chain's grace period
const LAPSED_S = 10 * 86_400
// a grace period other than the registrar's 90 days, so the line is seen to count the one the answer gives
const GRACE_S = 30 * 86_400
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"

test("search shows an expired name of yours with when it ran out and when it can be registered again", async ({ page }) => {
  const label = uniqueLabel("lapse")
  const hash = hex(labelHash(label))
  const expiresAt = Math.floor(Date.now() / 1000) - LAPSED_S
  await page.goto("/#/trademarks")
  await page.evaluate(({ label, hash, owner }) => localStorage.setItem("simplex-names:order:reg-lapsed", JSON.stringify({
    registrationId: "reg-lapsed", invoiceId: null, label, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner, contact: "", channel: "", method: "code", paid: 0,
    years: 2, tld: "simplex", createdAt: new Date().toISOString(),
    request: { labelHash: hash, length: label.length, owner, commitment: "0x01", sealed: "sealed" },
  })), { label, hash, owner: OWNER })
  await page.route("**/api/name/**", (route) => route.fulfill({ json: {
    status: "registered", entities: [], owner: OWNER, records: { contact: "", channel: "" }, recordsNonce: 0, expiresAt, gracePeriod: GRACE_S, tld: "simplex", community: null,
  } }))
  await page.goto(`/#/?name=${label}`)
  await expect(page.locator(".answer .row")).toContainText("Expired")
  await expect(page.locator(".answer .line")).toHaveText(`Its registration ran out on ${dateOf(expiresAt)}. It can be registered again from ${dateOf(expiresAt + GRACE_S)}.`)
})

const SEARCH_RTT_MS = 300

test("as a search pause ends, the paused line gives way to a checking line rather than an empty room, until the answer", async ({ page, request }) => {
  await page.goto("/")
  // what each drawn frame shows below the search, from the press on
  await recordFrames(page, () => document.querySelector(".answer .row") ? "answer" : document.querySelector(".answer .line")?.textContent ?? "")
  // each search takes a moment to answer, as one over a network does
  await page.route(/\/api\/name\//, async (route) => {
    await new Promise((answered) => setTimeout(answered, SEARCH_RTT_MS))
    await route.continue()
  })
  await control(request, "search", { limitSeconds: 1 })
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("resume"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .line", { hasText: "Searching is paused" })).toBeVisible()
  await expect(page.locator(".answer .row")).toBeVisible({ timeout: 30_000 })
  const frames = await recordedFrames<string>(page)
  const paused = frames.findIndex((f) => f.startsWith("Searching is paused"))
  const answered = frames.indexOf("answer")
  expect(paused, "a frame with the paused line").toBeGreaterThanOrEqual(0)
  const between = [...new Set(frames.slice(paused, answered))]
  expect(between.filter((f) => !f.startsWith("Searching is paused") && f !== "Checking the name…"), "what showed between the pause and the answer").toEqual([])
})
