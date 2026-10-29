import { type APIRequestContext, type Browser, expect, type Locator, type Page } from "@playwright/test"
import { CODE_LIMIT } from "../dev/mock/limits.ts"
import { MAX_LABEL_LENGTH } from "../src/names.ts"
import type { Links } from "../src/api.ts"
import { checksumAddress } from "../src/crypto/wallet.ts"
import { walletOf } from "../src/flow.ts"
import { dateOf } from "../src/format.ts"
import {
  agreeToTerms, answersReserved, blockTimeOf, chainExpiry, channelLink, CHECKOUT_KEY, checkoutOwnerCode, CODE_HEADING, codeField, contactLink, control, fakeRegisteredName, fillLinks, FIT_SIZES, LINKS_HEADING, MOCK, offCentre, onStep,
  payButton, previewsShown, qrText, savedToReview, search, searchName, sevenLetters, shot, shownCode, SLOW_FETCH_MS, startOrder, test, textChangesOf, toCodeStep, restoreOrder, toReview, uniqueLabel,
  useCode, waitRegistered,
} from "./helpers.ts"

// a commit's wait of about three minutes, counted from the service's own clock
const WAIT_S = 200

// Whether a page drawn after this ever said the code is kept, from its first frame on.
const watchKept = () => {
  const w = window as unknown as { __kept: boolean }
  w.__kept = false
  new MutationObserver(() => { if (document.body?.textContent?.includes("Your code is kept")) w.__kept = true }).observe(document, { childList: true, subtree: true, characterData: true })
}
const saidKept = (page: Page) => page.evaluate(() => (window as unknown as { __kept: boolean }).__kept)

const USED_WHY = "A code registers one name only."
// A code refused for good leaves nothing to try again: the page says why and offers another search instead.
async function offersSearchInstead(page: Page): Promise<void> {
  await expect(page.getByText(USED_WHY)).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Search a name" })).toBeVisible()
}

async function reopenRefused(page: Page): Promise<void> {
  await page.addInitScript(watchKept)
  await page.reload()
  await expect(page.locator(".screen-head .lead")).toHaveText("Your code can no longer be used for it, so trying again cannot register it.")
  await expect(page.getByText("Your code was used for another name")).toBeVisible()
  await offersSearchInstead(page)
  expect(await saidKept(page), "the page said the code is kept before it said it is refused").toBe(false)
}

// another registration took the code once this one's failure let it go, and spent it
async function releasedAndUsed(request: APIRequestContext, code: string): Promise<void> {
  await control(request, "code/state", { code, state: "unused" })
  await control(request, "code/state", { code, state: "used" })
}

const keptRefusal = (page: Page, registrationId: string) =>
  page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`) ?? "{}").codeRefusal ?? null, registrationId)

const total = (page: Page) => page.locator(".card.order .trow.total")
const chip = (page: Page) => page.locator("body > header .code-chip")
const REGISTER_WITH_CODE = "Register with your code"
const TOO_MANY = 429
// a review's last row with a code, which costs nothing
const FREE_TOTAL = "Free SimpleX name"

// The name searched is registered with a prepaid code entered in Check your code, with its links or with them skipped;
// the page is left on the registration.
async function payWithCode(page: Page, label: string, code: string, links: Links | null = null): Promise<void> {
  await useCode(page, code)
  await search(page, label)
  if (links) {
    await onStep(page).getByRole("button", { name: "Register" }).click()
    await fillLinks(page, links.contact, links.channel)
    await previewsShown(page)
    await onStep(page).getByRole("button", { name: "Continue" }).click()
    await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
    await savedToReview(page)
  } else await toReview(page)
  await expect(total(page)).toHaveText(FREE_TOTAL)
  await onStep(page).getByRole("button", { name: REGISTER_WITH_CODE }).click()
  await page.waitForURL(/\?registration=/)
}

async function registerWithCode(page: Page, request: APIRequestContext, prefix: string, links: Links | null = null): Promise<{ code: string; registrationId: string; label: string }> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel(prefix)
  await payWithCode(page, label, code, links)
  return { code, registrationId: new URL(page.url()).searchParams.get("registration")!, label }
}

const ownerCodeOf = (page: Page, registrationId: string) =>
  page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`)!).ownerCode as string, registrationId)

test("a prepaid code from Check your code shows a name as Free and registers it with nothing to pay", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, years: 5 }) as { code: string }
  const label = uniqueLabel("pre")
  await useCode(page, code)
  await expect(chip(page)).toHaveText("Code: 6+ letters, 5 years")
  await expect(page.locator("body > header").getByRole("link", { name: "Check your code" })).toBeHidden()
  await search(page, label)
  const deal = page.locator(".answer .row .deal")
  await expect(deal).toHaveText("Free / 5 years")
  await shot(page, "K1b-code-applied-home")
  await toReview(page)
  await expect(total(page)).toHaveText(FREE_TOTAL)
  // no row nor note words the code as a payment
  await expect(page.locator(".card.order .trow")).toHaveText([/^Term5 years and (\d{2,} days|1 day)Early adopter bonus: your 5 years start on 1\u00a0January 2027\.$/, /^Registered until/, FREE_TOTAL])
  await expect(onStep(page).locator(".notes")).toHaveCount(0)
  await expect(page.getByRole("radio")).toHaveCount(0)
  await shot(page, "K3-checkout-covered")
  const register = onStep(page).getByRole("button", { name: REGISTER_WITH_CODE })
  await expect(register).toBeEnabled()
  await register.click()
  await page.waitForURL(/\?registration=/)
  // the code is the order's now, so the header offers Check your code again
  await expect(chip(page)).toBeHidden()
  await waitRegistered(page, label)
  const registered = await searchName(request, label)
  expect(registered.status).toBe("registered")
  await expect(page.locator("body > main .lead")).toHaveText(`Registered until ${dateOf(registered.expiresAt as number)}.`)
  // the code's term, its 5 years and the free days, sent as the duration, counted on chain from the register's block
  const view = await (await request.get(`${MOCK}/api/registration/${new URL(page.url()).searchParams.get("registration")}`)).json() as { years: number; duration: number; registerTx: string }
  expect(view.years).toBe(5)
  expect(await chainExpiry(label)).toBe(await blockTimeOf(view.registerTx) + view.duration)
  expect(registered.expiresAt).toBe(await chainExpiry(label))
  await shot(page, "K8-registered-with-code")
  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  await expect(row.locator(".sub"), "a registered name says its date alone").toHaveText(/^Until \d+\u00a0\w+ \d{4}$/)
  const codeRow = page.locator(".code-row")
  await expect(codeRow.locator(".chip")).toHaveText("Used")
  // the code on one line, its chip on its actions' line just before them, as the mockup's code rows end with their action
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const drawn = await codeRow.evaluate((r) => {
      const [code, chip, acts] = [".main .mono", ".state", ".acts"].map((s) => r.querySelector(s)!)
      const [c, a] = [chip.getBoundingClientRect(), acts.getBoundingClientRect()]
      return { codeLines: new Set([...code.getClientRects()].map((b) => Math.round(b.top))).size, chipLine: Math.round(c.top + c.height / 2) === Math.round(a.top + a.height / 2),
        chipBefore: c.right <= a.left, atEnd: Math.round(a.right) === Math.round(r.getBoundingClientRect().right - parseFloat(getComputedStyle(r).paddingRight)) }
    })
    expect(drawn, `the code's row at ${size.width}x${size.height}`).toEqual({ codeLines: 1, chipLine: true, chipBefore: true, atEnd: true })
  }
  await page.setViewportSize(FIT_SIZES[0])
  await shot(page, "K10-names-paid-with-code")

  // the code is spent
  await page.goto("/#/code")
  await codeField(page).fill(code)
  await expect(page.locator(".code-entry .verdict.bad")).toContainText("This code was already used")
  await expect(onStep(page).getByRole("button", { name: "Find a name" })).toBeDisabled()
  await shot(page, "K5-code-used")
})

