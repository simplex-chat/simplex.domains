import { expect, type Locator, type Page, type Route } from "@playwright/test"
import { walletOf } from "../src/flow.ts"
import { CONTACT_KEY } from "../src/crypto/registration.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import { dateOf } from "../src/format.ts"
import { LINK_MAX_BYTES } from "../src/names.ts"
import { CARD_FORM_TIMEOUT_MS } from "../src/stripe.ts"
import {
  blockTimeOf, chainExpiry, channelLink, CHECKOUT_KEY, checkoutOwnerCode, CODE_HEADING, codeField, contactLink, control, fakeRegisteredName, fillLinks, FIT_SIZES, LINKS_HEADING, MOCK, mockRegistration, onStep, oracleQuote, payButton, previewsShown, REGISTRATION_MS,
  offCentre, orderOwnerCode, qrText, registrationOf, restoreOrder, SAVED, AGREE, agreeToTerms, savedToReview, search, searchName, shot, shownCode, SLOW_FETCH_MS, startOrder, test, toCodeStep, toFullReview, toReview, uniqueLabel, waitRegistered, withStripeKey, AVAILABLE_BRIEF, TAKEN_BRIEF,
} from "./helpers.ts"

// the card form these tests pay with is the dev server's stand-in; a production build loads Stripe's own
const STAND_IN_ONLY = "needs the dev server's card stand-in"
// a production build's service worker answers the page's requests past Playwright's routes, in WebKit
test.use({ serviceWorkers: "block" })

// A test that raised the mock's yearly limit of link edits puts back the service's default. Only the mock has the
// control, so the cases the service's contract run takes from here never reach it.
const EDITS_PER_YEAR = 3
let editsRaised = false
test.afterEach(async ({ request }) => {
  if (!editsRaised) return
  editsRaised = false
  await control(request, "edits", { limit: EDITS_PER_YEAR })
})

// a field's focus ring reaches 4 px past it, and keeps clear of the label over it
const RING_ROOM_PX = 6

// a stage's drawn line: where the bar's gradient turns from the fill to the track; null for a stage the page has just
// replaced, which has no style left to read
const drawnFill = (stage: Locator) => stage.evaluate((node) => {
  if (node.classList.contains("done")) return 1
  const stops = getComputedStyle(node, "::before").backgroundImage.match(/[\d.]+%/g)
  return stops ? parseFloat(stops[1]) / 100 : null
})

