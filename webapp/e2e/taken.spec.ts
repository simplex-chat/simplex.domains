import { expect } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { labelHash } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import {
  addNameCode, answersReserved, agreeToTerms, checkoutOwnerCode, contactLink, control, failedOrder, FIT_SIZES, MOCK, mockRegistration, onStep, payButton, previewsShown, REGISTRATION_MS, registrationOf, savedToReview,
  offCentre, search, searchName, sevenLetters, shot, startOrder, takenHeading, takenOrder, test, toCodeStep, toReview, uniqueLabel, useCode, waitRegistered,
} from "./helpers.ts"

test("a name taken first keeps its payment as its balance, which pays for another name owned by the same code", async ({ page, request }) => {
  const label = uniqueLabel("tk")
  const { invoiceId, ownerCode } = await takenOrder(page, request, label)
  await expect(onStep(page).locator(".notice", { hasText: "What you paid is kept as your balance." })).toBeVisible()
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Taken")
  await expect(page.getByText(`Reference ${invoiceId}`)).toBeVisible()
  await shot(page, "N8-taken")
  // a browser without the order's code says where to add it, and offers neither the balance nor its refund
  const elsewhere = await page.context().browser()!.newContext()
  const stranger = await elsewhere.newPage()
  await stranger.goto(`/?order=${invoiceId}`)
  await expect(stranger.getByText("Add it in Check your code to use the balance.")).toBeVisible()
  await expect(onStep(stranger).getByRole("button", { name: "Choose another name" })).toBeDisabled()
  await expect(onStep(stranger).getByText("Get a refund")).toHaveCount(0)
  await elsewhere.close()

  await page.getByRole("button", { name: "Choose another name" }).click()
  await expect(page.locator(".code-chip")).toContainText("Balance: $100")
  await expect(page.getByRole("button", { name: "Stop using the balance" })).toBeVisible()
  const next = uniqueLabel("tk2")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .hint")).toHaveText("Paid from your balance.")
  await shot(page, "N8a-another-name")
  await toCodeStep(page)
  expect(await checkoutOwnerCode(page), "the balance's name code owns the new name too").toBe(ownerCode)
  await savedToReview(page)
  await expect(onStep(page).locator(".trow", { hasText: "From your balance" })).toContainText("\u2212$100")
  await expect(onStep(page).locator(".trow.total")).toHaveText(/^To pay\s*\$0$/)
  await expect(page.getByRole("radio", { name: "Bitcoin" }), "nothing is left to pay with a method").toHaveCount(0)
  await onStep(page).getByRole("button", { name: "Register with your balance" }).click()
  await page.waitForURL(/\?registration=/)
  await expect(page.locator(".code-chip"), "a spent balance pays for nothing more").toBeHidden()
  await waitRegistered(page, next)
  const answer = await searchName(request, next)
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
})

test("a paid order whose name was reserved meanwhile says so, and keeps its payment as its balance", async ({ page, request }) => {
  const label = uniqueLabel("prs")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await answersReserved(page, label)
  await control(request, "take", { label })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `${label}.simplex is reserved` })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(onStep(page).locator(".lead")).toHaveText("It was reserved meanwhile, so it can't be registered.")
  await expect(onStep(page).locator(".stage.failed")).toHaveText("Reserved")
  await expect(onStep(page).locator(".notice", { hasText: "What you paid is kept as your balance." })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Choose another name" })).toBeEnabled()
})

// a wait on moving the payment that ends while the search gone back to is still out, and that search's answer
const MOVE_WAIT_S = 3
const SEARCH_RTT_MS = 5_000