// These cases need a prepaid code alone, from /control/code, so they run against the service as well as the mock.
test("a prepaid code registers a name with its links, which its records on chain then hold", async ({ page, request }) => {
  const links = { contact: contactLink("CL"), channel: channelLink("CL") }
  const { registrationId, label } = await registerWithCode(page, request, "clinks", links)
  await waitRegistered(page, label)
  const answer = await searchName(request, label)
  expect(answer.status).toBe("registered")
  expect(answer.records).toEqual(links)
  expect(answer.owner, "the name code's wallet owns the name").toBe(checksumAddress(walletOf(await ownerCodeOf(page, registrationId))!.address))
  await page.goto(`/#/?name=${label}`)
  await expect(page.locator(".answer .row .chat"), "the name's answer opens both chats").toHaveCount(2)
})

test("a code order's name code, entered in another browser before the reveal, lets that browser reveal and register the name", async ({ page, browser, request }) => {
  const links = { contact: contactLink("CR"), channel: channelLink("CR") }
  const { registrationId, label } = await registerWithCode(page, request, "creveal", links)
  const ownerCode = await ownerCodeOf(page, registrationId)
  // the buying browser goes away before its commitment's wait is over, so it never reveals the name
  await page.close()

  const other = await browser.newContext()
  const restored = await other.newPage()
  const reveals: string[] = []
  restored.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith(`/api/registration/${registrationId}/reveal`)) reveals.push(r.url()) })
  await restoreOrder(restored, ownerCode, label)
  await waitRegistered(restored, label)
  expect(reveals.length, "the restoring browser revealed the name").toBeGreaterThan(0)
  const answer = await searchName(request, label)
  expect(answer.records).toEqual(links)
  expect(answer.owner).toBe(checksumAddress(walletOf(ownerCode)!.address))
  await expect(await shownCode(restored), "the restored browser holds the name code").toHaveText(ownerCode)
  await other.close()
})

test("a name's link whose data cannot be read now shows as its kind's default picture, and opens by the chat core's form", async ({ page, request }) => {
  const contact = contactLink("Unr")
  const { label } = await registerWithCode(page, request, "cunread", { contact, channel: channelLink("CU") })
  await waitRegistered(page, label)
  await page.goto(`/#/?name=${label}`)
  await page.locator(".answer").getByRole("button", { name: "Contact address", exact: true }).click()
  const open = page.getByRole("dialog", { name: "Contact address" }).getByRole("link", { name: "Open in SimpleX" })
  await expect(open).toHaveAttribute("href", `simplex:/a#${contact.split("#")[1]}?h=smp8.simplex.im`)
})

test("Edit links on a name registered with a code adds both its links on chain in one transaction, then changes one", async ({ page, request }) => {
  const { registrationId, label } = await registerWithCode(page, request, "cedit")
  await waitRegistered(page, label)
  await page.goto("/#/names")
  await page.locator(".list-row", { hasText: `${label}.simplex` }).getByRole("button", { name: "Add links" }).click()
  await page.waitForURL((url) => url.hash === `#/edit/${registrationId}`)
  const contact = contactLink("CE")
  const channel = channelLink("CE")
  const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
  await link.fill(contact)
  await onStep(page).getByRole("button", { name: "Add a channel link" }).click()
  await onStep(page).getByRole("textbox", { name: "Channel", exact: true }).fill(channel)
  await previewsShown(page)
  const save = onStep(page).getByRole("button", { name: "Save links" })
  const sends = recordsSent(page)
  const answered = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/name/records")
  await save.click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect(sends.map((body) => body.edits.map((e) => [e.key, e.value])), "one request with both links").toEqual([[["simplex.contact", contact], ["simplex.channel", channel]]])
  const { tx } = await (await answered).json() as { tx: string }
  expect(await textChangesOf(tx), "one multicall that set both records").toEqual({ multicall: true, changes: [["simplex.contact", contact], ["simplex.channel", channel]] })
  expect((await searchName(request, label)).records).toEqual({ contact, channel })

  // read again from the chain, the page shows the saved links, and a second edit spends the next nonce
  await page.reload()
  await expect(link).toHaveValue(contact)
  await expect(onStep(page).getByRole("textbox", { name: "Channel", exact: true })).toHaveValue(channel)
  const nextContact = contactLink("CF")
  await link.fill(nextContact)
  await previewsShown(page)
  await save.click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact: nextContact, channel })
})

test("Check your code checks a code with the key icon, and Search keeps the magnifying glass", async ({ page }) => {
  const pathOf = (scope: Locator) => scope.locator("svg path").getAttribute("d")
  // a page that shows the key icon by itself: Edit links of an order this browser has no code for
  await page.goto("/#/edit/nosuchname")
  const key = await pathOf(onStep(page).locator(".notice"))
  await page.goto("/#/code")
  const check = onStep(page).getByRole("button", { name: "Check", exact: true })
  expect(await pathOf(check)).toBe(key)
  await page.goto("/")
  const lens = await pathOf(page.getByRole("button", { name: "Search", exact: true }))
  expect(lens, "the magnifying glass").toMatch(/^M10\.5 17a6\.5 6\.5/)
  expect(lens).not.toBe(key)
})

// The boxes of the name-is-yours screen's heading and of its body's parts above Edit links, and Edit links' own.
const yoursLayout = (page: Page) => onStep(page).evaluate((step) => {
  const edit = step.querySelector(".yours-edit")!
  const above = [step.querySelector(".screen-head")!, ...[...step.querySelector(".screen-body")!.children].filter((n) => n.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING)]
  const box = (n: Element) => { const r = n.getBoundingClientRect(); return [r.top, r.left, r.width, r.height] }
  return { above: above.map(box), edit: box(edit), clear: above.every((n) => n.getBoundingClientRect().bottom <= edit.getBoundingClientRect().top) }
})

test("the name-is-yours screen offers Edit links, a small secondary button under the name code that moves nothing above it", async ({ page, request }) => {
  const { registrationId, label } = await registerWithCode(page, request, "cyours", { contact: contactLink("CY"), channel: channelLink("CY") })
  await waitRegistered(page, label)
  const edit = onStep(page).getByRole("button", { name: "Edit links" })
  await expect(edit).toBeVisible()
  await expect(edit, "small and quiet, not the main action").toHaveClass("btn quiet small")
  await expect(onStep(page).locator(".actions-row .btn")).toHaveCount(0)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const shut = await yoursLayout(page)
    expect(shut.clear, `everything above it ends before it at ${size.width} px`).toBe(true)
    // the name code's QR goes under it, so showing the code moves nothing above it, nor it
    await onStep(page).getByRole("button", { name: "Show" }).click()
    await expect(onStep(page).locator(".code-qr svg")).toBeVisible()
    expect(await yoursLayout(page), `${size.width} px`).toEqual(shut)
    await onStep(page).getByRole("button", { name: "Hide" }).click()
    await expect(onStep(page).locator(".code-qr svg")).toHaveCount(0)
  }
  await shot(page, "K8b-registered-edit-links")
  await edit.click()
  await page.waitForURL((url) => url.hash === `#/edit/${registrationId}`)
  await expect(onStep(page).getByRole("heading", { name: "Edit links" })).toBeVisible()
  await expect(onStep(page).getByRole("textbox", { name: "Link", exact: true })).toHaveValue(contactLink("CY"))
})

// The boxes of a Your names row's parts, and whether its chat pictures take the room they did as plain pictures: the
// picture's 32 px each and the gap between them, whatever room their buttons give the pointer.
const rowLayout = (row: Locator) => row.evaluate((r) => {
  const box = (n: Element) => { const b = n.getBoundingClientRect(); return [b.top, b.left, b.width, b.height] }
  const chats = r.querySelector(".chats")
  const pics = [...r.querySelectorAll(".chats .chat-pic")]
  const gap = chats ? parseFloat(getComputedStyle(chats).columnGap) : 0
  const room = pics.reduce((w, p) => w + p.getBoundingClientRect().width, 0) + gap * Math.max(0, pics.length - 1)
  return { parts: [...r.querySelectorAll(".name, .sub, .chats, .chat-pic, .acts > *")].map(box), asPictures: chats ? chats.getBoundingClientRect().width === room && chats.getBoundingClientRect().height === 32 : true }
})
// what a chat's popup says and offers, from its heading to its actions
const popupContent = (page: Page) => page.locator(".modal[open] .pop").evaluate((pop) => ({
  text: pop.textContent, qr: pop.querySelector(".pop-qr svg")?.getAttribute("aria-label") ?? null,
  acts: [...pop.querySelectorAll(".pop-acts > *")].map((a) => [a.textContent, a.getAttribute("href")]),
}))