test("the wait's line fills as the wait goes, and is full when it ends", async ({ page, request }) => {
  // each wait stage drawn, as it is first attached: whether its fill is set before it can paint
  await page.addInitScript(() => {
    const w = window as unknown as { __fills: string[] }
    w.__fills = []
    new MutationObserver((changes) => {
      for (const node of changes.flatMap((c) => [...c.addedNodes])) {
        if (!(node instanceof Element)) continue
        const stages = [...node.querySelectorAll<HTMLElement>(".stage.active")].filter((s) => s.textContent?.includes("Waiting"))
        for (const stage of stages) w.__fills.push(stage.style.getPropertyValue("--done"))
      }
    }).observe(document, { childList: true, subtree: true })
  })
  const { invoiceId } = await startOrder(page, uniqueLabel("fill"), { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  const wait = page.locator("body > main .stage", { hasText: "Waiting" })
  await expect(wait).toHaveClass(/\bactive\b/, { timeout: REGISTRATION_MS })
  const filled = () => drawnFill(wait)
  const first = (await filled())!
  expect(first, "the line starts short of full").toBeLessThan(1)
  expect(first, "the line starts visibly filled, apart from the stages to come").toBeGreaterThanOrEqual(0.08)
  const fills = await page.evaluate(() => (window as unknown as { __fills: string[] }).__fills)
  expect(fills.length, "the wait stage was drawn").toBeGreaterThan(0)
  expect(fills.filter((f) => f === ""), `every wait stage is drawn with its fill set: ${fills}`).toEqual([])
  await expect.poll(filled, { message: "the line fills as the wait goes" }).toBeGreaterThan(first)
  await page.locator(".countdown b > svg").waitFor({ timeout: REGISTRATION_MS })
  await expect.poll(filled, { message: "the line is full when the wait ends" }).toBe(1)
})

test("a stage with no timed wait, as the register transaction being mined, draws no fill", async ({ page, request }) => {
  const label = uniqueLabel("mined")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible({ timeout: REGISTRATION_MS })
  // the order is held at its register transaction, whatever the chain does meanwhile
  await page.route(`**/api/invoice/${invoiceId}*`, async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    await route.fulfill({ response, json: { ...json, registration: { ...json.registration, phase: "registering" } } })
  })
  await page.reload()
  const mined = page.locator("body > main .stage.active")
  await expect(mined).toContainText("Registering")
  // a node the page redraws between finding and reading it has no style; the stage drawn again is read again
  await expect.poll(() => drawnFill(mined), { message: "the untimed stage's drawn fill" }).toBe(0)
  await page.unrouteAll({ behavior: "wait" })
})

test("a Bitcoin order pays in two parts, registers on chain, takes its links on Edit links, and the code owns it", async ({ page, request }) => {
  const label = uniqueLabel("btc")
  const contact = contactLink("A1")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc", shots: "N3" })
  expect(ownerCode).toMatch(/^SN-/)

  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(onStep(page).locator(".card.pay .qr svg")).toBeVisible()
  await expect(onStep(page).locator(".pay-status")).toHaveText(new RegExp(`^Waiting for paymentInvoice valid for \\d+:\\d\\dReference ${invoiceId}$`))
  await shot(page, "N4-bitcoin")
  // the wallet link is a BIP21 URI for what is left to send, and each copy button says what it copies
  const invoice = async () => (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as Promise<{ address: string; cryptoAmount: string; cryptoAmountDue: string }>
  const wallet = onStep(page).getByRole("link", { name: "Open in wallet" })
  const { address, cryptoAmount } = await invoice()
  await expect(wallet).toHaveAttribute("href", `bitcoin:${address}?amount=${cryptoAmount}`)
  await expect(onStep(page).getByRole("button", { name: "Copy amount in BTC" })).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Copy Bitcoin address" })).toBeVisible()
  // a laptop opens the wallet from the QR's card; a phone, without the QR, from the link under the address
  await expect(wallet.locator("xpath=..")).toHaveClass(/\bqr\b/)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(onStep(page).locator(".qr-grid > .qr")).toBeHidden()
  await expect(wallet).toHaveClass(/\bwallet\b/)
  await expect(wallet).toHaveAttribute("href", `bitcoin:${address}?amount=${cryptoAmount}`)
  const [walletBox, addressBox] = [(await wallet.boundingBox())!, (await onStep(page).locator(".copy-field").last().boundingBox())!]
  expect(walletBox.y, "the wallet's link under the address").toBeGreaterThan(addressBox.y + addressBox.height)
  await page.setViewportSize({ width: 1280, height: 900 })

  await control(request, `partial/${invoiceId}`)
  await expect(page.getByText("Part of the payment arrived")).toBeVisible()
  const { cryptoAmountDue } = await invoice()
  expect(cryptoAmountDue, "the rest is less than the whole").not.toBe(cryptoAmount)
  await expect(wallet).toHaveAttribute("href", `bitcoin:${address}?amount=${cryptoAmountDue}`)
  await expect(onStep(page).getByRole("button", { name: "Copy rest to send in BTC" })).toBeVisible()
  await shot(page, "N4a-partial")

  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible()
  await expect(page.locator(".stage.done", { hasText: "Committed" })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(".countdown b")).toHaveText(/\d+:\d\d/)
  await shot(page, "N6a-waiting")
  await waitRegistered(page, label)
  await expect(page.getByTestId("owner-code"), "the name code is hidden until shown").not.toHaveText(ownerCode)
  await expect(await shownCode(page), "the code to use in the app").toHaveText(ownerCode)
  await shot(page, "N7-registered")

  const answer = await searchName(request, label)
  expect(answer.status).toBe("registered")
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
  expect(answer.records, "a name whose links were skipped is registered with none").toEqual({ contact: "", channel: "" })
  const registrationId = await registrationOf(request, invoiceId)

  // edit links: both links, signed in the page, sent by the mock's relayer
  await page.goto(`/#/edit/${registrationId}`)
  const link = page.getByRole("textbox", { name: "Link", exact: true })
  const channelField = page.getByRole("textbox", { name: "Channel", exact: true })
  await expect(link).toHaveValue("")
  const labelRoom = await page.locator(".link-fields").evaluate((fields) => fields.querySelector(".field")!.getBoundingClientRect().top - fields.previousElementSibling!.getBoundingClientRect().bottom)
  expect(labelRoom, "room between the label and the field's focus ring").toBeGreaterThanOrEqual(RING_ROOM_PX)
  await link.fill(contact)
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  const channel = channelLink("B2")
  await page.getByRole("button", { name: "Add a channel link" }).click()
  await channelField.fill(channel)
  await expect(page.locator(".link-field").nth(1)).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  // Save stays off with nothing left to save, so focus goes to the answer below it, which stays in view
  const saved = page.locator(".notice", { hasText: "Links saved" })
  await expect(saved).toBeFocused()
  await expect(saved).toBeInViewport()
  await shot(page, "N12b-edit-links")
  expect((await searchName(request, label)).records).toEqual({ contact, channel })

  await page.goto(`/#/?name=${label}`)
  await expect(page.locator(".answer").getByRole("button", { name: "Contact A1Y8m3, contact address" })).toBeVisible()
  await expect(page.locator(".answer .row").getByRole("link", { name: "Your name" })).toHaveAttribute("href", "/#/names")
  await shot(page, "N2a-taken-own")
  // the saves below are more than a name's yearly limit of edits
  editsRaised = true
  await control(request, "edits", { limit: 100 })
  await page.goto(`/#/edit/${registrationId}`)
  await expect(link).toHaveValue(contact)
  await expect(channelField).toHaveValue(channel)

  // a rate-limited edit keeps Save off for the wait it was given, whatever is typed meanwhile
  await page.route("**/api/name/records", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  await link.fill("")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Too many attempts")).toBeVisible()
  await link.fill(contact)
  await link.fill("")
  await expect(page.getByRole("button", { name: "Save links" })).toBeDisabled()
  await page.unroute("**/api/name/records")
  await expect(page.getByRole("button", { name: "Save links" })).toBeEnabled({ timeout: 10_000 })

  // a second edit spends the next resolver nonce
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact: "", channel })

  // a Save of both links is one request, so a refusal leaves both as the chain has them
  const nextChannel = channelLink("C3")
  const refused: { edits: { key: string }[] }[] = []
  await page.route("**/api/name/records", (route) => {
    refused.push(route.request().postDataJSON())
    return route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } })
  })
  await link.fill(contact)
  await channelField.fill(nextChannel)
  await expect(page.locator(".link-field").nth(1)).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.locator("[aria-hidden=true]", { hasText: /^The links were not saved\. Try again in/ })).toBeVisible({ timeout: 30_000 })
  expect(refused.map((body) => body.edits.map((e) => e.key))).toEqual([["simplex.contact", "simplex.channel"]])
  expect((await searchName(request, label)).records).toEqual({ contact: "", channel })
  await page.unroute("**/api/name/records")
  await expect(page.getByRole("button", { name: "Save links" })).toBeEnabled({ timeout: 10_000 })
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact, channel: nextChannel })

  // a Save refused because an earlier one moved the nonce shows the links on chain in both fields
  const nonceMoved = (ahead: number, records: { contact: string; channel: string }) => page.route(/\/api\/name\/(0x)?[0-9a-f]{64}/, async (route) => {
    const res = await route.fetch()
    const json = await res.json() as { recordsNonce: number }
    await route.fulfill({ response: res, json: { ...json, recordsNonce: json.recordsNonce + ahead, records } })
  })
  await page.route("**/api/name/records", (route) => route.fulfill({ status: 400, json: { error: "bad_request" } }))
  await nonceMoved(2, { contact, channel: nextChannel })
  await link.fill("")
  await channelField.fill(channelLink("D4"))
  await expect(page.locator(".link-field").nth(1)).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("An earlier save got there first")).toBeVisible({ timeout: 30_000 })
  await expect(link).toHaveValue(contact)
  await expect(channelField).toHaveValue(nextChannel)
  await expect(page.locator(".link-field").first().locator(".entity:not(.skeleton)")).toBeVisible()
  await expect(page.locator(".link-field").nth(1).locator(".entity:not(.skeleton)")).toBeVisible()
  await expect(page.getByText("An earlier save got there first")).toBeVisible()
  await page.unroute(/\/api\/name\/(0x)?[0-9a-f]{64}/)
  await page.unroute("**/api/name/records")
  // read again, the page signs with the chain's own nonce
  await page.reload()
  await expect(link).toHaveValue(contact)
  await link.fill("")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact: "", channel: nextChannel })

  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  // a registered name says so by its date, and shows the chats it opens
  await expect(row.locator(".chip")).toHaveCount(0)
  await expect(row.locator(".sub")).toHaveText(`Until ${dateOf((await searchName(request, label)).expiresAt as number)}`)
  await expect(row.locator(".chats .chat-pic")).toHaveCount(1)
  await shot(page, "N12-history")
  // Name code opens the code in its own row, focus staying on the toggle, which folds it again
  const toggle = row.getByRole("button", { name: "Name code" })
  await toggle.focus()
  await page.keyboard.press("Enter")
  await expect(row.locator(".row-code .code-text")).toHaveText(ownerCode)
  await expect(row.locator(".row-code svg.qr")).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(toggle).toBeFocused()
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await offCentre(row.locator(".row-code > .qr")), `the name code's QR at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, "N12g-history-code")
  await page.keyboard.press("Enter")
  await expect(row.locator(".row-code")).toHaveCount(0)
  await expect(toggle).toBeFocused()

  // the chain holds the channel alone, which the Link field now shows; the contact goes in the field added for it
  await row.getByText("Edit links").click()
  await expect(link).toHaveValue(nextChannel)
  await page.getByRole("button", { name: "Add a contact address" }).click()
  await page.getByRole("textbox", { name: "Contact address" }).fill(contact)
  await expect(page.locator(".link-field").nth(1)).toHaveAttribute("data-state", "ok")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
})

test("a purchase walks the steps a buyer expects, and the links set before paying are on chain", async ({ page, request }) => {
  const label = uniqueLabel("flow")
  const [contact, channel] = [contactLink("F1"), channelLink("G1")]
  await search(page, label)
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)

  await expect(step.getByRole("heading", { name: "Your name's links" })).toBeFocused()
  await expect(step.locator(".lead")).toHaveText("Paste your SimpleX contact address or channel link. You can change it later.")
  await expect(step.getByRole("button", { name: "Skip for now" })).toBeVisible()
  await expect(step.getByRole("button", { name: "Continue" }), "Continue waits for a link").toBeDisabled()
  await fillLinks(page, contact, channel)
  await expect(step.getByRole("button", { name: "Skip for now" }), "a link given leaves only Continue").toHaveCount(0)
  await step.getByRole("textbox", { name: "Channel" }).blur()
  for (const field of await step.locator(".link-field").all()) {
    await expect(field).toHaveAttribute("data-state", "ok")
    await expect(field.locator(".entity:not(.skeleton)")).toBeVisible()
  }
  await expect(step.locator(".link-field .entity small")).toHaveText(["Contact address", "Channel"])
  await expect(step.getByRole("button", { name: /^Add a/ }), "one link of each kind").toHaveCount(0)
  await step.getByRole("button", { name: "Continue" }).click()

  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeFocused()
  const ownerCode = await checkoutOwnerCode(page)
  await expect(step.getByTestId("owner-code"), "the name code is hidden until shown").not.toHaveText(ownerCode)
  await expect(await shownCode(page)).toHaveText(ownerCode)
  expect(await page.evaluate((c) => localStorage.getItem(`simplex-names:pending:${c}`) !== null, ownerCode), "the code is kept in this browser as its step opens").toBe(true)
  await expect(step.getByText(`It is the only key to ${label}.simplex. If you lose it, nothing can recover it.`)).toBeVisible()
  const next = step.getByRole("button", { name: "Continue" })
  await expect(next, "Continue waits for the box").toBeDisabled()
  await step.getByText(SAVED).click()
  await expect(next).toBeEnabled()
  await next.click()

  await expect(step.getByRole("heading", { name: "Check your order" })).toBeFocused()
  // the order, then how it pays and what to know before paying, in one column, and under it the line a wait would say
  expect(await step.locator(".review > *").evaluateAll((nodes) => nodes.map((n) => n.className))).toEqual(["card order", "pay-with", "have-code", "notes"])
  await expect(step.locator(".screen-body > .review + [role=status] + .mid")).toHaveCount(1)
  await expect(step.locator(".card.order .name")).toHaveText(`${label}.simplex`)
  // the term holds the free days until the paid years start, which are folded into it
  await expect(step.locator(".card.order .trow")).toHaveText([/^Term2 years and (\d{2,} days|1 day)Early adopter bonus: your 2 years start on 1\u00a0January 2027\.$/, /^Registered until31\u00a0December 2028$/, /^Total\$\d+$/])
  // each link as the chat it opens, read only
  await expect(step.locator(".card.order .chat")).toHaveCount(2)
  await expect(step.getByRole("button", { name: "Contact F1Y8m3, contact address" })).toBeVisible()
  await expect(step.getByRole("button", { name: /^Change/ })).toHaveCount(0)
  await expect(step.getByRole("radio")).toHaveText(["Card", "Bitcoin", "Monero"])
  // the ETH link ends the note under the methods, and nothing sits under Pay
  const dapp = step.locator(".notes").getByRole("link", { name: "Pay with ETH" })
  await expect(dapp).toHaveAttribute("href", "https://app.simplex.domains")
  await expect(step.locator(".notes")).toHaveText("After paying, keep this page open, or reopen its link within 24 hours. Pay with ETH")
  await expect(step.locator(".actions-row .alt")).toHaveCount(0)
  // the one box to tick, the terms, holds Pay until it is ticked; its link opens the terms beside the order
  await expect(step.getByRole("checkbox")).toHaveCount(1)
  const terms = step.getByRole("checkbox", { name: AGREE })
  await expect(terms).not.toBeChecked()
  await expect(payButton(page), "Pay waits for the terms").toBeDisabled()
  await expect(step.getByRole("link", { name: "SimpleX name terms" })).toHaveAttribute("href", "https://simplex.chat/")
  await expect(step.getByRole("link", { name: "SimpleX name terms" })).toHaveAttribute("target", "_blank")
  await agreeToTerms(page)
  await expect(payButton(page)).toBeEnabled()

  // Back walks the steps in reverse, the box still ticked and the links kept
  await step.getByRole("link", { name: "Back" }).click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeFocused()
  await expect(step.getByRole("checkbox", { name: SAVED })).toBeChecked()
  await step.getByRole("link", { name: "Back" }).click()
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeFocused()
  await expect(step.getByRole("textbox", { name: "Link", exact: true })).toHaveValue(contact)
  await expect(step.getByRole("textbox", { name: "Channel" })).toHaveValue(channel)
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("heading", { name: "Check your order" })).toBeFocused()
  await expect(step.getByRole("checkbox", { name: AGREE }), "the terms stay agreed to").toBeChecked()

  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  await expect(page.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  const invoiceId = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByRole("heading", { name: `Registering ${label}.simplex` })).toBeVisible({ timeout: REGISTRATION_MS })
  await expect(page.getByTestId("owner-code"), "the code was saved before paying").toHaveCount(0)
  await expect(page.getByRole("checkbox")).toHaveCount(0)

  await waitRegistered(page, label)
  const main = page.locator("body > main")
  await expect(main.locator(".lead")).toHaveText(`Registered until ${dateOf((await searchName(request, label)).expiresAt as number)}.`)
  // on chain: the price charged is the oracle's quote for the paid years, and the name expires the sent duration after the register's block
  const paidInvoice = await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as { amount: number; registration: { years: number; duration: number; registerTx: string } }
  expect(paidInvoice.amount).toBe(await oracleQuote(label, paidInvoice.registration.years))
  expect(await chainExpiry(label)).toBe(await blockTimeOf(paidInvoice.registration.registerTx) + paidInvoice.registration.duration)
  // how to use the name in the app, with its code, and no buttons to go elsewhere
  await expect(main.locator(".card.use").getByRole("heading", { name: "Use in the app" })).toBeVisible()
  await expect(await shownCode(page)).toHaveText(ownerCode)
  await expect(main.getByRole("button", { name: "Copy code" })).toBeVisible()
  await expect(main.getByRole("checkbox")).toHaveCount(0)
  await expect(main.getByRole("link", { name: "Your names" })).toHaveCount(0)
  await expect(main.getByRole("link", { name: "Edit links" })).toHaveCount(0)
  const answer = await searchName(request, label)
  expect(answer.owner, "the code saved before paying owns the name").toBe(checksumAddress(walletOf(ownerCode)!.address))
  expect(answer.records, "the links set before paying are on chain").toEqual({ contact, channel })

  // Your names, opened from the header, draws the name as registered from its first frame, never as a row still being
  // checked, and its line as it stays once the name's links are read
  await page.evaluate((name) => {
    const w = window as unknown as { __chips: string[]; __lines: Set<string> }
    w.__chips = []
    w.__lines = new Set()
    new MutationObserver(() => {
      for (const row of document.querySelectorAll(".list-row")) {
        if (!row.textContent!.includes(name)) continue
        const chip = row.querySelector(".chip")
        if (chip) w.__chips.push(chip.textContent!)
        w.__lines.add(row.querySelector(".sub")!.textContent!)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  }, `${label}.simplex`)
  const nameRead = page.waitForResponse((r) => /\/api\/name\/(0x)?[0-9a-f]{64}/.test(new URL(r.url()).pathname))
  await page.locator("body > header").getByRole("link", { name: "Your names" }).click()
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await expect(row.getByRole("button", { name: "Name code" })).toBeVisible()
  await nameRead
  await expect(row.getByRole("button", { name: "Edit links" })).toBeVisible()
  const { chips, lines } = await page.evaluate(() => {
    const w = window as unknown as { __chips: string[]; __lines: Set<string> }
    return { chips: w.__chips, lines: [...w.__lines] }
  })
  expect(chips, chips.join(" | ")).toEqual([])
  expect(lines, "the row's line as first drawn").toHaveLength(1)
  await row.getByRole("button", { name: "Edit links" }).click()
  await expect(page.getByRole("heading", { name: "Edit links" })).toBeVisible()
  await expect(onStep(page).locator(".lead")).toContainText(`${label}.simplex.`)
  expect(new URL(page.url()).hash).toBe(`#/edit/${await registrationOf(request, invoiceId)}`)
  const link = page.getByRole("textbox", { name: "Link", exact: true })
  await expect(link).toHaveValue(contact)

  // a link of the kind the other field holds is refused, and Save takes focus to it
  await link.fill("https://smp8.simplex.im/c#notacontact")
  await expect(page.getByText("This is a channel link. Paste a contact address here.")).toBeVisible()
  await shot(page, "N12f-link-wrong-kind")
  await page.getByRole("button", { name: "Save links" }).click()
  await expect(link).toBeFocused()
  // a link preview the service cannot answer now is checked again by itself
  let refused = 0
  await page.route("**/api/link/preview", async (route) => {
    if (refused++ === 0) return route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } })
    return route.continue()
  })
  await link.fill(contactLink("prev"))
  await expect(page.locator(".field-error [aria-hidden=true]", { hasText: /The link could not be checked now/ })).toBeVisible()
  await link.blur()
  await expect(page.locator(".link-field").first().locator(".entity")).toBeVisible({ timeout: 10_000 })
  await page.unrouteAll({ behavior: "wait" })
})

