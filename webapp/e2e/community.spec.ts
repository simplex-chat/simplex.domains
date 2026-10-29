// Community names and the terms every signature for a name waits for (contract section 1, Terms and community names).
// The first cases need no /control endpoint, so they run against the service too, which lists bakers with words of its own.
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import {
  AGREE, agreeToTerms, contactLink, control, failedOrder, MOCK, onStep, payButton, previewsShown, REGISTRATION_MS, registrationOf, restoreOrder, savedToReview, search, sevenLetters,
  startOrder, takenOrder, test, toReview, uniqueLabel, waitRegistered, withStripeKey,
} from "./helpers.ts"

const COMMUNITY_LABEL = "bakers"
const TERMS_VERSION = "2026-10-23"
const NEWER_VERSION = "2026-11-01"
const COMMUNITY_WORDS = "I agree to SimpleX name terms and will use this name for its community."
const PLAIN_WORDS = "I agree to SimpleX name terms and do not knowingly violate any trademarks."
const TERMS_CHANGED = "The terms changed. Agree to them again."
// what the popup says of every community name after what the name is for
const POPUP_END = "Its owner agrees to use it for this community, not as the name of one person or business."
// what the tests put a name on the list for
const LISTED_FOR = "test bakers"
const MARKER = "Community name: about it"
const SLOW_READ_MS = 1500
// the longest name, of letters as wide as most
const longLabel = () => `${uniqueLabel("cm")}${"m".repeat(63)}`.slice(0, 63)

// The service's terms at another version while `f` runs, as after a restart with a new terms_version.
async function atVersion<T>(request: APIRequestContext, version: string, f: () => Promise<T>): Promise<T> {
  await control(request, "terms", { version })
  try {
    return await f()
  } finally {
    await control(request, "terms", { version: TERMS_VERSION })
  }
}

// The names on the community list while `f` runs, as after an edit of the service's ini and a restart.
async function listed<T>(request: APIRequestContext, labels: string[], f: () => Promise<T>): Promise<T> {
  for (const label of labels) await control(request, "community", { label, for: LISTED_FOR })
  try {
    return await f()
  } finally {
    for (const label of labels) await control(request, "community", { label, for: null })
  }
}

const viewOf = async (request: APIRequestContext, registrationId: string) => (await request.get(`${MOCK}/api/registration/${registrationId}`)).json() as Promise<Record<string, unknown>>
const invoiceViewOf = async (request: APIRequestContext, invoiceId: string) => (await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as { registration: Record<string, unknown> }).registration

// Where a community name's marker stands: its baseline against the name's, its gap after the name's TLD, its gap to the
// right of the name's box, and its icon's middle against its word's, in pixels.
const markerPlace = (name: Locator) => name.evaluate((n) => {
  const tld = n.querySelector(".tld")!
  const mark = n.querySelector(".cmark")!
  // Boxes of no size on the baselines of the name's last line and of the marker, read together in one task. The line's is
  // put after the name's last letters, as one in the TLD can move the name's breaks in WebKit. The marker's takes back the
  // flex gap it adds, so a name that fits its row exactly does not wrap under the probe.
  const baselines = () => {
    const probes = [n.querySelector(".nowrap")!, mark].map((el) => {
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline"
      return el.appendChild(probe)
    })
    probes[1].style.marginLeft = `-${getComputedStyle(mark).columnGap}`
    const [line, marker] = probes.map((p) => p.getBoundingClientRect().bottom)
    for (const p of probes) p.remove()
    return line - marker
  }
  const word = document.createRange()
  word.selectNodeContents(mark.firstChild!)
  const [t, m, box, icon, w] = [tld.getBoundingClientRect(), mark.getBoundingClientRect(), n.getBoundingClientRect(), mark.querySelector("svg")!.getBoundingClientRect(), word.getBoundingClientRect()]
  const tenth = (x: number) => Math.round(x * 10) / 10
  return { baseline: tenth(baselines()), gap: tenth(m.left - t.right), right: tenth(box.right - m.right),
    icon: tenth((icon.top + icon.bottom) / 2 - (w.top + w.bottom) / 2), fontSize: parseFloat(getComputedStyle(n).fontSize) }
})