test("Your names opens a registered name's chat popup from its name or its picture, as the search answer does, and nothing in its row moves", async ({ page, request }) => {
  const links = { contact: contactLink("CP"), channel: channelLink("CP") }
  const { label } = await registerWithCode(page, request, "cpop", links)
  await waitRegistered(page, label)
  // the search answer's own popup of the name's first chat
  await page.goto(`/#/?name=${label}`)
  const answerChats = page.locator(".answer .row .chat")
  await expect(answerChats).toHaveCount(2)
  await answerChats.first().click()
  await expect(page.locator(".modal[open]")).toBeVisible()
  const contactPopup = await popupContent(page)
  expect(contactPopup.qr, "the link's QR code").not.toBeNull()
  await page.keyboard.press("Escape")
  await answerChats.nth(1).click()
  const channelPopup = await popupContent(page)
  await page.keyboard.press("Escape")

  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  const chats = row.locator(".chats .chat")
  await expect(chats).toHaveCount(2)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const before = await rowLayout(row)
    expect(before.asPictures, `the pictures take their own room at ${size.width} px`).toBe(true)
    await row.locator(".name .tld").click()
    await expect(page.locator(".modal[open]")).toBeVisible()
    expect(await popupContent(page), "the name opens its first chat's popup").toEqual(contactPopup)
    await page.keyboard.press("Escape")
    await expect(page.locator(".modal[open]")).toHaveCount(0)
    await expect(chats.first(), "focus goes back to the picture whose popup it is").toBeFocused()
    await chats.nth(1).hover()
    await chats.nth(1).click()
    expect(await popupContent(page)).toEqual(channelPopup)
    await page.keyboard.press("Escape")
    expect(await rowLayout(row), `nothing in the row moved at ${size.width} px`).toEqual(before)
  }
  await shot(page, "N13-names-chat-pictures")

  // a name without links has nothing to open
  const bare = uniqueLabel("cbare")
  await fakeRegisteredName(page, bare, { contact: "", channel: "" })
  await page.goto("/#/names")
  const bareRow = page.locator(".list-row", { hasText: `${bare}.simplex` })
  await expect(bareRow.getByRole("button", { name: "Add links" })).toBeVisible()
  await expect(bareRow.locator(".chats")).toHaveCount(0)
  expect(await bareRow.locator(".name").evaluate((n) => getComputedStyle(n).cursor)).toBe("auto")
  await bareRow.locator(".name .tld").click()
  await expect(page.locator(".modal[open]")).toHaveCount(0)
})

// what keeps browsers and password managers from filling, correcting or capitalizing a field
const NO_AUTOFILL = { autocomplete: "off", autocorrect: "off", autocapitalize: "none", spellcheck: "false", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" }
async function noAutofill(page: Page, where: string, fields: number): Promise<void> {
  const inputs = page.locator("body > main input[type=text]")
  await expect(inputs, where).toHaveCount(fields)
  for (const input of await inputs.all()) {
    const attrs = await input.evaluate((n, names) => Object.fromEntries(names.map((a) => [a, n.getAttribute(a)])), Object.keys(NO_AUTOFILL))
    expect(attrs, `${where}: ${await input.getAttribute("aria-label")}`).toEqual(NO_AUTOFILL)
  }
}

test("no field offers autofill, autocorrect or a password manager: the name search, both code fields and every link field", async ({ page }) => {
  await page.goto("/")
  await noAutofill(page, "the name search", 1)
  await page.goto("/#/code")
  await noAutofill(page, "Check your code", 1)
  const label = uniqueLabel("nofill")
  await search(page, label)
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await fillLinks(page, contactLink("NF"), channelLink("NF"))
  await noAutofill(page, "the links step", 2)
  await search(page, uniqueLabel("nofillr"))
  await toReview(page)
  await onStep(page).getByRole("button", { name: "I have a code" }).click()
  await noAutofill(page, "the checkout's code field", 1)
  const { registrationId } = await fakeRegisteredName(page, uniqueLabel("nofille"), { contact: contactLink("NF"), channel: channelLink("NF") })
  await page.goto(`/#/edit/${registrationId}`)
  await expect(onStep(page).getByRole("heading", { name: "Edit links" })).toBeVisible()
  await noAutofill(page, "Edit links", 2)
})

const editCount = (page: Page) => onStep(page).locator(".edit-count")
const saveLinks = (page: Page) => onStep(page).getByRole("button", { name: "Save links" })
// The bodies of the record edits the page sends from now on.
function recordsSent(page: Page): { edits: { key: string; value: string; nonce: number }[] }[] {
  const bodies: { edits: { key: string; value: string; nonce: number }[] }[] = []
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/name/records") bodies.push(req.postDataJSON())
  })
  return bodies
}
// Save's box and the top and height of the line under it, whose width follows its words: a change of either moves what is around them
async function saveRow(page: Page): Promise<unknown[]> {
  await expect(saveLinks(page)).toBeVisible()
  const count = (await editCount(page).boundingBox())!
  return [await saveLinks(page).boundingBox(), count.y, count.height]
}
const YEAR_S = 365 * 86400

test("Edit links counts the name's edits left this year under Save, one per Save of one link or both, in place and on one line", async ({ page, request }) => {
  const { registrationId, label } = await registerWithCode(page, request, "ccount")
  await waitRegistered(page, label)
  await expect(onStep(page).getByRole("button", { name: "Add links" }), "a name without links adds them").toHaveClass("btn quiet small")
  expect((await searchName(request, label)).recordEdits, "links set at registration count no edit").toEqual({ left: 3, nextAt: null })
  await page.goto(`/#/edit/${registrationId}`)
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await expect(editCount(page)).toHaveText("3 edits left this year.")
    await expect(editCount(page)).toBeVisible()
    const lineHeight = await editCount(page).evaluate((n) => parseFloat(getComputedStyle(n).lineHeight))
    expect((await editCount(page).boundingBox())!.height, `one line at ${size.width} px`).toBeLessThanOrEqual(lineHeight + 1)
  }
  const before = await saveRow(page)
  const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
  const contact = contactLink("CC")
  await link.fill(contact)
  await onStep(page).getByRole("button", { name: "Add a channel link" }).click()
  await onStep(page).getByRole("textbox", { name: "Channel", exact: true }).fill(channelLink("CC"))
  await previewsShown(page)
  await expect(editCount(page), "both links take one edit").toHaveText("3 edits left this year.")
  const sends = recordsSent(page)
  await saveLinks(page).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  await expect(editCount(page)).toHaveText("2 edits left this year.")
  expect(sends.map((body) => body.edits.map((e) => e.key)), "one request").toEqual([["simplex.contact", "simplex.channel"]])
  const { nonce } = sends[0].edits[0]
  expect(sends[0].edits.map((e) => e.nonce), "consecutive nonces").toEqual([nonce, nonce + 1])
  expect(await saveRow(page), "Save and the count keep their place").toEqual(before)
  await link.fill(contactLink("CD"))
  await previewsShown(page)
  await saveLinks(page).click()
  await expect(editCount(page)).toHaveText("1 edit left this year.")
  expect(sends.map((body) => body.edits.map((e) => e.nonce)), "the next Save from the nonce both spent").toEqual([[nonce, nonce + 1], [nonce + 2]])
  await page.reload()
  await expect(editCount(page)).toHaveText("1 edit left this year.")
  expect((await searchName(request, label)).recordEdits).toMatchObject({ left: 1 })
})

