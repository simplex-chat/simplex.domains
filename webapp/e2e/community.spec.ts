// Community names and the terms every signature for a name waits for (contract section 1, Terms and community names).
// The first cases need no /control endpoint, so they run against the service too, which has words of its own for bakers,
// a name dev/deploy.ts lists.
import { createHash } from "node:crypto"
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import {
  ACCEPT, acceptCommunityTerms, AGREE, agreeToTerms, COMMUNITY_HEADING, contactLink, control, failedOrder, MOCK, onStep, payButton, previewsShown, REGISTRATION_MS, registrationOf, restoreOrder, savedToReview, search, sevenLetters,
  SAVED, startOrder, takenOrder, test, toCodeStep, toReview, uniqueLabel, waitRegistered, withStripeKey, acceptedOnChain, COMMUNITY_TERMS, COMMUNITY_TERMS_HASH, PLAIN_TERMS,
} from "./helpers.ts"
import { keccak256, toHex } from "viem"
import { labelHash } from "../src/crypto/registration.ts"
import { hex } from "../src/crypto/wallet.ts"
import { RETRY_MS } from "../src/screens/order.ts"

const COMMUNITY_LABEL = "bakers"
// the community name dev/deploy.ts registered under the terms, with links
const TAKEN_COMMUNITY = "bakehouse"
const ACCEPT_WORDS = "I accept the community terms and will use this name for its community."
const PLAIN_WORDS = "I agree to SimpleX general terms and do not knowingly violate any trademarks."
const TERMS_CHANGED = "The terms changed. Agree to them again."
// what the popup says of every community name after what the name is for
const POPUP_END = "Its owner agrees to use it for this community, not as the name of one person or business."
// what the tests put a name on the list for
const LISTED_FOR = "test bakers"
const MARKER = "Community name: about it"
const SLOW_READ_MS = 1500
// the longest name, of letters as wide as most
const longLabel = () => `${uniqueLabel("cm")}${"m".repeat(63)}`.slice(0, 63)