// the left and top of each part, to the tenth of a pixel
const places = (page: Page, selectors: string[]) => page.evaluate((all) => all.map((s) => {
  const box = document.querySelector(`body > main ${s}`)!.getBoundingClientRect()
  return `${s} ${Math.round(box.left * 10) / 10} ${Math.round(box.top * 10) / 10}`
}), selectors)

const DESKTOP_GAP = 16
const DESKTOP_SIZE = 22
const PHONE_SIZE = 19
// layout rounds to device pixels, which a measure across two boxes can be off by
const PIXEL = 1

test("a community name shows its marker after the name, a button whose popup says what the name is for", async ({ page }) => {
  await search(page, COMMUNITY_LABEL)
  const name = onStep(page).locator(".answer .row .name")
  const marker = name.getByRole("button", { name: MARKER })
  await expect(marker).toHaveText("Community")
  await marker.click()
  const popup = page.getByRole("dialog", { name: `${COMMUNITY_LABEL}.simplex` })
  await expect(popup.locator(".soft")).toHaveText("Community name")
  const words = await popup.locator("p").textContent()
  expect(words?.startsWith("This name is for "), words ?? "").toBe(true)
  expect(words?.endsWith(`. ${POPUP_END}`), words ?? "").toBe(true)
  await popup.getByRole("button", { name: "Close" }).click()
  await expect(marker).toBeFocused()
  await expect(marker, "a pointer over the marker").toHaveCSS("cursor", "pointer")
  await marker.hover()
  await expect(marker, "no underline under the pointer").toHaveCSS("text-decoration-line", "none")
  await search(page, uniqueLabel("cn"))
  await expect(onStep(page).getByRole("button", { name: "Register" })).toBeEnabled()
  await expect(onStep(page).getByRole("button", { name: MARKER }), "a name not on the list").toHaveCount(0)
})