test("Edit links saves both links with the last edit left, then keeps Save off until the edits return", async ({ page, request }) => {
  const { registrationId, label } = await registerWithCode(page, request, "cnone")
  await waitRegistered(page, label)
  const made = Math.floor(Date.now() / 1000) - 86400
  await control(request, "edits", { label, count: 2, at: made })
  await page.goto(`/#/edit/${registrationId}`)
  await expect(editCount(page)).toHaveText("1 edit left this year.")
  const before = await saveRow(page)
  const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
  const contact = contactLink("CN")
  const channel = channelLink("CN")
  await link.fill(contact)
  await onStep(page).getByRole("button", { name: "Add a channel link" }).click()
  await onStep(page).getByRole("textbox", { name: "Channel", exact: true }).fill(channel)
  await previewsShown(page)
  await expect(editCount(page)).toHaveText("1 edit left this year.")
  await expect(saveLinks(page)).toBeEnabled()
  await saveLinks(page).click()
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  expect((await searchName(request, label)).records).toEqual({ contact, channel })
  const again = `You can edit links again on ${dateOf(made + YEAR_S)}.`
  await expect(editCount(page)).toHaveText(again)
  await link.fill("")
  await expect(saveLinks(page), "none left, whatever is typed").toBeDisabled()
  expect(await saveRow(page), "Save and the count keep their place").toEqual(before)
  await page.reload()
  await expect(editCount(page)).toHaveText(again)
  await expect(saveLinks(page)).toBeDisabled()
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    await expect(editCount(page)).toBeVisible()
    const lineHeight = await editCount(page).evaluate((n) => parseFloat(getComputedStyle(n).lineHeight))
    expect((await editCount(page).boundingBox())!.height, `one line at ${size.width} px`).toBeLessThanOrEqual(lineHeight + 1)
  }
  await shot(page, "N12c-edit-links-used-up")
})

test("a Save of both links from a tab opened before the name's edits ran out says when they return, and changes neither link", async ({ page, request }) => {
  const { registrationId, label } = await registerWithCode(page, request, "cstale")
  await waitRegistered(page, label)
  await page.goto(`/#/edit/${registrationId}`)
  await expect(editCount(page)).toHaveText("3 edits left this year.")
  const made = Math.floor(Date.now() / 1000) - 3600
  const again = `You can edit links again on ${dateOf(made + YEAR_S)}.`
  // used up elsewhere: nothing is sent, and nothing else is said
  await control(request, "edits", { label, count: 3, at: made })
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("CS"))
  await onStep(page).getByRole("button", { name: "Add a channel link" }).click()
  await onStep(page).getByRole("textbox", { name: "Channel", exact: true }).fill(channelLink("CS"))
  await previewsShown(page)
  await saveLinks(page).click()
  await expect(editCount(page)).toHaveText(again)
  await expect(saveLinks(page)).toBeDisabled()
  await expect(onStep(page).locator(".notice")).toHaveCount(0)
  expect((await searchName(request, label)).records).toEqual({ contact: "", channel: "" })
})

test("the tab's code pays for each name it covers until it is taken off, which takes it off the checkout too", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await useCode(page, code)
  const label = uniqueLabel("stay")
  await search(page, label)
  await toReview(page)
  await expect(total(page)).toHaveText(FREE_TOTAL)
  // Back through the name code and links steps to the search, and on again
  await page.goBack()
  await expect(onStep(page).getByRole("heading", { name: CODE_HEADING })).toBeVisible()
  await page.goBack()
  await page.goBack()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(label)
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("button", { name: "Skip for now" }).click()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(total(page)).toHaveText(FREE_TOTAL)
  // taking the code off, in the header, prices the order again
  await chip(page).getByRole("button", { name: "Remove code" }).click()
  await expect(chip(page)).toBeHidden()
  await expect(total(page)).not.toHaveText(FREE_TOTAL)
  await expect(payButton(page)).toBeEnabled()
  await expect(page.getByRole("radio")).toHaveCount(3)
  await search(page, uniqueLabel("other"))
  await expect(page.locator(".answer .row .deal s")).toHaveCount(0)
})

test("a code the service refuses as the order is sent says why on the review, which then pays", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await useCode(page, code)
  await search(page, uniqueLabel("used"))
  await toReview(page)
  await expect(total(page)).toHaveText(FREE_TOTAL)
  await page.route("**/api/name/register", (route) => route.fulfill({ status: 409, json: { error: "code_used" } }))
  await onStep(page).getByRole("button", { name: REGISTER_WITH_CODE }).click()
  await expect(page.getByText("This code was already used. Pay for the name here, or check another code.")).toBeVisible()
  await expect(total(page)).not.toHaveText(FREE_TOTAL)
  await expect(page.getByRole("radio")).toHaveCount(3)
  await expect(payButton(page)).toHaveText(/^Pay \$[\d.,]+ with Bitcoin/)
  await expect(payButton(page)).toBeEnabled()
  await expect(chip(page), "the refused code pays for nothing more").toBeHidden()
  // the refusal offers another code in its own words, and no second link under the payment choices
  await expect(onStep(page).getByRole("button", { name: "I have a code" })).toHaveCount(0)
  await onStep(page).getByRole("button", { name: "check another code" }).click()
  await expect(codeField(page)).toBeFocused()
  await expect(page.getByText("This code was already used. Pay for the name here")).toHaveCount(0)
  await page.unrouteAll({ behavior: "wait" })
})

test("an order refused once the tab moved on to another checkout draws that checkout, ready to pay", async ({ page }) => {
  const other = uniqueLabel("movedto")
  await search(page, uniqueLabel("moved"))
  await toReview(page)
  await page.route("**/api/invoice", async (route) => {
    await page.evaluate(([key, label]) => sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(key)!), label })), [CHECKOUT_KEY, other])
    await route.fulfill({ status: 503, json: { error: "provider_unavailable" } })
  })
  await payButton(page).click()
  await expect(onStep(page).locator(".card.order")).toContainText(`${other}.simplex`)
  await expect(payButton(page), "the stale page's order is no longer on its way").toHaveText(/^Pay \$[\d.,]+ with Bitcoin/)
  await expect(payButton(page)).toBeEnabled()
  await page.unrouteAll({ behavior: "wait" })
})

const haveCode = (page: Page) => onStep(page).getByRole("button", { name: "I have a code" })
const removeCode = (page: Page) => onStep(page).getByRole("button", { name: "Remove code" })
// the main button's top, centre and height
const mainAt = (page: Page) => onStep(page).locator(".actions-row > .btn").evaluate((b) => {
  const r = b.getBoundingClientRect()
  return [r.top, r.left + r.width / 2, r.height]
})
// the review's content clear of the terms box, and the terms box clear of the main button, at each size a page must fit
async function reviewFits(page: Page, what: string): Promise<void> {
  for (const size of FIT_SIZES) {
    await page.setViewportSize(size)
    const gaps = await onStep(page).evaluate((step) => {
      const [review, terms, actions] = [".review", ".check.terms", ".actions-row"].map((s) => step.querySelector(s)!.getBoundingClientRect())
      return [terms.top - review.bottom, actions.top - terms.bottom]
    })
    expect(Math.min(...gaps), `${what} at ${size.width} px`).toBeGreaterThanOrEqual(0)
  }
  await page.setViewportSize(FIT_SIZES[0])
}