// where each part of the review stands, which nothing shown over it may change
const reviewLayout = (page: Page) => onStep(page).locator(".screen-body, .card.order, .trow, .pay-with, .notes, .check.terms, .actions-row .btn")
  .evaluateAll((nodes) => nodes.map((n) => [n.className, ...Object.values(n.getBoundingClientRect().toJSON())]))
const bonusOf = (page: Page) => onStep(page).getByRole("button", { name: /^and (\d+ days|1 day)$/ })
const termStartOf = (page: Page) => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).termStart as number, CHECKOUT_KEY)
const inWindow = async (page: Page, node: Locator) => {
  const box = (await node.boundingBox())!
  const { width, height } = page.viewportSize()!
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height
}
const termLines = (page: Page) => onStep(page).locator(".trow").first().locator("> span").last()
  .evaluate((value) => new Set([...value.getClientRects()].map((r) => Math.round(r.top))).size)

test("the term's free days are the early adopter bonus, explained on hover, focus and tap, with nothing moving", async ({ page, browser, baseURL }) => {
  await search(page, uniqueLabel("bonus"))
  await toReview(page, false)
  const hint = `Early adopter bonus: your 2 years start on ${dateOf(await termStartOf(page))}.`
  const bonus = bonusOf(page)
  const tip = onStep(page).getByRole("tooltip")
  await expect(bonus).toHaveAccessibleDescription(hint)
  await expect(tip).toBeHidden()
  const okColour = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("i"))
    probe.style.color = "var(--ok-fg)"
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  })
  expect(await bonus.evaluate((b) => getComputedStyle(b).color), "the free days in the success colour").toBe(okColour)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    expect(await termLines(page), `the term on one line at ${size.width} px`).toBe(1)
  }
  await page.setViewportSize(FIT_SIZES[0])
  const before = await reviewLayout(page)

  await bonus.hover()
  await expect(tip).toBeVisible()
  await expect(tip).toHaveText(hint)
  expect(await inWindow(page, tip), "the hint on hover in the window").toBe(true)
  expect(await reviewLayout(page), "the hint shown on hover moves nothing").toEqual(before)
  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  // the keyboard reaches the days from Back, as the first control after it
  await onStep(page).locator(".back").focus()
  await page.keyboard.press("Tab")
  await expect(bonus).toBeFocused()
  await expect(tip).toBeVisible()
  expect(await reviewLayout(page), "the hint shown on focus moves nothing").toEqual(before)
  await page.keyboard.press("Escape")
  await expect(tip, "Escape hides the hint").toBeHidden()
  await expect(bonus).toBeFocused()

  // the same checkout on a touch screen, opened at its review, as WebKit here crashes on the links step's camera check
  const checkout = await page.evaluate((key) => sessionStorage.getItem(key)!, CHECKOUT_KEY)
  const context = await browser.newContext({ baseURL, viewport: FIT_SIZES[1], hasTouch: true, reducedMotion: "reduce" })
  await context.addInitScript(([key, value]) => sessionStorage.setItem(key, value), [CHECKOUT_KEY, checkout])
  const phone = await context.newPage()
  await phone.goto("/#/checkout")
  await expect(onStep(phone).getByRole("heading", { name: "Check your order" })).toBeVisible()
  const phoneBefore = await reviewLayout(phone)
  await bonusOf(phone).tap()
  await expect(onStep(phone).getByRole("tooltip")).toBeVisible()
  expect(await inWindow(phone, onStep(phone).getByRole("tooltip")), "the hint on tap in the window").toBe(true)
  expect(await reviewLayout(phone), "the hint shown on tap moves nothing").toEqual(phoneBefore)
  await context.close()
})

test("a term that has started has no free days, so no bonus or hint, which come back with the days", async ({ page }) => {
  await search(page, uniqueLabel("nobonus"))
  await toReview(page, false)
  const termStart = await termStartOf(page)
  const startAt = (at: number) => page.evaluate(([key, start]) => sessionStorage.setItem(key as string, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key as string)!), termStart: start })), [CHECKOUT_KEY, at])
  await startAt(Math.floor(Date.now() / 1000) - 86400)
  await page.reload()
  await expect(onStep(page).locator(".trow").first()).toHaveText("Term2 years")
  await expect(bonusOf(page)).toHaveCount(0)
  await expect(onStep(page).locator("[role=tooltip]")).toHaveCount(0)
  await startAt(termStart)
  await page.reload()
  await expect(bonusOf(page)).toHaveAccessibleDescription(/^Early adopter bonus/)
})