test("a wait on moving the payment that ends while Back checks the name again sends no second search", async ({ page, request }) => {
  const { registrationId } = await failedOrder(page, request, uniqueLabel("tw"))
  await page.goto(`/#/?retarget=${registrationId}`)
  const next = uniqueLabel("tw2")
  // an order this browser made for the name before, which has Back check the name again
  await page.evaluate(({ label, hash }) => localStorage.setItem("simplex-names:order:reg-before", JSON.stringify({
    registrationId: "reg-before", invoiceId: null, label, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    contact: "", channel: "", method: "code", paid: 0, years: 2, tld: "simplex", createdAt: new Date().toISOString(),
    request: { labelHash: hash, length: label.length, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: "0x01", sealed: "sealed" },
  })), { label: next, hash: hex(labelHash(next)) })
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.getByText("Covered by your payment")).toBeVisible()
  await page.route("**/name", (route) => route.request().method() === "POST" ? route.fulfill({ status: 429, headers: { "retry-after": String(MOVE_WAIT_S) }, json: { error: "rate_limited" } }) : route.continue())
  await agreeToTerms(page)
  await page.getByRole("button", { name: "Register with your payment" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  let searches = 0
  await page.route("**/api/name/**", async (route) => {
    searches++
    await new Promise((answered) => setTimeout(answered, SEARCH_RTT_MS))
    await route.continue()
  })
  await page.locator("body > footer").getByRole("link", { name: "Trademark owners" }).click()
  await expect(page.getByRole("heading", { name: "Trademark owners" })).toBeVisible()
  await page.goBack()
  await expect(page.locator(".answer .line", { hasText: "Checking the name…" })).toBeVisible()
  await expect(page.getByText("Covered by your payment")).toBeVisible({ timeout: 2 * SEARCH_RTT_MS })
  expect(searches, "searches sent since Back").toBe(1)
})

test("a failed registration is retried without paying again, and another tab follows the retry", async ({ page, request }) => {
  const label = uniqueLabel("fl")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `fail/${await registrationOf(request, invoiceId)}`)
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 60_000 })
  // the service's own sentence, then what the buyer can do, with support's address for the reference below
  const alert = onStep(page).locator(".notice", { hasText: "The blockchain did not take the commit" })
  // the lead above already says the payment is kept and that trying again charges nothing
  await expect(onStep(page).locator(".screen-head .lead")).toHaveText("Your payment is kept. Trying again charges nothing.")
  await expect(alert).toHaveText("The blockchain did not take the commitIf Try again still fails, write to chat@simplex.chat with its reference.")
  await expect(alert.getByRole("link", { name: "chat@simplex.chat" })).toHaveAttribute("href", "mailto:chat@simplex.chat")
  // the order's line centred under the heading and its lead, as it is when it is the lead
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await offCentre(onStep(page).locator(".screen-body > .note").first()), `the order's line at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, "N9-failed")
  const other = await page.context().newPage()
  await other.goto(`/?order=${invoiceId}`)
  await expect(other.getByRole("heading", { name: "Paid, not registered" })).toBeVisible()
  // a rate-limited retry holds its button for the wait
  await page.route("**/retry", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await page.getByRole("button", { name: "Try again" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toBeDisabled()
  await page.unroute("**/retry")
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled({ timeout: 10_000 })
  // a keyboard user is back on the button once the wait is over
  await expect(page.getByRole("button", { name: "Try again" })).toBeFocused()
  await page.getByRole("button", { name: "Try again" }).click()
  // the button is gone from the redrawn page, so focus goes to its heading at once
  await expect(page.locator("main h1")).toBeFocused({ timeout: 2_000 })
  await expect(other.getByRole("heading", { name: "Paid, not registered" })).toHaveCount(0)
  await waitRegistered(page, label)
  await waitRegistered(other, label)
})

// a chain that fails each transaction before it goes out, as an RPC provider down for a while, and a look half way through
const UNSENT_S = 4
const UNSENT_CHECK_MS = UNSENT_S * 1000 / 2
test("a chain that sends nothing for a moment keeps the order where it was, then registers it", async ({ page, request }) => {
  const label = uniqueLabel("ns")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: UNSENT_S })
    await control(request, `settle/${invoiceId}`)
    await page.waitForTimeout(UNSENT_CHECK_MS)
    // tried again every few seconds, the commit neither fails nor goes back to the queue
    expect((await mockRegistration(request, invoiceId)).phase).toBe("committing")
    await expect(page.locator(".stage.active", { hasText: "Committing" })).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await waitRegistered(page, label)
})

test("a chain that sends nothing for longer than its resends fails the order in plain words, and Try again sends it", async ({ page, request }) => {
  test.setTimeout(240_000)
  const label = uniqueLabel("nd")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  try {
    await control(request, "search", { unsentSeconds: 120 })
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByRole("heading", { name: "Paid, not registered" })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText("The blockchain did not answer")).toBeVisible()
  } finally {
    await control(request, "search", { unsentSeconds: 0 })
  }
  await page.getByRole("button", { name: "Try again" }).click()
  await waitRegistered(page, label)
})

test("a late payment to a replaced invoice is kept by a restored browser after the order's balance paid for another name", async ({ page, browser, request }) => {
  const label = `${uniqueLabel("adopt")}-${"long-name".repeat(4)}`
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, "take", { label })
  await control(request, `settle/${second}`)
  await expect(page.getByRole("heading", { name: takenHeading(label) })).toBeVisible({ timeout: REGISTRATION_MS })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByRole("button", { name: "Choose another name" }).click()
  const next = uniqueLabel("adopt2")
  await search(page, next)
  await toReview(page)
  await onStep(page).getByRole("button", { name: "Register with your balance" }).click()
  await page.waitForURL(/\?registration=/)
  await waitRegistered(page, next)

  // another browser restores the code, which finds the name it registered, and opens the taken order
  const other = await browser.newContext()
  const restored = await other.newPage()
  await addNameCode(restored, ownerCode)
  await restored.goto(`/?order=${second}`)
  await expect(restored.getByRole("heading", { name: takenHeading(label) })).toBeVisible()
  await control(request, `partial/${invoiceId}`)
  await restored.goto(`/?order=${invoiceId}`)
  await expect(restored.getByText(/BTC arrived, which is not the full amount/)).toBeVisible()
  await restored.goto("/#/names")
  // the taken order and the replaced one that the money reached each have a row of the name
  await expect(restored.locator(".list-row:visible", { hasText: `${label}.simplex` }).filter({ hasText: "Part of the payment arrived; kept as your balance" })).toHaveCount(1)
  await restored.goto(`/?order=${invoiceId}`)
  await restored.getByRole("button", { name: "Open the new invoice" }).click()
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await other.close()

  // the name someone else registered, searched at phone width, wraps inside its card
  await page.goto(`/#/?name=${label}`)
  await expect(page.getByText("Taken", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})