test("a prepaid code entered on Check your order makes the order free in place, with the main button where it was, and removed pays again", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, years: 5 }) as { code: string }
  await search(page, uniqueLabel("here"))
  await toReview(page, false)
  // the link under the payment choices
  expect(await onStep(page).locator(".review > *").evaluateAll((nodes) => nodes.map((n) => n.className))).toEqual(["card order", "pay-with", "have-code", "notes"])
  await reviewFits(page, "the link")
  const at = await mainAt(page)
  await haveCode(page).click()
  await expect(codeField(page)).toBeFocused()
  await expect(haveCode(page)).toHaveCount(0)
  // the field takes the payment choices' place, and the main button waits for a code
  await expect(page.getByRole("radio")).toHaveCount(0)
  await expect(onStep(page).locator(".notes")).toHaveCount(0)
  const register = onStep(page).getByRole("button", { name: REGISTER_WITH_CODE })
  await expect(register).toBeDisabled()
  expect(await mainAt(page), "the field opened").toEqual(at)
  await reviewFits(page, "the field")

  await codeField(page).fill(code)
  await expect(onStep(page).locator(".code-entry .verdict")).toHaveText("This code allows you to register a free name of 6 or more letters, for 5 years.")
  await expect(total(page)).toHaveText(FREE_TOTAL)
  await expect(page.locator(".card.order .trow").first()).toHaveText(/^Term5 years and/)
  await expect(register, "the terms are still to be agreed").toBeDisabled()
  expect(await mainAt(page), "the code taken").toEqual(at)
  await reviewFits(page, "the code taken")
  await shot(page, "K3b-checkout-code-entered")
  await page.reload()
  await expect(codeField(page), "reloaded, the field still holds the code").toHaveValue(code)
  await expect(total(page)).toHaveText(FREE_TOTAL)

  await removeCode(page).click()
  await expect(total(page)).not.toHaveText(FREE_TOTAL)
  await expect(page.getByRole("radio")).toHaveCount(3)
  await expect(payButton(page)).toHaveText(/^Pay \$[\d.,]+ with Bitcoin/)
  await expect(codeField(page)).toHaveCount(0)
  await expect(haveCode(page)).toBeFocused()
  expect(await mainAt(page), "the code removed").toEqual(at)
  await haveCode(page).click()
  await expect(codeField(page), "opened again, the field is empty").toHaveValue("")

  await codeField(page).fill(code)
  await expect(total(page)).toHaveText(FREE_TOTAL)
  await agreeToTerms(page)
  await register.click()
  await page.waitForURL(/\?registration=/)
})

test("a code on Check your order that is not valid, used, too short for the name or a name code says why, and the order is paid once it is removed", async ({ page, request }) => {
  const { code: used } = await control(request, "code", { minLength: 6 }) as { code: string }
  await control(request, "code/state", { code: used, state: "used" })
  const { code: longer } = await control(request, "code", { minLength: 8 }) as { code: string }
  await search(page, sevenLetters())
  await toReview(page)
  const at = await mainAt(page)
  await haveCode(page).click()
  const cases: [string, string | RegExp][] = [
    ["SN7-BJTBP-29596-R3HJ8-25YM8", /^This code is not valid/],
    [used, "This code was already used. Each code registers one name."],
    [longer, "This code does not cover this name. It covers names of 8 or more letters."],
    [await checkoutOwnerCode(page), "This is a name code. A code from SimpleX lets you register a free name."],
  ]
  for (const [text, says] of cases) {
    await codeField(page).fill(text)
    await expect(onStep(page).locator(".code-entry .verdict")).toHaveText(says)
    await expect(total(page)).not.toHaveText(FREE_TOTAL)
    await expect(onStep(page).getByRole("button", { name: REGISTER_WITH_CODE })).toBeDisabled()
    expect(await mainAt(page), `${text} refused`).toEqual(at)
    await reviewFits(page, `${text} refused`)
  }
  await shot(page, "K3c-checkout-code-refused")
  await removeCode(page).click()
  await expect(page.getByRole("radio")).toHaveCount(3)
  await expect(payButton(page)).toBeEnabled()
  expect(await mainAt(page)).toEqual(at)
})

test("Check your code tells a prepaid code, a name code and anything else apart, and a code for longer names says so on the home", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 8 }) as { code: string }
  await page.goto("/#/code")
  const verdict = page.locator(".code-entry .verdict")
  const find = onStep(page).getByRole("button", { name: "Find a name" })
  await codeField(page).fill("SN7-BJTBP-29596-R3HJ8-25YM8")
  await expect(verdict).toHaveText(/^This code is not valid/)
  await expect(find).toBeDisabled()
  await shot(page, "K6-code-invalid")
  // a name code is judged by the orders find lists for it, none for this one
  await codeField(page).fill("SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G")
  await expect(verdict).toHaveText("No order was found for this code. The service has no order registered to its wallet.")
  await expect(find).toBeDisabled()
  await codeField(page).fill(code)
  await expect(verdict).toHaveText("This code allows you to register a free name of 8 or more letters, for 2 years.")
  await expect(onStep(page).getByText("Search for a name; it shows as Free.")).toBeVisible()
  await expect(onStep(page).locator(".lead")).toHaveText("A code from SimpleX lets you register a free name.A name code brings a name you own to this browser.")
  await shot(page, "K1-code-valid")
  await find.click()
  const short = uniqueLabel("k7").slice(0, 7)
  await search(page, short)
  await expect(page.locator(".answer .row .deal")).toHaveText(/^\$\d+ \/ 2 years$/)
  await expect(page.locator(".answer .hint")).toHaveText("Your code allows you to register a free name of 8 or more letters. This name has 7.")
  await shot(page, "K7-code-too-short")
  await toReview(page)
  await expect(page.getByRole("radio")).toHaveCount(3)
})

test("a code checked is listed in Your names, used again from there, and forgotten", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 7 }) as { code: string }
  await useCode(page, code)
  await chip(page).getByRole("button", { name: "Remove code" }).click()
  await page.goto("/#/names")
  const row = page.locator(".list-row", { hasText: code })
  await expect(row.locator(".chip")).toHaveText("Unused")
  await shot(page, "N12a-codes")
  await row.getByRole("button", { name: "Use", exact: true }).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await expect(chip(page)).toHaveText("Code: 7+ letters, 2 years")
  await page.goto("/#/names")
  await page.getByText("Forget everything in this browser").click()
  await shot(page, "N12c-forget")
  await page.getByRole("button", { name: "Forget everything" }).click()
  await expect(row).toHaveCount(0)
  // the confirmed question is drawn away, so focus goes to the page's heading
  await expect(page.getByRole("heading", { name: "Your names" })).toBeFocused()
  await expect(page.getByRole("link", { name: "Add a name code" })).toHaveAttribute("href", "/#/code")
})

// The service's code check answers a rate limit with this wait the first `times` it is asked, and the page's checks are counted.
async function limitCodeChecks(page: Page, times: number, waitSeconds: number): Promise<() => number> {
  let checks = 0
  await page.route("**/api/code/check", (route) => ++checks <= times
    ? route.fulfill({ status: 429, headers: { "retry-after": String(waitSeconds) }, json: { error: "rate_limited" } }) : route.continue())
  return () => checks
}

test("Save pressed in Edit links while a link is still checked waits for its check, then saves it", async ({ page, request }) => {
  const first = contactLink("UnrC")
  const second = contactLink("UnrD")
  const { registrationId, label } = await registerWithCode(page, request, "cwait", { contact: first, channel: channelLink("CW") })
  await waitRegistered(page, label)
  await control(request, "search", { fetchDelays: { [second]: SLOW_FETCH_MS } })
  await page.goto(`/#/edit/${registrationId}`)
  const link = onStep(page).getByRole("textbox", { name: "Link", exact: true })
  await expect(link).toHaveValue(first)
  await link.fill(second)
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "checking")
  const save = onStep(page).locator(".btn[data-focus=save]")
  const before = await save.boundingBox()
  await save.click()
  // busy where it stands while the link is checked, and said so
  await expect(save).toHaveAccessibleName("Checking link…")
  await expect(save).toHaveAttribute("aria-busy", "true")
  expect(await save.boundingBox(), "the busy button keeps its place and size").toEqual(before)
  await expect(page.locator("body > .sr-only[role=status]")).toHaveText("Checking link…")
  await expect(page.getByText("Links saved")).toBeVisible({ timeout: 30_000 })
  await expect(save).toHaveAccessibleName("Save links")
  await expect(save).not.toHaveAttribute("aria-busy", "true")
  expect((await searchName(request, label)).records).toEqual({ contact: second, channel: channelLink("CW") })
  await control(request, "search", { fetchDelays: {} })
})

test("a code row in Your names whose check meets the rate limit counts down its wait and is checked again, as often as it is met", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 7 }) as { code: string }
  await useCode(page, code)
  const checks = await limitCodeChecks(page, 2, 3)
  await page.goto("/#/names")
  const state = page.locator(".list-row", { hasText: code }).locator(".chip")
  await expect(state).toHaveText(/^Checking again in [1-3] seconds?$/)
  await expect(state, "checked again after each wait").toHaveText("Unused", { timeout: 15_000 })
  expect(checks(), "two refused checks and the one after them").toBe(3)
})