test("Check your order of a community name asks for the community wording, its terms linked and its ⓘ saying what the name is for, and Pay waits for the tick", async ({ page }) => {
  await search(page, COMMUNITY_LABEL)
  await toReview(page, false)
  await expect(onStep(page).locator(".order .name").getByRole("button", { name: MARKER })).toBeVisible()
  const terms = onStep(page).locator(".check.terms")
  await expect(terms).toHaveText(COMMUNITY_WORDS)
  await expect(terms.getByRole("link", { name: "SimpleX name terms" })).toHaveAttribute("href", /^https:\/\//)
  await expect(payButton(page)).toBeDisabled()
  const info = terms.getByRole("button", { name: "Which community this name is for" })
  await info.click()
  const popup = page.getByRole("dialog", { name: `${COMMUNITY_LABEL}.simplex` })
  await expect(popup.locator("p")).toContainText(POPUP_END)
  await popup.getByRole("button", { name: "Close" }).click()
  await expect(info).toBeFocused()
  await expect(onStep(page).getByRole("checkbox", { name: AGREE }), "the ⓘ inside the box's words does not tick it").not.toBeChecked()
  await agreeToTerms(page)
  await expect(payButton(page)).toBeEnabled()
})

test("an order refused for terms changed meanwhile unticks the box and says so in place, the box and Pay staying put, and signs the new terms once ticked", async ({ page, request }) => {
  const label = uniqueLabel("ct")
  await search(page, label)
  await toReview(page)
  await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
  const parts = [".card.order", ".check.terms .box", ".actions-row .btn"]
  const before = await places(page, parts)
  await atVersion(request, NEWER_VERSION, async () => {
    await payButton(page).click()
    const notice = onStep(page).locator(".line", { hasText: TERMS_CHANGED })
    await expect(notice).toBeVisible()
    await expect(notice, "the notice takes the focus of Pay, which waits again").toBeFocused()
    await expect(onStep(page).getByRole("checkbox", { name: AGREE })).not.toBeChecked()
    await expect(payButton(page)).toBeDisabled()
    expect(await places(page, parts), "with the notice").toEqual(before)
    await agreeToTerms(page)
    await expect(notice).toHaveCount(0)
    expect(await places(page, parts), "ticked again").toEqual(before)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    const invoiceId = new URL(page.url()).searchParams.get("order")!
    expect((await invoiceViewOf(request, invoiceId)).terms).toBe(NEWER_VERSION)
  })
})

test("a name put on the list meanwhile is refused for the community wording, which the review then asks for under its marker, and Your names marks the name", async ({ page, request }) => {
  const label = uniqueLabel("cl")
  await search(page, label)
  await toReview(page)
  await listed(request, [label], async () => {
    await payButton(page).click()
    await expect(onStep(page).getByText(TERMS_CHANGED)).toBeVisible()
    await expect(onStep(page).locator(".check.terms")).toHaveText(COMMUNITY_WORDS)
    await expect(onStep(page).locator(".order .name").getByRole("button", { name: MARKER })).toBeVisible()
    await agreeToTerms(page)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    const view = await invoiceViewOf(request, new URL(page.url()).searchParams.get("order")!)
    expect([view.terms, view.community]).toEqual([`${TERMS_VERSION}/community`, { for: LISTED_FOR }])
    await page.goto("/#/names")
    const marker = page.locator(".list-row", { hasText: `${label}.simplex` }).getByRole("button", { name: MARKER })
    await marker.click()
    await expect(page.getByRole("dialog").locator("p")).toHaveText(`This name is for ${LISTED_FOR}. ${POPUP_END}`)
  })
})

test("a failed order moved through the search to another name asks for that name's terms first, in the community wording for a community name, and signs them anew after they changed", async ({ page, request }) => {
  const { registrationId } = await failedOrder(page, request, uniqueLabel("cm"))
  const target = uniqueLabel("cmt")
  await listed(request, [target], async () => {
    await page.goto(`/#/?retarget=${registrationId}`)
    await page.getByLabel("Name", { exact: true }).fill(target)
    await page.getByLabel("Name", { exact: true }).press("Enter")
    const move = page.getByRole("button", { name: "Register with your payment" })
    await expect(page.locator(".answer .check.terms")).toHaveText(COMMUNITY_WORDS)
    await expect(page.locator(".answer .row .name").getByRole("button", { name: MARKER })).toBeVisible()
    await expect(move, "a move waits for the tick").toBeDisabled()
    const parts = [".answer .row", ".answer .check.terms .box"]
    const before = await places(page, parts)
    await atVersion(request, NEWER_VERSION, async () => {
      await agreeToTerms(page)
      await move.click()
      await expect(page.getByText(TERMS_CHANGED)).toBeVisible()
      await expect(move).toBeDisabled()
      expect(await places(page, parts), "with the notice under the box").toEqual(before)
      await agreeToTerms(page)
      await move.click()
      await page.waitForURL(/\?order=/)
      await expect.poll(async () => (await viewOf(request, registrationId)).terms, { timeout: REGISTRATION_MS }).toBe(`${NEWER_VERSION}/community`)
    })
  })
})

test("a new invoice for the same name signs the order's own terms without asking while they are the name's, also restored elsewhere, and asks first once they changed", async ({ page, browser, request }) => {
  const label = uniqueLabel("ci")
  const { invoiceId, ownerCode } = await startOrder(page, label)
  await control(request, `expire/${invoiceId}`)
  // another browser, holding the name code alone, takes the order's terms from its view
  const other = await browser.newContext()
  const away = await other.newPage()
  await restoreOrder(away, ownerCode, label)
  await expect(onStep(away).getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  await onStep(away).getByRole("button", { name: "Get a new invoice" }).click()
  await away.waitForURL((url) => (url.searchParams.get("order") ?? invoiceId) !== invoiceId)
  await expect(onStep(away).locator(".check.terms"), "nothing asked at the same version").toHaveCount(0)
  const second = new URL(away.url()).searchParams.get("order")!
  expect((await invoiceViewOf(request, second)).terms).toBe(TERMS_VERSION)
  await other.close()

  await control(request, `expire/${second}`)
  await page.goto(`/?order=${second}`)
  await expect(onStep(page).getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  const again = onStep(page).getByRole("button", { name: "Get a new invoice" })
  const parts = [".notice", ".ref", ".actions-row .btn"]
  const before = await places(page, parts)
  await atVersion(request, NEWER_VERSION, async () => {
    await again.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await expect(onStep(page).getByRole("checkbox", { name: AGREE }), "the box takes focus as it comes").toBeFocused()
    await expect(again).toBeDisabled()
    expect(await places(page, parts), "with the box").toEqual(before)
    await agreeToTerms(page)
    await again.click()
    await page.waitForURL((url) => url.searchParams.get("order") !== second)
    const third = new URL(page.url()).searchParams.get("order")!
    expect((await invoiceViewOf(request, third)).terms).toBe(NEWER_VERSION)
  })
})

test("a card form that did not load asks for changed terms before cancelling its invoice, which stays open until the buyer agrees", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("cc"), { method: "card" })
  await withStripeKey(page)
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.reload()
  await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
  const again = onStep(page).getByRole("button", { name: "Get a new invoice" })
  await atVersion(request, NEWER_VERSION, async () => {
    await again.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await expect(again).toBeDisabled()
    expect((await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json()).status, "nothing cancelled before the tick").toBe("open")
    await agreeToTerms(page)
    await again.click()
    await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
    expect((await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json()).status).toBe("expired")
    expect((await invoiceViewOf(request, new URL(page.url()).searchParams.get("order")!)).terms).toBe(NEWER_VERSION)
  })
})

test("a new invoice paid partly from a balance asks for changed terms before spending it again, and asks nothing when the balance is gone and the search opens", async ({ page, request }) => {
  const taken = await takenOrder(page, request, uniqueLabel("cb"))
  await onStep(page).getByRole("button", { name: "Choose another name" }).click()
  const dearer = sevenLetters()
  await search(page, dearer)
  await toReview(page)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const first = new URL(page.url()).searchParams.get("order")!
  await control(request, `expire/${first}`)
  const again = onStep(page).getByRole("button", { name: "Get a new invoice" })
  await atVersion(request, NEWER_VERSION, async () => {
    await again.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await agreeToTerms(page)
    await again.click()
    await page.waitForURL((url) => url.searchParams.get("order") !== first)
    const second = new URL(page.url()).searchParams.get("order")!
    expect(await invoiceViewOf(request, second)).toMatchObject({ terms: NEWER_VERSION, fromBalance: 10000 })
    await control(request, `expire/${second}`)
    await control(request, `refund/${taken.invoiceId}`)
    await control(request, "terms", { version: "2026-12-01" })
    // asking would keep the page; the search opening at once shows it asked nothing
    await onStep(page).getByRole("button", { name: "Get a new invoice" }).click()
    await page.waitForURL((url) => url.hash.includes(`name=${dearer}`))
  })
})

test("Your names draws a community name's row with its marker on the name's last line, its popup saying what the name is for", async ({ page, context, request }) => {
  const long = longLabel()
  await listed(request, [long], async () => {
    await startOrder(page, long)
    for (const [width, height] of SIZES) {
      const fresh = await context.newPage()
      await fresh.addInitScript(() => localStorage.removeItem("simplex-names-seen"))
      await fresh.setViewportSize({ width, height })
      // the order's read takes a while, so a row drawn before it would be pressed first
      await fresh.route("**/api/invoice/*", async (route) => {
        await new Promise((wait) => setTimeout(wait, SLOW_READ_MS))
        await route.continue()
      })
      await fresh.goto("/#/names")
      const name = fresh.locator(".list-row .name.comm", { hasText: `${long.slice(-3)}.simplex` })
      await name.getByRole("button", { name: MARKER }).click()
      await expect(fresh.getByRole("dialog").locator("p")).toHaveText(`This name is for ${LISTED_FOR}. ${POPUP_END}`)
      await fresh.getByRole("dialog").getByRole("button", { name: "Close" }).click()
      expect(Math.abs((await markerPlace(name)).baseline), `the marker on the name's last line at ${width} px`).toBeLessThanOrEqual(PIXEL)
      await fresh.close()
    }
  })
})

test("Register without links asks for the terms once they changed, and the order registers under the new ones", async ({ page, request }) => {
  const label = uniqueLabel("cw")
  await search(page, label)
  await onStep(page).getByRole("button", { name: "Register" }).click()
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("CW"))
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
  const move = onStep(page).getByRole("button", { name: "Register without links" })
  await atVersion(request, NEWER_VERSION, async () => {
    await move.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await expect(move).toBeDisabled()
    await agreeToTerms(page)
    await move.click()
    await waitRegistered(page, label)
    expect((await viewOf(request, await registrationOf(request, invoiceId))).terms).toBe(NEWER_VERSION)
  })
})