test("a link's late preview never fills the field once it holds another link, whose own preview it waits for", async ({ page, request }) => {
  const first = contactLink("UnrA")
  const second = contactLink("UnrB")
  await search(page, uniqueLabel("stale"))
  await page.getByRole("button", { name: "Register" }).click()
  const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
  await link.fill(first)
  await previewsShown(page)
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  // the Links step drawn anew asks for the kept link's preview, held until the field asks for another link's, which the service takes long to fetch
  await page.reload()
  await control(request, "search", { fetchDelays: { [second]: SLOW_FETCH_MS } })
  let askedSecond: () => void = () => undefined
  const secondAsked = new Promise<void>((resolve) => { askedSecond = resolve })
  await page.route("**/api/link/preview", async (route) => {
    const asked = route.request().postDataJSON().link as string
    if (asked === second) askedSecond()
    if (asked === first) await secondAsked
    await route.continue()
  })
  const firstAnswered = page.waitForResponse((r) => r.url().endsWith("/api/link/preview") && r.request().postDataJSON().link === first)
  await page.goBack()
  await expect(link).toHaveValue(first)
  // a field checking a link shows its place held, never another link's profile
  await page.evaluate(() => {
    const w = window as unknown as { __stale: boolean }
    w.__stale = false
    const look = () => { if (document.querySelector(".link-field[data-state=checking] .entity:not(.skeleton)")) w.__stale = true }
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] })
  })
  await link.fill(second)
  await firstAnswered
  await previewsShown(page)
  expect(await page.evaluate(() => (window as unknown as { __stale: boolean }).__stale), "the first link's profile drawn while the second was checked").toBe(false)
  await page.unrouteAll({ behavior: "wait" })
  await control(request, "search", { fetchDelays: {} })
})

test("a link's profile comes in the very box its place held while it was read, at a laptop's and a phone's width", async ({ page, request }) => {
  const box = async (locator: Locator) => {
    await expect(locator).toBeVisible()
    const b = (await locator.boundingBox())!
    return [b.x, b.y, b.width, b.height].map(Math.round)
  }
  for (const [i, size] of FIT_SIZES.entries()) {
    // a link no earlier run has had read, as the service keeps a read profile for minutes
    const link = contactLink(`Vf${i}${Date.now().toString(36)}`)
    await page.setViewportSize(size)
    await search(page, uniqueLabel("place"))
    await page.getByRole("button", { name: "Register" }).click()
    await control(request, "search", { fetchDelays: { [link]: SLOW_FETCH_MS } })
    try {
      const field = onStep(page).getByRole("textbox", { name: "Link", exact: true })
      await field.fill(link)
      await field.blur()
      const held = await box(onStep(page).locator(".link-field .entity.skeleton"))
      expect(await box(onStep(page).locator(".link-field .entity:not(.skeleton)")), `${size.width}x${size.height}`).toEqual(held)
    } finally {
      await control(request, "search", { fetchDelays: {} })
    }
  }
})

test("Continue pressed while a link is checked is busy where it stands, says so, and goes on once the check ends", async ({ page, request }) => {
  const slow = contactLink("UnrE")
  await control(request, "search", { fetchDelays: { [slow]: SLOW_FETCH_MS } })
  await search(page, uniqueLabel("busy"))
  await page.getByRole("button", { name: "Register" }).click()
  // a link taken first keeps Continue on while the link typed over it is checked
  const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
  await link.fill(contactLink("E5"))
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  await link.fill(slow)
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "checking")
  const next = onStep(page).locator(".btn[data-focus=continue]")
  const before = await next.boundingBox()
  await next.click()
  await expect(next).toHaveAttribute("aria-busy", "true")
  await expect(next).toHaveAccessibleName("Checking link…")
  expect(await next.boundingBox(), "the busy button keeps its place and size").toEqual(before)
  await expect(page.locator("body > .sr-only[role=status]")).toHaveText("Checking link…")
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  expect(JSON.parse(await page.evaluate((key) => sessionStorage.getItem(key)!, CHECKOUT_KEY)).contact, "the link checked last goes on").toBe(slow)
  await control(request, "search", { fetchDelays: {} })
})

test("Skip for now shows only while no link is given, and a link edited keeps its last good value until emptied", async ({ page }) => {
  await search(page, uniqueLabel("skip"))
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  const skip = step.getByRole("button", { name: "Skip for now" })
  const link = step.getByRole("textbox", { name: "Link", exact: true })
  const stored = () => page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!) as { contact: string; channel: string }, CHECKOUT_KEY)
  const contact = contactLink("S1")
  const border = () => step.locator(".link-field .field").first().evaluate((box) => getComputedStyle(box).borderTopColor)
  // the pointer left where Register was lies over the field, which takes the hover border whenever the browser next updates hover
  await page.mouse.move(0, 0)
  await link.blur()
  const neutral = await border()
  await link.fill(contact)
  await expect(step.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  await link.blur()
  expect(await border(), "an accepted link's field keeps its plain border, as its chat shows it is accepted").toBe(neutral)
  await expect(skip, "Skip would drop the given link").toHaveCount(0)
  expect((await stored()).contact).toBe(contact)
  await link.fill(`${contact}!`)
  await expect(step.locator(".link-field").first()).toHaveAttribute("data-state", "bad")
  expect((await stored()).contact, "a link being edited keeps the last good one").toBe(contact)
  // the same field takes the other kind, which takes the place of the first
  const channel = channelLink("S2")
  await link.fill(channel)
  await expect(step.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  await expect.poll(stored, "a channel in the Link field").toEqual(expect.objectContaining({ contact: "", channel }))
  await expect(step.getByRole("button", { name: "Add a contact address" })).toBeVisible()
  // the field's remove button empties it, and its link
  await step.locator(".link-field").first().getByRole("button", { name: "Remove link" }).click()
  await expect(link).toBeFocused()
  await expect.poll(stored, "a field emptied empties its link").toEqual(expect.objectContaining({ contact: "", channel: "" }))
  await expect(skip).toBeVisible()
  await skip.click()
  await expect(step.getByRole("heading", { name: CODE_HEADING })).toBeFocused()
  await savedToReview(page)
  await expect(step.locator(".card.order .chat")).toHaveCount(0)
})

test("Edit links keeps several links on chain as the contact address they hold, and emptying the field removes them", async ({ page }) => {
  const { registrationId } = await fakeRegisteredName(page, uniqueLabel("several"), { contact: `${contactLink("M1")};${contactLink("M2")}`, channel: "" })
  const sent: { edits: { key: string; value: string }[] }[] = []
  await page.route("**/api/name/records", (route) => {
    sent.push(route.request().postDataJSON())
    return route.fulfill({ json: { tx: "0x04" } })
  })
  await page.goto(`/#/edit/${registrationId}`)
  const step = onStep(page)
  await expect(step.getByText("Several links. SimpleX opens the first one.")).toBeVisible()
  await expect(step.getByRole("button", { name: "Add a channel link" }), "the field holds a contact address").toBeVisible()
  await step.locator(".link-field").first().getByRole("button", { name: "Remove link" }).click()
  await step.getByRole("button", { name: "Save links" }).click()
  await expect(step.getByText("Links saved")).toBeVisible()
  expect(sent.map(({ edits }) => edits.map(({ key, value }) => ({ key, value }))), "the edits sent").toEqual([[{ key: CONTACT_KEY, value: "" }]])
})

test("Check your order draws a link whose profile cannot be read as its kind's default picture, named by the link", async ({ page }) => {
  await toFullReview(page, uniqueLabel("unread"))
  await page.route("**/api/link/preview", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }))
  await page.reload()
  const chats = onStep(page).locator(".card.order .chat")
  await expect(chats).toHaveCount(2)
  await expect(chats.nth(0)).toHaveAccessibleName(`${contactLink("R1")}, contact address`)
  await expect(chats.nth(1)).toHaveAccessibleName(`${channelLink("R2")}, channel`)
  await chats.nth(1).click()
  await expect(page.getByRole("dialog")).toContainText(channelLink("R2"))
})

test("a link whose host the service does not fetch is taken with the kind's default picture and no name", async ({ page }) => {
  await search(page, uniqueLabel("unfetched"))
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("Off"))
  await previewsShown(page)
  const entity = onStep(page).locator(".link-field .entity")
  await expect(entity).toHaveText("Contact address")
  await expect(entity.locator("img")).toHaveCount(0)
  await expect(entity.locator("svg")).toHaveCount(1)
  await expect(onStep(page).getByRole("button", { name: "Continue" })).toBeEnabled()
})

test("Check your order asked for before the name code is saved opens the name code step instead", async ({ page }) => {
  await search(page, uniqueLabel("gate"))
  await toCodeStep(page)
  expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).saved, CHECKOUT_KEY)).toBe(false)
  await page.goto("/#/checkout")
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/checkout/code")
})

test("Continue on the links step waits for a link being checked, and takes focus to one refused", async ({ page }) => {
  await search(page, uniqueLabel("linkbad"))
  await page.getByRole("button", { name: "Register" }).click()
  const step = onStep(page)
  await step.getByRole("textbox", { name: "Link", exact: true }).fill(`${contactLink("W0")}?x=${"a".repeat(LINK_MAX_BYTES)}`)
  await expect(step.getByText("This link is too long.")).toBeVisible()
  await step.getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("W0"))
  await expect(step.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  await step.getByRole("button", { name: "Add a channel link" }).click()
  await step.getByRole("textbox", { name: "Channel" }).fill(contactLink("W1"))
  await expect(step.getByText("This is a contact address. Paste a channel link here.")).toBeVisible()
  await step.getByRole("button", { name: "Continue" }).click()
  await expect(step.getByRole("textbox", { name: "Channel" })).toBeFocused()
  await expect(step.getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
})

test("a Monero invoice's wallet link is monero:// for Monero GUI on a laptop and monero: on a phone, and its QR keeps monero:", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("xmrlink"), { method: "xmr" })
  await expect(page.getByRole("heading", { name: "Pay with Monero" })).toBeVisible()
  const { address, cryptoAmount } = await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as { address: string; cryptoAmount: string }
  const wallet = onStep(page).getByRole("link", { name: "Open in wallet" })
  await expect(wallet).toHaveAttribute("href", `monero://${address}?tx_amount=${cryptoAmount}`)
  await expect(wallet.locator("xpath=..")).toHaveClass(/\bqr\b/)
  expect(await qrText(onStep(page).locator(".card.pay .qr svg")), "the QR").toBe(`monero:${address}?tx_amount=${cryptoAmount}`)
  await page.setViewportSize(FIT_SIZES[1])
  await expect(wallet).toHaveClass(/\bwallet\b/)
  await expect(wallet).toHaveAttribute("href", `monero:${address}?tx_amount=${cryptoAmount}`)
})