test("an owner code made at checkout is kept in Your names until its order exists", async ({ page }) => {
  const label = uniqueLabel("pend")
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await toCodeStep(page)
  // another tab, which does not hold this checkout, looks for its order
  const other = await page.context().newPage()
  await other.goto("/#/names")
  const row = other.locator(".list-row", { hasText: `${label}.simplex` })
  await expect(row.locator(".chip")).toHaveText("Checkout not finished")
  await row.getByText("Find the order").click()
  await expect(row.locator(".chip")).toHaveText("No order was made")
  await shot(other, "N12d-unfinished-checkout")
  await row.getByText("Remove").click()
  await expect(other.locator(".list-row", { hasText: `${label}.simplex` })).toHaveCount(0)
})

test("Your names continues this tab's unfinished checkout at the step it was left on", async ({ page }) => {
  const label = uniqueLabel("cont")
  await search(page, label)
  await toCodeStep(page)
  const row = page.locator(".list-row", { hasText: `${label}.simplex` })
  const resume = async (heading: string) => {
    await page.goto("/#/names")
    await expect(row.locator(".chip")).toHaveText("Checkout not finished")
    await expect(row.getByText("Find the order"), "this tab's checkout is continued, not looked for").toHaveCount(0)
    await row.getByRole("button", { name: "Continue checkout" }).click()
    await expect(onStep(page).getByRole("heading", { name: heading })).toBeVisible()
  }
  await resume(CODE_HEADING)
  await savedToReview(page)
  await resume("Check your order")
  // the order's links are read here, and changed on its Links step, by Back
  await onStep(page).getByRole("link", { name: "Back" }).click()
  await onStep(page).getByRole("link", { name: "Back" }).click()
  await expect(onStep(page).getByRole("heading", { name: LINKS_HEADING })).toBeVisible()
  await resume(LINKS_HEADING)
})

test("an order refused at checkout for a name taken meanwhile leaves no unfinished checkout in Your names", async ({ page }) => {
  const label = uniqueLabel("ptk")
  await page.goto("/")
  await page.getByLabel("Name", { exact: true }).fill(label)
  await page.getByLabel("Name", { exact: true }).press("Enter")
  await toReview(page)
  await page.route("**/api/invoice", (route) => route.fulfill({ status: 409, json: { error: "name_taken" } }))
  await payButton(page).click()
  await expect(onStep(page).getByRole("heading", { name: "This name is no longer available" })).toBeVisible()
  await page.getByRole("link", { name: "Your names" }).first().click()
  await expect(page.getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(page.getByText(/^No names in this browser yet/).or(page.locator(".list-row").first())).toBeVisible()
  await expect(page.locator(".list-row", { hasText: `${label}.simplex` })).toHaveCount(0)
})

test("a code order taken first gives its code back, ready for another name", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("ctk")
  await control(request, "take", { label })
  await payWithCode(page, label, code)
  await expect(page.getByRole("heading", { name: "Someone registered it first" })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator(".outcome .code-text")).toHaveText(code)
  await shot(page, "K9-code-released")
  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: code }).locator(".chip")).toHaveText("Unused")
})

test("a code order whose name was reserved meanwhile says so, and gives its code back", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("crs")
  await control(request, "take", { label })
  await payWithCode(page, label, code)
  await answersReserved(page, label)
  await expect(page.getByRole("heading", { name: "The name was reserved meanwhile" })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator(".outcome .notice")).toHaveText(`${label}.simplex can't be registered. Your code was not spent: use it for another name.`)
  await expect(page.locator(".outcome .code-text")).toHaveText(code)
})

test("a retry refused for a code used elsewhere says the code is gone and offers no Try again, also once reopened", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "cgone")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator(".screen-head .lead")).toHaveText("Your code is kept. Trying again spends nothing more.")
  await page.route("**/retry", (route) => route.fulfill({ status: 409, json: { error: "code_used" } }))
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByText("Your code was used for another name")).toBeVisible()
  await expect(page.locator(".screen-head .lead")).toHaveText("Your code can no longer be used for it, so trying again cannot register it.")
  await offersSearchInstead(page)
  await page.getByRole("button", { name: "Search a name" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible()
  await reopenRefused(page)
})

test("a failed code order opened again after its code was used elsewhere offers no Try again, and from the first frame the time after", async ({ page, request }) => {
  const { code, registrationId } = await registerWithCode(page, request, "cgone")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await releasedAndUsed(request, code)
  await page.addInitScript(watchKept)
  await page.reload()
  await expect(page.getByText("Your code was used for another name")).toBeVisible()
  await expect(page.locator(".screen-head .lead")).toHaveText("Your code can no longer be used for it, so trying again cannot register it.")
  await offersSearchInstead(page)
  expect(await saidKept(page), "the page opened first after the code went said it is kept").toBe(false)
  await reopenRefused(page)
})

test("a failed code order is drawn before its code is checked, and says the code is kept only once the check answers", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "ccheck")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  const lead = page.locator(".screen-head .lead")
  await page.addInitScript(watchKept)
  for (const unanswered of ["rate limit", "provider down", "dropped"]) {
    await page.route("**/api/code/check", (route) => unanswered === "dropped" ? route.abort()
      : route.fulfill(unanswered === "rate limit" ? { status: 429, headers: { "retry-after": "30" }, json: { error: "rate_limited" } } : { status: 503, json: { error: "provider_unavailable" } }))
    const asked = page.waitForRequest("**/api/code/check")
    await page.reload()
    await asked
    await expect(page.getByRole("heading", { name: "Not registered" }), unanswered).toBeVisible()
    await expect(lead, unanswered).toHaveText("Trying again spends nothing more.")
    await expect(page.getByRole("button", { name: "Try again" }), unanswered).toBeEnabled()
    expect(await saidKept(page), `${unanswered}: the page said the code is kept without an answer`).toBe(false)
    await page.unrouteAll({ behavior: "wait" })
  }
  let answer: () => void = () => undefined
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await page.route("**/api/code/check", async (route) => {
    await answered
    await route.continue()
  })
  await page.reload()
  await expect(page.getByRole("heading", { name: "Not registered" }), "the order is drawn while its code is checked").toBeVisible()
  await expect(lead).toHaveText("Trying again spends nothing more.")
  answer()
  await expect(lead, "the lead says the code is kept once the check answers").toHaveText("Your code is kept. Trying again spends nothing more.")
  await page.unrouteAll({ behavior: "wait" })
})

test("a failed code order whose code check meets the rate limit counts down its wait, then says the code is kept", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "climit")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  const checks = await limitCodeChecks(page, 1, 3)
  await page.reload()
  const notice = onStep(page).locator(".notice", { hasText: "Too many checks just now" })
  await expect(notice.locator("span[aria-hidden=true]")).toHaveText(/^Your code may be fine\. Checking again in [1-3] seconds?\.$/)
  await expect(page.locator(".screen-head .lead")).toHaveText("Trying again spends nothing more.")
  await expect(page.locator(".screen-head .lead")).toHaveText("Your code is kept. Trying again spends nothing more.", { timeout: 15_000 })
  await expect(notice).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled()
  expect(checks(), "the refused check and the one after its wait").toBe(2)
})

test("a code held by this browser's failed order says it is in use and links to the order; a revoked code says SimpleX withdrew it", async ({ page, request }) => {
  const { code, registrationId } = await registerWithCode(page, request, "cinuse")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await page.goto("/#/code")
  await codeField(page).fill(code)
  const verdict = page.locator(".code-entry .verdict")
  await expect(verdict).toHaveText("This code is being used for a name now. Each code registers one name; this one is held by an unfinished registration. Open that order")
  await verdict.getByRole("link", { name: "Open that order" }).click()
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("registration")).toBe(registrationId)
  const { code: revoked } = await control(request, "code", { minLength: 6, state: "revoked" }) as { code: string }
  await page.goto("/#/code")
  await codeField(page).fill(revoked)
  await expect(verdict).toHaveText("This code is not valid: SimpleX withdrew it.")
})