test("an order whose links the service refuses at its reveal registers without them, and a move past the limit names support", async ({ page, request }) => {
  const label = uniqueLabel("lr")
  await search(page, label)
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("LR"))
  await previewsShown(page)
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await savedToReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const invoiceId = new URL(page.url()).searchParams.get("order")!
  // the service's link check refuses the next reveal's links, which the order committed to
  await control(request, "search", { refuseLinks: true })
  try {
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByText("The service refused this order's links")).toBeVisible({ timeout: REGISTRATION_MS })
  } finally {
    await control(request, "search", { refuseLinks: false })
  }
  const move = page.getByRole("button", { name: "Register without links" })
  await page.route("**/api/registration/*/name", (route) => route.fulfill({ status: 409, json: { error: "move_limit" } }))
  await move.click()
  await expect(page.getByText("This order cannot move again")).toBeVisible()
  await expect(page.locator(".notice", { hasText: "cannot move again" })).toContainText(`: ${invoiceId}.`)
  await page.unrouteAll({ behavior: "wait" })
  await move.click()
  await waitRegistered(page, label)
  const view = await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as { registration: { moves: number } }
  expect(view.registration.moves).toBe(1)
  const answer = await searchName(request, label)
  expect(answer.records).toEqual({ contact: "", channel: "" })
})

test("Register without links that loses a race follows the order as it is now, saying nothing changed only when nothing did", async ({ page, request }) => {
  const label = uniqueLabel("lrr")
  await search(page, label)
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("LRR"))
  await previewsShown(page)
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await savedToReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const invoiceId = new URL(page.url()).searchParams.get("order")!
  await control(request, "search", { refuseLinks: true })
  try {
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByText("The service refused this order's links")).toBeVisible({ timeout: REGISTRATION_MS })
  } finally {
    await control(request, "search", { refuseLinks: false })
  }
  // the service's answer to a move whose order changed meanwhile, the order as it is now, which this move left as it was
  const view = await (await request.get(`${MOCK}/api/registration/${await registrationOf(request, invoiceId)}`)).json()
  await page.route("**/api/registration/*/name", (route) => route.fulfill({ status: 409, json: { error: "registration_changed", registration: view } }))
  await onStep(page).getByRole("button", { name: "Register without links" }).click()
  await expect(onStep(page).getByText("That did not go through. Nothing changed. Try again in a moment.")).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Register without links" })).toBeEnabled()

  // the order lapsed first, failed with its links still refused, which keeps the same screen
  await page.unrouteAll({ behavior: "wait" })
  const lapsed = { ...view, version: view.version + 1, phase: "failed", error: "The name was not signed in time" }
  await page.route("**/api/registration/*/name", (route) => route.fulfill({ status: 409, json: { error: "registration_changed", registration: lapsed } }))
  await onStep(page).getByRole("button", { name: "Register without links" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Paid, not registered" })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Register without links" })).toBeEnabled()
  await expect(onStep(page).getByRole("button", { name: "Register without links" })).not.toHaveAttribute("aria-busy", "true")

  await page.unrouteAll({ behavior: "wait" })
  const moved = { ...view, version: view.version + 1, moves: 1, phase: "queued", linksRefused: false, label: null, revealAfter: null, revealBefore: null, commitTx: null }
  await page.route("**/api/registration/*/name", (route) => route.fulfill({ status: 409, json: { error: "registration_changed", registration: moved } }))
  await onStep(page).getByRole("button", { name: "Register without links" }).click()
  await expect(onStep(page).getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible()
  await expect(onStep(page).getByText("The service refused this order's links")).toHaveCount(0)
  await expect(page.getByText("Nothing changed")).toHaveCount(0)
})