test("the owner code restores an order in another browser, and a bad code is refused", async ({ page, browser, request }) => {
  const label = uniqueLabel("rest")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "xmr" })
  await expect(page.getByRole("heading", { name: "Pay with Monero" })).toBeVisible()
  const { address, cryptoAmount } = await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as { address: string; cryptoAmount: string }
  await expect(onStep(page).getByRole("link", { name: "Open in wallet" }), "the Monero URI").toHaveAttribute("href", `monero://${address}?tx_amount=${cryptoAmount}`)
  await control(request, `confirming/${invoiceId}`)
  await expect(page.getByText("Waiting for 1 confirmation")).toBeVisible()
  await shot(page, "N5-confirming")
  // the buying browser goes away before the payment settles, so nothing reveals the name
  await page.close()
  await control(request, `settle/${invoiceId}`)

  const other = await browser.newContext()
  const page2 = await other.newPage()
  await page2.goto(`/?order=${invoiceId}`)
  await expect(page2.getByRole("heading", { name: "The name code is not in this browser" })).toBeVisible({ timeout: 60_000 })
  await shot(page2, "N7b-not-here")
  await page2.getByRole("button", { name: "Enter your name code" }).click()

  await codeField(page2).fill("SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")
  await expect(page2.getByText("This code is not valid")).toBeVisible()
  await expect(onStep(page2).getByRole("button", { name: "Find a name" })).toBeDisabled()
  await shot(page2, "N7c-restore-invalid")

  await codeField(page2).fill(ownerCode.toLowerCase().replaceAll("-", " "))
  // reached from the order's page, the code found goes back to its order
  await onStep(page2).getByRole("button", { name: "Add to Your names" }).click()
  await page2.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await waitRegistered(page2, label)
  await expect(await shownCode(page2), "the restored browser holds the code").toHaveText(ownerCode)
  await other.close()
})

test("a card order waits for Stripe, blocks a second card order meanwhile, then registers", async ({ page, request }) => {
  test.skip(!!process.env.BASE_URL, STAND_IN_ONLY)
  const label = uniqueLabel("card")
  const { invoiceId } = await startOrder(page, label, { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await shot(page, "N10-card")
  // a whole amount has no cents, as the search and the order showed it
  await expect(onStep(page).locator(".screen-head .lead")).toContainText(/\u00b7 \$\d+ \/ 2 years$/)
  await expect(onStep(page).getByRole("button", { name: /^Pay \$\d+$/ })).toBeVisible()
  await expect(onStep(page).getByText("The card form is Stripe's. Nothing is charged until you pay.")).toBeVisible()
  // the development stand-in says what it is, and the invoice can be cancelled from the form as from a crypto invoice
  await expect(onStep(page).locator(".stripe > .label")).toHaveText("Test card form: no Stripe key is set, so Pay simulates a payment.")
  await expect(onStep(page).getByRole("button", { name: "Cancel this invoice" })).toBeVisible()
  await onStep(page).getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await expect(onStep(page).getByRole("button", { name: "Cancel this invoice" })).toBeVisible()
  await shot(page, "N10b-card-confirming")

  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(uniqueLabel("second"))
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await toReview(page)
  await expect(page.getByText("You have an order waiting to be confirmed")).toBeVisible()
  await expect(payButton(page)).toBeDisabled()
  await shot(page, "N3e-open-card-order")
  await page.getByRole("button", { name: "Open the waiting order" }).click()

  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
})

test("a card payment Stripe has not confirmed, with nothing paid, can still be cancelled", async ({ page }) => {
  test.skip(!!process.env.BASE_URL, STAND_IN_ONLY)
  await startOrder(page, uniqueLabel("cardcx"), { method: "card" })
  await onStep(page).getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await onStep(page).getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(page.getByText("This invoice was cancelled and nothing was received.")).toBeVisible()
})

// The Stripe frame reloads whenever its form is taken out of the page, so the card screen takes another tab's writes in place.
test("the card form stays in place while another tab writes the order, the same record and a changed one", async ({ page }) => {
  test.skip(!!process.env.BASE_URL, STAND_IN_ONLY)
  const { invoiceId } = await startOrder(page, uniqueLabel("cardstay"), { method: "card" })
  await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
  await page.evaluate(() => {
    const form = document.querySelector(".stripe")!
    const w = window as unknown as { __moved: number; __parent: Element }
    w.__moved = 0
    w.__parent = form.parentElement!
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) if (n === form || n.contains(form)) w.__moved++
    }).observe(document.body, { childList: true, subtree: true })
  })
  const key = await page.evaluate((id) => Object.keys(localStorage).find((k) => k.startsWith("simplex-names:order:") && localStorage.getItem(k)!.includes(id))!, invoiceId)
  const other = await page.context().newPage()
  await other.goto("/")
  const writes: ((k: string) => void)[] = [
    (k) => localStorage.setItem(k, `${localStorage.getItem(k)!} `),
    (k) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)!), contact: "https://smp8.simplex.im/a#S1" })),
  ]
  for (const write of writes) {
    const read = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/invoice/${invoiceId}` && !r.url().includes("?"))
    await other.evaluate(write, key)
    await read
    await expect(page.locator("main[aria-busy]")).toHaveCount(0)
  }
  expect(await page.evaluate(() => {
    const w = window as unknown as { __moved: number; __parent: Element }
    return { moved: w.__moved, sameParent: document.querySelector(".stripe")?.parentElement === w.__parent }
  })).toEqual({ moved: 0, sameParent: true })
  await expect(onStep(page).getByRole("button", { name: /^Pay \$/ })).toBeEnabled()
  await other.close()
})

test("a cancelled invoice leads back to its name to order again, and expired invoices are replaced and say what arrived", async ({ page, request }) => {
  const label = uniqueLabel("exp")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  const cancels: string[] = []
  page.on("request", (r) => { if (r.url().endsWith("/cancel")) cancels.push(r.url()) })
  await page.getByText("Cancel this invoice").dblclick()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(page.getByText("This invoice was cancelled and nothing was received.")).toBeVisible()
  expect(cancels).toHaveLength(1)
  await shot(page, "N4b-cancelled")

  // ordering again opens Check your order with the same name code, saved already; nothing is ordered until Pay
  const ownerCode = await orderOwnerCode(page, invoiceId)
  await page.getByRole("button", { name: "Order the name again" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  expect(await checkoutOwnerCode(page), "the same name code").toBe(ownerCode)
  expect(cancels).toHaveLength(1)
  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText("Invoice cancelled")
  await expect(page.locator(".list-row", { hasText: "Checkout not finished" }), "no second entry for the same code").toHaveCount(0)
  await page.goBack()
  await page.getByRole("radio", { name: "Bitcoin" }).click()
  // an order made again is agreed to again
  await expect(payButton(page)).toBeDisabled()
  await agreeToTerms(page)
  await payButton(page).click()
  await page.waitForURL((url) => (url.searchParams.get("order") ?? invoiceId) !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  expect(await checkoutOwnerCode(page).catch(() => null), "the checkout ended").toBeNull()
  expect(await orderOwnerCode(page, second), "the new order's name code").toBe(ownerCode)
  await control(request, `expire/${second}`)
  await expect(page.getByText("Nothing was received before it closed.")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await shot(page, "N4c-expired")

  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== second)
  const third = new URL(page.url()).searchParams.get("order")!
  await control(request, `partial/${third}`)
  await control(request, `expire/${third}`)
  await expect(page.getByText(/BTC arrived, which is not the full amount/)).toBeVisible()
  await shot(page, "N4d-expired-partial")

  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` }).first().locator(".chip")).toHaveText(/Invoice (expired|cancelled)/)
})

test("a name searched again after its invoice was cancelled keeps that order's name code, saved already", async ({ page }) => {
  const label = uniqueLabel("keep")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  await page.getByRole("button", { name: "Cancel this invoice" }).click()
  await expect(page.getByText("This invoice was cancelled and nothing was received.")).toBeVisible()

  await search(page, label)
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  expect(await checkoutOwnerCode(page), "the cancelled order's name code").toBe(ownerCode)
  // saved already, so the links step goes on to Check your order, past the code step
  await onStep(page).getByRole("button", { name: "Skip for now" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  await page.goto("/#/checkout/code")
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await expect(onStep(page).getByRole("checkbox", { name: SAVED })).toBeChecked()
  await expect(await shownCode(page)).toHaveText(ownerCode)

  // the cancelled order is not live, so the same code orders the name again
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await agreeToTerms(page)
  await payButton(page).click()
  await page.waitForURL((url) => (url.searchParams.get("order") ?? invoiceId) !== invoiceId)
  expect(await orderOwnerCode(page, new URL(page.url()).searchParams.get("order")!), "the new order's name code").toBe(ownerCode)
  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: "Checkout not finished" }), "no new code is left pending").toHaveCount(0)
})