test("a failed code order whose code is revoked or past its date while still held by it offers Try again, which registers it", async ({ page, request }) => {
  const { code, registrationId } = await registerWithCode(page, request, "cheld")
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  for (const state of ["expired", "revoked"]) {
    await control(request, "code/state", { code, state })
    await page.reload()
    await expect(page.locator(".screen-head .lead"), state).toHaveText("Your code is kept. Trying again spends nothing more.")
    await expect(page.getByRole("button", { name: "Try again" }), state).toBeEnabled()
    expect(await keptRefusal(page, registrationId), state).toBeNull()
  }
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("heading", { name: /^Registering / })).toBeVisible()
})

test("an order restored in a browser without its code promises nothing of the code, and keeps the service's refusal of Try again", async ({ page, request, browser, baseURL }) => {
  const { code, registrationId, label } = await registerWithCode(page, request, "crest")
  const ownerCode = await page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`)!).ownerCode as string, registrationId)
  await control(request, `fail/${registrationId}`)
  await expect(page.getByRole("heading", { name: "Not registered" })).toBeVisible({ timeout: 60_000 })
  await releasedAndUsed(request, code)
  const other = await browser.newContext({ baseURL, reducedMotion: "reduce" })
  try {
    const restored = await other.newPage()
    await restored.addInitScript(watchKept)
    await restoreOrder(restored, ownerCode, label)
    await expect(restored.getByRole("heading", { name: "Not registered" })).toBeVisible()
    await expect(restored.locator(".screen-head .lead")).toHaveText("Trying again spends nothing more.")
    expect(await saidKept(restored), "the restored order said its code is kept").toBe(false)
    await restored.getByRole("button", { name: "Try again" }).click()
    await expect(restored.getByText("Your code was used for another name")).toBeVisible()
    await offersSearchInstead(restored)
    expect(await keptRefusal(restored, registrationId)).toBe("code_used")
  } finally {
    await other.close()
  }
})

test("the registering page's clock tells the time left from the commit's wait", async ({ page, request }) => {
  const { registrationId } = await registerWithCode(page, request, "cwait")
  await page.route(`**/api/registration/${registrationId}*`, async (route) => {
    const response = await route.fetch()
    const view = await response.json()
    const serviceNow = Date.parse(response.headers()["date"]!) / 1000
    await route.fulfill({ response, json: { ...view, phase: "committed", label: null, commitTx: view.commitTx ?? `0x${"1".repeat(64)}`, revealAfter: serviceNow + WAIT_S } })
  })
  await page.reload()
  await expect(page.locator(".countdown b")).toHaveText(/^3:[12]\d$/)
  await expect(page.locator(".screen-head .lead")).toHaveText("Keep this page open until the name is yours, or come back within 24 hours.")
  await page.unrouteAll({ behavior: "ignoreErrors" })
})

test("a device clock three minutes slow signs as soon as the service allows", async ({ page, request }) => {
  await page.clock.install({ time: Date.now() - 3 * 60_000 })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("skew")
  await payWithCode(page, label, code)
  await expect(page.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible({ timeout: 60_000 })
})

test("a name code added on a fresh page works at once with the device clock 15 minutes off", async ({ page, browser }) => {
  const label = uniqueLabel("fresh")
  const { ownerCode } = await startOrder(page, label, { method: "btc" })
  const other = await browser.newContext()
  const fresh = await other.newPage()
  await fresh.clock.install({ time: Date.now() + 15 * 60_000 })
  await restoreOrder(fresh, ownerCode, label)
  await other.close()
})

test("a code check past the service's limit counts down its wait, then checks the code again by itself", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  // this client's checks until the limit refuses one, which other cases this minute may have spent part of
  const statuses: number[] = []
  while (statuses.at(-1) !== TOO_MANY && statuses.length <= CODE_LIMIT) statuses.push((await request.post(`${MOCK}/api/code/check`, { data: { code } })).status())
  expect(statuses.at(-1), `the limit refuses a check within ${CODE_LIMIT + 1}: ${statuses}`).toBe(TOO_MANY)
  let checks = 0
  page.on("request", (r) => { if (r.url().endsWith("/api/code/check")) checks++ })
  await page.goto("/#/code")
  await codeField(page).fill(code)
  const count = page.locator(".code-entry .verdict.bad [aria-hidden=true]")
  await expect(count).toHaveText(/^Too many checks just now\. Your code may be fine\. Checking again in \d+ seconds\.$/)
  const find = onStep(page).getByRole("button", { name: "Find a name" })
  await expect(find).toBeDisabled()
  const left = async () => Number((await count.textContent())!.match(/(\d+) seconds?/)![1])
  const first = await left()
  await expect.poll(left, "the wait counts down").toBeLessThan(first)
  await expect(page.locator(".code-entry .verdict.ok")).toHaveText(/^This code allows you to register a free name of 6 or more letters/, { timeout: (first + 5) * 1000 })
  await expect(find).toBeEnabled()
  expect(checks, "the refused check and the one after the wait").toBe(2)
})

test("Your names reads a revoked code as not valid, and has a codes section only once it has codes", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6, state: "revoked" }) as { code: string }
  await page.goto("/#/names")
  await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
  await expect(onStep(page).getByRole("heading", { name: "Codes" })).toHaveCount(0)
  await expect(onStep(page).getByRole("link", { name: "Add a name code" })).toBeVisible()
  await page.goto("/")
  await page.evaluate((c) => localStorage.setItem(`simplex-names:code:${c}`, JSON.stringify({ code: c, minLength: 6, years: 2, addedAt: new Date().toISOString() })), code)
  await page.goto("/#/names")
  await expect(page.locator(".list-row", { hasText: code }).locator(".chip")).toHaveText("Not valid")
  await expect(onStep(page).getByRole("heading", { name: "Codes" })).toBeVisible()
})

test("a name code whose order fails on the network to be read gives focus back to its button", async ({ page }) => {
  const label = uniqueLabel("rfocus")
  const { ownerCode } = await startOrder(page, label, { method: "btc" })
  await page.goto("/#/code")
  await codeField(page).fill(ownerCode)
  await expect(page.locator(".code-entry .verdict")).toHaveText(`Name code of ${label}.simplex. Adding it shows the name in Your names, where you can edit its links.`)
  await page.route("**/api/invoice/*", (route) => route.abort())
  const add = page.getByRole("button", { name: "Add to Your names" })
  await add.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("The service could not be asked now")).toBeVisible()
  await expect(add).toBeFocused()
})

const NAME_CODE = "SN-GE65A-H60EF-815JQ-DT70X-DH67M-Q7M9J"
// the narrowest phone width at which a name code still fits the restore field whole beside its Check button, its letters at
// the legible floor or larger: 38 monospace characters of 14 px, the button, the field's padding and the page's gutters
const FITS_FROM_PX = 430
const NARROWEST_PX = 320
// the smallest letters a phone's code field draws; a code wider than its field at this size scrolls in it
const LEGIBLE_PX = 14

// A phone's own scrollbars lie over the page; Chromium draws them so only when it is told it is a phone.
async function codeFieldAt(browser: Browser, browserName: string, width: number) {
  const phone = width < 1000
  const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: phone && browserName === "chromium", hasTouch: phone })
  // a phone with a camera, whose field holds the scan button too; this container's WebKit aborts on a real device query
  await context.addInitScript(() => Object.defineProperty(navigator, "mediaDevices", { value: { enumerateDevices: async () => [{ kind: "videoinput" }] } }))
  const page = await context.newPage()
  await page.goto("/#/code")
  if (phone) await expect(page.getByRole("button", { name: "Scan QR code" }), "the scan button beside the code").toBeVisible()
  await codeField(page).fill(NAME_CODE)
  // a name code is judged by its orders, which this one has none of
  await expect(page.locator(".verdict.bad")).toContainText("No order was found")
  // Firefox reads a size set in container units as if the field had no container until its first layout, so the field is read after a frame
  const field = await codeField(page).evaluate(async (n: HTMLInputElement) => {
    await new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn)))
    return { overflow: n.scrollWidth - n.clientWidth, font: parseFloat(getComputedStyle(n).fontSize) }
  })
  await context.close()
  return field
}

test("a name code, the longest code, shows whole in Check your code's field on a laptop", async ({ browser, browserName }) => {
  const field = await codeFieldAt(browser, browserName, 1280)
  expect(field.overflow, "the code's width past the field").toBeLessThanOrEqual(0)
  expect(field.font, "the code's letter size").toBeGreaterThanOrEqual(LEGIBLE_PX)
})

for (const width of [FITS_FROM_PX, 390, NARROWEST_PX]) {
  test(`at ${width} px the code field keeps its letters at ${LEGIBLE_PX} px or larger, a field too narrow for a name code scrolling it`, async ({ browser, browserName }) => {
    const field = await codeFieldAt(browser, browserName, width)
    if (width >= FITS_FROM_PX) expect(field.overflow, "the code's width past the field").toBeLessThanOrEqual(0)
    expect(field.font, "the code's letter size").toBeGreaterThanOrEqual(LEGIBLE_PX)
    if (field.overflow > 0) expect(field.font, "the letter size of a code its field scrolls").toBe(LEGIBLE_PX)
  })
}

test("Check your code opened again shows a prepaid code typed there, never a name code", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  await search(page, uniqueLabel("keepnot"))
  await toCodeStep(page)
  const ownerCode = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)!).ownerCode as string, CHECKOUT_KEY)
  const header = page.locator("body > header")
  const reopen = async () => {
    await header.getByRole("link", { name: "Your names" }).click()
    await expect(onStep(page).getByRole("heading", { name: "Your names" })).toBeVisible()
    await header.getByRole("link", { name: "Check your code" }).click()
    await expect(onStep(page).getByRole("heading", { name: "Check your code" })).toBeVisible()
  }
  await header.getByRole("link", { name: "Check your code" }).click()
  await codeField(page).fill(ownerCode)
  await expect(page.locator(".verdict.bad")).toContainText("No order was found")
  await reopen()
  await expect(codeField(page), "the name code typed is not shown again").toHaveValue("")
  // nor most of one: mistyped in its check, or cut short past a prepaid code's length
  for (const [what, text] of [["mistyped", ownerCode.slice(0, -1) + (ownerCode.endsWith("0") ? "1" : "0")], ["cut short", ownerCode.slice(0, 30)]]) {
    await codeField(page).fill(text)
    await reopen()
    await expect(codeField(page), `a name code ${what}`).toHaveValue("")
  }
  await codeField(page).fill(code)
  await expect(page.locator(".verdict.ok")).toBeVisible()
  await reopen()
  await expect(codeField(page), "the prepaid code typed is shown again").toHaveValue(code)
})

test("Check your code says nothing of a code being typed, and refuses one too short once Enter is pressed or focus leaves", async ({ page }) => {
  await page.goto("/#/code")
  const verdict = page.locator(".verdict")
  await codeField(page).fill("SN-HELLO-WORLD")
  await expect(verdict).toBeEmpty()
  await codeField(page).press("Enter")
  await expect(page.locator(".verdict.bad")).toHaveText("This is not a SimpleX names code. Check it and try again.")
  await expect(page.locator(".verdict.bad"), "a verdict reads at the body's size").toHaveCSS("font-size", "16px")
  await shot(page, "N7c-check-unfinished")
  await codeField(page).press("End")
  await codeField(page).press("Backspace")
  await expect(verdict, "typing again clears the refusal").toBeEmpty()
  await codeField(page).blur()
  await expect(page.locator(".verdict.bad")).toHaveText("This is not a SimpleX names code. Check it and try again.")
  await expect(onStep(page).getByRole("button", { name: "Find a name" })).toBeDisabled()
})

test("a view whose sponsor nonce could not be read is read again after 5 then 15 seconds, without holding, and then signed", async ({ page, request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const label = uniqueLabel("unread")
  const reads: { at: number; held: boolean; unread: string[] }[] = []
  page.on("response", async (r) => {
    const url = new URL(r.url())
    if (!/^\/api\/registration\/[^/]+$/.test(url.pathname) || r.request().method() !== "GET") return
    const view = await r.json().catch(() => null) as { unread: string[] } | null
    if (view) reads.push({ at: Date.now(), held: url.searchParams.has("seenVersion"), unread: view.unread })
  })
  // the service's reads of the sponsor's nonce fail for a while from the commit on
  await control(request, "search", { unreadSeconds: 12 })
  try {
    await payWithCode(page, label, code)
    await waitRegistered(page, label)
  } finally {
    await control(request, "search", { unreadSeconds: 0 })
  }
  const first = reads.findIndex((r) => r.unread.includes("intentNonce"))
  expect(first, "a view answered with the nonce unread").toBeGreaterThanOrEqual(0)
  const [again, third] = [reads[first + 1], reads[first + 2]]
  expect(again.held, "read again without holding on the version").toBe(false)
  expect(again.at - reads[first].at).toBeGreaterThanOrEqual(4500)
  if (again.unread.length) expect(third.at - again.at).toBeGreaterThanOrEqual(14500)
})

const CODE_QR = "QR code of the name code"
// the least room between the name code's QR and the invest note under the page
const QR_ABOVE_INVEST = 16

// where the name's page draws its heading block and each part of its content but the QR, the QR, and the invest note
const registeredPlaces = (page: Page) => page.evaluate(() => {
  const place = (n: Element | null) => {
    const b = n?.getBoundingClientRect()
    return b ? { top: Math.round(b.top + scrollY), bottom: Math.round(b.bottom + scrollY) } : null
  }
  const parts = [...document.querySelectorAll("body > main > section :is(.screen-head > *, .screen-body > :not(.code-qr), .actions-row)")].map(place)
  return { parts, code: place(document.querySelector("body > main .code-display")), qr: place(document.querySelector("body > main .code-qr svg")),
    invest: place(document.querySelector("body > .invest p")) }
})

for (const length of [6, MAX_LABEL_LENGTH]) {
  test(`a name's page shows its code's QR only while the code is shown, under it, nothing above moving, and Your names with the code, for a name of ${length} wide letters`, async ({ page }) => {
    const label = "w".repeat(length)
    const { registrationId, ownerCode } = await fakeRegisteredName(page, label, { contact: "", channel: "" })
    await page.goto(`/?registration=${registrationId}`)
    const step = onStep(page)
    await expect(step.getByRole("heading", { name: `${label}.simplex is yours` })).toBeVisible()
    const qr = step.getByRole("img", { name: CODE_QR })
    for (const size of FIT_SIZES) {
      const where = `${size.width}x${size.height}`
      await page.setViewportSize(size)
      await expect(page.locator("body > main svg.qr"), `${where}: no QR while the code is hidden`).toHaveCount(0)
      const hidden = await registeredPlaces(page)
      await step.getByRole("button", { name: "Show" }).click()
      await expect(qr, where).toBeVisible()
      expect(await qrText(qr), `${where}: the QR holds the code as it is typed`).toBe(ownerCode)
      const shown = await registeredPlaces(page)
      expect(shown.parts, `${where}: nothing above the QR moved`).toEqual(hidden.parts)
      expect(shown.qr!.top, `${where}: the QR under the code`).toBeGreaterThan(shown.code!.bottom)
      expect(shown.invest!.top - shown.qr!.bottom, `${where}: the room between the QR and the invest note`).toBeGreaterThanOrEqual(QR_ABOVE_INVEST)
      expect(await offCentre(qr), `${where}: the QR centred`).toBeLessThanOrEqual(1)
      await step.getByRole("button", { name: "Hide" }).click()
      await expect(page.locator("body > main svg.qr"), `${where}: the QR gone with the code`).toHaveCount(0)
      expect(await registeredPlaces(page), `${where}: the page as before Show`).toEqual(hidden)
    }
    await page.setViewportSize(FIT_SIZES[0])
    await page.goto("/#/names")
    const row = page.locator(".list-row", { hasText: `${label}.simplex` })
    await expect(row.getByRole("img", { name: CODE_QR }), "Your names: no QR while the code is folded").toHaveCount(0)
    await row.getByRole("button", { name: "Name code" }).click()
    expect(await qrText(row.getByRole("img", { name: CODE_QR })), "Your names: the QR holds the code").toBe(ownerCode)
    await row.getByRole("button", { name: "Name code" }).click()
    await expect(row.locator("svg.qr"), "Your names: the QR gone with the code").toHaveCount(0)
  })
}