test("a taken community name's chats say so in their popup", async ({ page, request }) => {
  // bakery is registered with links from the start
  await listed(request, ["bakery"], async () => {
    await search(page, "bakery")
    const row = onStep(page).locator(".answer .row")
    await expect(row.getByRole("button", { name: MARKER })).toBeVisible()
    await row.locator(".chat").first().click()
    await expect(page.getByRole("dialog").locator(".soft").first()).toHaveText(/^[@#]bakery\.simplex · Community name$/)
  })
})

// The marker on the name's baseline with its icon centred on its word: 16 px after the name on a desktop; on a phone at
// the right end of the name's last line, at the size of other names; in light and dark, for a short and a 63-letter name.
const SIZES = [[1280, 900], [390, 844]] as const

async function expectMarkerPlaces(page: Page, surface: string, label: string, name: Locator, fontSize = true): Promise<void> {
  await expect(name.getByRole("button", { name: MARKER })).toBeVisible()
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => document.fonts.ready)
    for (const dark of [false, true]) {
      await page.evaluate((d) => document.documentElement.classList.toggle("dark", d), dark)
      const place = await markerPlace(name)
      const at = `${surface}, ${label.length} letters, ${width} px${dark ? ", dark" : ""}`
      console.log(`${at}: ${JSON.stringify(place)}`)
      expect(Math.abs(place.baseline), `on the name's baseline, ${at}`).toBeLessThanOrEqual(PIXEL)
      expect(Math.abs(place.icon), `the icon centred on its word, ${at}`).toBeLessThanOrEqual(PIXEL)
      if (width < SIZES[0][0]) expect(Math.abs(place.right), `at the right of the name's last line, ${at}`).toBeLessThanOrEqual(PIXEL)
      else expect(Math.abs(place.gap - DESKTOP_GAP), `16 px after the name, ${at}`).toBeLessThanOrEqual(PIXEL)
      if (fontSize) expect(place.fontSize, at).toBe(width < SIZES[0][0] ? PHONE_SIZE : DESKTOP_SIZE)
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"))
  }
}

test("the marker stands where the mockup draws it in the search's rows, available and taken", async ({ page, request }) => {
  const long = longLabel()
  await listed(request, [long, "bakery"], async () => {
    for (const label of [COMMUNITY_LABEL, long, "bakery"]) {
      await search(page, label)
      await expectMarkerPlaces(page, label === "bakery" ? "taken row" : "search row", label, onStep(page).locator(".answer .row .name"))
    }
  })
})

test("the marker stands where the mockup draws it on Check your order", async ({ page, request }) => {
  const long = longLabel()
  await listed(request, [long], async () => {
    for (const label of [COMMUNITY_LABEL, long]) {
      await search(page, label)
      await toReview(page, false)
      // the order's name is drawn smaller on a phone's review that holds a line under the order
      await expectMarkerPlaces(page, "review", label, onStep(page).locator(".order .row .name"), false)
    }
  })
})

test("the marker stands where the mockup draws it in Your names", async ({ page, request }) => {
  test.setTimeout(2 * 180_000)
  const long = longLabel()
  await listed(request, [long], async () => {
    for (const label of [COMMUNITY_LABEL, long]) await startOrder(page, label)
    await page.goto("/#/names")
    for (const label of [COMMUNITY_LABEL, long]) {
      await expectMarkerPlaces(page, "Your names", label, page.locator(".list-row .name.comm", { hasText: `${label.slice(-3)}.simplex` }))
    }
  })
})