test("an order failed with links the service refused offers no Try again, which the service refuses, in another browser too, and registers without them", async ({ page, browser, request }) => {
  const label = uniqueLabel("lf")
  await search(page, label)
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("LF"))
  await previewsShown(page)
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await savedToReview(page)
  const ownerCode = await checkoutOwnerCode(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const invoiceId = new URL(page.url()).searchParams.get("order")!
  await control(request, "search", { refuseLinks: true })
  try {
    await control(request, `settle/${invoiceId}`)
    await expect(page.getByText("The service refused this order's links")).toBeVisible({ timeout: REGISTRATION_MS })
  } finally {
    await control(request, "search", { refuseLinks: false })
  }
  // the commitment runs out unsigned, and the order fails with the refused links still in it
  const registrationId = await registrationOf(request, invoiceId)
  await control(request, `lapse/${registrationId}`)
  await expect(onStep(page).getByRole("heading", { name: "Paid, not registered" })).toBeVisible()
  await expect(onStep(page).getByText("The service refused this order's links")).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Try again" })).toHaveCount(0)
  await expect(onStep(page).getByRole("button", { name: "Choose another name" })).toBeVisible()
  await shot(page, "N9b-failed-links-refused")
  const retried = await request.post(`${MOCK}/api/registration/${registrationId}/retry`)
  expect([retried.status(), (await retried.json()).error], "a retry would commit the refused links again").toEqual([400, "bad_request"])

  // a browser that restores the code learns of the refusal from the view
  const other = await browser.newContext()
  const restored = await other.newPage()
  await addNameCode(restored, ownerCode)
  await restored.goto(`/?order=${invoiceId}`)
  await expect(onStep(restored).getByRole("button", { name: "Register without links" })).toBeVisible()
  await expect(onStep(restored).getByRole("button", { name: "Try again" })).toHaveCount(0)
  await other.close()

  await onStep(page).getByRole("button", { name: "Register without links" }).click()
  await waitRegistered(page, label)
  expect((await searchName(request, label)).records).toEqual({ contact: "", channel: "" })
})

test("a failed order's move to a cheaper name says the rest stays as its balance", async ({ page, request }) => {
  const label = `t${Math.random().toString(36).slice(2).replace(/[^a-z]/g, "").padEnd(6, "t")}`.slice(0, 7)
  const { registrationId } = await failedOrder(page, request, label)
  await page.goto(`/#/?retarget=${registrationId}`)
  await expect(page.getByText(/Your payment is kept: \$200\./)).toBeVisible()
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("cheap"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .line", { hasText: "Uses" })).toHaveText("Uses $100 of your $200; the rest stays as your balance.")
})

// shorter than any unique label, which is the order's first name and the name it moves to
const CODE_MIN_LENGTH = 10

test("a code order whose links the service refuses moves to another name its code pays for, which costs it nothing", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: CODE_MIN_LENGTH }) as { code: string }
  await useCode(page, code)
  await search(page, uniqueLabel("cmv"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("CM"))
  await previewsShown(page)
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await savedToReview(page)
  const ownerCode = await checkoutOwnerCode(page)
  await control(request, "search", { refuseLinks: true })
  try {
    await onStep(page).getByRole("button", { name: "Register with your code" }).click()
    await expect(page.getByText("The service refused this order's links")).toBeVisible({ timeout: REGISTRATION_MS })
  } finally {
    await control(request, "search", { refuseLinks: false })
  }
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  await expect(page.locator(".notice", { hasText: "Your code is kept." })).toHaveText(`Your code is kept.It pays for another name of ${CODE_MIN_LENGTH} or more letters, for 2 years.`)

  const short = sevenLetters()
  await page.getByLabel("Name", { exact: true }).fill(short)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .line", { hasText: "Your code" })).toHaveText(`Your code pays for a name of ${CODE_MIN_LENGTH} or more letters. This name has 7.`)
  await expect(page.getByRole("button", { name: "Register with your code" })).toBeDisabled()

  const next = uniqueLabel("cmn")
  await page.getByLabel("Name", { exact: true }).fill(next)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(page.locator(".answer .line", { hasText: "Covered by your code" })).toBeVisible()
  await expect(page.locator(".answer .deal")).toHaveText("Free / 2 years")
  await expect(page.locator("body > main"), "a code is no payment").not.toContainText("$0")
  await shot(page, "N8a3-code-move")
  await agreeToTerms(page)
  await page.getByRole("button", { name: "Register with your code" }).click()
  await waitRegistered(page, next)
  expect((await searchName(request, next)).owner, "the order's name code owns the name it moved to").toBe(checksumAddress(walletOf(ownerCode)!.address))
})