// The community terms' link and text the service fetches by the chain's link, whose text the page draws from its Markdown.
const termsOnChain = async (page: Page) => (await page.request.get(`/api/terms/${COMMUNITY_TERMS_HASH}`)).json() as Promise<{ link: string; text: string }>
const headingOf = (text: string) => text.split("\n")[0].replace(/^# /, "")

// The name policy's terms of a kind changed to the link of this text while `f` runs, then back to the deployed ones.
async function withTerms<T>(request: APIRequestContext, kind: "general-terms" | "community-terms", text: string, f: (hash: string) => Promise<T>): Promise<T> {
  const { hash } = await control(request, kind, { text }) as { hash: string }
  try {
    return await f(hash)
  } finally {
    await control(request, kind, { text: null })
  }
}
const withGeneralTerms = <T>(request: APIRequestContext, text: string, f: (hash: string) => Promise<T>) => withTerms(request, "general-terms", text, f)
const withCommunityTerms = <T>(request: APIRequestContext, text: string, f: (hash: string) => Promise<T>) => withTerms(request, "community-terms", text, f)

// The names on the chain's community list, with the ini's words, while `f` runs.
async function listed<T>(request: APIRequestContext, labels: string[], f: () => Promise<T>): Promise<T> {
  for (const label of labels) await control(request, "community", { label, for: LISTED_FOR })
  try {
    return await f()
  } finally {
    for (const label of labels) await control(request, "community", { label, for: null })
  }
}

// A listed name's order, not yet paid, while the name policy's community terms change for `f`.
async function orderBeforeTermsChange(page: Page, request: APIRequestContext, prefix: string, f: (label: string, invoiceId: string, hash: string) => Promise<void>): Promise<void> {
  const label = uniqueLabel(prefix)
  await listed(request, [label], async () => {
    const { invoiceId } = await startOrder(page, label)
    await withCommunityTerms(request, `the community terms, changed for ${label}`, (hash) => f(label, invoiceId, hash))
  })
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

test("a community name's order shows its community terms on their own step before Check your order, Continue waiting for their tick, and its ⓘ says what the name is for", async ({ page }) => {
  await search(page, COMMUNITY_LABEL)
  await toCodeStep(page)
  await onStep(page).getByText(SAVED).click()
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await expect(onStep(page).getByRole("heading", { name: COMMUNITY_HEADING })).toBeVisible()
  const text = onStep(page).locator(".terms-text")
  const onChain = await termsOnChain(page)
  expect(keccak256(toHex(onChain.link)), "the service answers the text of the link whose hash the order signs").toBe(COMMUNITY_TERMS_HASH)
  await expect(text.locator("h3"), "the terms' heading drawn as one").toHaveText(headingOf(onChain.text))
  await expect(text.locator("li"), "their list drawn as one").toHaveCount(onChain.text.split("\n").filter((l) => l.startsWith("- ")).length)
  await expect(text, "no Markdown left in the words").not.toContainText("#")
  await expect(onStep(page).getByRole("link", { name: /^View at commit/ }), "a file on this machine is at no commit").toHaveCount(0)
  const terms = onStep(page).locator(".check.terms")
  await expect(terms).toHaveText(ACCEPT_WORDS)
  await expect(onStep(page).getByRole("button", { name: "Continue" })).toBeDisabled()
  const info = terms.getByRole("button", { name: "Which community this name is for" })
  await info.click()
  const popup = page.getByRole("dialog", { name: `${COMMUNITY_LABEL}.simplex` })
  await expect(popup.locator("p")).toContainText(POPUP_END)
  await popup.getByRole("button", { name: "Close" }).click()
  await expect(info).toBeFocused()
  await expect(onStep(page).getByRole("checkbox", { name: ACCEPT }), "the ⓘ inside the box's words does not tick it").not.toBeChecked()
  await acceptCommunityTerms(page)
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
  await expect(onStep(page).locator(".order .name").getByRole("button", { name: MARKER })).toBeVisible()
  await expect(onStep(page).locator(".check.terms"), "the community terms include the general terms, accepted once").toHaveCount(0)
  await expect(payButton(page)).toBeEnabled()
  await onStep(page).getByRole("link", { name: "Back" }).click()
  await expect(onStep(page).getByRole("heading", { name: COMMUNITY_HEADING })).toBeVisible()
  await expect(onStep(page).getByRole("checkbox", { name: ACCEPT }), "the step gone back to keeps its tick").toBeChecked()
})

test("community terms at a commit of git.simplex.chat link that commit's page under their text", async ({ page }) => {
  const text = "# Community terms\n\n- Use the name for its community.\n"
  const digest = createHash("sha256").update(text).digest("hex")
  const commit = "4cb24444a1f2e3d4c5b6a7980716253443526170"
  const path = `simplex-chat/simplex-chat/raw/commit/${commit}/docs/community-terms.md`
  const link = `https://git.simplex.chat/${path}#sha256=${digest}`
  const hash = keccak256(toHex(link))
  await page.route("**/api/name/*", async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    await route.fulfill({ response, json: json.status === "available" ? { ...json, terms: { hash, link } } : json })
  })
  await page.route(`**/api/terms/${hash}`, (route) => route.fulfill({ json: { link, text } }))
  await search(page, COMMUNITY_LABEL)
  await toCodeStep(page)
  await onStep(page).getByText(SAVED).click()
  await onStep(page).getByRole("button", { name: "Continue" }).click()
  await expect(onStep(page).getByRole("heading", { name: COMMUNITY_HEADING })).toBeVisible()
  await expect(onStep(page).locator(".terms-text h3")).toHaveText("Community terms")
  await expect(onStep(page).getByRole("link", { name: `View at commit ${commit.slice(0, 7)}` }))
    .toHaveAttribute("href", `https://git.simplex.chat/${path.replace("/raw/commit/", "/src/commit/")}`)
})

test("an order refused for terms changed meanwhile unticks the box and says so in place, the box and Pay staying put, and signs the new terms once ticked", async ({ page, request }) => {
  const label = uniqueLabel("ct")
  await search(page, label)
  await toReview(page)
  await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
  const parts = [".card.order", ".check.terms .box", ".actions-row .btn"]
  const before = await places(page, parts)
  await withGeneralTerms(request, `the general terms, changed for ${label}`, async (hash) => {
    await payButton(page).click()
    const notice = onStep(page).locator(".line", { hasText: TERMS_CHANGED })
    await expect(notice).toBeVisible()
    await expect(notice, "the notice takes the focus of Pay, which waits again").toBeFocused()
    await expect(onStep(page).getByRole("checkbox", { name: AGREE })).not.toBeChecked()
    await expect(payButton(page)).toBeDisabled()
    expect(await places(page, parts), "with the notice").toEqual(before)
    await expect(onStep(page).getByRole("link", { name: "SimpleX general terms" }), "the box links the changed terms")
      .toHaveAttribute("href", ((await (await page.request.get(`/api/terms/${hash}`)).json()) as { link: string }).link.split("#")[0])
    await agreeToTerms(page)
    await expect(notice).toHaveCount(0)
    expect(await places(page, parts), "ticked again").toEqual(before)
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    const invoiceId = new URL(page.url()).searchParams.get("order")!
    expect((await invoiceViewOf(request, invoiceId)).terms).toBe(hash.slice(2))
  })
})

test("a name whose terms can't be read now can't be ordered: its search says so, and an order sent meanwhile is refused with nothing charged", async ({ page, request }) => {
  const label = uniqueLabel("cu")
  await search(page, label)
  await toReview(page)
  const missing = "0".repeat(64)
  await control(request, "general-terms", { link: `http://127.0.0.1:8098/terms/${missing}.md#sha256=${missing}` })
  try {
    await payButton(page).click()
    await expect(onStep(page).getByRole("heading", { name: "Names can't be ordered right now" })).toBeVisible()
    await expect(onStep(page).getByText("Nothing was charged.", { exact: false })).toBeVisible()
    await search(page, uniqueLabel("cu"))
    await expect(onStep(page).locator(".answer .line", { hasText: "Names can't be ordered right now. Try again later." })).toBeVisible()
    await expect(onStep(page).getByRole("button", { name: "Register" })).toBeDisabled()
  } finally {
    await control(request, "general-terms", { text: null })
  }
  const { registrations } = await (await request.get(`${MOCK}/control/state`)).json() as { registrations: { labelHash: string }[] }
  expect(registrations.some((r) => r.labelHash === hex(labelHash(label))), "no order made").toBe(false)
})

test("a name put on the list meanwhile is refused for the community terms, which their step then asks for, the review showing its marker, and Your names marks the name", async ({ page, request }) => {
  const label = uniqueLabel("cl")
  await search(page, label)
  await toReview(page)
  await listed(request, [label], async () => {
    await payButton(page).click()
    await expect(onStep(page).getByRole("heading", { name: COMMUNITY_HEADING })).toBeVisible()
    await expect(onStep(page).getByText(TERMS_CHANGED)).toBeVisible()
    await acceptCommunityTerms(page)
    await expect(onStep(page).locator(".check.terms"), "the community terms include the general terms").toHaveCount(0)
    await expect(onStep(page).locator(".order .name").getByRole("button", { name: MARKER })).toBeVisible()
    await payButton(page).click()
    await page.waitForURL(/\?order=/)
    const view = await invoiceViewOf(request, new URL(page.url()).searchParams.get("order")!)
    expect([view.terms, view.community]).toEqual([COMMUNITY_TERMS, { for: LISTED_FOR, years: 2 }])
    await page.goto("/#/names")
    const marker = page.locator(".list-row", { hasText: `${label}.simplex` }).getByRole("button", { name: MARKER })
    await marker.click()
    await expect(page.getByRole("dialog").locator("p")).toHaveText(`This name is for ${LISTED_FOR}. ${POPUP_END}`)
  })
})

test("a failed order moved through the search to another name asks for that name's terms first, a community name's own box in place of the general terms' one, whose words open the terms, and signs them anew after they changed", async ({ page, request }) => {
  const { registrationId } = await failedOrder(page, request, uniqueLabel("cm"))
  const target = uniqueLabel("cmt")
  await listed(request, [target], async () => {
    await page.goto(`/#/?retarget=${registrationId}`)
    await page.getByLabel("Name", { exact: true }).fill(target)
    await page.getByLabel("Name", { exact: true }).press("Enter")
    const move = page.getByRole("button", { name: "Register with your payment" })
    await expect(page.locator(".answer .check.terms")).toHaveText([ACCEPT_WORDS])
    await page.locator(".answer .check.terms").getByRole("button", { name: "community terms" }).click()
    const popup = page.getByRole("dialog", { name: "Community terms" })
    await expect(popup.locator(".terms-text h3"), "the terms of the hash the move signs").toHaveText(headingOf((await termsOnChain(page)).text))
    await popup.getByRole("button", { name: "Close" }).click()
    await expect(page.getByRole("checkbox", { name: ACCEPT }), "the words' button does not tick the box").not.toBeChecked()
    await expect(page.locator(".answer .row .name").getByRole("button", { name: MARKER })).toBeVisible()
    await expect(move, "a move waits for the tick").toBeDisabled()
    const parts = [".answer .row", ".answer .check.terms .box"]
    const before = await places(page, parts)
    await withCommunityTerms(request, `the community terms, changed for the move to ${target}`, async (hash) => {
      await agreeToTerms(page)
      await move.click()
      await expect(page.getByText(TERMS_CHANGED)).toBeVisible()
      await expect(move).toBeDisabled()
      expect(await places(page, parts), "with the notice under the box").toEqual(before)
      await agreeToTerms(page)
      await move.click()
      await page.waitForURL(/\?order=/)
      await expect.poll(async () => (await viewOf(request, registrationId)).terms, { timeout: REGISTRATION_MS }).toBe(`community/${hash.slice(2)}`)
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
  expect((await invoiceViewOf(request, second)).terms).toBe(PLAIN_TERMS)
  await other.close()

  await control(request, `expire/${second}`)
  await page.goto(`/?order=${second}`)
  await expect(onStep(page).getByRole("heading", { name: "Invoice closed" })).toBeVisible()
  const again = onStep(page).getByRole("button", { name: "Get a new invoice" })
  const parts = [".notice", ".ref", ".actions-row .btn"]
  const before = await places(page, parts)
  await withGeneralTerms(request, `the general terms, changed for ${label}`, async (hash) => {
    await again.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await expect(onStep(page).getByRole("checkbox", { name: AGREE }), "the box takes focus as it comes").toBeFocused()
    await expect(again).toBeDisabled()
    expect(await places(page, parts), "with the box").toEqual(before)
    await agreeToTerms(page)
    await again.click()
    await page.waitForURL((url) => url.searchParams.get("order") !== second)
    const third = new URL(page.url()).searchParams.get("order")!
    expect((await invoiceViewOf(request, third)).terms).toBe(hash.slice(2))
  })
})

test("a card form that did not load asks for changed terms before cancelling its invoice, which stays open until the buyer agrees", async ({ page, request }) => {
  const { invoiceId } = await startOrder(page, uniqueLabel("cc"), { method: "card" })
  await withStripeKey(page)
  await page.route("https://js.stripe.com/**", (route) => route.abort())
  await page.reload()
  await expect(page.getByText("Stripe's form was blocked or failed to load. Nothing was charged.")).toBeVisible()
  const again = onStep(page).getByRole("button", { name: "Get a new invoice" })
  await withGeneralTerms(request, "the general terms, changed for a card order", async (hash) => {
    await again.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await expect(again).toBeDisabled()
    expect((await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json()).status, "nothing cancelled before the tick").toBe("open")
    await agreeToTerms(page)
    await again.click()
    await page.waitForURL((url) => url.searchParams.get("order") !== invoiceId)
    expect((await (await request.get(`${MOCK}/api/invoice/${invoiceId}`)).json()).status).toBe("expired")
    expect((await invoiceViewOf(request, new URL(page.url()).searchParams.get("order")!)).terms).toBe(hash.slice(2))
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
  await withGeneralTerms(request, `the general terms, changed for ${dearer}`, async (hash) => {
    await again.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await agreeToTerms(page)
    await again.click()
    await page.waitForURL((url) => url.searchParams.get("order") !== first)
    const second = new URL(page.url()).searchParams.get("order")!
    expect(await invoiceViewOf(request, second)).toMatchObject({ terms: hash.slice(2), fromBalance: 10000 })
    await control(request, `expire/${second}`)
    await control(request, `refund/${taken.invoiceId}`)
    await control(request, "general-terms", { text: `the general terms, changed again for ${dearer}` })
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
  await withGeneralTerms(request, `the general terms, changed for ${label}`, async (hash) => {
    await move.click()
    await expect(onStep(page).locator(".check.terms")).toHaveText(PLAIN_WORDS)
    await expect(move).toBeDisabled()
    await agreeToTerms(page)
    await move.click()
    await waitRegistered(page, label)
    const view = await viewOf(request, await registrationOf(request, invoiceId))
    expect(view.terms).toBe(hash.slice(2))
    expect((await acceptedOnChain(view.registerTx as string))?.termsHash, "the register recorded the new general terms").toBe(hash)
  })
})

test("community terms changed on chain between the order and its reveal are agreed to again on the order's page before it signs, and the name registers under them", async ({ page, request }) => {
  let reveals = 0
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/reveal")) reveals++ })
  await orderBeforeTermsChange(page, request, "cv", async (label, invoiceId, hash) => {
    await control(request, `settle/${invoiceId}`)
    const notice = onStep(page).locator(".line", { hasText: TERMS_CHANGED })
    await expect(notice).toBeVisible({ timeout: REGISTRATION_MS })
    await expect(notice, "the notice takes the focus from the page").toBeFocused()
    await expect(onStep(page).locator(".check.terms")).toHaveText([ACCEPT_WORDS])
    await expect(onStep(page).getByRole("checkbox", { name: ACCEPT })).not.toBeChecked()
    // past the wait after which the reveal would have gone, nothing is signed before the tick
    const { revealAfter } = await invoiceViewOf(request, invoiceId) as { revealAfter: number }
    await page.waitForTimeout(Math.max(0, revealAfter * 1000 - Date.now()) + 3000)
    expect([(await invoiceViewOf(request, invoiceId)).label, reveals]).toEqual([null, 0])
    await expect(onStep(page).getByText("The registration is not signed yet.")).toBeVisible()
    await agreeToTerms(page)
    await waitRegistered(page, label)
    const view = await invoiceViewOf(request, invoiceId)
    expect(view.terms, "the order keeps the terms it signed").toBe(COMMUNITY_TERMS)
    expect((await acceptedOnChain(view.registerTx as string))?.termsHash, "the register recorded the new terms").toBe(hash)
  })
})

test("changed community terms whose searches fail for now are asked for once a search is made again after a pause", async ({ page, request }) => {
  await orderBeforeTermsChange(page, request, "cs", async (_, invoiceId) => {
    // the pay page checks the name too, so only the searches once the order is committed fail, and past the tick at
    // revealAfter, so that only a search made again after a pause can bring the notice
    let failing = true
    let failed = 0
    await page.route("**/api/name/*", async (route) => {
      if (!failing || (await invoiceViewOf(request, invoiceId)).phase !== "committed") return route.fallback()
      failed++
      await route.fulfill({ status: 503, json: { error: "provider_unavailable" } })
    })
    await control(request, `settle/${invoiceId}`)
    await expect.poll(async () => (await invoiceViewOf(request, invoiceId)).phase, { timeout: REGISTRATION_MS }).toBe("committed")
    const { revealAfter } = await invoiceViewOf(request, invoiceId) as { revealAfter: number }
    await page.waitForTimeout(Math.max(0, revealAfter * 1000 - Date.now()) + 1000)
    failing = false
    await expect(onStep(page).locator(".line", { hasText: TERMS_CHANGED })).toBeVisible({ timeout: 2 * RETRY_MS })
    expect(failed).toBeGreaterThan(1)
  })
})

test("changed community terms that a search answers otherwise than the view are asked for once the view is read again", async ({ page, request }) => {
  await orderBeforeTermsChange(page, request, "cr", async (_, invoiceId) => {
    // the first search once the order is committed answers yet other terms, as if they changed again after the view
    let answered = false
    await page.route("**/api/name/*", async (route) => {
      if (answered || (await invoiceViewOf(request, invoiceId)).phase !== "committed") return route.fallback()
      const response = await route.fetch()
      const json = await response.json()
      const link = `http://127.0.0.1:8098/terms/${"d8".repeat(32)}.md#sha256=${"d8".repeat(32)}`
      json.terms = { hash: keccak256(toHex(link)), link }
      answered = true
      await route.fulfill({ response, json })
    })
    let reads = 0
    page.on("request", (r) => { if (answered && r.url().endsWith(`/api/invoice/${invoiceId}`)) reads++ })
    await control(request, `settle/${invoiceId}`)
    await expect(onStep(page).locator(".line", { hasText: TERMS_CHANGED })).toBeVisible({ timeout: REGISTRATION_MS })
    expect([answered, reads > 0], "the view is read again after that search").toEqual([true, true])
  })
})

test("changed community terms of a name reserved meanwhile are not asked for: the page says the order cannot register it, and searches no more", async ({ page, request }) => {
  await orderBeforeTermsChange(page, request, "cz", async (_, invoiceId) => {
    let searches = 0
    await page.route("**/api/name/*", async (route) => {
      if ((await invoiceViewOf(request, invoiceId)).phase !== "committed") return route.fallback()
      searches++
      await route.fulfill({ json: { status: "reserved", community: null } })
    })
    await control(request, `settle/${invoiceId}`)
    await expect(onStep(page).locator(".notice", { hasText: "The name was reserved meanwhile" })).toContainText("This order can't register it.", { timeout: REGISTRATION_MS })
    await expect(onStep(page).locator(".screen-head .lead"), "no lead asks to keep the page open for the name").toHaveCount(0)
    await page.waitForTimeout(3 * RETRY_MS)
    expect(searches, "one search, not one after each pause").toBe(1)
    await expect(onStep(page).getByText(TERMS_CHANGED)).toHaveCount(0)
  })
})

test("community terms changed after the reveal, before its relay, are agreed to again and the name registers under them", async ({ page, request }) => {
  const label = uniqueLabel("cx")
  await listed(request, [label], async () => {
    const { invoiceId } = await startOrder(page, label)
    try {
      await control(request, `settle/${invoiceId}`)
      await expect.poll(async () => (await invoiceViewOf(request, invoiceId)).phase, { timeout: REGISTRATION_MS }).toBe("committed")
      // the relay is held back while the reveal is stored and the terms change, then refused for the old terms
      await control(request, "search", { unsentSeconds: REGISTRATION_MS / 1000 })
      await expect.poll(async () => (await invoiceViewOf(request, invoiceId)).label, { timeout: REGISTRATION_MS }).toBe(label)
      await withCommunityTerms(request, `the community terms, changed after the reveal of ${label}`, async (hash) => {
        await control(request, "search", { unsentSeconds: 0 })
        await expect(onStep(page).locator(".line", { hasText: TERMS_CHANGED })).toBeVisible({ timeout: REGISTRATION_MS })
        await agreeToTerms(page)
        await waitRegistered(page, label)
        expect((await acceptedOnChain((await invoiceViewOf(request, invoiceId)).registerTx as string))?.termsHash).toBe(hash)
      })
    } finally {
      await control(request, "search", { unsentSeconds: 0 })
    }
  })
})

test("a taken community name's chats say so in their popup", async ({ page }) => {
  // a registered name cannot be listed, so dev/deploy.ts registers bakehouse with links under the terms
  await search(page, TAKEN_COMMUNITY)
  const row = onStep(page).locator(".answer .row")
  await expect(row.getByRole("button", { name: MARKER })).toBeVisible()
  await row.locator(".chat").first().click()
  await expect(page.getByRole("dialog").locator(".soft").first()).toHaveText(/^[@#]bakehouse\.simplex · Community name$/)
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
  await listed(request, [long], async () => {
    for (const label of [COMMUNITY_LABEL, long, TAKEN_COMMUNITY]) {
      await search(page, label)
      await expectMarkerPlaces(page, label === TAKEN_COMMUNITY ? "taken row" : "search row", label, onStep(page).locator(".answer .row .name"))
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