test("a replaced invoice leads to its new order until a late payment reaches it", async ({ page, browser, request }) => {
  const label = uniqueLabel("late")
  const row = (p: typeof page) => p.locator(".list-row:visible", { hasText: `${label}.simplex` })
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "xmr" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await page.goto(`/?order=${invoiceId}`)
  await page.waitForURL((url) => url.searchParams.get("order") === second)
  await page.goto("/#/names")
  await expect(row(page).locator(".chip")).toHaveText(["Waiting for payment"])

  // a browser restored with the code knows only the new order
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restoreOrder(restored, ownerCode, label)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)

  // the service has forgotten the old invoice; this browser still knows what replaced it
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.goto(`/?order=${invoiceId}`)
  await page.waitForURL((url) => url.searchParams.get("order") === second)
  await page.unroute(`**/api/invoice/${invoiceId}*`)

  await control(request, `settle/${invoiceId}`)
  for (const p of [page, restored]) {
    await p.goto(`/?order=${invoiceId}`)
    await expect(p.getByText("The payment arrived after this invoice had closed")).toBeVisible()
    await expect(onStep(p).getByText(/Once confirmed|not the full amount/), "all of it arrived and is credited").toHaveCount(0)
    await expect(p.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
    expect(new URL(p.url()).searchParams.get("order")).toBe(invoiceId)
    await p.goto("/#/names")
    await expect(row(p).locator(".chip")).toHaveText(["Waiting for payment", "Paid late"])
    await expect(row(p).nth(1)).toContainText(`reference ${invoiceId}`)
    await p.goto(`/?order=${invoiceId}`)
    await p.getByRole("button", { name: "Open the new invoice" }).click()
    await p.waitForURL((url) => url.searchParams.get("order") === second)
  }
  await other.close()
})

test("an invoice that received part of its payment and was replaced leads on to the new one once the rest arrives", async ({ page, request }) => {
  const label = uniqueLabel("part")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `partial/${invoiceId}`)
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${invoiceId}`)
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByText("The payment arrived after this invoice had closed")).toBeVisible()
  await expect(onStep(page).getByText(/Once confirmed|not the full amount/), "the rest arrived and all of it is credited").toHaveCount(0)
  await page.goto("/#/names")
  await expect(page.locator(".list-row:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Waiting for payment", "Paid late"])
  await page.goto(`/?order=${invoiceId}`)
  await page.getByRole("button", { name: "Open the new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") === second)
})

test("an invoice that closed while its payment was confirming says a payment reached it, on its page and in Your names", async ({ page, request }) => {
  const label = uniqueLabel("late")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `confirming/${invoiceId}`)
  await control(request, `expire/${invoiceId}`)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(page.getByText("A payment did not complete before the invoice closed.")).toBeVisible()
  await shot(page, "N4e-expired-confirming")
  await page.goto("/#/names")
  const row = page.locator(".list-row:visible", { hasText: `${label}.simplex` })
  await expect(row).toContainText("A payment did not complete before the invoice closed")
  await expect(row.locator(".chip")).toHaveText(["Invoice expired"])
  await shot(page, "N12f-history-expired-paid")
})

test("an overpaid invoice registers its name, even where the service reads its due below zero", async ({ page, request }) => {
  const label = uniqueLabel("over")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  // BTCPay's due for an overpaid invoice, as a service that passes it on answers it
  await page.route(`**/api/invoice/${invoiceId}*`, async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    await route.fulfill({ response, json: json.paidInFull ? { ...json, cryptoAmountDue: "-0.00078" } : json })
  })
  await control(request, `settle/${invoiceId}`, { paid: "0.00234" })
  await waitRegistered(page, label)
  await page.unrouteAll({ behavior: "ignoreErrors" })
})

const KEPT_LATE = "kept as your balance for this name or another, or refunded on request; Your names shows it."

test("a part payment on a closed invoice, once credited, says so and gets an invoice for the rest of the same name in the main button's place", async ({ page, request }) => {
  const label = uniqueLabel("rest")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `partial/${invoiceId}`)
  await control(request, `expire/${invoiceId}`)
  const actions = onStep(page).locator(".actions-row")
  await expect(page.getByText(`0.00078 BTC arrived, which is not the full amount. Once confirmed, it is ${KEPT_LATE}`)).toBeVisible()
  const place = await actions.locator(".btn").boundingBox()
  await control(request, `settle/${invoiceId}`, { paid: "0.00078" })
  await expect(page.getByText(`0.00078 BTC arrived, which is not the full amount. It is ${KEPT_LATE}`)).toBeVisible()
  await expect(actions.locator(".btn"), "one main action").toHaveText(["Get a new invoice"])
  expect(await actions.locator(".btn").boundingBox(), "the main button stays where it was").toEqual(place)
  await expect(actions.locator(".alt a")).toHaveText(["Choose another name", "Get a refund"])
  await shot(page, "N4g-part-credited")
  await actions.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  const invoice = async (id: string) => (await request.get(`${MOCK}/api/invoice/${id}`)).json()
  const [closed, rest] = [await invoice(invoiceId), await invoice(second)]
  expect([rest.amount, rest.registration.price, rest.registration.fromBalance, rest.registration.labelHash], "the difference, for the same name")
    .toEqual([5000, 10000, 5000, closed.registration.labelHash])
  await control(request, `settle/${second}`)
  await waitRegistered(page, label)
})

test("a whole payment after the close, once credited, says so and registers the same name with the balance", async ({ page, request }) => {
  const label = uniqueLabel("whole")
  const { invoiceId } = await startOrder(page, label, { method: "xmr" })
  await control(request, `expire/${invoiceId}`)
  await control(request, `settle/${invoiceId}`)
  await expect(page.getByText(`The payment arrived after this invoice had closed, so nothing was registered. It is ${KEPT_LATE}`)).toBeVisible()
  await expect(onStep(page).getByText(/Once confirmed|not the full amount/)).toHaveCount(0)
  await expect(onStep(page).locator(".actions-row .alt a")).toHaveText(["Choose another name", "Get a refund"])
  await onStep(page).getByRole("button", { name: "Register with your balance" }).click()
  await page.waitForURL(/\?registration=/)
  await waitRegistered(page, label)
})

const INVOICE_EXPIRED = "The invoice expired before the full amount arrived. Don't send more; what you sent is kept as your balance."
// the controls that ask for more of the payment, which go once the rate expires; the address and the reference stay
const payMore = (page: Page) => [
  onStep(page).getByRole("img", { name: "Bitcoin payment" }),
  onStep(page).getByRole("button", { name: "Copy rest to send in BTC" }),
  onStep(page).getByRole("link", { name: "Open in wallet" }),
]

test("an invoice past its rate window that part of the payment reached stays open, asks for no more, and registers once paid", async ({ page, request }) => {
  const label = uniqueLabel("due")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `partial/${invoiceId}`)
  await control(request, `overdue/${invoiceId}`)
  await page.reload()
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await expect(page.getByText(/^Part of the payment arrived: [\d.]+ of [\d.]+ BTC is seen\.$/)).toBeVisible()
  await expect(page.getByText(INVOICE_EXPIRED)).toBeVisible()
  await expect(page.getByText(/Invoice valid for|Send the remaining/), "no countdown and no ask for the rest").toHaveCount(0)
  for (const control of payMore(page)) await expect(control).toHaveCount(0)
  await expect(onStep(page).getByText(/rest to send|Open in wallet/i), "nothing that asks for more is drawn, hidden or not").toHaveCount(0)
  await expect(onStep(page).getByRole("button", { name: "Copy Bitcoin address" })).toBeVisible()
  await expect(onStep(page).getByText(`Reference ${invoiceId}`)).toBeVisible()
  await shot(page, "N4f-partial-rate-expired")
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
})

// the rate window of the invoice ends this long after the page first reads it
const RATE_LEFT_MS = 6000
// each part of the pay screen and of its notice and rate line: where it is and how tall, on a laptop and on a phone
async function payLayout(page: Page): Promise<Record<string, string[]>> {
  const layout: Record<string, string[]> = {}
  for (const [device, width] of [["desktop", 1280], ["phone", 390]] as const) {
    await page.setViewportSize({ width, height: 900 })
    layout[device] = await page.evaluate(() => [...document.querySelectorAll("body > main :is(.screen-body, .notice > div, .card.pay, .qr-grid, .copy-fields, .pay-status) > *")]
      .map((n) => { const b = n.getBoundingClientRect(); return `${n.tagName} ${Math.round(b.top)} ${Math.round(b.height)}` }))
  }
  return layout
}

test("a part-paid invoice whose rate window ends in view swaps the countdown for the expired line and hides what asks for more, in the same room", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("due"), { method: "btc" })
  await control(request, `partial/${invoiceId}`)
  let expiresAt: string | null = null
  await page.route(`**/api/invoice/${invoiceId}*`, async (route) => {
    const response = await route.fetch()
    expiresAt ??= new Date(Date.now() + RATE_LEFT_MS).toISOString()
    await route.fulfill({ response, json: { ...await response.json(), expiresAt } })
  })
  // each time the rate line's countdown shows, as it changes
  await page.addInitScript(() => {
    const w = window as unknown as { __times: string[] }
    w.__times = []
    new MutationObserver((changes) => {
      for (const { target } of changes) if (target instanceof Element && target.closest(".pay-status") && /^\d+:\d\d$/.test(target.textContent ?? "")) w.__times.push(target.textContent!)
    }).observe(document, { childList: true, subtree: true })
  })
  await page.reload()
  const held = page.getByText(/Invoice valid for \d+:\d\d/)
  const rest = page.getByText(/^Send the remaining/)
  await expect(held).toBeVisible()
  await expect(rest).toBeVisible()
  for (const control of payMore(page)) await expect(control).toBeVisible()
  const before = await payLayout(page)
  await expect(held, "the layout was read while the rate was held").toBeVisible()
  await expect(page.getByText(INVOICE_EXPIRED)).toBeVisible()
  await expect(held).toBeHidden()
  await expect(rest).toBeHidden()
  const times = await page.evaluate(() => (window as unknown as { __times: string[] }).__times)
  expect(times, "the countdown reads 0:01 to the end, and never 0:00 while the rate is held").toContain("0:01")
  expect(times).not.toContain("0:00")
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    for (const control of payMore(page)) await expect(control, `${width}px`).toBeHidden()
    await expect(onStep(page).getByRole("button", { name: "Copy Bitcoin address" }), `${width}px`).toBeVisible()
  }
  expect(await payLayout(page)).toEqual(before)
  // the page's read held open meanwhile answers nothing this test needs
  await page.unrouteAll({ behavior: "ignoreErrors" })
})

test("a browser restored before another browser made a new invoice carries on with that invoice", async ({ page, browser, request }) => {
  const label = uniqueLabel("sib")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restoreOrder(restored, ownerCode, label)
  await restored.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await page.close()

  await restored.goto(`/?order=${second}`)
  await expect(restored.getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  // the adopted order carries the service's time of making it, which later searches for a newer order compare against
  const made = (await mockRegistration(request, second)).createdAt
  const adopted = await restored.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith("simplex-names:order:"))
    .map((k) => JSON.parse(localStorage.getItem(k)!)).find((o: { invoiceId: string }) => o.invoiceId === id), second)
  expect(adopted.createdAt).toBe(made)
  await restored.goto("/#/names")
  await expect(restored.locator(".list-row:visible", { hasText: `${label}.simplex` }).locator(".chip")).toHaveText(["Waiting for payment"])
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await control(request, `settle/${second}`)
  await waitRegistered(restored, label)
  await other.close()
})

// a balanced wrap leaves the lines of a long address within a character or two of each other
const EVEN_LINES = 0.9
test("a long address wraps into even lines on the pay page, on a phone too", async ({ page }) => {
  await startOrder(page, uniqueLabel("xmrwrap"), { method: "xmr" })
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const lines = await page.locator(".copy-field", { hasText: "Monero address" }).locator(".val > span").evaluate((n) => {
      const range = document.createRange()
      range.selectNodeContents(n)
      const rows = new Map<number, number>()
      // the break opportunities between the letters are boxes of no width
      for (const r of [...range.getClientRects()].filter((r) => r.width >= 1)) rows.set(Math.round(r.top), (rows.get(Math.round(r.top)) ?? 0) + r.width)
      return [...rows.values()]
    })
    expect(lines.length, `${width}px: the address breaks`).toBeGreaterThan(1)
    expect(Math.min(...lines) / Math.max(...lines), `${width}px: line widths ${lines.map(Math.round)}`).toBeGreaterThanOrEqual(EVEN_LINES)
  }
})

test("Cancel this invoice reads as working while its request runs, and as itself again once the request fails", async ({ page }) => {
  await startOrder(page, uniqueLabel("cxl"), { method: "btc" })
  let answer!: () => void
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await page.route("**/cancel", async (route) => {
    await answered
    await route.fulfill({ status: 503, json: { error: "provider_unavailable" } })
  })
  const link = onStep(page).locator("a[data-focus=cancel]")
  await link.click()
  await expect(link).toHaveAccessibleName("Cancelling…")
  await expect(link).toHaveAttribute("aria-disabled", "true")
  await expect(link).toBeFocused()
  answer()
  await expect(link).toHaveAccessibleName("Cancel this invoice")
  await expect(link).not.toHaveAttribute("aria-disabled")
  await expect(page.getByText("The invoice could not be cancelled now. Try again in a moment.")).toBeVisible()
})

test("a cancel refused for a rate limit keeps the invoice payable and says so until the wait is over", async ({ page }) => {
  await startOrder(page, uniqueLabel("cxh"), { method: "btc" })
  await page.route("**/api/invoice/*/cancel", (route) => route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "rate_limited" } }))
  const cancel = onStep(page).getByText("Cancel this invoice")
  await cancel.click()
  await expect(page.locator("[aria-hidden=true]", { hasText: /^The invoice is still open\. Try again in/ })).toBeVisible()
  await expect(onStep(page).getByRole("heading", { name: "Pay with Bitcoin" })).toBeVisible()
  await page.unroute("**/api/invoice/*/cancel")
  await expect(page.getByText("Too many attempts")).toHaveCount(0, { timeout: 10_000 })
  await cancel.click()
  await expect(page.getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await expect(page.getByText("This invoice was cancelled and nothing was received.")).toBeVisible()
})

test("a restored browser that never opened another browser's newer invoice finds it through the code", async ({ page, browser, request }) => {
  const label = uniqueLabel("newer")
  const { invoiceId, ownerCode } = await startOrder(page, label, { method: "btc" })
  const other = await browser.newContext()
  const restored = await other.newPage()
  await restoreOrder(restored, ownerCode, label)
  await restored.waitForURL((url) => url.searchParams.get("order") === invoiceId)
  await restored.goto("/#/")
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  await control(request, `settle/${second}`)
  await waitRegistered(page, label)

  // the service has forgotten the old invoice by now; the code still finds the order that replaced it
  await restored.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await restored.goto(`/?order=${invoiceId}`)
  await restored.waitForURL((url) => url.searchParams.get("order") === second)
  await restored.unroute(`**/api/invoice/${invoiceId}*`)
  await restored.goto("/#/names")
  const row = restored.locator(".list-row:visible", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip"), "a registered name says so by its date").toHaveCount(0)
  await expect(row.locator(".sub")).toContainText("Until ")
  await other.close()
})

test("a forgotten empty invoice never leads back to the older invoice it replaced", async ({ page, request }) => {
  const label = uniqueLabel("loopb")
  const { invoiceId } = await startOrder(page, label, { method: "btc" })
  await control(request, `expire/${invoiceId}`)
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  const second = new URL(page.url()).searchParams.get("order")!
  const secondRegistration = await registrationOf(request, second)
  await control(request, `expire/${second}`)
  await control(request, `settle/${invoiceId}`)
  // the service forgets the empty invoice and keeps the late-paid one
  await page.route(`**/api/invoice/${second}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.route("**/api/registration/find", async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { registrations: body.registrations.filter((r: { registrationId: string }) => r.registrationId !== secondRegistration) } })
  })
  await page.goto(`/?order=${second}`)
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("order")).toBe(second)
})

test("a forgotten order whose code's lookup is refused says the link does not work", async ({ page }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("refuse"), { method: "btc" })
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await page.route("**/api/registration/find", (route) => route.fulfill({ status: 400, json: { error: "bad_request" } }))
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
})

test("a forgotten order whose code's lookup is rate limited waits as asked, then answers", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("limit"), { method: "btc" })
  await page.route(`**/api/invoice/${invoiceId}*`, (route) => route.fulfill({ status: 404, json: { error: "not_found" } }))
  await control(request, "search", { findLimitSeconds: 2 })
  await page.goto(`/?order=${invoiceId}`)
  await expect(page.getByRole("heading", { name: "This order could not be loaded" })).toBeVisible()
  // with nothing newer than this order, the lookup ends at the dead link once the limit is over
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible({ timeout: 10_000 })
  await control(request, "search", { findLimitSeconds: 0 })
})

test("an unknown order link says so", async ({ page }) => {
  await page.goto("/?order=nothing-here")
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible()
  await shot(page, "N11-unknown")
})

test("a card form that does not load says so and offers a new invoice", async ({ page }) => {
  const label = uniqueLabel("nocard")
  const { invoiceId } = await startOrder(page, label, { method: "card" })
  // Stripe.js is blocked here
  await withStripeKey(page)
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.reload()
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
  await shot(page, "N10a-card-not-loaded")
  await page.getByRole("button", { name: "Get a new invoice" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
  // or the coins: the card invoice is cancelled and the name ordered again, paid with the coin chosen
  const card = new URL(page.url()).searchParams.get("order")!
  await page.getByRole("button", { name: "Pay with Monero" }).click()
  await page.waitForURL((url) => url.searchParams.get("order") !== card)
  await expect(page.getByRole("heading", { name: "Pay with Monero" })).toBeVisible()
  const cancelled = await (await page.request.get(`${MOCK}/api/invoice/${card}`)).json() as { status: string }
  expect(cancelled.status, "the card invoice").toBe("expired")
})

// a Stripe.js whose card form reports, once mounted, that it could not load, as it does for an intent Stripe refuses
const STRIPE_FORM_FAILS = `window.Stripe = () => ({ elements: () => ({ create: () => {
  const handlers = {}
  return { on: (event, handler) => { handlers[event] = handler }, mount: () => setTimeout(() => handlers.loaderror?.({ elementType: "payment" })), destroy: () => undefined }
} }) })`

test("a card form that Stripe cannot load says so and offers a new invoice, rather than a form that never comes", async ({ page }) => {
  await startOrder(page, uniqueLabel("cardfail"), { method: "card" })
  await withStripeKey(page)
  await page.route("https://js.stripe.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: STRIPE_FORM_FAILS }))
  await page.reload()
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toBeEnabled()
})

// a Stripe.js whose card form, once mounted, neither loads nor says it failed, as on a stalled network
const STRIPE_FORM_STALLS = `window.Stripe = () => ({ elements: () => ({ create: () => ({ on: () => undefined, mount: () => undefined, destroy: () => undefined }) }) })`
// room past the bound for the page to draw what follows
const CARD_FORM_SLACK_MS = 15_000

// Stripe.js loaded with a form that never says how it went, or a request for Stripe.js that is never answered
const STALLS: [string, (route: Route) => Promise<void> | undefined][] = [
  ["form", (route) => route.fulfill({ contentType: "text/javascript", body: STRIPE_FORM_STALLS })],
  ["script", () => undefined],
]

for (const [stalled, answer] of STALLS) {
  test(`a card ${stalled} that neither loads nor fails gives up after its bound and offers a new invoice, rather than Pay off for good`, async ({ page }) => {
    await startOrder(page, uniqueLabel("cardstall"), { method: "card" })
    await withStripeKey(page)
    await page.route("https://js.stripe.com/**", answer)
    await page.reload()
    await expect(page.getByRole("heading", { name: "Pay by card" })).toBeVisible()
    await expect(payButton(page)).toBeDisabled()
    await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible({ timeout: CARD_FORM_TIMEOUT_MS + CARD_FORM_SLACK_MS })
    await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Get a new invoice" })).toBeEnabled()
  })
}

test("a card form that does not load, in a browser without the order, leads to the name code", async ({ page }) => {
  await startOrder(page, uniqueLabel("nocardrec"), { method: "card" })
  await withStripeKey(page)
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole("heading", { name: "Card payment not confirmed" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Get a new invoice" })).toHaveCount(0)
  await page.getByRole("button", { name: "Enter your name code" }).click()
  await expect(codeField(page)).toBeVisible()
})

test("once a name is registered, Back to its search never offers it again, and Your names draws its row registered at once after a reload", async ({ page, request }) => {
  const label = uniqueLabel("mine")
  const { invoiceId } = await startOrder(page, label)
  await control(request, `settle/${invoiceId}`)
  await waitRegistered(page, label)
  // every Register the search draws from here on, however briefly
  await page.evaluate(() => {
    const w = window as unknown as { __offers: number }
    w.__offers = 0
    new MutationObserver(() => {
      if ([...document.querySelectorAll(".answer button")].some((b) => b.textContent!.includes("Register"))) w.__offers += 1
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.goBack()
  await expect(page.locator(".answer .row").getByRole("link", { name: "Your name" })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __offers: number }).__offers), "draws offering the name again").toBe(0)

  await page.reload()
  await expect(page.locator(".answer .row").getByRole("link", { name: "Your name" })).toBeVisible()
  // each chip the name's row is drawn with, from the list's first draw: a registered row has none, and is never still being checked
  await page.evaluate((title) => {
    const w = window as unknown as { __chips: string[] }
    w.__chips = []
    new MutationObserver(() => {
      const row = [...document.querySelectorAll(".list-row")].find((r) => r.querySelector(".name")?.textContent === title)
      const chip = row?.querySelector(".chip")?.textContent
      if (chip && w.__chips.at(-1) !== chip) w.__chips.push(chip)
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  }, `${label}.simplex`)
  await page.getByRole("link", { name: "Your names" }).first().click()
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  // ordered without links, it offers to add them
  await expect(row.getByRole("button", { name: "Add links" })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __chips: string[] }).__chips), "the row's chips from its first draw").toEqual([])
})

test("on a phone, a long name wraps beside its chats on Check your order, the chats at the row's right", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await toFullReview(page, `${uniqueLabel("wrap")}${"w".repeat(63)}`.slice(0, 63))
  const row = onStep(page).locator(".card.order > .row")
  const [box, name, chats] = await Promise.all([row, row.locator(".name"), row.locator(".chats")].map(async (l) => (await l.boundingBox())!))
  const padding = await row.evaluate((r) => parseFloat(getComputedStyle(r).paddingRight))
  expect(chats.x, "the chats after the name").toBeGreaterThanOrEqual(name.x + name.width)
  expect(Math.round(chats.x + chats.width), "the chats at the row's right").toBe(Math.round(box.x + box.width - padding))
  expect(name.height, "the name on more than one line").toBeGreaterThan(40)
})

// how often a pay page checks its name again (NAME_CHECK_MS in src/views/order.ts)
const NAME_CHECK_MINUTES = 5
const AVAILABLE = /^The name is available \(checked at \d\d:\d\d\)\. If someone registers it before you pay and the registration succeeds, what you paid is kept as your balance for another name, or refunded on request\.$/
const TAKEN = /^Someone has registered this name \(checked at \d\d:\d\d\)\. Don't pay this invoice: cancel it and choose another name\.$/
const takenAnswer = (route: Route) => route.fulfill({ json: { status: "registered", entities: [], tld: "simplex", community: null } })
// the heading, the note, the payment's details and the link under them: where each is and how tall
const payPlaces = (page: Page) => page.evaluate(() => ["h1", ".name-check", ":is(.card.pay, .stripe)", ".actions-row .alt"]
  .map((s) => { const b = document.querySelector(`body > main ${s}`)!.getBoundingClientRect(); return `${s} ${Math.round(b.top)} ${Math.round(b.height)}` }))

// how far the sentence in force sits from the middle of the note: the room above it less the room under it
const takenRoom = (page: Page) => page.evaluate(() => {
  const note = document.querySelector("body > main .name-check")!.getBoundingClientRect()
  const text = document.querySelector("body > main .name-check > :not(.sizer)")!.getBoundingClientRect()
  return Math.abs((text.top - note.top) - (note.bottom - text.bottom))
})

test("a Bitcoin page checks its name as it opens and every 5 minutes; taken meanwhile, the note turns red and the payment is turned off in place", async ({ page }) => {
  await page.clock.install()
  const checks: string[] = []
  page.on("request", (r) => { if (/\/api\/name\/0x/.test(r.url())) checks.push(r.url()) })
  await startOrder(page, uniqueLabel("chk"), { method: "btc" })
  const note = onStep(page).locator(".name-check")
  // the sentence not in force is in the note too, hidden, to hold its height
  await expect(note.locator(":scope > :not(.sizer)")).toHaveText(AVAILABLE)
  await expect(note).toHaveAttribute("role", "status")
  const opened = checks.length
  expect(opened, "the name was checked as the page opened").toBeGreaterThan(0)
  const before = { desktop: await payPlaces(page), phone: [] as string[] }
  await page.setViewportSize({ width: 390, height: 844 })
  before.phone = await payPlaces(page)
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.route("**/api/name/**", takenAnswer)
  await page.clock.fastForward(`0${NAME_CHECK_MINUTES - 1}:50`)
  await expect(note.locator(":scope > :not(.sizer)"), "no check before the minutes are up").toHaveText(AVAILABLE)
  expect(checks.length).toBe(opened)
  await page.clock.fastForward("00:15")
  await expect(note.locator(":scope > :not(.sizer)")).toHaveText(TAKEN)
  await expect(note).toHaveClass(/\bdanger\b/)
  expect(checks.length, "one check after the minutes").toBe(opened + 1)
  // the payment's details fade and take no input; Cancel stays
  const details = onStep(page).locator(".card.pay")
  await expect(details).toHaveClass(/\boff\b/)
  await expect(details).toHaveJSProperty("inert", true)
  expect(await details.evaluate((d) => getComputedStyle(d).opacity)).toBe("0.45")
  const copy = onStep(page).getByRole("button", { name: "Copy Bitcoin address" })
  await copy.focus()
  await expect(copy, "a control of the payment takes no focus").not.toBeFocused()
  await expect(onStep(page).getByRole("button", { name: "Cancel this invoice" })).toBeEnabled()
  expect(await payPlaces(page), "nothing moves on a laptop").toEqual(before.desktop)
  expect(await takenRoom(page), "the shorter sentence centred in the note's room on a laptop").toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await payPlaces(page), "nothing moves on a phone").toEqual(before.phone)
  expect(await takenRoom(page), "the shorter sentence centred in the note's room on a phone").toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await shot(page, "N4t-bitcoin-name-taken")

  // the page opened again says so from its first check
  await page.reload()
  await expect(onStep(page).locator(".name-check:not(.unchecked) > :not(.sizer)")).toHaveText(TAKEN)
  await expect(onStep(page).locator(".card.pay")).toHaveJSProperty("inert", true)
})

test("a card page whose name was taken meanwhile says so in brief and turns its form and Pay off, nothing on it moving", async ({ page }) => {
  test.skip(!!process.env.BASE_URL, STAND_IN_ONLY)
  await startOrder(page, uniqueLabel("chkcard"), { method: "card" })
  const sentence = onStep(page).locator(".name-check:not(.unchecked) > :not(.sizer)")
  await expect(sentence).toHaveText(AVAILABLE_BRIEF)
  await expect(onStep(page).getByRole("button", { name: /^Pay \$/ })).toBeEnabled()
  const placesAtEachSize = async () => {
    const places: string[][] = []
    for (const size of FIT_SIZES) {
      await page.setViewportSize(size)
      places.push(await payPlaces(page))
    }
    return places
  }
  const before = await placesAtEachSize()
  await page.route("**/api/name/**", takenAnswer)
  await page.reload()
  await expect(sentence).toHaveText(TAKEN_BRIEF)
  expect(await placesAtEachSize(), "the heading, the note, the form and Cancel at a laptop's and a phone's size").toEqual(before)
  await expect(onStep(page).locator(".stripe")).toHaveJSProperty("inert", true)
  await expect(onStep(page).getByRole("button", { name: /^Pay \$/ })).toBeDisabled()
  await expect(onStep(page).getByRole("button", { name: "Cancel this invoice" })).toBeEnabled()
})
