import { chromium, expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { keccak256, toHex } from "viem"
import { labelHash, YEAR_S } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import { newOwnerCode, walletOf } from "../src/flow.ts"
import {
  addNameCode, agreeToTerms, answersReserved, CHAIN, channelLink, CHECKOUT_KEY, checkoutOwnerCode, CODE_HEADING, codeField, COMMUNITY_HEADING, contactLink, contractsOwnerLists, control, fillLinks,
  keepOrder, type KeptOrder, LINKS_HEADING, MOCK, mockRegistration, newClient, onStep, ownerSetsResolver, payButton, previewsShown, REGISTRATION_MS, registrationOf, registrationView, SAVED,
  savedToReview, search, searchName, shownCode, startOrder, takenOrder, test, toCodeStep, toFullReview, toReview, useCode, waitRegistered, withStripeKey,
} from "./helpers.ts"

const START_S = Date.UTC(2026, 10, 2, 8) / 1000
const STEP_S = 300
const SIZES = [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const
const FAILED = "The name could not be registered"
const LAPSED = "The name was not signed in time"
const TERMS_TEXT = "The general terms, changed for the screens"
const FLAT_BACKGROUND = fileURLToPath(new URL("screens.css", import.meta.url))

interface Reach { page: Page; request: APIRequestContext; browser: Browser; baseURL: string; id: string; now: number }

function seedPageRandom(seed: string): void {
  let state = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261) || 1
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    const bytes = array ? new Uint8Array(array.buffer, array.byteOffset, array.byteLength) : new Uint8Array()
    for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 0xff
    return array
  }
}

async function serviceFailureTexts(target: Page | BrowserContext): Promise<void> {
  await target.route(/\/api\/(invoice|registration)\/[^/?]+(\?.*)?$/, async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback()
    try {
      const res = await route.fetch()
      const json = await res.json()
      const view = json.registration ?? json
      if (view?.phase === "failed" && view.error !== LAPSED) view.error = FAILED
      await route.fulfill({ response: res, json })
    } catch {
      await route.abort().catch(() => undefined)
    }
  })
}

const countdowns = (page: Page): Locator[] =>
  [page.locator("body > main .time"), page.locator("body > main .countdown b"), page.locator('body > main .sr-only + [aria-hidden="true"] > span'), page.locator("video")]

type Size = typeof SIZES[number][0]

interface ScreenOptions {
  sizes?: Size[]
  before?: Size
  covers?: string[]
  timeout?: number
}

function screen(slot: number, id: string, reach: (r: Reach) => Promise<Page | void>, { sizes = ["desktop", "phone"], before, timeout }: ScreenOptions = {}): void {
  test(id, async ({ page, request, browser, baseURL }) => {
    if (timeout) test.setTimeout(timeout)
    const now = START_S + slot * STEP_S
    await control(request, "clock", { now })
    await control(request, "seed", { seed: id })
    seedPageRandom(`${id} test`)
    await page.clock.install({ time: now * 1000 })
    await page.addInitScript(seedPageRandom, id)
    await serviceFailureTexts(page)
    if (before) await page.setViewportSize(SIZES.find(([size]) => size === before)![1])
    const shown = await reach({ page, request, browser, baseURL: baseURL!, id, now }) ?? page
    await expect.poll(() => shown.evaluate(async () => {
      await Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined)))
      return [...document.fonts].filter((f) => !f.family.includes("fallback") && f.status !== "loaded").map((f) => `${f.family} ${f.weight}`)
    }), { message: "the page's fonts" }).toEqual([])
    await shown.mouse.move(0, 0)
    for (const [size, viewport] of SIZES.filter(([size]) => sizes.includes(size))) {
      await shown.setViewportSize(viewport)
      await expect.soft(shown).toHaveScreenshot(`${id}-${size}.png`, { fullPage: true, mask: countdowns(shown), stylePath: FLAT_BACKGROUND })
    }
  })
}

const launched: Browser[] = []
const opened: BrowserContext[] = []

test.afterEach(async ({ page, request }) => {
  for (const context of [page.context(), ...opened.splice(0)]) {
    for (const each of context.pages()) await each.unrouteAll({ behavior: "ignoreErrors" })
    await context.unrouteAll({ behavior: "ignoreErrors" })
    if (context !== page.context()) await context.close()
  }
  await Promise.all(launched.splice(0).map((browser) => browser.close()))
  await control(request, "search", { chainDown: false, limitSeconds: 0, findLimitSeconds: 0, invoiceError: null, unsentSeconds: 0, unreadSeconds: 0, refuseLinks: false, fetchDelays: {} })
  await control(request, "mode", { mode: "open" })
  await control(request, "general-terms", { text: null })
  await control(request, "seed", { seed: null })
})

async function elsewhere({ browser, id, now }: Reach, url: string): Promise<Page> {
  const context = await browser.newContext()
  opened.push(context)
  await context.clock.install({ time: now * 1000 })
  await context.addInitScript(seedPageRandom, `${id} elsewhere`)
  await serviceFailureTexts(context)
  const page = await context.newPage()
  await page.goto(url)
  return page
}

async function cameraPage({ baseURL, id, now }: Reach, grant: boolean): Promise<Page> {
  const browser = await chromium.launch({ channel: "chromium", args: ["--use-fake-device-for-media-stream"] })
  launched.push(browser)
  const context = await browser.newContext({
    baseURL, viewport: SIZES[1][1], hasTouch: true, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US", extraHTTPHeaders: newClient(),
  })
  opened.push(context)
  if (grant) await context.grantPermissions(["camera"])
  await context.clock.install({ time: now * 1000 })
  await context.addInitScript(seedPageRandom, `${id} camera`)
  await serviceFailureTexts(context)
  return context.newPage()
}

const clockAt = (r: Reach, seconds: number) => control(r.request, "clock", { now: r.now + seconds })
const label = (id: string) => id
const shown = (page: Page, text: string | RegExp) => expect(onStep(page).getByText(text).first()).toBeVisible({ timeout: REGISTRATION_MS })
const heading = (page: Page, name: string | RegExp) => expect(onStep(page).getByRole("heading", { name })).toBeVisible({ timeout: REGISTRATION_MS })
const press = (page: Page, name: string | RegExp) => onStep(page).getByRole("button", { name }).first().click()
const chooseMethod = (page: Page, name: "Card" | "Bitcoin" | "Monero") => page.getByRole("radio", { name }).click()
const answer = (route: Route, status: number, error: string, retryAfter?: number) =>
  route.fulfill({ status, json: { error }, headers: retryAfter ? { "retry-after": String(retryAfter) } : {} })
const posting = (path: RegExp, f: (route: Route) => Promise<unknown> | unknown) => async (route: Route) =>
  route.request().method() === "POST" && path.test(new URL(route.request().url()).pathname) ? f(route) : route.fallback()

async function paid(r: Reach, name: string): Promise<{ invoiceId: string; registrationId: string }> {
  const { invoiceId } = await startOrder(r.page, name, { method: "btc" })
  return { invoiceId, registrationId: await registrationOf(r.request, invoiceId) }
}

async function failed(r: Reach, name: string): Promise<{ invoiceId: string; registrationId: string }> {
  const order = await paid(r, name)
  await control(r.request, `fail/${order.registrationId}`)
  await control(r.request, `settle/${order.invoiceId}`)
  await heading(r.page, "Paid, not registered")
  return order
}

async function committedUnsigned(r: Reach, name: string): Promise<{ invoiceId: string; registrationId: string }> {
  const order = await paid(r, name)
  await r.page.route("**/api/registration/*/reveal", (route) => route.abort())
  await control(r.request, `settle/${order.invoiceId}`)
  await expect.poll(async () => (await mockRegistration(r.request, order.invoiceId)).phase, { timeout: REGISTRATION_MS }).toBe("committed")
  return order
}

async function lapsedOrder(r: Reach, name: string): Promise<{ invoiceId: string; registrationId: string }> {
  const order = await committedUnsigned(r, name)
  await control(r.request, `lapse/${order.registrationId}`)
  await shown(r.page, LAPSED)
  return order
}

async function codeOrder(r: Reach, name: string, link: string | null = null): Promise<{ code: string; registrationId: string }> {
  const { code } = await control(r.request, "code", { minLength: 6 }) as { code: string }
  await useCode(r.page, code)
  await search(r.page, name)
  if (link) {
    await press(r.page, "Register")
    await onStep(r.page).getByRole("textbox", { name: "Link", exact: true }).fill(link)
    await previewsShown(r.page)
    await press(r.page, "Continue")
    await savedToReview(r.page)
  } else await toReview(r.page)
  await press(r.page, "Register with your code")
  await r.page.waitForURL(/\?registration=/)
  return { code, registrationId: new URL(r.page.url()).searchParams.get("registration")! }
}

async function codeFailed(r: Reach, name: string): Promise<{ code: string; registrationId: string }> {
  await control(r.request, "search", { unsentSeconds: 30 })
  const order = await codeOrder(r, name)
  await control(r.request, `fail/${order.registrationId}`)
  await control(r.request, "search", { unsentSeconds: 0 })
  await heading(r.page, "Not registered")
  return order
}

async function withLink(r: Reach, name: string, kind: "contact" | "channel"): Promise<string> {
  await search(r.page, name)
  await press(r.page, "Register")
  await onStep(r.page).getByRole("textbox", { name: "Link", exact: true }).fill(kind === "contact" ? contactLink("LR") : channelLink("LR"))
  await previewsShown(r.page)
  await press(r.page, "Continue")
  await savedToReview(r.page)
  await payButton(r.page).click()
  await r.page.waitForURL(/\?order=/)
  return new URL(r.page.url()).searchParams.get("order")!
}

async function linksRefused(r: Reach, name: string, kind: "contact" | "channel" = "contact"): Promise<{ invoiceId: string; registrationId: string }> {
  const invoiceId = await withLink(r, name, kind)
  await control(r.request, "search", { refuseLinks: true })
  await control(r.request, `settle/${invoiceId}`)
  await shown(r.page, "The service refused this order's links")
  return { invoiceId, registrationId: await registrationOf(r.request, invoiceId) }
}

async function kept(r: Reach, registrationId: string, invoiceId: string | null, name: string, links = { contact: "", channel: "" }): Promise<KeptOrder> {
  const order = await keepOrder(r.page, registrationId, invoiceId, name, links)
  await r.page.evaluate(([key, at]) => {
    const record = JSON.parse(localStorage.getItem(key)!)
    localStorage.setItem(key, JSON.stringify({ ...record, createdAt: at }))
  }, [`simplex-names:order:${registrationId}`, new Date(r.now * 1000).toISOString()] as const)
  return order
}

const registeredAnswer = (order: KeptOrder, expiresAt: number | null, extra: Record<string, unknown> = {}) => ({
  status: "registered", entities: [], owner: order.owner, resolver: CHAIN.resolver, chainId: CHAIN.chainId, records: { contact: "", channel: "" }, recordsNonce: 0,
  recordEdits: { left: 3, nextAt: null }, expiresAt, tld: "simplex", community: null, ...extra,
})

const configUnread = (target: Page | BrowserContext) => target.route("**/api/config", (route) => route.fulfill({ status: 500, json: { error: "internal" } }))

// --- home

screen(100, "home-unchecked-config", async ({ page }) => {
  await configUnread(page)
  await search(page, "home-unchecked-config")
  await expect(page.locator(".answer > *").first()).toBeVisible()
})

screen(102, "home-own-paid-order", async (r) => {
  const { invoiceId } = await paid(r, label(r.id))
  await control(r.request, "search", { unsentSeconds: 120 })
  await control(r.request, `settle/${invoiceId}`)
  await search(r.page, label(r.id))
  await shown(r.page, "You already have an order for this name.")
})

screen(104, "home-own-order-registering", async (r) => {
  await paid(r, label(r.id))
  await r.page.route(`**/api/name/${hex(labelHash(label(r.id)))}*`, (route) => route.fulfill({ json: { status: "registered", entities: [], tld: "simplex", community: null } }))
  await search(r.page, label(r.id))
  await shown(r.page, "Being registered")
})

screen(106, "home-own-order-failed", async (r) => {
  await failed(r, label(r.id))
  await search(r.page, label(r.id))
  await expect(onStep(r.page).locator(".answer .card.row")).toBeVisible()
})

screen(108, "home-other-order-holds", async (r) => {
  await failed(r, label(r.id))
  const other = await elsewhere(r, "/")
  await search(other, label(r.id))
  await expect(onStep(other).locator(".answer .card.row")).toBeVisible()
  return other
})

screen(110, "home-other-order-registering", async ({ page, id }) => {
  await page.route(`**/api/name/${hex(labelHash(id))}*`, (route) => route.fulfill({ json: { status: "registered", entities: [], tld: "simplex", community: null } }))
  await search(page, id)
  await shown(page, "Being registered")
})

screen(112, "home-taken-unparseable-link", async ({ page }) => {
  await search(page, "bakery")
  await expect(onStep(page).locator(".answer .card.row")).toContainText("Taken")
})

screen(114, "home-taken-kind-mismatch", async ({ page, id }) => {
  const link = contactLink("KM")
  await page.route(`**/api/name/${hex(labelHash(id))}*`, (route) => route.fulfill({ json: {
    status: "registered", owner: "0x0000000000000000000000000000000000000001", resolver: CHAIN.resolver, chainId: CHAIN.chainId, expiresAt: START_S + 2 * YEAR_S, gracePeriod: 90 * 86400,
    tld: "simplex", community: null, records: null, recordsNonce: 0,
    entities: [{ type: "address", kind: "channel", displayName: "News", fullName: "", image: null, subscribers: 5, profile: "ok", link, deepLink: link }],
  } }))
  await search(page, id)
  await expect(page.locator(".answer > *").first()).toBeVisible()
})

screen(116, "home-retarget-failed-other-cause", async (r) => {
  const { registrationId } = await failed(r, label(r.id))
  await r.page.goto(`/#/?retarget=${registrationId}`)
  await expect(r.page.getByLabel("Name", { exact: true })).toBeVisible()
  await expect(onStep(r.page).locator(".notice").first()).toBeVisible()
})

screen(118, "home-retarget-moved", async (r) => {
  const { invoiceId } = await paid(r, label(r.id))
  await r.page.goto(`/#/?retarget=${await registrationOf(r.request, invoiceId)}`)
  await shown(r.page, "Your order already went to another name.")
})

screen(120, "home-retarget-moved-after-refusal", async (r) => {
  const { registrationId } = await failed(r, label(r.id))
  const retarget = `/#/?retarget=${registrationId}`
  await r.page.goto(retarget)
  await r.page.getByLabel("Name", { exact: true }).fill(`${r.id}-y`)
  await r.page.getByLabel("Name", { exact: true }).press("Enter")
  await agreeToTerms(r.page)
  const other = await r.page.context().newPage()
  await other.goto(retarget)
  await other.getByLabel("Name", { exact: true }).fill(`${r.id}-z`)
  await other.getByLabel("Name", { exact: true }).press("Enter")
  await agreeToTerms(other)
  await press(other, "Register with your payment")
  await other.waitForURL(/\?order=/)
  await other.close()
  await press(r.page, "Register with your payment")
  await shown(r.page, "Your order already went to another name.")
})

screen(122, "home-retarget-own-name", async (r) => {
  const { registrationId } = await failed(r, label(r.id))
  await r.page.goto(`/#/?retarget=${registrationId}`)
  await r.page.getByLabel("Name", { exact: true }).fill(label(r.id))
  await r.page.getByLabel("Name", { exact: true }).press("Enter")
  await expect(onStep(r.page).locator(".answer .card.row")).toBeVisible()
})

const nameField = (page: Page) => page.getByLabel("Name", { exact: true })
const searchHere = async (page: Page, name: string) => {
  await nameField(page).fill(name)
  await nameField(page).press("Enter")
}
const answerRow = (page: Page) => expect(page.locator(".answer .row").first()).toBeVisible()
const answerLine = (page: Page) => expect(page.locator(".answer > *").first()).toBeVisible()
const held = () => new Promise<void>(() => undefined)
const answerName = (page: Page, name: string, json: Record<string, unknown>) =>
  page.route(`**/api/name/${hex(labelHash(name))}*`, (route) => route.fulfill({ json }))
const UNREADABLE_TERMS = `http://127.0.0.1:8098/terms/${"0".repeat(64)}.md#sha256=${"0".repeat(64)}`
const OTHER_OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as const
const chat = (kind: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  type: kind === "channel" ? "channel" : "address", kind, displayName, fullName: "", image: null, subscribers: kind === "channel" ? 1 : null, profile: "ok",
  link: `https://smp8.simplex.im/${kind === "channel" ? "c" : "a"}#${kind}`, deepLink: `simplex:/${kind === "channel" ? "c" : "a"}#${kind}?h=smp8.simplex.im`, ...extra,
})
const BAKERY = [chat("contact", "Alice's Bakery", { fullName: "Sourdough and pastries, Lisbon" }),
  chat("channel", "Bakery news", { fullName: "Daily bakes and opening hours", subscribers: 1204, link: channelLink("BN"), deepLink: `simplex:/c#${channelLink("BN").split("#")[1]}?h=smp9.simplex.im` })]
const takenWith = (entities: unknown[]) => ({ status: "registered", entities, owner: OTHER_OWNER, tld: "simplex", community: null })
const seven = (id: string) => `s${([...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261) % 36 ** 6).toString(36).padStart(6, "0")}`
const freezeClock = async (page: Page) => page.clock.pauseAt(await page.evaluate(() => Date.now() + 1))

screen(124, "home-empty", async ({ page }) => {
  await page.goto("/")
  await expect(nameField(page)).toBeVisible()
})
screen(126, "home-searching", async ({ page, id }) => {
  await page.route("**/api/name/**", held)
  await search(page, id)
  await expect(page.getByRole("button", { name: "Search" })).toHaveAttribute("aria-busy", "true")
})
screen(128, "home-rule-short", async ({ page }) => {
  await search(page, "abc")
  await answerLine(page)
})
screen(130, "home-rule-long", async ({ page }) => {
  await search(page, "a".repeat(64))
  await answerLine(page)
})
screen(132, "home-rule-chars", async ({ page }) => {
  await search(page, "bad_name")
  await answerLine(page)
})
screen(134, "home-checking", async ({ page, request, id }) => {
  let asked = 0
  await page.route("**/api/name/**", (route) => asked++ === 0 ? route.fallback() : held())
  await page.goto("/")
  await control(request, "search", { limitSeconds: 1 })
  await searchHere(page, id)
  await expect(page.locator(".answer .line", { hasText: "Checking the name" })).toBeVisible({ timeout: 30_000 })
})
screen(136, "home-unchecked", async ({ page, request, id }) => {
  await control(request, "search", { chainDown: true })
  await search(page, id)
  await shown(page, "This name could not be checked.")
})
screen(138, "home-paused", async ({ page, request, id }) => {
  await control(request, "search", { limitSeconds: 30 })
  await search(page, id)
  await shown(page, "Searching is paused")
})
screen(140, "home-available", async ({ page, id }) => {
  await search(page, id)
  await answerRow(page)
})
screen(142, "home-available-community", async ({ page, request, id }) => {
  await control(request, "community", { label: id, for: "bakers and pastry chefs" })
  await search(page, id)
  await answerRow(page)
})
screen(144, "home-community-popup-for", async ({ page }) => {
  await search(page, "bakers")
  await page.locator(".answer").getByRole("button", { name: "Community name: about it" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
})
screen(146, "home-community-popup-plain", async ({ page }) => {
  await search(page, "bakehouse")
  await page.locator(".answer").getByRole("button", { name: "Community name: about it" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
})
const withCode = async (r: Reach, minLength: number, more: Record<string, unknown> = {}) => {
  const { code } = await control(r.request, "code", { minLength, ...more }) as { code: string }
  await useCode(r.page, code)
  return code
}
screen(148, "home-available-code-free", async (r) => {
  await withCode(r, 6)
  await searchHere(r.page, r.id)
  await answerRow(r.page)
})
screen(150, "home-available-code-short", async (r) => {
  await withCode(r, 30)
  await searchHere(r.page, r.id)
  await answerRow(r.page)
})
const balanceTo = async (r: Reach, taken: string, next: string) => {
  await takenOrder(r.page, r.request, taken)
  await press(r.page, "Choose another name")
  await searchHere(r.page, next)
  await answerRow(r.page)
}
screen(152, "home-available-balance-rest", (r) => balanceTo(r, "hbrest7", r.id))
screen(154, "home-available-balance-exact", (r) => balanceTo(r, `${r.id}-taken`, r.id))
screen(156, "home-available-balance-short", (r) => balanceTo(r, `${r.id}-taken`, "hbshrt7"))
const balanceHeld = async (r: Reach, taken: string): Promise<string> => {
  await takenOrder(r.page, r.request, taken)
  await press(r.page, "Choose another name")
  await expect(nameField(r.page)).toBeVisible()
  const other = await r.page.context().newPage()
  await other.goto("/#/names")
  await other.locator(".list-row", { hasText: taken }).getByRole("button", { name: "Use" }).click()
  await searchHere(other, seven(r.id))
  await toReview(other)
  await clockAt(r, 120)
  await payButton(other).click()
  await other.waitForURL(/\?order=/)
  const invoiceId = new URL(other.url()).searchParams.get("order")!
  await other.close()
  return invoiceId
}
screen(158, "home-available-balance-held-open", async (r) => {
  await balanceHeld(r, `${r.id}-taken`)
  await search(r.page, r.id)
  await shown(r.page, "Your balance is in use by another order")
})
screen(160, "home-available-balance-held-funded", async (r) => {
  const invoiceId = await balanceHeld(r, `${r.id}-taken`)
  await control(r.request, `confirming/${invoiceId}`)
  await search(r.page, r.id)
  await shown(r.page, "while its payment is being confirmed")
})
screen(162, "home-available-terms-unreadable", async ({ page, request, id }) => {
  await control(request, "general-terms", { link: UNREADABLE_TERMS })
  await search(page, id)
  await shown(page, "Names can't be ordered right now.")
})
screen(164, "home-own-unpaid-order", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await search(page, id)
  await shown(page, "You already have an order for this name.")
})
screen(166, "home-reserved", async ({ page }) => {
  await search(page, "support")
  await shown(page, "Reserved names are not sold here.")
})
screen(168, "home-taken-chats-read", async ({ page }) => {
  await answerName(page, "bakery", takenWith(BAKERY))
  await search(page, "bakery")
  await expect(page.locator(".answer").getByRole("button", { name: "Bakery news, channel" })).toBeVisible()
})
screen(170, "home-taken-chats-unread", async ({ page }) => {
  await search(page, "bakery")
  await expect(page.locator(".answer .row .chat").first()).toBeVisible()
})
screen(172, "home-taken-no-chats", async ({ page }) => {
  await search(page, "harbour")
  await answerRow(page)
})
screen(174, "home-taken-community", async ({ page }) => {
  await search(page, "bakehouse")
  await expect(page.locator(".answer .row .chat").first()).toBeVisible()
})
screen(176, "home-yours", async (r) => {
  const { invoiceId } = await paid(r, r.id)
  await control(r.request, `settle/${invoiceId}`)
  await waitRegistered(r.page, r.id)
  await search(r.page, r.id)
  await shown(r.page, "Your name")
})
const yoursExpired = async (r: Reach, daysAgo: number) => {
  const order = await kept(r, `reg-${r.id}`, null, r.id)
  await answerName(r.page, r.id, registeredAnswer(order, r.now - daysAgo * 86400, { gracePeriod: 30 * 86400 }))
  await r.page.goto(`/#/?name=${r.id}`)
  await shown(r.page, "Expired")
}
screen(178, "home-yours-expired", (r) => yoursExpired(r, 10))
screen(180, "home-yours-expired-again-taken", (r) => yoursExpired(r, 100))
const bakeryChat = async (page: Page, name: string) => {
  await answerName(page, "bakery", takenWith(BAKERY))
  await search(page, "bakery")
  await page.locator(".answer").getByRole("button", { name }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
}
screen(182, "home-chat-popup-channel", ({ page }) => bakeryChat(page, "Bakery news, channel"))
screen(184, "home-chat-popup-contact", ({ page }) => bakeryChat(page, "Alice's Bakery, contact address"))
screen(186, "home-chat-popup-unread", async ({ page }) => {
  await search(page, "bakery")
  await page.locator(".answer .row .chat").last().click()
  await expect(page.getByRole("dialog")).toBeVisible()
})
screen(188, "home-chat-popup-community", async ({ page }) => {
  await search(page, "bakehouse")
  await page.locator(".answer .row .chat").first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
})
screen(190, "home-chat-popup-copied", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await bakeryChat(page, "Bakery news, channel")
  await page.getByRole("dialog").getByRole("button", { name: "Copy link" }).click()
  await expect(page.getByRole("dialog").getByText("Copied!")).toBeVisible()
  await freezeClock(page)
})
screen(192, "home-chat-popup-unsafe-link", async ({ page }) => {
  await answerName(page, "bakery", takenWith([chat("contact", "Alice's Bakery", { link: "ftp://x", deepLink: null })]))
  await search(page, "bakery")
  await page.locator(".answer .row .chat").first().click()
  await expect(page.getByRole("dialog")).toBeVisible()
})
screen(194, "home-codes-only-locked", async ({ page, request }) => {
  await control(request, "mode", { mode: "codes" })
  await page.goto("/#/?name=bakery")
  await shown(page, "Names can be registered with an investor code for now.")
})
screen(196, "home-codes-only-uncovered", async (r) => {
  await control(r.request, "mode", { mode: "codes" })
  await withCode(r, 7)
  await searchHere(r.page, "abcdef")
  await answerLine(r.page)
})
screen(198, "home-codes-only-covered", async (r) => {
  await control(r.request, "mode", { mode: "codes" })
  await withCode(r, 7, { years: 2 })
  await searchHere(r.page, r.id)
  await answerRow(r.page)
})
screen(200, "home-header-code-chip", async (r) => { await withCode(r, 7) })
screen(202, "home-header-balance-chip", async (r) => {
  await takenOrder(r.page, r.request, r.id)
  await press(r.page, "Choose another name")
  await expect(nameField(r.page)).toBeVisible()
})
screen(204, "home-phone-menu", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Menu" }).click()
  await expect(page.getByRole("button", { name: "Close menu" })).toBeVisible()
}, { sizes: ["phone"], before: "phone" })
screen(206, "home-offline", async ({ page }) => {
  await page.goto("/")
  await expect(nameField(page)).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { get: () => false })
    dispatchEvent(new Event("offline"))
  })
  await expect(page.getByText("You are offline.")).toBeVisible()
})
screen(208, "home-trademarks", async ({ page }) => {
  await page.goto("/#/trademarks")
  await heading(page, "Trademark owners")
})
screen(210, "home-retarget-unknown", async ({ page }) => {
  await page.goto("/#/?retarget=reg-unknown")
  await expect(nameField(page)).toBeVisible()
})
const retargetPaid = async (r: Reach, name: string): Promise<string> => {
  const { registrationId } = await failed(r, name)
  await r.page.goto(`/#/?retarget=${registrationId}`)
  await shown(r.page, "Your payment is kept")
  return registrationId
}
screen(212, "home-retarget-paid-opening", async (r) => { await retargetPaid(r, r.id) })
const retargetCode = async (r: Reach): Promise<void> => {
  await withCode(r, 10)
  await searchHere(r.page, r.id)
  await press(r.page, "Register")
  await onStep(r.page).getByRole("textbox", { name: "Link", exact: true }).fill(contactLink("RC"))
  await previewsShown(r.page)
  await press(r.page, "Continue")
  await savedToReview(r.page)
  await control(r.request, "search", { refuseLinks: true })
  await press(r.page, "Register with your code")
  await shown(r.page, "The service refused this order's links")
  await control(r.request, "search", { refuseLinks: false })
  await press(r.page, "Choose another name")
  await shown(r.page, "Your code is kept.")
}
screen(214, "home-retarget-code-opening", (r) => retargetCode(r))
const retargetNoText = async (r: Reach) => {
  const order = await kept(r, `reg-${r.id}`, null, r.id)
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "failed", commitTx: "0x02", error: FAILED }) }))
  await r.page.goto(`/#/?retarget=reg-${r.id}`)
  await shown(r.page, "Your code is kept.")
}
screen(216, "home-retarget-code-opening-no-text", (r) => retargetNoText(r))
const retargetTo = async (r: Reach, from: string, to: string) => {
  await retargetPaid(r, from)
  await searchHere(r.page, to)
  await answerRow(r.page)
}
screen(218, "home-retarget-paid-cheaper", (r) => retargetTo(r, "hrchea7", r.id))
screen(220, "home-retarget-paid-same", (r) => retargetTo(r, `${r.id}-from`, r.id))
screen(222, "home-retarget-paid-dearer", (r) => retargetTo(r, r.id, "hrdear7"))
const retargetTicked = async (r: Reach) => {
  await retargetTo(r, seven(r.id), r.id)
  await agreeToTerms(r.page)
}
const MOVE = /\/api\/registration\/[^/]+\/name$/
const moveAnswer = (page: Page, f: (route: Route) => Promise<unknown>) => page.route("**/api/registration/*/name", posting(MOVE, f))
screen(224, "home-retarget-ticked", (r) => retargetTicked(r))
screen(226, "home-retarget-busy", async (r) => {
  await retargetTicked(r)
  await moveAnswer(r.page, held)
  await press(r.page, "Register with your payment")
  await expect(onStep(r.page).getByRole("button", { name: "Register with your payment" })).toHaveAttribute("aria-busy", "true")
})
const retargetCommunity = async (r: Reach) => {
  await control(r.request, "community", { label: r.id, for: "bakers and pastry chefs" })
  await retargetTo(r, `${r.id}-from`, r.id)
}
screen(228, "home-retarget-community", (r) => retargetCommunity(r))
screen(230, "home-retarget-community-terms-popup", async (r) => {
  await retargetCommunity(r)
  await press(r.page, "Names Conditions")
  await expect(r.page.getByRole("dialog").locator(".terms-text")).toBeVisible()
})
screen(232, "home-retarget-community-terms-unreadable-popup", async (r) => {
  await r.page.route("**/api/terms/**", (route) => answer(route, 503, "unavailable"))
  await retargetCommunity(r)
  await press(r.page, "Names Conditions")
  await expect(r.page.getByRole("dialog").getByText("can't be shown now")).toBeVisible()
})
screen(234, "home-retarget-code-covered", async (r) => {
  await retargetCode(r)
  await searchHere(r.page, `${r.id}-next`)
  await answerRow(r.page)
})
screen(236, "home-retarget-code-short", async (r) => {
  await retargetCode(r)
  await searchHere(r.page, "hrcsht7")
  await answerRow(r.page)
})
screen(238, "home-retarget-code-no-text-shorter", async (r) => {
  await retargetNoText(r)
  await searchHere(r.page, "hrnotext")
  await answerRow(r.page)
})
screen(240, "home-retarget-terms-changed", async (r) => {
  await retargetTicked(r)
  await control(r.request, "general-terms", { text: TERMS_TEXT })
  await press(r.page, "Register with your payment")
  await shown(r.page, "The Names Conditions changed.")
})
const moveRefusals: [number, string, number, string][] = [
  [242, "home-retarget-refused-taken", 409, "name_taken"],
  [244, "home-retarget-refused-dearer", 409, "price_too_high"],
  [248, "home-retarget-refused-unavailable", 503, "terms_unavailable"],
  [250, "home-retarget-refused-failed", 503, "provider_unavailable"],
  [252, "home-retarget-refused-limit", 409, "move_limit"],
  [254, "home-retarget-refused-code-used", 409, "code_used"],
  [256, "home-retarget-refused-code-reserved", 409, "code_reserved"],
  [258, "home-retarget-refused-code-expired", 409, "code_expired"],
  [260, "home-retarget-refused-code-revoked", 400, "code_invalid"],
]
for (const [slot, id, status, error] of moveRefusals) {
  screen(slot, id, async (r) => {
    await retargetTicked(r)
    await moveAnswer(r.page, (route) => answer(route, status, error))
    await press(r.page, "Register with your payment")
    await expect(onStep(r.page).locator(".notice").last()).toBeVisible()
  })
}
screen(261, "home-retarget-refused-uncovered", async (r) => {
  await retargetCode(r)
  await searchHere(r.page, `${r.id}-next`)
  await agreeToTerms(r.page)
  await moveAnswer(r.page, (route) => answer(route, 409, "code_not_covering"))
  await press(r.page, "Register with your code")
  await shown(r.page, "Your code does not pay for this name.")
})
screen(262, "home-retarget-refused-other-order", async (r) => {
  await retargetTicked(r)
  const hash = hex(labelHash(r.id))
  await r.page.route("**/api/registration/find", async (route) => {
    const res = await route.fetch()
    const json = await res.json() as { registrations: Record<string, unknown>[] }
    await route.fulfill({ response: res, json: { registrations: json.registrations.map((found) => ({ ...found, labelHash: hash })) } })
  })
  await moveAnswer(r.page, (route) => answer(route, 409, "order_exists"))
  await press(r.page, "Register with your payment")
  await expect(onStep(r.page).locator(".notice").last()).toBeVisible()
})
screen(264, "home-retarget-held", async (r) => {
  await retargetTicked(r)
  await moveAnswer(r.page, (route) => answer(route, 429, "rate_limited", 30))
  await press(r.page, "Register with your payment")
  await shown(r.page, "Too many attempts")
})
screen(266, "home-retarget-own-open-order", async (r) => {
  await startOrder(r.page, r.id, { method: "btc" })
  await retargetTo(r, `${r.id}-from`, r.id)
  await shown(r.page, "You already have an order for this name.")
})
screen(268, "home-retarget-terms-unreadable", async (r) => {
  await retargetPaid(r, `${r.id}-from`)
  await control(r.request, "general-terms", { link: UNREADABLE_TERMS })
  await searchHere(r.page, r.id)
  await shown(r.page, "Names can't be ordered right now.")
})

// --- checkout

const linkStep = async (page: Page, name: string, link: string) => {
  await search(page, name)
  await press(page, "Register")
  await onStep(page).getByRole("textbox", { name: "Link", exact: true }).fill(link)
  await page.waitForTimeout(800)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.waitForTimeout(800)
}

screen(1000, "checkout-links-simplex-without-h", ({ page, id }) => linkStep(page, id, "simplex:/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9"))
screen(1002, "checkout-links-noncanonical-key", ({ page, id }) => linkStep(page, id, "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS"))
screen(1004, "checkout-links-forms-now-taken", ({ page, id }) => linkStep(page, id, "https://smp8.simplex.im/A#G7Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7p"))

const review = async ({ page, id }: Reach, method?: "Card" | "Bitcoin" | "Monero") => {
  await search(page, id)
  await toReview(page)
  if (method) await chooseMethod(page, method)
  await expect(payButton(page)).toBeEnabled()
}

screen(1010, "checkout-review-btc", (r) => review(r))
screen(1012, "checkout-review-card", (r) => review(r, "Card"))
screen(1014, "checkout-review-xmr", (r) => review(r, "Monero"))
screen(1016, "checkout-review-unticked", async ({ page, id }) => {
  await search(page, id)
  await toReview(page, false)
})
screen(1018, "checkout-review-term-started", async ({ page, id }) => {
  await page.route(`**/api/name/${hex(labelHash(id))}*`, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...await res.json(), termStart: START_S - 86400 } })
  })
  await search(page, id)
  await toReview(page)
})
screen(1020, "checkout-review-bonus-tip", async (r) => {
  await review(r)
  await onStep(r.page).getByRole("button", { name: /^and (\d+ days|1 day)$/ }).focus()
})
screen(1022, "checkout-review-links", ({ page, id }) => toFullReview(page, id))
screen(1024, "checkout-review-links-unread", async ({ page, id }) => {
  await toFullReview(page, id)
  await page.route("**/api/link/preview", (route) => answer(route, 503, "unavailable"))
  await page.reload()
  await expect(onStep(page).getByRole("heading", { name: "Check your order" })).toBeVisible()
})
screen(1026, "checkout-review-chat-popup", async ({ page, id }) => {
  await toFullReview(page, id)
  await onStep(page).locator(".card.order .chat").first().click()
  await expect(page.locator(".modal[open]")).toBeVisible()
})
screen(1028, "checkout-review-community", async ({ page }) => {
  await search(page, "bakers")
  await toReview(page)
})
screen(1030, "checkout-review-community-popup", async ({ page }) => {
  await search(page, "bakers")
  await toReview(page)
  await onStep(page).getByRole("button", { name: "Community name: about it" }).click()
  await expect(page.locator(".modal[open]")).toBeVisible()
})

const codeRefused = async (r: Reach, refuse: (code: string) => Promise<unknown>) => {
  const { code } = await control(r.request, "code", { minLength: 6 }) as { code: string }
  await useCode(r.page, code)
  await search(r.page, r.id)
  await toReview(r.page)
  await refuse(code)
  await press(r.page, "Register with your code")
  await expect(onStep(r.page).getByRole("button", { name: "check another code" })).toBeVisible()
}
for (const [slot, state] of [[1040, "used"], [1042, "revoked"], [1044, "reserved"], [1046, "expired"], [1048, "unpaid"]] as const) {
  const id = { used: "checkout-review-code-refused-used", revoked: "checkout-review-code-refused-invalid", reserved: "checkout-review-code-refused-reserved",
    expired: "checkout-review-code-refused-expired", unpaid: "checkout-review-code-refused-unpaid" }[state]
  screen(slot, id, (r) => codeRefused(r, (code) => control(r.request, "code/state", { code, state })))
}
screen(1050, "checkout-review-code-refused-not-covering", (r) => codeRefused(r, () => r.page.route("**/api/name/register", (route) => answer(route, 409, "code_not_covering"))))

const balanceFromTaken = async (r: Reach, next: string) => {
  await takenOrder(r.page, r.request, `${r.id}-taken`)
  await press(r.page, "Choose another name")
  await r.page.getByLabel("Name", { exact: true }).fill(next)
  await r.page.getByLabel("Name", { exact: true }).press("Enter")
  await toReview(r.page)
}

screen(1060, "checkout-review-balance-part", (r) => balanceFromTaken(r, "bpart07"))
screen(1062, "checkout-review-balance-part-coin-only", async (r) => {
  const { invoiceId } = await startOrder(r.page, `${r.id}-late`, { method: "btc" })
  await control(r.request, `expire/${invoiceId}`)
  await control(r.request, "rate", { btc: 63800 })
  await control(r.request, `settle/${invoiceId}`)
  await shown(r.page, "The payment arrived after this invoice had closed")
  await control(r.request, "rate", { btc: null })
  await press(r.page, "Choose another name")
  await r.page.getByLabel("Name", { exact: true }).fill(r.id)
  await r.page.getByLabel("Name", { exact: true }).press("Enter")
  await toReview(r.page)
})
screen(1064, "checkout-review-balance-held-this-name", async (r) => {
  await balanceFromTaken(r, "bheld07")
  let lost = false
  await r.page.route("**/api/registration/*/spend", async (route) => {
    if (lost) return route.fallback()
    lost = true
    await route.fetch()
    await route.abort()
  })
  await clockAt(r, 120)
  await payButton(r.page).click()
  await r.page.waitForTimeout(1500)
  await r.page.goBack()
  await r.page.goForward()
  await heading(r.page, "Check your order")
})
screen(1066, "checkout-review-balance-gone", async (r) => {
  await takenOrder(r.page, r.request, `${r.id}-taken`)
  const invoiceId = new URL(r.page.url()).searchParams.get("order")!
  await r.page.goto("/#/names")
  await press(r.page, "Use")
  await search(r.page, r.id)
  await toReview(r.page)
  await control(r.request, `refund/${invoiceId}`)
  await press(r.page, "Register with your balance")
  await shown(r.page, "Your balance was spent or refunded meanwhile")
})
screen(1068, "checkout-review-balance-took-own-order", async (r) => {
  await takenOrder(r.page, r.request, `${r.id}-taken`)
  await press(r.page, "Choose another name")
  await r.page.getByLabel("Name", { exact: true }).fill(r.id)
  await r.page.getByLabel("Name", { exact: true }).press("Enter")
  await toReview(r.page)
  let lost = false
  await r.page.route("**/api/registration/*/spend", async (route) => {
    if (lost) return route.fallback()
    lost = true
    await route.fetch()
    await route.abort()
  })
  await press(r.page, "Register with your balance")
  await r.page.waitForTimeout(1500)
  await r.page.goBack()
  await r.page.goForward()
  await heading(r.page, "Check your order")
})
screen(1070, "checkout-review-balance-changed", async (r) => {
  await balanceFromTaken(r, "bchang7")
  const source = await r.page.evaluate(() => JSON.parse(sessionStorage.getItem("simplex-names-balance")!).source as string)
  await control(r.request, `credit/${source}`, { cents: 5000 })
  await payButton(r.page).click()
  await shown(r.page, "Your balance changed to")
})
screen(1072, "checkout-review-open-order", async (r) => {
  await startOrder(r.page, `${r.id}-first`, { method: "btc" })
  await search(r.page, r.id)
  await toReview(r.page)
  await shown(r.page, "Another order")
})
screen(1074, "checkout-review-open-order-confirming", async (r) => {
  const { invoiceId } = await startOrder(r.page, `${r.id}-first`, { method: "btc" })
  await search(r.page, r.id)
  await toReview(r.page)
  await control(r.request, `confirming/${invoiceId}`)
  await shown(r.page, "is confirming its payment")
})
screen(1076, "checkout-review-method-unavailable", async (r) => {
  await review(r)
  await control(r.request, "search", { invoiceError: "provider_unavailable" })
  await payButton(r.page).click()
  await shown(r.page, "temporarily unavailable")
})
screen(1078, "checkout-review-hold", async (r) => {
  await review(r)
  await r.page.route("**/api/invoice", posting(/\/api\/invoice$/, (route) => answer(route, 429, "rate_limited", 30)))
  await payButton(r.page).click()
  await r.page.waitForTimeout(500)
  await r.page.goBack()
  await r.page.goForward()
  await heading(r.page, "Check your order")
})
screen(1080, "checkout-review-terms-changed", async (r) => {
  await review(r)
  await control(r.request, "general-terms", { text: TERMS_TEXT })
  await payButton(r.page).click()
  await expect(onStep(r.page).getByRole("checkbox", { name: /^I accept/, checked: false })).toBeVisible()
})
screen(1082, "checkout-review-busy", async (r) => {
  await review(r)
  await r.page.route("**/api/invoice", posting(/\/api\/invoice$/, () => new Promise(() => undefined)))
  await payButton(r.page).click()
  await r.page.waitForTimeout(500)
})
screen(1084, "checkout-review-sending", async (r) => {
  await review(r)
  await r.page.route("**/api/invoice", posting(/\/api\/invoice$/, () => new Promise(() => undefined)))
  await payButton(r.page).click()
  await r.page.waitForTimeout(500)
  await r.page.goBack()
  await r.page.goForward()
  await heading(r.page, "Check your order")
})

const linkField = (page: Page, name = "Link") => onStep(page).getByRole("textbox", { name, exact: true })
const linksStep = async (page: Page, name: string) => {
  await search(page, name)
  await press(page, "Register")
  await heading(page, LINKS_HEADING)
}
const typedLink = async (page: Page, name: string, link: string) => {
  await linksStep(page, name)
  await linkField(page).fill(link)
  await page.waitForTimeout(800)
}
const givenLink = async (page: Page, name: string, link: string) => {
  await linksStep(page, name)
  await linkField(page).fill(link)
  await previewsShown(page)
}
const blurred = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

screen(1086, "checkout-links-empty", ({ page, id }) => linksStep(page, id))
screen(1088, "checkout-links-empty-camera", async (r) => {
  const phone = await cameraPage(r, false)
  await linksStep(phone, r.id)
  await expect(onStep(phone).getByRole("button", { name: "Scan QR code" })).toBeVisible()
  return phone
}, { sizes: ["phone"] })
screen(1090, "checkout-links-checking", async ({ page, request, id }) => {
  const link = contactLink("UnrCk")
  await control(request, "search", { fetchDelays: { [link]: 120_000 } })
  await linksStep(page, id)
  await linkField(page).fill(link)
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "checking")
})
screen(1092, "checkout-links-continue-checking", async ({ page, request, id }) => {
  const slow = contactLink("UnrE")
  await control(request, "search", { fetchDelays: { [slow]: 120_000 } })
  await linksStep(page, id)
  await linkField(page).fill(contactLink("E5"))
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "ok")
  await linkField(page).fill(slow)
  await expect(page.locator(".link-field").first()).toHaveAttribute("data-state", "checking")
  await onStep(page).locator(".btn[data-focus=continue]").click()
  await expect(onStep(page).locator(".btn[data-focus=continue]")).toHaveAttribute("aria-busy", "true")
})
screen(1094, "checkout-links-contact", ({ page, id }) => givenLink(page, id, contactLink("A1")))
screen(1096, "checkout-links-channel", ({ page, id }) => givenLink(page, id, channelLink("C1")))
screen(1098, "checkout-links-second-empty", async ({ page, id }) => {
  await givenLink(page, id, contactLink("S1"))
  await press(page, "Add a channel link")
  await blurred(page)
})
screen(1100, "checkout-links-business", ({ page, id }) => givenLink(page, id, contactLink("BizCo")))
screen(1102, "checkout-links-bot", ({ page, id }) => givenLink(page, id, contactLink("BotCo")))
screen(1104, "checkout-links-picture", ({ page, id }) => givenLink(page, id, contactLink("PicCo")))
screen(1106, "checkout-links-no-profile", ({ page, id }) => givenLink(page, id, contactLink("OffCo")))
screen(1108, "checkout-links-both", async ({ page, id }) => {
  await linksStep(page, id)
  await fillLinks(page, contactLink("B1"), channelLink("B2"))
  await previewsShown(page)
})
screen(1110, "checkout-links-kept-raw", async ({ page, id }) => {
  await givenLink(page, id, contactLink("K1"))
  await press(page, "Continue")
  await heading(page, CODE_HEADING)
  await page.route("**/api/link/preview", (route) => answer(route, 503, "unavailable"))
  await page.goto("/#/checkout/links")
  await page.reload()
  await heading(page, LINKS_HEADING)
  await blurred(page)
  await page.waitForTimeout(800)
})
screen(1112, "checkout-links-several", async ({ page, id }) => {
  await linksStep(page, id)
  await page.evaluate(([key, contact]) => {
    const checkout = JSON.parse(sessionStorage.getItem(key)!)
    sessionStorage.setItem(key, JSON.stringify({ ...checkout, contact }))
  }, [CHECKOUT_KEY, `${contactLink("M1")};${contactLink("M2")}`] as const)
  await page.reload()
  await shown(page, "Several links.")
})
screen(1114, "checkout-links-too-long", ({ page, id }) => typedLink(page, id, `${contactLink("W0")}?x=${"a".repeat(1024)}`))
screen(1116, "checkout-links-not-a-link", ({ page, id }) => typedLink(page, id, "hello"))
screen(1118, "checkout-links-second-not-a-link", async ({ page, id }) => {
  await givenLink(page, id, contactLink("N1"))
  await press(page, "Add a channel link")
  await linkField(page, "Channel").fill("hello")
  await page.waitForTimeout(800)
})
screen(1120, "checkout-links-other-kind-given", async ({ page, id }) => {
  await givenLink(page, id, contactLink("W0"))
  await press(page, "Add a channel link")
  await linkField(page, "Channel").fill(contactLink("W1"))
  await page.waitForTimeout(800)
})
screen(1122, "checkout-links-other-kind-field", async ({ page, id }) => {
  await givenLink(page, id, contactLink("F1"))
  await press(page, "Add a channel link")
  await onStep(page).getByRole("button", { name: "Remove link" }).first().click()
  await linkField(page, "Channel").fill(contactLink("F2"))
  await page.waitForTimeout(800)
})
screen(1124, "checkout-links-refused-by-service", async ({ page, id }) => {
  await page.route("**/api/link/preview", (route) => answer(route, 400, "invalid_link"))
  await typedLink(page, id, contactLink("R0"))
  await shown(page, "This link could not be opened.")
})
screen(1126, "checkout-links-not-checked", async ({ page, id }) => {
  await page.route("**/api/link/preview", (route) => answer(route, 429, "rate_limited", 30))
  await typedLink(page, id, contactLink("T0"))
  await shown(page, "The link could not be checked now.")
})
screen(1128, "checkout-links-no-camera", async (r) => {
  const phone = await cameraPage(r, false)
  await linksStep(phone, r.id)
  await onStep(phone).getByRole("button", { name: "Scan QR code" }).click()
  await shown(phone, "Allow the camera, or paste the link.")
  return phone
}, { sizes: ["phone"] })
screen(1130, "checkout-links-scan-dialog", async (r) => {
  const phone = await cameraPage(r, true)
  await linksStep(phone, r.id)
  await onStep(phone).getByRole("button", { name: "Scan QR code" }).click()
  await expect.poll(() => phone.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
  return phone
}, { sizes: ["phone"] })
const codeStep = async (page: Page, name: string) => {
  await search(page, name)
  await toCodeStep(page)
}
screen(1132, "checkout-code-unsaved", ({ page, id }) => codeStep(page, id))
screen(1134, "checkout-code-saved", async ({ page, id }) => {
  await codeStep(page, id)
  await onStep(page).getByText(SAVED).click()
})
screen(1136, "checkout-code-shown", async ({ page, id }) => {
  await codeStep(page, id)
  await shownCode(page)
})
screen(1138, "checkout-code-no-storage", async ({ page, id }) => {
  await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("denied", "SecurityError") } }))
  await codeStep(page, id)
})
const communityStep = async (page: Page, name: string) => {
  await search(page, name)
  await toCodeStep(page)
  await onStep(page).getByText(SAVED).click()
  await press(page, "Continue")
  await expect(onStep(page).getByRole("heading", { name: COMMUNITY_HEADING, level: 1 })).toBeVisible()
}
screen(1140, "checkout-community-loading", async ({ page }) => {
  await page.route("**/api/terms/*", held)
  await communityStep(page, "bakers")
})
screen(1142, "checkout-community-text", async ({ page }) => {
  await communityStep(page, "bakers")
  await expect(onStep(page).locator(".terms-text")).toBeVisible()
})
screen(1144, "checkout-community-accepted", async ({ page }) => {
  await communityStep(page, "bakers")
  await expect(onStep(page).locator(".terms-text")).toBeVisible()
  await onStep(page).locator(".check.terms .box").click()
})
screen(1146, "checkout-community-unreadable", async ({ page }) => {
  await page.route("**/api/terms/*", (route) => answer(route, 404, "not_found"))
  await communityStep(page, "bakers")
  await shown(page, "can't be shown now")
})
screen(1148, "checkout-community-commit-link", async ({ page }) => {
  const text = "# Community terms\n\n- Use the name for its community.\n"
  const link = `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/4cb24444a1f2e3d4c5b6a7980716253443526170/docs/community-terms.md#sha256=${createHash("sha256").update(text).digest("hex")}`
  const hash = keccak256(toHex(link))
  await page.route("**/api/name/*", async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({ response: res, json: json.status === "available" ? { ...json, terms: { hash, link } } : json })
  })
  await page.route(`**/api/terms/${hash}`, (route) => route.fulfill({ json: { link, text } }))
  await communityStep(page, "bakers")
  await expect(onStep(page).locator(".terms-text")).toBeVisible()
})
screen(1150, "checkout-community-terms-changed", async ({ page, request, id }) => {
  await search(page, id)
  await toReview(page)
  await control(request, "community", { label: id, for: "screens of the names page" })
  await payButton(page).click()
  await shown(page, "The Names Conditions changed.")
})
screen(1152, "checkout-community-popup-for", async ({ page }) => {
  await communityStep(page, "bakers")
  await press(page, "Which community this name is for")
  await expect(page.getByRole("dialog")).toBeVisible()
})
screen(1154, "checkout-community-popup-plain", async ({ page, id }) => {
  await contractsOwnerLists(id)
  await communityStep(page, id)
  await press(page, "Which community this name is for")
  await expect(page.getByRole("dialog")).toBeVisible()
})
screen(1156, "checkout-review-tab-code", async (r) => {
  await withCode(r, 6)
  await searchHere(r.page, r.id)
  await toReview(r.page)
})
screen(1158, "checkout-review-community-code-hint", async (r) => {
  await contractsOwnerLists(r.id)
  await withCode(r, 6, { years: 5 })
  await searchHere(r.page, r.id)
  await toReview(r.page)
})
const codeFieldOn = async (r: Reach, name: string = r.id) => {
  await search(r.page, name)
  await toReview(r.page)
  await press(r.page, "I have a code")
  await expect(codeField(r.page)).toBeVisible()
}
const codeTyped = async (r: Reach, code: string, name: string = r.id) => {
  await codeFieldOn(r, name)
  await codeField(r.page).fill(code)
  await r.page.waitForTimeout(800)
}
const issued = async (r: Reach, more: Record<string, unknown> = {}, minLength = 6) => (await control(r.request, "code", { minLength, ...more })).code as string
screen(1160, "checkout-review-code-field-empty", (r) => codeFieldOn(r))
screen(1162, "checkout-review-code-field-covering", async (r) => codeTyped(r, await issued(r, { years: 5 })))
screen(1164, "checkout-review-code-verdict-mistyped", (r) => codeTyped(r, "SN7-U"))
screen(1166, "checkout-review-code-verdict-unfinished", async (r) => {
  await codeTyped(r, "SN7-BJTBP")
  await codeField(r.page).press("Enter")
  await r.page.waitForTimeout(500)
})
screen(1168, "checkout-review-code-verdict-name-code", async (r) => {
  await codeFieldOn(r)
  await codeField(r.page).fill(await checkoutOwnerCode(r.page))
  await r.page.waitForTimeout(800)
})
screen(1170, "checkout-review-code-verdict-not-issued", async (r) => {
  await r.page.route("**/api/code/check", (route) => answer(route, 400, "code_invalid"))
  await codeTyped(r, await issued(r))
})
screen(1172, "checkout-review-code-verdict-not-covering", async (r) => codeTyped(r, await issued(r, {}, 8), seven(r.id)))
for (const [slot, state] of [[1174, "used"], [1176, "reserved"], [1180, "revoked"], [1182, "expired"]] as const) {
  screen(slot, `checkout-review-code-verdict-${state}`, async (r) => {
    const code = await issued(r)
    await control(r.request, "code/state", { code, state })
    await codeTyped(r, code)
  })
}
screen(1184, "checkout-review-code-verdict-reserved-own", async (r) => {
  const code = await withCode(r, 6)
  await control(r.request, "search", { unsentSeconds: 60 })
  await searchHere(r.page, `${r.id}-first`)
  await toReview(r.page)
  await press(r.page, "Register with your code")
  await r.page.waitForURL(/\?registration=/)
  await control(r.request, `fail/${new URL(r.page.url()).searchParams.get("registration")}`)
  await control(r.request, "search", { unsentSeconds: 0 })
  await heading(r.page, "Not registered")
  await codeTyped(r, code)
})
screen(1186, "checkout-review-code-verdict-unpaid", async (r) => codeTyped(r, await issued(r, { state: "unpaid" })))
screen(1188, "checkout-review-code-verdict-rate-limited", async (r) => {
  await r.page.route("**/api/code/check", (route) => answer(route, 429, "rate_limited", 30))
  await codeTyped(r, await issued(r))
})
screen(1190, "checkout-review-code-verdict-not-checked", async (r) => {
  await r.page.route("**/api/code/check", (route) => route.fulfill({ status: 503, json: {} }))
  await codeTyped(r, await issued(r))
})
screen(1192, "checkout-review-code-verdict-no-camera", async (r) => {
  const phone = await cameraPage(r, false)
  await search(phone, r.id)
  await toReview(phone)
  await press(phone, "I have a code")
  await press(phone, "Scan QR code")
  await phone.waitForTimeout(800)
  return phone
}, { sizes: ["phone"] })
screen(1194, "checkout-review-code-scan-dialog", async (r) => {
  const phone = await cameraPage(r, true)
  await search(phone, r.id)
  await toReview(phone)
  await press(phone, "I have a code")
  await press(phone, "Scan QR code")
  await expect.poll(() => phone.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
  return phone
}, { sizes: ["phone"] })
screen(1196, "checkout-review-codes-only-code", async (r) => {
  await control(r.request, "mode", { mode: "codes" })
  await withCode(r, 6)
  await searchHere(r.page, r.id)
  await toReview(r.page)
})
screen(1198, "checkout-review-codes-only-field", async (r) => {
  await control(r.request, "mode", { mode: "codes" })
  await withCode(r, 6)
  await searchHere(r.page, r.id)
  await toReview(r.page)
  await r.page.locator(".code-chip").getByRole("button", { name: "Remove code" }).click()
  await expect(codeField(r.page)).toBeVisible()
})
screen(1200, "checkout-review-codes-only-refused", async (r) => {
  await control(r.request, "mode", { mode: "codes" })
  const code = await withCode(r, 6)
  await searchHere(r.page, r.id)
  await toReview(r.page)
  await control(r.request, "code/state", { code, state: "used" })
  await press(r.page, "Register with your code")
  await shown(r.page, "Enter another code.")
})
screen(1202, "checkout-review-balance-covers", async (r) => {
  await balanceTo(r, seven(r.id), r.id)
  await toReview(r.page)
})
const reviewHeld = async (r: Reach): Promise<string> => {
  const taken = `${r.id}-taken`
  await takenOrder(r.page, r.request, taken)
  await press(r.page, "Choose another name")
  await searchHere(r.page, r.id)
  await toReview(r.page)
  const other = await r.page.context().newPage()
  await other.goto("/#/names")
  await other.locator(".list-row", { hasText: taken }).getByRole("button", { name: "Use" }).click()
  await searchHere(other, seven(r.id))
  await toReview(other)
  await clockAt(r, 120)
  await payButton(other).click()
  await other.waitForURL(/\?order=/)
  const invoiceId = new URL(other.url()).searchParams.get("order")!
  await other.close()
  return invoiceId
}
screen(1204, "checkout-review-balance-held-named", async (r) => {
  await reviewHeld(r)
  await press(r.page, "Register with your balance")
  await shown(r.page, "Your balance is in use by")
})
screen(1206, "checkout-review-balance-held-named-confirming", async (r) => {
  const invoiceId = await reviewHeld(r)
  await control(r.request, `partial/${invoiceId}`)
  await press(r.page, "Register with your balance")
  await shown(r.page, "while its payment is being confirmed")
})
screen(1208, "checkout-review-balance-held-unnamed", async (r) => {
  await reviewHeld(r)
  await r.page.route("**/api/registration/find", (route) => answer(route, 429, "rate_limited", 60))
  await press(r.page, "Register with your balance")
  await shown(r.page, "Your balance is in use by another order")
})
screen(1210, "checkout-review-balance-held-unnamed-confirming", async (r) => {
  const invoiceId = await reviewHeld(r)
  await r.page.route("**/api/registration/find", (route) => answer(route, 429, "rate_limited", 60))
  await control(r.request, `partial/${invoiceId}`)
  await press(r.page, "Register with your balance")
  await shown(r.page, "while its payment is being confirmed")
})
screen(1212, "checkout-review-waiting-card", async (r) => {
  await startOrder(r.page, `${r.id}-card`, { method: "card" })
  await onStep(r.page).getByRole("button", { name: /^Pay \$/ }).click()
  await expect(r.page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  await search(r.page, r.id)
  await toReview(r.page)
  await shown(r.page, "You have an order waiting to be confirmed")
})
const refusedOrder = async (r: Reach, refuse: () => Promise<unknown>, says: string | RegExp) => {
  await search(r.page, r.id)
  await toReview(r.page)
  await refuse()
  await payButton(r.page).click()
  await heading(r.page, says)
}
screen(1214, "checkout-status-price-changed", (r) => refusedOrder(r, () => control(r.request, "search", { invoiceError: "catalog_changed" }), "The price changed"))
screen(1216, "checkout-status-too-many", (r) => refusedOrder(r,
  () => r.page.route("**/api/invoice", posting(/\/api\/invoice$/, (route) => answer(route, 429, "rate_limited", 30))), "Too many attempts"))
screen(1218, "checkout-status-too-many-ended", async (r) => {
  await refusedOrder(r, () => r.page.route("**/api/invoice", posting(/\/api\/invoice$/, (route) => answer(route, 429, "rate_limited", 2))), "Too many attempts")
  await expect(onStep(r.page).getByRole("button", { name: "Try again" })).toBeEnabled({ timeout: 10_000 })
})
screen(1220, "checkout-status-taken", (r) => refusedOrder(r, async () => {
  await control(r.request, "take", { label: r.id })
  await expect.poll(async () => (await searchName(r.request, r.id)).status, { timeout: REGISTRATION_MS }).toBe("registered")
}, "This name is no longer available"))
screen(1222, "checkout-status-failed", (r) => refusedOrder(r, () => control(r.request, "search", { invoiceError: "internal" }), "That did not go through"))
screen(1224, "checkout-status-failed-retrying", async (r) => {
  await refusedOrder(r, () => control(r.request, "search", { invoiceError: "internal" }), "That did not go through")
  await r.page.route("**/api/invoice", posting(/\/api\/invoice$/, held))
  await press(r.page, "Try again")
  await expect(onStep(r.page).getByRole("button", { name: "Try again" })).toHaveAttribute("aria-busy", "true")
})
screen(1226, "checkout-status-unavailable", (r) => refusedOrder(r, () => control(r.request, "general-terms", { link: UNREADABLE_TERMS }), "Names can't be ordered right now"))
screen(1228, "checkout-status-unavailable-retrying", async (r) => {
  await refusedOrder(r, () => control(r.request, "general-terms", { link: UNREADABLE_TERMS }), "Names can't be ordered right now")
  await r.page.route("**/api/invoice", posting(/\/api\/invoice$/, held))
  await press(r.page, "Try again")
  await expect(onStep(r.page).getByRole("button", { name: "Try again" })).toHaveAttribute("aria-busy", "true")
})
screen(1230, "checkout-status-codes-only", (r) => refusedOrder(r, () => control(r.request, "mode", { mode: "codes" }), "Registration is by code only for now"))

// --- order

screen(2000, "order-pay-crypto-held-by-order", async (r) => {
  const mine = await startOrder(r.page, r.id, { method: "btc" })
  const other = await elsewhere(r, "/")
  const theirs = await startOrder(other, r.id, { method: "btc" })
  await control(r.request, "search", { unsentSeconds: 120 })
  await control(r.request, `settle/${theirs.invoiceId}`)
  await other.close()
  await r.page.goto(`/?order=${mine.invoiceId}`)
  await expect(onStep(r.page).locator(".name-check:not(.unchecked)")).toBeVisible()
})
screen(2002, "order-pay-card-held-by-order", async (r) => {
  const mine = await startOrder(r.page, r.id, { method: "card" })
  const other = await elsewhere(r, "/")
  const theirs = await startOrder(other, r.id, { method: "btc" })
  await control(r.request, "search", { unsentSeconds: 120 })
  await control(r.request, `settle/${theirs.invoiceId}`)
  await other.close()
  await r.page.goto(`/?order=${mine.invoiceId}`)
  await expect(onStep(r.page).locator(".name-check:not(.unchecked)")).toBeVisible()
})
screen(2004, "order-registering-committing", async (r) => {
  const { invoiceId } = await paid(r, r.id)
  await control(r.request, "search", { unsentSeconds: 120 })
  await control(r.request, `settle/${invoiceId}`)
  await expect(r.page.locator(".stage.active", { hasText: "Committing" })).toBeVisible()
})

const registeringAs = async (r: Reach, change: Record<string, unknown>) => {
  const order = await kept(r, `reg-${r.id}`, `inv-${r.id}`, r.id)
  const view = registrationView(order, { phase: "committed", commitTx: "0x02", revealAfter: r.now + 600, revealBefore: r.now + 86400, ...change })
  const invoice = { invoiceId: `inv-${r.id}`, status: "paid", amount: 10000, currency: "usd", expiresAt: new Date((r.now + 3600) * 1000).toISOString(), kind: "name",
    registration: view, cryptoCurrency: "btc", cryptoAmount: "0.00156", cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true, address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s" }
  await r.page.route(`**/api/invoice/inv-${r.id}*`, (route) => route.fulfill({ json: invoice }))
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: view }))
  await r.page.goto(`/?order=inv-${r.id}`)
}

screen(2006, "order-registering-wait", async (r) => {
  await registeringAs(r, {})
  await shown(r.page, "Every new name waits a little")
})
screen(2008, "order-registering-signing", async (r) => {
  await registeringAs(r, { revealAfter: r.now - 10, label: r.id })
  await shown(r.page, "Registering the name.")
})
screen(2010, "order-registering-register-sent", async (r) => {
  await registeringAs(r, { phase: "registering", label: r.id, registerTx: "0x03" })
  await shown(r.page, "Registering the name.")
})
screen(2012, "order-registering-stalled", async (r) => {
  await registeringAs(r, { phase: "registering", label: r.id, registerTx: "0x03" })
  await shown(r.page, "Registering the name.")
  await control(r.request, "clock", { now: r.now + 240 })
  await r.page.clock.fastForward("04:00")
  await shown(r.page, "This is taking longer than usual")
})
screen(2014, "order-registering-signature-refused", async (r) => {
  const { invoiceId } = await paid(r, r.id)
  await r.page.route("**/api/registration/*/reveal", (route) => answer(route, 400, "bad_request"))
  await control(r.request, `settle/${invoiceId}`)
  await shown(r.page, "The name could not be signed")
})

const termsChangedOrder = async (r: Reach) => {
  const { invoiceId } = await paid(r, r.id)
  await control(r.request, "general-terms", { text: TERMS_TEXT })
  await control(r.request, `settle/${invoiceId}`)
  await expect(onStep(r.page).getByRole("checkbox", { name: /^I accept/ })).toBeVisible({ timeout: REGISTRATION_MS })
  return invoiceId
}

screen(2016, "order-registering-terms-asked", async (r) => { await termsChangedOrder(r) })
screen(2018, "order-registering-community-terms-asked", async (r) => {
  await control(r.request, "community", { label: r.id, for: "screens of the names page" })
  const { invoiceId } = await paid(r, r.id)
  await control(r.request, "community-terms", { text: "The community terms, changed for the screens" })
  await control(r.request, `settle/${invoiceId}`)
  await expect(onStep(r.page).getByRole("checkbox", { name: /^I accept/ })).toBeVisible({ timeout: REGISTRATION_MS })
  await control(r.request, "community-terms", { text: null })
})
screen(2020, "order-registering-terms-ticked", async (r) => {
  await r.page.route("**/api/registration/*/reveal", (route) => new Promise(() => route))
  await termsChangedOrder(r)
  await agreeToTerms(r.page)
})
const goneWhileTermsWait = async (r: Reach, gone: Record<string, unknown>, says: string) => {
  const { invoiceId } = await paid(r, r.id)
  let answered = false
  await r.page.route(`**/api/name/${hex(labelHash(r.id))}*`, (route) => answered ? route.fulfill({ json: gone }) : route.fallback())
  await control(r.request, "general-terms", { text: TERMS_TEXT })
  answered = true
  await control(r.request, `settle/${invoiceId}`)
  await shown(r.page, says)
}

screen(2022, "order-registering-name-registered-meanwhile", (r) =>
  goneWhileTermsWait(r, { status: "registered", entities: [], tld: "simplex", community: null }, "Someone registered the name first"))
screen(2024, "order-registering-name-reserved-meanwhile", (r) => goneWhileTermsWait(r, { status: "reserved", community: null }, "The name was reserved meanwhile"))
screen(2026, "order-registering-lapsed", async (r) => { await lapsedOrder(r, r.id) })
screen(2028, "order-lapsed-no-record", async (r) => {
  const { invoiceId } = await lapsedOrder(r, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Paid, not registered")
  return other
})
screen(2030, "order-registering-no-record-committing", async (r) => {
  const { invoiceId } = await paid(r, r.id)
  await control(r.request, "search", { unsentSeconds: 120 })
  await control(r.request, `settle/${invoiceId}`)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await expect(onStep(other).getByRole("heading")).toBeVisible()
  return other
})
screen(2032, "order-registering-no-record-wait", async (r) => {
  const { invoiceId } = await committedUnsigned(r, r.id)
  const other = await elsewhere(r, "/#/trademarks")
  await other.route(`**/api/invoice/${invoiceId}*`, async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({ response: res, json: { ...json, registration: { ...json.registration, revealAfter: r.now + 600 } } })
  })
  await other.goto(`/?order=${invoiceId}`)
  await expect(onStep(other).getByRole("heading")).toBeVisible()
  return other
})
screen(2034, "order-links-refused-committed-paid", async (r) => { await linksRefused(r, r.id) })
screen(2036, "order-links-refused-committed-code", async (r) => {
  await control(r.request, "search", { refuseLinks: true })
  await codeOrder(r, r.id, contactLink("LR"))
  await shown(r.page, "The service refused this order's links")
})
screen(2038, "order-links-refused-channel", async (r) => { await linksRefused(r, r.id, "channel") })
screen(2040, "order-links-refused-lapsed-paid", async (r) => {
  const { registrationId } = await linksRefused(r, r.id)
  await control(r.request, `lapse/${registrationId}`)
  await heading(r.page, "Paid, not registered")
})
screen(2042, "order-links-refused-failed-code", async (r) => {
  await control(r.request, "search", { refuseLinks: true })
  const { registrationId } = await codeOrder(r, r.id, contactLink("LR"))
  await shown(r.page, "The service refused this order's links")
  await control(r.request, `lapse/${registrationId}`)
  await heading(r.page, "Not registered")
})
screen(2044, "order-links-refused-no-record-failed", async (r) => {
  const { invoiceId, registrationId } = await linksRefused(r, r.id)
  await control(r.request, `lapse/${registrationId}`)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Paid, not registered")
  return other
})

const moveRefused = async (r: Reach, refuse: (route: Route) => Promise<unknown>) => {
  await linksRefused(r, r.id)
  await r.page.route("**/api/registration/*/name", posting(/\/name$/, refuse))
  await press(r.page, "Register without links")
  await expect(onStep(r.page).locator(".notice").nth(1)).toBeVisible()
}

screen(2046, "order-links-refused-move-limit", (r) => moveRefused(r, (route) => answer(route, 409, "move_limit")))
screen(2048, "order-links-refused-move-failed", (r) => moveRefused(r, (route) => answer(route, 500, "internal")))
screen(2050, "order-links-refused-move-name-gone", async (r) => {
  await linksRefused(r, r.id)
  await control(r.request, "take", { label: r.id })
  await expect.poll(async () => ((await (await r.request.get(`${MOCK}/api/name/${hex(labelHash(r.id))}?length=${r.id.length}`)).json()) as { status: string }).status, { timeout: REGISTRATION_MS }).toBe("registered")
  await press(r.page, "Register without links")
  await expect(onStep(r.page).locator(".notice").nth(1)).toBeVisible()
})
screen(2052, "order-links-refused-move-terms-changed", async (r) => {
  await linksRefused(r, r.id)
  await control(r.request, "general-terms", { text: TERMS_TEXT })
  await press(r.page, "Register without links")
  await expect(onStep(r.page).getByRole("checkbox", { name: /^I accept/, checked: false })).toBeVisible({ timeout: REGISTRATION_MS })
})
screen(2054, "order-links-refused-move-limited", (r) => moveRefused(r, (route) => answer(route, 429, "rate_limited", 30)))
screen(2056, "order-taken-outpaid", async (r) => { await takenOrder(r.page, r.request, r.id) })
screen(2060, "order-failed-generic-paid", async (r) => { await failed(r, r.id) })
screen(2062, "order-failed-generic-paid-no-record", async (r) => {
  const { invoiceId } = await failed(r, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Paid, not registered")
  return other
})
screen(2064, "order-failed-generic-code-unchecked", async (r) => {
  await codeFailed(r, r.id)
  await r.page.route("**/api/code/check", () => new Promise(() => undefined))
  await r.page.reload()
  await heading(r.page, "Not registered")
})
screen(2066, "order-failed-generic-code-kept", async (r) => {
  await codeFailed(r, r.id)
  await shown(r.page, "Your code is kept.")
})
screen(2068, "order-failed-generic-code-limited", async (r) => {
  await codeFailed(r, r.id)
  await r.page.route("**/api/code/check", (route) => answer(route, 429, "rate_limited", 30))
  await r.page.reload()
  await shown(r.page, "Too many checks just now")
})
screen(2070, "order-failed-generic-code-refused", async (r) => {
  const { code } = await codeFailed(r, r.id)
  await control(r.request, "code/state", { code, state: "unused" })
  await control(r.request, "code/state", { code, state: "used" })
  await r.page.reload()
  await shown(r.page, "Your code was used for another name")
})
screen(2072, "order-failed-generic-code-no-record", async (r) => {
  const { registrationId } = await codeFailed(r, r.id)
  const other = await elsewhere(r, `/?registration=${registrationId}`)
  await heading(other, "Not registered")
  return other
})
screen(2074, "order-failed-name-paid", async (r) => { await failed(r, r.id) })
screen(2076, "order-failed-name-paid-no-record", async (r) => {
  const { invoiceId } = await failed(r, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Paid, not registered")
  return other
})
screen(2078, "order-failed-name-code-unchecked", async (r) => {
  await codeFailed(r, r.id)
  await r.page.route("**/api/code/check", () => new Promise(() => undefined))
  await r.page.reload()
  await heading(r.page, "Not registered")
})
screen(2080, "order-failed-name-code-kept", async (r) => {
  await codeFailed(r, r.id)
  await shown(r.page, "Your code is kept.")
})
screen(2082, "order-failed-name-code-limited", async (r) => {
  await codeFailed(r, r.id)
  await r.page.route("**/api/code/check", (route) => answer(route, 429, "rate_limited", 30))
  await r.page.reload()
  await shown(r.page, "Too many checks just now")
})
screen(2084, "order-failed-name-gone-since", async (r) => {
  await failed(r, r.id)
  await control(r.request, "take", { label: r.id })
  await expect.poll(async () => ((await (await r.request.get(`${MOCK}/api/name/${hex(labelHash(r.id))}?length=${r.id.length}`)).json()) as { status: string }).status, { timeout: REGISTRATION_MS }).toBe("registered")
  await r.page.reload()
  await shown(r.page, "Choose another name")
})
screen(2086, "order-failed-signature-paid", async (r) => { await failed(r, r.id) })
screen(2088, "order-failed-signature-code", async (r) => {
  await codeFailed(r, r.id)
  await shown(r.page, "Your code is kept.")
})
screen(2090, "order-failed-month-paid", async (r) => { await failed(r, r.id) })
screen(2092, "order-failed-month-code", async (r) => {
  await codeFailed(r, r.id)
  await shown(r.page, "Your code is kept.")
})
screen(2094, "order-failed-unread-paid", async (r) => { await lapsedOrder(r, r.id) })
screen(2096, "order-failed-unread-paid-no-record", async (r) => {
  const { invoiceId } = await lapsedOrder(r, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Paid, not registered")
  return other
})
screen(2098, "order-failed-unread-code", async (r) => {
  await r.page.route("**/api/registration/*/reveal", (route) => route.abort())
  const { registrationId } = await codeOrder(r, r.id)
  await expect.poll(async () => ((await (await r.request.get(`${MOCK}/api/registration/${registrationId}`)).json()) as { phase: string }).phase, { timeout: REGISTRATION_MS }).toBe("committed")
  await control(r.request, `lapse/${registrationId}`)
  await shown(r.page, LAPSED)
})

const retryRefused = async (r: Reach, refuse: (route: Route) => Promise<unknown>) => {
  await lapsedOrder(r, r.id)
  await r.page.route("**/api/registration/*/retry", posting(/\/retry$/, refuse))
  await press(r.page, "Try again")
  await expect(onStep(r.page).locator(".notice").nth(1)).toBeVisible()
}

screen(2100, "order-failed-action-limited", (r) => retryRefused(r, (route) => answer(route, 429, "rate_limited", 30)))
screen(2102, "order-failed-action-failed", (r) => retryRefused(r, (route) => answer(route, 500, "internal")))

const codeRetryRefused = async (r: Reach, status: number, error: string) => {
  await codeFailed(r, r.id)
  await shown(r.page, "Your code is kept.")
  await r.page.route("**/api/registration/*/retry", posting(/\/retry$/, (route) => answer(route, status, error)))
  await press(r.page, "Try again")
  await expect(onStep(r.page).locator(".notice").nth(1)).toBeVisible()
}

screen(2104, "order-failed-retry-code-reserved", (r) => codeRetryRefused(r, 409, "code_reserved"))
screen(2106, "order-failed-retry-code-invalid", (r) => codeRetryRefused(r, 400, "code_invalid"))
screen(2108, "order-failed-retry-code-expired", (r) => codeRetryRefused(r, 409, "code_expired"))
screen(2110, "order-failed-no-error", async (r) => {
  await kept(r, `reg-${r.id}`, `inv-${r.id}`, r.id)
  const order = JSON.parse(await r.page.evaluate((key) => localStorage.getItem(key)!, `simplex-names:order:reg-${r.id}`)) as KeptOrder
  const view = registrationView(order, { phase: "failed", commitTx: "0x02", error: null })
  await r.page.route(`**/api/invoice/inv-${r.id}*`, (route) => route.fulfill({ json: {
    invoiceId: `inv-${r.id}`, status: "paid", amount: 10000, currency: "usd", expiresAt: new Date((r.now + 3600) * 1000).toISOString(), kind: "name", registration: view,
    cryptoCurrency: "btc", cryptoAmount: "0.00156", cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true, address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s",
  } }))
  await r.page.goto(`/?order=inv-${r.id}`)
  await heading(r.page, "Paid, not registered")
})

const nameChecked = (page: Page) => expect(onStep(page).locator(".name-check:not(.unchecked)")).toBeVisible()
const orderOf = (page: Page) => new URL(page.url()).searchParams.get("order")!
const TAKEN_ANSWER = { status: "registered", entities: [], tld: "simplex", community: null }
const cancelAnswer = (page: Page, f: (route: Route) => Promise<unknown>) => page.route("**/api/invoice/*/cancel", posting(/\/cancel$/, f))
const STRIPE_STUB = (declines: boolean) => `window.Stripe = () => ({
  confirmPayment: async () => (${declines} ? { error: { type: "card_error", message: "Your card was declined." } } : { paymentIntent: { status: "processing" } }),
  elements: () => ({ update: () => undefined, create: () => {
    const handlers = {}
    return { on: (event, handler) => { handlers[event] = handler }, destroy: () => undefined, mount: (target) => {
      const form = document.createElement("div")
      form.style.height = (target.clientWidth >= 489 ? 221 : 306) + "px"
      target.append(form)
      setTimeout(() => handlers.ready?.(), 0)
    } }
  } }),
})`

screen(2112, "order-pay-btc-available", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await nameChecked(page)
})
screen(2114, "order-pay-xmr-available", async ({ page, id }) => {
  await startOrder(page, id, { method: "xmr" })
  await nameChecked(page)
})
screen(2116, "order-pay-crypto-difference", async (r) => {
  await balanceTo(r, `${r.id}-taken`, seven(r.id))
  await toReview(r.page)
  await payButton(r.page).click()
  await r.page.waitForURL(/\?order=/)
  await nameChecked(r.page)
})
screen(2118, "order-pay-crypto-taken-on-chain", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await answerName(page, id, TAKEN_ANSWER)
  await page.reload()
  await shown(page, "Someone has registered this name")
})
screen(2120, "order-pay-crypto-unchecked", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await page.route("**/api/name/**", (route) => route.abort())
  await page.reload()
  await heading(page, "Pay with Bitcoin")
  await page.waitForTimeout(1500)
})
screen(2122, "order-pay-crypto-no-record", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Pay with Bitcoin")
  return other
})
screen(2124, "order-pay-crypto-part-paid", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  await control(r.request, `partial/${invoiceId}`)
  await shown(r.page, "Part of the payment arrived")
})
screen(2126, "order-pay-crypto-part-paid-expired", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  await control(r.request, `partial/${invoiceId}`)
  await control(r.request, `overdue/${invoiceId}`)
  await r.page.reload()
  await shown(r.page, "The invoice expired before the full amount arrived")
})
const copiedCheckout = async (page: Page, name: string, card: boolean): Promise<Page> => {
  await search(page, name)
  await toReview(page)
  if (card) await chooseMethod(page, "Card")
  const checkout = await page.evaluate((key) => sessionStorage.getItem(key)!, CHECKOUT_KEY)
  await payButton(page).click()
  await page.waitForURL(/\?order=/)
  const copy = await page.context().newPage()
  await copy.addInitScript(([key, value]) => { if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value) }, [CHECKOUT_KEY, checkout])
  await copy.goto("/#/checkout")
  await chooseMethod(copy, card ? "Bitcoin" : "Monero")
  await payButton(copy).click()
  await copy.waitForURL(/\?order=/)
  await shown(copy, "opened instead of")
  return copy
}
screen(2128, "order-pay-crypto-opened-instead", ({ page, id }) => copiedCheckout(page, id, false))
screen(2130, "order-pay-crypto-cancel-refused", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await cancelAnswer(page, (route) => answer(route, 409, "funded"))
  await press(page, "Cancel this invoice")
  await shown(page, "A payment has reached this invoice")
})
screen(2132, "order-pay-crypto-cancel-limited", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await cancelAnswer(page, (route) => answer(route, 429, "rate_limited", 30))
  await press(page, "Cancel this invoice")
  await shown(page, "Too many attempts")
})
screen(2134, "order-pay-card-available", async ({ page, id }) => {
  await startOrder(page, id, { method: "card" })
  await nameChecked(page)
})
screen(2136, "order-pay-card-taken-on-chain", async ({ page, id }) => {
  await startOrder(page, id, { method: "card" })
  await answerName(page, id, TAKEN_ANSWER)
  await page.reload()
  await shown(page, "Taken at")
})
screen(2138, "order-pay-card-no-record", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "card" })
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Pay by card")
  return other
})
screen(2140, "order-pay-card-declined", async ({ page, id }) => {
  await startOrder(page, id, { method: "card" })
  await withStripeKey(page)
  await page.route("https://js.stripe.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: STRIPE_STUB(true) }))
  await page.reload()
  await heading(page, "Pay by card")
  await nameChecked(page)
  await payButton(page).click()
  await shown(page, "Your card was declined.")
})
screen(2142, "order-pay-card-cannot-persist", async ({ page, id }) => {
  await page.addInitScript(() => {
    const keep = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "simplex-names-probe") throw new DOMException("full", "QuotaExceededError")
      return keep.call(this, key, value)
    }
  })
  await startOrder(page, id, { method: "card" })
  await shown(page, "This browser cannot remember a card payment.")
})
screen(2144, "order-pay-card-opened-instead", ({ page, id }) => copiedCheckout(page, id, true))
screen(2146, "order-pay-card-cancel-refused", async ({ page, id }) => {
  await startOrder(page, id, { method: "card" })
  await cancelAnswer(page, (route) => answer(route, 409, "funded"))
  await press(page, "Cancel this invoice")
  await shown(page, "A payment has reached this invoice")
})
screen(2148, "order-confirming-crypto", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  await control(r.request, `confirming/${invoiceId}`)
  await heading(r.page, "Confirming your payment")
})
screen(2150, "order-confirming-crypto-settle", async (r) => {
  const order = await kept(r, `reg-${r.id}`, `inv-${r.id}`, r.id)
  const view = registrationView(order)
  await r.page.route(`**/api/invoice/inv-${r.id}*`, (route) => route.fulfill({ json: {
    invoiceId: `inv-${r.id}`, status: "open", amount: 10000, currency: "usd", expiresAt: new Date((r.now + 3600) * 1000).toISOString(), kind: "name", registration: view,
    cryptoCurrency: "btc", cryptoAmount: "0.00156", cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true, requiredConfirmations: 0,
    address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s",
  } }))
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: view }))
  await r.page.goto(`/?order=inv-${r.id}`)
  await shown(r.page, "Waiting for the payment to settle")
})
const cardSubmitted = async (page: Page, name: string) => {
  const { invoiceId } = await startOrder(page, name, { method: "card" })
  await onStep(page).getByRole("button", { name: /^Pay \$/ }).click()
  await expect(page.getByText("Waiting for Stripe to confirm")).toBeVisible()
  return invoiceId
}
screen(2152, "order-confirming-card-submitted", async ({ page, id }) => { await cardSubmitted(page, id) })
screen(2154, "order-confirming-card-seen", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "card" })
  await control(r.request, `confirming/${invoiceId}`)
  await heading(r.page, "Paying by card")
})
const cardFormFailed = async (r: Reach, before: () => Promise<unknown> = async () => undefined) => {
  await startOrder(r.page, r.id, { method: "card" })
  await withStripeKey(r.page)
  await r.page.route("https://js.stripe.com/**", (route) => route.abort())
  await before()
  await r.page.reload()
  await heading(r.page, "Card payment not confirmed")
}
screen(2156, "order-card-form-failed", (r) => cardFormFailed(r))
screen(2158, "order-card-form-failed-no-record", (r) => cardFormFailed(r, () => r.page.evaluate(() => localStorage.clear())))
screen(2160, "order-card-form-failed-codes-only", (r) => cardFormFailed(r, () => control(r.request, "mode", { mode: "codes" })))
const cardSlow = async (r: Reach) => {
  const invoiceId = await cardSubmitted(r.page, r.id)
  await r.page.evaluate(([id, at]) => {
    for (const key of Object.keys(localStorage).filter((k) => k.startsWith("simplex-names:order:"))) {
      const record = JSON.parse(localStorage.getItem(key)!)
      if (record.invoiceId === id) localStorage.setItem(key, JSON.stringify({ ...record, cardSubmittedAt: at }))
    }
  }, [invoiceId, new Date((r.now - 660) * 1000).toISOString()] as const)
  return invoiceId
}
screen(2162, "order-card-slow", async (r) => {
  await cardSlow(r)
  await r.page.reload()
  await heading(r.page, "Card payment not confirmed")
})
screen(2164, "order-card-slow-seen", async (r) => {
  const invoiceId = await cardSlow(r)
  await control(r.request, `confirming/${invoiceId}`)
  await r.page.reload()
  await heading(r.page, "Card payment not confirmed")
})
screen(2166, "order-paid-by-invoice-record", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  await r.page.goto(`/?registration=${await registrationOf(r.request, invoiceId)}`)
  await heading(r.page, "This order is paid by invoice")
})
screen(2168, "order-paid-by-invoice-no-record", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  const other = await elsewhere(r, `/?registration=${await registrationOf(r.request, invoiceId)}`)
  await heading(other, "This order is paid by invoice")
  return other
})
screen(2170, "order-registering-no-record-signed", async (r) => {
  const order = await kept(r, `reg-${r.id}`, `inv-${r.id}`, r.id)
  const view = registrationView(order, { phase: "registering", label: r.id, commitTx: "0x02", registerTx: "0x03", revealAfter: r.now - 60, revealBefore: r.now + 86400 })
  const other = await elsewhere(r, "/#/trademarks")
  await other.route(`**/api/invoice/inv-${r.id}*`, (route) => route.fulfill({ json: {
    invoiceId: `inv-${r.id}`, status: "paid", amount: 10000, currency: "usd", expiresAt: new Date((r.now + 3600) * 1000).toISOString(), kind: "name", registration: view,
    cryptoCurrency: "btc", cryptoAmount: "0.00156", cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true, address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s",
  } }))
  await other.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: view }))
  await other.goto(`/?order=inv-${r.id}`)
  await heading(other, `Registering ${r.id}.simplex`)
  return other
})
screen(2172, "order-not-on-device", async (r) => {
  const { invoiceId } = await committedUnsigned(r, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "The name code is not in this browser")
  return other
})
screen(2174, "order-registered-links", async (r) => {
  const invoiceId = await withLink(r, r.id, "contact")
  await control(r.request, `settle/${invoiceId}`)
  await waitRegistered(r.page, r.id)
})
screen(2176, "order-registered-no-links", async (r) => {
  const { invoiceId } = await paid(r, r.id)
  await control(r.request, `settle/${invoiceId}`)
  await waitRegistered(r.page, r.id)
})
screen(2178, "order-registered-no-record", async (r) => {
  const { invoiceId } = await paid(r, r.id)
  await control(r.request, `settle/${invoiceId}`)
  await waitRegistered(r.page, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, `${r.id}.simplex is yours`)
  return other
})
screen(2180, "order-taken-chain", async (r) => { await takenOrder(r.page, r.request, r.id) })
screen(2182, "order-taken-reserved", async (r) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  await answersReserved(r.page, r.id)
  await control(r.request, "take", { label: r.id })
  await control(r.request, `settle/${invoiceId}`)
  await heading(r.page, `${r.id}.simplex is reserved`)
})
screen(2184, "order-taken-no-record", async (r) => {
  const { invoiceId } = await takenOrder(r.page, r.request, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, `${r.id}.simplex was taken`)
  return other
})
screen(2186, "order-taken-balance-spent", async (r) => {
  const { invoiceId } = await takenOrder(r.page, r.request, r.id)
  await control(r.request, `refund/${invoiceId}`)
  await r.page.reload()
  await shown(r.page, "It has been spent or refunded since")
})
screen(2188, "order-taken-balance-held", async (r) => {
  const { invoiceId } = await takenOrder(r.page, r.request, r.id)
  await press(r.page, "Choose another name")
  await searchHere(r.page, seven(r.id))
  await toReview(r.page)
  await payButton(r.page).click()
  await r.page.waitForURL(/\?order=/)
  await r.page.goto(`/?order=${invoiceId}`)
  await heading(r.page, `${r.id}.simplex was taken`)
})
screen(2190, "order-taken-codes-only", async (r) => {
  await takenOrder(r.page, r.request, r.id)
  await control(r.request, "mode", { mode: "codes" })
  await r.page.reload()
  await shown(r.page, "You can ask for a refund.")
})
screen(2192, "order-taken-balance-order", async (r) => {
  const order = await kept(r, `reg-${r.id}`, null, r.id)
  await r.page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)!), method: "balance" })), `simplex-names:order:reg-${r.id}`)
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: registrationView(order, {
    phase: "taken", fromBalance: 10000, balance: { amount: 10000, held: false, heldUntil: null, refunded: 0 }, commitTx: "0x02",
  }) }))
  await r.page.goto(`/?registration=reg-${r.id}`)
  await heading(r.page, `${r.id}.simplex was taken`)
})
const codeTaken = async (r: Reach) => {
  const code = await issued(r)
  await control(r.request, "take", { label: r.id })
  await useCode(r.page, code)
  await searchHere(r.page, r.id)
  await toReview(r.page)
  await press(r.page, "Register with your code")
  await r.page.waitForURL(/\?registration=/)
  return new URL(r.page.url()).searchParams.get("registration")!
}
screen(2194, "order-taken-code", async (r) => {
  await codeTaken(r)
  await heading(r.page, "Someone registered it first")
})
screen(2196, "order-taken-code-reserved", async (r) => {
  await codeTaken(r)
  await answersReserved(r.page, r.id)
  await heading(r.page, "The name was reserved meanwhile")
})
screen(2198, "order-taken-code-no-record", async (r) => {
  const registrationId = await codeTaken(r)
  await heading(r.page, "Someone registered it first")
  const other = await elsewhere(r, `/?registration=${registrationId}`)
  await heading(other, "Someone registered it first")
  return other
})
const closed = async (r: Reach, method: "btc" | "card" = "btc") => {
  const { invoiceId } = await startOrder(r.page, r.id, { method })
  await control(r.request, `expire/${invoiceId}`)
  await heading(r.page, "Invoice closed")
  return invoiceId
}
screen(2200, "order-closed-expired-crypto", async (r) => { await closed(r) })
screen(2202, "order-closed-expired-card", async (r) => { await closed(r, "card") })
screen(2204, "order-closed-expired-no-record", async (r) => {
  const invoiceId = await closed(r)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await heading(other, "Invoice closed")
  return other
})
screen(2206, "order-closed-cancelled", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await press(page, "Cancel this invoice")
  await heading(page, "Invoice closed")
})
const halfOf = async (r: Reach, invoiceId: string) => {
  const invoice = await (await r.request.get(`${MOCK}/api/invoice/${invoiceId}`)).json() as { cryptoAmountPaid: string }
  return invoice.cryptoAmountPaid
}
const closedPart = async (r: Reach) => {
  const { invoiceId } = await startOrder(r.page, r.id, { method: "btc" })
  await control(r.request, `partial/${invoiceId}`)
  const paidPart = await halfOf(r, invoiceId)
  await control(r.request, `expire/${invoiceId}`)
  return { invoiceId, paidPart }
}
screen(2208, "order-closed-received-confirming", async (r) => {
  await closedPart(r)
  await shown(r.page, "which is not the full amount. Once confirmed")
})
screen(2210, "order-closed-received-crediting", async (r) => {
  const { invoiceId, paidPart } = await closedPart(r)
  await control(r.request, `late/${invoiceId}`, { waiting: "crediting" })
  await control(r.request, `settle/${invoiceId}`, { paid: paidPart })
  await shown(r.page, "Once credited")
})
screen(2212, "order-closed-received-support", async (r) => {
  const { invoiceId } = await closedPart(r)
  await control(r.request, `late/${invoiceId}`, { waiting: "support" })
  await shown(r.page, "It is not credited to your balance by itself")
})
const receivedOffer = async (r: Reach) => {
  const { invoiceId, paidPart } = await closedPart(r)
  await control(r.request, `settle/${invoiceId}`, { paid: paidPart })
  await shown(r.page, "It is kept as your balance")
  return invoiceId
}
screen(2214, "order-closed-received-offer", async (r) => { await receivedOffer(r) })
screen(2216, "order-closed-late-confirming", async (r) => {
  const invoiceId = await closed(r)
  await control(r.request, `confirming/${invoiceId}`)
  await shown(r.page, "A payment did not complete before the invoice closed")
})
screen(2218, "order-closed-paid-late-offer", async (r) => {
  const invoiceId = await closed(r)
  await control(r.request, `settle/${invoiceId}`)
  await shown(r.page, "The payment arrived after this invoice had closed")
})
screen(2220, "order-closed-paid-late-support", async (r) => {
  const invoiceId = await closed(r)
  await control(r.request, `late/${invoiceId}`, { waiting: "support" })
  await control(r.request, `settle/${invoiceId}`)
  await shown(r.page, "It is not credited to your balance by itself")
})
screen(2222, "order-closed-replaced", async (r) => {
  const old = await closed(r)
  await press(r.page, "Get a new invoice")
  await r.page.waitForURL((url) => url.searchParams.get("order") !== old)
  await control(r.request, `partial/${old}`)
  const paidPart = await halfOf(r, old)
  await control(r.request, `settle/${old}`, { paid: paidPart })
  await r.page.goto(`/?order=${old}`)
  await heading(r.page, "Invoice closed")
  await shown(r.page, "What reached this invoice is kept")
})
screen(2224, "order-closed-codes-only", async (r) => {
  await closed(r)
  await control(r.request, "mode", { mode: "codes" })
  await r.page.reload()
  await heading(r.page, "Invoice closed")
})
screen(2226, "order-closed-terms-asked", async (r) => {
  await closed(r)
  await control(r.request, "general-terms", { text: TERMS_TEXT })
  await press(r.page, "Get a new invoice")
  await expect(onStep(r.page).getByRole("checkbox", { name: /^I accept/, checked: false })).toBeVisible()
})
const reorderRefused = async (r: Reach, refuse: () => Promise<unknown>) => {
  await closed(r)
  await refuse()
  await press(r.page, "Get a new invoice")
  await expect(onStep(r.page).locator(".notice").last()).toBeVisible()
  await r.page.waitForTimeout(800)
}
screen(2228, "order-reorder-provider-unavailable", (r) => reorderRefused(r, () => control(r.request, "search", { invoiceError: "provider_unavailable" })))
screen(2230, "order-reorder-codes-only", (r) => reorderRefused(r, () => control(r.request, "mode", { mode: "codes" })))
screen(2232, "order-reorder-balance-in-use", async (r) => {
  await balanceTo(r, `${r.id}-taken`, seven(r.id))
  const source = await r.page.evaluate(() => JSON.parse(sessionStorage.getItem("simplex-names-balance")!).source as string)
  await toReview(r.page)
  await payButton(r.page).click()
  await r.page.waitForURL(/\?order=/)
  await control(r.request, `expire/${orderOf(r.page)}`)
  await heading(r.page, "Invoice closed")
  await r.page.route(`**/api/registration/${source}*`, async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({ response: res, json: { ...json, balance: { amount: 10000, held: true, heldUntil: new Date((r.now + 3600) * 1000).toISOString(), refunded: 0 } } })
  })
  await press(r.page, "Get a new invoice")
  await shown(r.page, "Your balance is in use by")
})
screen(2234, "order-reorder-no-orders", (r) => reorderRefused(r, () => control(r.request, "general-terms", { link: UNREADABLE_TERMS })))
screen(2236, "order-reorder-balance-changed", async (r) => {
  await receivedOffer(r)
  await r.page.route("**/spend", posting(/\/spend$/, (route) => route.fulfill({ status: 409, json: { error: "balance_changed", balance: null } })))
  await press(r.page, "Get a new invoice")
  await shown(r.page, "Your balance changed meanwhile.")
})
screen(2238, "order-reorder-failed", (r) => reorderRefused(r, () => control(r.request, "search", { invoiceError: "internal" })))
screen(2240, "order-reorder-limited", (r) => reorderRefused(r, () => control(r.request, "search", { invoiceError: "rate_limited" })))
screen(2242, "order-reorder-cancel-refused", async (r) => {
  await cardFormFailed(r)
  await cancelAnswer(r.page, (route) => answer(route, 409, "funded"))
  await press(r.page, "Get a new invoice")
  await shown(r.page, "A payment has reached this invoice, so it is kept.")
})
screen(2244, "order-reorder-name-unchecked", async ({ page, id }) => {
  await startOrder(page, id, { method: "btc" })
  await press(page, "Cancel this invoice")
  await heading(page, "Invoice closed")
  await page.route("**/api/name/**", (route) => answer(route, 503, "unavailable"))
  await press(page, "Order the name again")
  await shown(page, "The name could not be checked now.")
})
screen(2246, "order-price-changed", async (r) => {
  await closed(r)
  await control(r.request, "search", { invoiceError: "catalog_changed" })
  await press(r.page, "Get a new invoice")
  await heading(r.page, "The price changed")
})
screen(2248, "order-unreadable", async ({ page, id }) => {
  await page.route(`**/api/invoice/inv-${id}*`, (route) => answer(route, 500, "internal"))
  await page.goto(`/?order=inv-${id}`)
  await heading(page, "This order could not be loaded")
})
screen(2250, "order-loading", async ({ page, id }) => {
  await page.route(`**/api/invoice/inv-${id}*`, held)
  await page.goto(`/?order=inv-${id}`)
  await shown(page, "Opening the order")
})
screen(2252, "order-unknown-link", async ({ page }) => {
  await page.goto("/?order=nothing-here")
  await heading(page, "This link does not work")
})

// --- Your names, Check your code, Edit links

screen(3000, "names-row-lapsed-unsigned", async (r) => {
  await lapsedOrder(r, r.id)
  await r.page.goto("/#/names")
  await expect(r.page.locator(".list-row", { hasText: r.id }).locator(".chip")).toBeVisible()
})

const ownerSetsChannel = async (r: Reach, registrationId: string) => {
  const ownerCode = await r.page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`)!).ownerCode as string, registrationId)
  const { ownerSetsText } = await import("./helpers.ts")
  await ownerSetsText(ownerCode, r.id, "simplex.channel", "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm")
}

screen(3002, "names-row-registered-unparsed-link", async (r) => {
  const { registrationId } = await codeOrder(r, r.id)
  await waitRegistered(r.page, r.id)
  await ownerSetsChannel(r, registrationId)
  await r.page.goto("/#/names")
  await expect(r.page.locator(".list-row", { hasText: r.id }).locator(".chat").first()).toBeVisible()
})

const registeredWithout = async (r: Reach, available: boolean) => {
  const order = await kept(r, `reg-${r.id}`, null, r.id)
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", expiresAt: null, commitTx: "0x02", registerTx: "0x03" }) }))
  await r.page.route(`**/api/name/${hex(labelHash(r.id))}*`, async (route) => {
    if (!available) return route.fulfill({ json: registeredAnswer(order, null) })
    const res = await route.fetch()
    await route.fulfill({ response: res })
  })
  return order
}

screen(3004, "names-row-registered-no-expiry", async (r) => {
  await registeredWithout(r, false)
  await r.page.goto("/#/names")
  await expect(r.page.locator(".list-row", { hasText: r.id })).toBeVisible()
})
screen(3006, "names-row-expired-no-expiry", async (r) => {
  await registeredWithout(r, true)
  await r.page.goto("/#/names")
  await expect(r.page.locator(".list-row", { hasText: r.id }).locator(".chip")).toBeVisible()
})
screen(3008, "names-balance-outpaid", async (r) => {
  await takenOrder(r.page, r.request, r.id)
  await r.page.goto("/#/names")
  await shown(r.page, "registered by someone else first")
})
screen(3010, "names-pending-config-unread", async (r) => {
  await search(r.page, r.id)
  await toReview(r.page)
  await r.page.route("**/api/invoice", posting(/\/api\/invoice$/, async (route) => {
    await route.fetch()
    await route.abort()
  }))
  await payButton(r.page).click()
  await r.page.waitForTimeout(1500)
  await configUnread(r.page.context())
  const tab = await r.page.context().newPage()
  await tab.goto("/#/names")
  await tab.getByRole("button", { name: "Find the order" }).click()
  await tab.waitForTimeout(1500)
  return tab
})
screen(3012, "names-list-config-unread-fresh", async (r) => {
  await codeOrder(r, r.id)
  await waitRegistered(r.page, r.id)
  await r.page.evaluate(() => localStorage.removeItem("simplex-names-seen"))
  await configUnread(r.page)
  await r.page.goto("about:blank")
  await r.page.goto("/#/names")
  await expect(r.page.locator(".list-row", { hasText: r.id })).toBeVisible()
})
screen(3014, "names-list-config-unread-seen", async (r) => {
  await codeOrder(r, r.id)
  await waitRegistered(r.page, r.id)
  await r.page.goto("/#/names")
  await expect(r.page.locator(".list-row", { hasText: r.id })).toContainText("Until")
  await configUnread(r.page)
  await r.page.reload()
  await r.page.waitForTimeout(1500)
})
screen(3016, "names-check-add-config-unread", async (r) => {
  const { registrationId } = await codeOrder(r, r.id)
  await waitRegistered(r.page, r.id)
  const ownerCode = await r.page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`)!).ownerCode as string, registrationId)
  const other = await elsewhere(r, "/#/trademarks")
  await configUnread(other)
  await other.goto("/#/code")
  await codeField(other).fill(ownerCode)
  await other.getByRole("button", { name: "Add to Your names" }).click()
  await other.waitForTimeout(1500)
  return other
})
screen(3018, "names-edit-expired-no-date", async (r) => {
  await registeredWithout(r, true)
  await r.page.goto(`/#/edit/reg-${r.id}`)
  await shown(r.page, "This name has expired")
})
screen(3020, "names-edit-form-no-count", async (r) => {
  const order = await kept(r, `reg-${r.id}`, null, r.id)
  const expiresAt = START_S + 2 * YEAR_S
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: registrationView(order, { phase: "registered", expiresAt, commitTx: "0x02", registerTx: "0x03" }) }))
  await r.page.route(`**/api/name/${hex(labelHash(r.id))}*`, (route) => route.fulfill({ json: registeredAnswer(order, expiresAt, { recordEdits: null }) }))
  await r.page.goto(`/#/edit/reg-${r.id}`)
  await heading(r.page, /Edit links/)
})
screen(3022, "names-edit-config-unread", async (r) => {
  const { registrationId } = await codeOrder(r, r.id)
  await waitRegistered(r.page, r.id)
  await configUnread(r.page)
  await r.page.goto("about:blank")
  await r.page.goto(`/#/edit/${registrationId}`)
  await r.page.waitForTimeout(1500)
})

const editField = async (r: Reach, link: string) => {
  const { registrationId } = await codeOrder(r, r.id)
  await waitRegistered(r.page, r.id)
  await r.page.goto(`/#/edit/${registrationId}`)
  await onStep(r.page).getByRole("textbox", { name: "Link", exact: true }).fill(link)
  await r.page.waitForTimeout(800)
  await r.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await r.page.waitForTimeout(800)
}

screen(3024, "names-edit-field-simplex-no-host", (r) => editField(r, "simplex:/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9"))
screen(3026, "names-edit-field-uppercase-type", (r) => editField(r, "https://smp8.simplex.im/A#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9"))
screen(3028, "names-edit-field-noncanonical-typed", (r) => editField(r, "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm"))
screen(3030, "names-edit-field-noncanonical-kept", async (r) => {
  const { registrationId } = await codeOrder(r, r.id)
  await waitRegistered(r.page, r.id)
  await ownerSetsChannel(r, registrationId)
  await r.page.goto(`/#/edit/${registrationId}`)
  await expect(onStep(r.page).locator(".link-field").first()).toBeVisible()
  await r.page.waitForTimeout(1500)
})

const listRow = (page: Page, text: string) => page.locator(".list-row", { hasText: text }).first()
const yourNames = async (page: Page, rows: string[] = []) => {
  await page.goto("/#/names")
  await heading(page, "Your names")
  for (const text of rows) await expect(listRow(page, text)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2000)
}
const ownerCodeOf = (page: Page, registrationId: string) =>
  page.evaluate((id) => JSON.parse(localStorage.getItem(`simplex-names:order:${id}`)!).ownerCode as string, registrationId)
const NO_STORAGE = () => Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("denied", "SecurityError") } })
const keptInvoice = (r: Reach, invoiceId: string, view: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  invoiceId, status: "paid", amount: 10000, currency: "usd", expiresAt: new Date((r.now + 3600) * 1000).toISOString(), kind: "name", registration: view,
  cryptoCurrency: "btc", cryptoAmount: "0.00156", cryptoAmountPaid: "0.00156", cryptoAmountDue: "0", paidInFull: true, address: "bcrt1qjhmc6927ct4w4vnas0g70pg3sdhgfdhcl8pd7s", ...more,
})
const faked = async (r: Reach, name: string, change: Record<string, unknown>, invoice: Record<string, unknown> | null = null, answer: Record<string, unknown> | null = null) => {
  const order = await kept(r, `reg-${name}`, invoice ? `inv-${name}` : null, name)
  const view = registrationView(order, change)
  await r.page.route(`**/api/registration/reg-${name}*`, (route) => route.fulfill({ json: view }))
  if (invoice) await r.page.route(`**/api/invoice/inv-${name}*`, (route) => route.fulfill({ json: keptInvoice(r, `inv-${name}`, view, invoice) }))
  if (answer) await answerName(r.page, name, answer)
  return order
}
const registeredFor = (order: KeptOrder, expiresAt: number, extra: Record<string, unknown> = {}) =>
  registeredAnswer(order, expiresAt, { gracePeriod: 90 * 86400, ...extra })
const registered = async (r: Reach, name: string, links: { contact: string; channel: string } | null = null) => {
  const code = await issued(r)
  await useCode(r.page, code)
  await searchHere(r.page, name)
  if (links) {
    await press(r.page, "Register")
    if (links.channel) await fillLinks(r.page, links.contact, links.channel)
    else await linkField(r.page).fill(links.contact)
    await previewsShown(r.page)
    await press(r.page, "Continue")
    await savedToReview(r.page)
  } else await toReview(r.page)
  await press(r.page, "Register with your code")
  await r.page.waitForURL(/\?registration=/)
  const registrationId = new URL(r.page.url()).searchParams.get("registration")!
  await waitRegistered(r.page, name)
  return registrationId
}

screen(3032, "names-list-empty", async ({ page }) => { await yourNames(page) })
screen(3034, "names-list-empty-no-storage", async ({ page }) => {
  await page.addInitScript(NO_STORAGE)
  await yourNames(page)
})
screen(3036, "names-list-reading", async (r) => {
  await kept(r, `reg-${r.id}`, null, r.id)
  await r.page.route(`**/api/registration/reg-${r.id}*`, held)
  await r.page.goto("/#/names")
  await shown(r.page, "Reading your names")
})
screen(3038, "names-list-codes-only", async (r) => { await yourNames(r.page, [await withCode(r, 7)]) })
screen(3040, "names-list-forget-asked", async (r) => {
  await yourNames(r.page, [await withCode(r, 7)])
  await press(r.page, "Forget everything in this browser")
  await shown(r.page, "Forget every name and code in this browser?")
})

const INVOICE_ROWS = ["names-row-unread", "names-row-unpaid", "names-row-confirming", "names-row-part-paid", "names-row-closed-empty", "names-row-cancelled",
  "names-row-closed-part-confirming", "names-row-closed-part-credited", "names-row-closed-part-crediting", "names-row-closed-part-support", "names-row-closed-incomplete",
  "names-row-paid-late", "names-row-paid-late-support"]
screen(3042, "names-rows-invoices", async (r) => {
  const order = async (name: string, method: "btc" | "xmr" = "btc") => (await startOrder(r.page, name, { method })).invoiceId
  const unread = await order("rows-unread")
  await order("rows-unpaid")
  await control(r.request, `confirming/${await order("rows-confirming", "xmr")}`)
  await control(r.request, `partial/${await order("rows-part-paid")}`)
  await control(r.request, `expire/${await order("rows-closed-empty")}`)
  await order("rows-cancelled")
  await press(r.page, "Cancel this invoice")
  await heading(r.page, "Invoice closed")
  const part = async (name: string) => {
    const invoiceId = await order(name)
    await control(r.request, `partial/${invoiceId}`)
    const paidPart = await halfOf(r, invoiceId)
    await control(r.request, `expire/${invoiceId}`)
    return { invoiceId, paidPart }
  }
  await part("rows-part-confirming")
  const credited = await part("rows-part-credited")
  await control(r.request, `settle/${credited.invoiceId}`, { paid: credited.paidPart })
  const crediting = await part("rows-part-crediting")
  await control(r.request, `late/${crediting.invoiceId}`, { waiting: "crediting" })
  await control(r.request, `settle/${crediting.invoiceId}`, { paid: crediting.paidPart })
  const support = await part("rows-part-support")
  await control(r.request, `late/${support.invoiceId}`, { waiting: "support" })
  const incomplete = await order("rows-incomplete")
  await control(r.request, `confirming/${incomplete}`)
  await control(r.request, `expire/${incomplete}`)
  const late = await order("rows-paid-late")
  await control(r.request, `expire/${late}`)
  await control(r.request, `settle/${late}`)
  const lateSupport = await order("rows-late-support")
  await control(r.request, `expire/${lateSupport}`)
  await control(r.request, `late/${lateSupport}`, { waiting: "support" })
  await control(r.request, `settle/${lateSupport}`)
  await r.page.route(`**/api/invoice/${unread}*`, (route) => answer(route, 503, "provider_unavailable"))
  await yourNames(r.page, ["rows-unread", "rows-late-support"])
}, { covers: INVOICE_ROWS, timeout: 300_000 })

const PROGRESS_ROWS = ["names-row-queued", "names-row-committing", "names-row-committed", "names-row-registering", "names-row-open-to-finish", "names-row-failed",
  "names-row-taken-code", "names-row-taken-spent"]
screen(3044, "names-rows-progress", async (r) => {
  await faked(r, "rows-queued", { phase: "queued" }, {})
  await faked(r, "rows-committed", { phase: "committed", label: "rows-committed", commitTx: "0x02", revealAfter: r.now + 3600, fromBalance: 10000 })
  await faked(r, "rows-registering", { phase: "registering", fromBalance: 10000, commitTx: "0x02", registerTx: "0x03" }, {})
  const { invoiceId } = await startOrder(r.page, "rows-open-to-finish", { method: "btc" })
  await r.page.goto("/#/trademarks")
  await control(r.request, `settle/${invoiceId}`)
  await expect.poll(async () => (await mockRegistration(r.request, invoiceId)).phase, { timeout: REGISTRATION_MS }).toBe("committed")
  await r.page.waitForTimeout(8000)
  await failed(r, "rows-failed")
  const code = await issued(r)
  await control(r.request, "take", { label: "rows-taken-code" })
  await useCode(r.page, code)
  await searchHere(r.page, "rows-taken-code")
  await toReview(r.page)
  await press(r.page, "Register with your code")
  await heading(r.page, "Someone registered it first")
  await takenOrder(r.page, r.request, "rows-taken-spent")
  const spend = await r.page.context().newPage()
  await yourNames(spend, ["rows-taken-spent"])
  await listRow(spend, "rows-taken-spent").getByRole("button", { name: "Use" }).click()
  await searchHere(spend, seven(r.id))
  await toReview(spend)
  await chooseMethod(spend, "Card")
  await payButton(spend).click()
  await spend.waitForURL(/\?order=/)
  await control(r.request, `settle/${orderOf(spend)}`)
  await waitRegistered(spend, seven(r.id))
  await spend.close()
  await control(r.request, "search", { unsentSeconds: 120 })
  await useCode(r.page, await issued(r))
  await searchHere(r.page, "rows-committing")
  await toReview(r.page)
  await press(r.page, "Register with your code")
  await r.page.waitForURL(/\?registration=/)
  await yourNames(r.page, ["rows-queued", "rows-committing", "rows-taken-spent"])
}, { covers: PROGRESS_ROWS, timeout: 400_000 })

const REGISTERED_ROWS = ["names-row-registered-chats", "names-row-registered-no-links", "names-row-registered-answer-failed", "names-row-registered-code-shown",
  "names-row-registered-other-owner", "names-row-registered-elsewhere", "names-row-registered-community", "names-row-expired"]
screen(3046, "names-rows-registered", async (r) => {
  await registered(r, "rows-chats", { contact: contactLink("CP"), channel: channelLink("CP") })
  await registered(r, "rows-no-links")
  await registered(r, "rows-answer-failed", { contact: contactLink("AF"), channel: "" })
  await registered(r, "rows-code-shown")
  const elsewhereId = await registered(r, "rows-elsewhere")
  await ownerSetsResolver(await ownerCodeOf(r.page, elsewhereId), "rows-elsewhere", OTHER_OWNER)
  await contractsOwnerLists("rows-community")
  await registered(r, "rows-community")
  const expiresAt = START_S + 2 * YEAR_S
  const other = await faked(r, "rows-other-owner", { phase: "registered", expiresAt, commitTx: "0x02", registerTx: "0x03" })
  await answerName(r.page, "rows-other-owner", registeredFor(other, expiresAt, { owner: CHAIN.sponsor }))
  const expired = await faked(r, "rows-expired", { phase: "registered", expiresAt: r.now - 86400, commitTx: "0x02", registerTx: "0x03" })
  await answerName(r.page, "rows-expired", registeredFor(expired, r.now - 86400))
  await r.page.route(`**/api/name/${hex(labelHash("rows-answer-failed"))}*`, (route) => answer(route, 503, "unavailable"))
  await yourNames(r.page, ["rows-chats", "rows-expired"])
  await listRow(r.page, "rows-code-shown").getByRole("button", { name: "Name code" }).click()
  await expect(listRow(r.page, "rows-code-shown").locator("svg").first()).toBeVisible()
}, { covers: REGISTERED_ROWS, timeout: 400_000 })

const BALANCE_ROWS = ["names-balance-taken", "names-balance-rest", "names-balance-held-here", "names-balance-held-elsewhere", "names-balance-held-funded",
  "names-balance-refunded-whole", "names-balance-refunded-part"]
screen(3048, "names-rows-balances", async (r) => {
  await takenOrder(r.page, r.request, "rows-balance-taken")
  const rest = await startOrder(r.page, "rows-balance-rest", { method: "btc" })
  const due = await (await r.request.get(`${MOCK}/api/invoice/${rest.invoiceId}`)).json() as { cryptoAmount: string }
  await control(r.request, `settle/${rest.invoiceId}`, { paid: (Number(due.cryptoAmount) * 2).toFixed(8) })
  await waitRegistered(r.page, "rows-balance-rest")
  const spend = async (taken: string, dearer: string) => {
    const tab = await r.page.context().newPage()
    await yourNames(tab, [taken])
    await listRow(tab, taken).getByRole("button", { name: "Use" }).click()
    await searchHere(tab, dearer)
    await toReview(tab)
    await payButton(tab).click()
    await tab.waitForURL(/\?order=/)
    const invoiceId = orderOf(tab)
    await tab.close()
    return invoiceId
  }
  await takenOrder(r.page, r.request, "rows-held-here")
  await clockAt(r, 150)
  await spend("rows-held-here", seven(`${r.id}-here`))
  await takenOrder(r.page, r.request, "rows-held-funded")
  await clockAt(r, 270)
  await control(r.request, `partial/${await spend("rows-held-funded", seven(`${r.id}-funded`))}`)
  const away = await takenOrder(r.page, r.request, "rows-held-elsewhere")
  await clockAt(r, 390)
  const other = await elsewhere(r, "/#/trademarks")
  await addNameCode(other, away.ownerCode)
  await listRow(other, "rows-held-elsewhere").getByRole("button", { name: "Use" }).click()
  await searchHere(other, seven(`${r.id}-away`))
  await toReview(other)
  await payButton(other).click()
  await other.waitForURL(/\?order=/)
  const whole = await takenOrder(r.page, r.request, "rows-refunded-whole")
  await control(r.request, `refund/${whole.invoiceId}`)
  const part = await takenOrder(r.page, r.request, "rows-refunded-part")
  await control(r.request, `refund/${part.invoiceId}`)
  await control(r.request, `credit/${await registrationOf(r.request, part.invoiceId)}`, { cents: 5000 })
  await yourNames(r.page, ["rows-balance-taken", "rows-refunded-part"])
}, { covers: BALANCE_ROWS, timeout: 400_000 })

const CODE_ROWS = ["names-code-checking", "names-code-used", "names-code-reserved", "names-code-expired", "names-code-unpaid", "names-code-not-valid",
  "names-code-unchecked", "names-code-rate-limited"]
screen(3050, "names-rows-codes", async (r) => {
  const codes: Record<string, string> = {}
  for (const state of ["checking", "used", "reserved", "expired", "unpaid", "revoked", "unchecked", "limited"]) {
    codes[state] = await issued(r, {}, 7)
    if (["used", "reserved", "expired", "unpaid", "revoked"].includes(state)) await control(r.request, "code/state", { code: codes[state], state })
  }
  await r.page.goto("/#/trademarks")
  await r.page.evaluate(([list, at]) => {
    for (const code of list) localStorage.setItem(`simplex-names:code:${code}`, JSON.stringify({ code, minLength: 7, years: 2, addedAt: at }))
  }, [Object.values(codes), new Date(r.now * 1000).toISOString()] as const)
  await r.page.route("**/api/code/check", (route) => {
    const { code } = route.request().postDataJSON() as { code: string }
    if (code === codes.checking) return held()
    if (code === codes.unchecked) return answer(route, 503, "provider_unavailable")
    if (code === codes.limited) return answer(route, 429, "rate_limited", 30)
    return route.fallback()
  })
  await yourNames(r.page, Object.values(codes))
}, { covers: CODE_ROWS, timeout: 300_000 })

const PENDING_ROWS = ["names-pending-this-tab", "names-pending-other-tab", "names-pending-finding", "names-pending-none", "names-pending-unchecked"]
screen(3052, "names-rows-pending", async (r) => {
  const owners: Record<string, string> = {}
  for (const name of ["rows-pending-other", "rows-pending-none", "rows-pending-unchecked", "rows-pending-finding"]) {
    const tab = await r.page.context().newPage()
    await codeStep(tab, name)
    owners[name] = checksumAddress(walletOf(await checkoutOwnerCode(tab))!.address).toLowerCase()
    await tab.close()
  }
  await codeStep(r.page, "rows-pending-here")
  await r.page.route("**/api/registration/find", (route) => {
    const { owner } = route.request().postDataJSON() as { owner: string }
    if (owner.toLowerCase() === owners["rows-pending-finding"]) return held()
    if (owner.toLowerCase() === owners["rows-pending-unchecked"]) return answer(route, 503, "provider_unavailable")
    return route.fallback()
  })
  await yourNames(r.page, ["rows-pending-here", "rows-pending-finding"])
  for (const name of ["rows-pending-none", "rows-pending-unchecked", "rows-pending-finding"]) {
    await listRow(r.page, name).getByRole("button", { name: "Find the order" }).click()
    await r.page.waitForTimeout(1500)
  }
}, { covers: PENDING_ROWS, timeout: 300_000 })

screen(3054, "names-pending-held", async (r) => {
  await codeStep(r.page, r.id)
  const ownerCode = await checkoutOwnerCode(r.page)
  await control(r.request, "search", { findLimitSeconds: 60 })
  const tab = await r.page.context().newPage()
  await tab.goto("/#/code")
  await codeField(tab).fill(ownerCode)
  await shown(tab, "Too many checks just now")
  await tab.getByRole("link", { name: "Your names" }).first().click()
  await heading(tab, "Your names")
  await expect(listRow(tab, r.id)).toBeVisible()
  await tab.waitForTimeout(1000)
  return tab
})
screen(3056, "names-balance-taken-codes-only", async (r) => {
  await takenOrder(r.page, r.request, r.id)
  await control(r.request, "mode", { mode: "codes" })
  await yourNames(r.page, [r.id])
})
screen(3058, "names-popup-refund", async (r) => {
  await takenOrder(r.page, r.request, r.id)
  await yourNames(r.page, [r.id])
  await listRow(r.page, r.id).getByRole("button", { name: "Refund" }).click()
  await expect(r.page.getByRole("dialog")).toBeVisible()
})
screen(3060, "names-popup-community", async (r) => {
  await control(r.request, "community", { label: r.id, for: "bakers and pastry chefs" })
  await registered(r, r.id)
  await yourNames(r.page, [r.id])
  await listRow(r.page, r.id).getByRole("button", { name: "Community" }).click()
  await expect(r.page.getByRole("dialog")).toBeVisible()
})
const chatPopup = async (r: Reach, open: (row: Locator) => Promise<void>) => {
  await registered(r, r.id, { contact: contactLink("CP"), channel: channelLink("CP") })
  await yourNames(r.page, [r.id])
  await open(listRow(r.page, r.id))
  await expect(r.page.getByRole("dialog")).toBeVisible()
}
screen(3062, "names-popup-chat-contact", (r) => chatPopup(r, (row) => row.locator(".name .tld").click()))
screen(3064, "names-popup-chat-channel", (r) => chatPopup(r, (row) => row.locator(".chats .chat").nth(1).click()))

const verdict = (page: Page) => expect(page.locator(".code-entry .verdict")).not.toBeEmpty()
const checked = async (page: Page, code: string) => {
  await page.goto("/#/code")
  await codeField(page).fill(code)
  await verdict(page)
  await page.waitForTimeout(500)
}
const NO_ORDER_CODE = "SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G"
screen(3066, "names-check-empty", async ({ page }) => {
  await page.goto("/#/code")
  await expect(codeField(page)).toBeVisible()
})
screen(3068, "names-check-mistyped", ({ page }) => checked(page, "SN7-BJTBP-29596-R3HJ8-25YM8"))
screen(3070, "names-check-unfinished", async ({ page }) => {
  await page.goto("/#/code")
  await codeField(page).fill("SN7-BJTBP")
  await codeField(page).press("Enter")
  await verdict(page)
})
screen(3072, "names-check-camera-refused", async (r) => {
  const phone = await cameraPage(r, false)
  await phone.goto("/#/code")
  await onStep(phone).getByRole("button", { name: "Scan QR code" }).click()
  await verdict(phone)
  return phone
}, { sizes: ["phone"] })
screen(3074, "names-check-scanning", async (r) => {
  const phone = await cameraPage(r, true)
  await phone.goto("/#/code")
  await onStep(phone).getByRole("button", { name: "Scan QR code" }).click()
  await expect.poll(() => phone.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
  return phone
}, { sizes: ["phone"] })
screen(3076, "names-check-prepaid-unused", async (r) => checked(r.page, await issued(r, {}, 8)))
for (const [slot, state] of [[3078, "reserved"], [3082, "used"], [3084, "revoked"], [3086, "expired"], [3088, "unpaid"]] as const) {
  screen(slot, `names-check-prepaid-${state}`, async (r) => checked(r.page, await issued(r, { state })))
}
screen(3089, "names-check-prepaid-reserved-own", async (r) => {
  const code = await withCode(r, 6)
  await control(r.request, "search", { unsentSeconds: 60 })
  await searchHere(r.page, r.id)
  await toReview(r.page)
  await press(r.page, "Register with your code")
  await r.page.waitForURL(/\?registration=/)
  await control(r.request, `fail/${new URL(r.page.url()).searchParams.get("registration")}`)
  await control(r.request, "search", { unsentSeconds: 0 })
  await heading(r.page, "Not registered")
  await checked(r.page, code)
})
screen(3090, "names-check-prepaid-unknown", async (r) => {
  await r.page.route("**/api/code/check", (route) => answer(route, 400, "code_invalid"))
  await checked(r.page, await issued(r))
})
screen(3092, "names-check-prepaid-rate-limited", async (r) => {
  await r.page.route("**/api/code/check", (route) => answer(route, 429, "rate_limited", 30))
  await checked(r.page, await issued(r))
})
screen(3094, "names-check-prepaid-unchecked", async (r) => {
  await r.page.route("**/api/code/check", (route) => answer(route, 503, "provider_unavailable"))
  await checked(r.page, await issued(r))
})
const ownerChecked = async (r: Reach, before: (other: Page, invoiceId: string) => Promise<unknown> = async () => undefined) => {
  const { invoiceId, ownerCode } = await startOrder(r.page, r.id, { method: "btc" })
  const other = await elsewhere(r, "/#/trademarks")
  await before(other, invoiceId)
  await checked(other, ownerCode)
  return other
}
screen(3096, "names-check-owner-found", (r) => ownerChecked(r))
screen(3098, "names-check-owner-none", ({ page }) => checked(page, NO_ORDER_CODE))
screen(3100, "names-check-owner-other", async ({ page, now }) => {
  await page.route("**/api/registration/find", (route) => route.fulfill({ json: { registrations: [{
    registrationId: "reg-x", invoiceId: null, phase: "unpaid", createdAt: new Date(now * 1000).toISOString(), labelHash: hex(labelHash("someone-else")), sealed: "sealed",
    balanceSource: null, heldBy: null,
  }] } }))
  await checked(page, newOwnerCode())
})
screen(3102, "names-check-owner-rate-limited", async ({ page, request }) => {
  await control(request, "search", { findLimitSeconds: 60 })
  await checked(page, NO_ORDER_CODE)
})
screen(3104, "names-check-owner-unchecked", async ({ page }) => {
  await page.route("**/api/registration/find", (route) => answer(route, 503, "provider_unavailable"))
  await checked(page, NO_ORDER_CODE)
})
const added = async (r: Reach, read: (route: Route) => Promise<unknown>, says?: string) => {
  const other = await ownerChecked(r, async (page, invoiceId) => {
    await page.route(`**/api/invoice/${invoiceId}*`, read)
    await page.route(`**/api/registration/${await registrationOf(r.request, invoiceId)}*`, read)
  })
  await press(other, "Add to Your names")
  if (says) await shown(other, says)
  await other.waitForTimeout(1000)
  return other
}
screen(3106, "names-check-adding", (r) => added(r, held))
screen(3108, "names-check-add-none", (r) => added(r, (route) => answer(route, 404, "not_found")))
screen(3110, "names-check-add-unasked", (r) => added(r, (route) => route.abort()))
screen(3112, "names-check-add-other", (r) => added(r, async (route) => {
  const res = await route.fetch()
  const json = await res.json()
  const view = json.registration ?? json
  view.commitment = `0x${"02".repeat(32)}`
  await route.fulfill({ response: res, json })
}))
screen(3114, "names-check-add-held", (r) => added(r, (route) => answer(route, 429, "rate_limited", 20)))
screen(3116, "names-check-held-at-open", async ({ page, request }) => {
  await control(request, "search", { findLimitSeconds: 60 })
  await checked(page, NO_ORDER_CODE)
  await page.locator("body > header").getByRole("link", { name: "Your names" }).click()
  await heading(page, "Your names")
  await page.locator("body > header").getByRole("link", { name: "Check your code" }).click()
  await expect(codeField(page)).toBeVisible()
  await page.waitForTimeout(800)
})
screen(3118, "names-check-from-order", async (r) => {
  const { invoiceId, ownerCode } = await startOrder(r.page, r.id, { method: "btc" })
  await control(r.request, `settle/${invoiceId}`)
  await waitRegistered(r.page, r.id)
  const other = await elsewhere(r, `/?order=${invoiceId}`)
  await press(other, "Restore with your name code")
  await codeField(other).fill(ownerCode)
  await verdict(other)
  return other
})

const editOf = async (r: Reach, links: { contact: string; channel: string } | null = null) => {
  const registrationId = await registered(r, r.id, links)
  await r.page.goto(`/#/edit/${registrationId}`)
  await heading(r.page, /Edit links/)
  await expect(onStep(r.page).locator(".link-field").first()).toBeVisible()
  await r.page.waitForTimeout(1000)
  return registrationId
}
const editFaked = async (r: Reach, change: Record<string, unknown>, answered: (order: KeptOrder) => Record<string, unknown> | null) => {
  const order = await kept(r, `reg-${r.id}`, null, r.id)
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => route.fulfill({ json: registrationView(order, { commitTx: "0x02", registerTx: "0x03", ...change }) }))
  const json = answered(order)
  if (json) await answerName(r.page, r.id, json)
  await r.page.goto("about:blank")
  await r.page.goto(`/#/edit/reg-${r.id}`)
  return order
}
const SAVE = "Save links"
screen(3120, "names-edit-loading", async (r) => {
  await kept(r, `reg-${r.id}`, null, r.id)
  await r.page.route(`**/api/registration/reg-${r.id}*`, held)
  await r.page.goto("about:blank")
  await r.page.goto(`/#/edit/reg-${r.id}`)
  await shown(r.page, "Reading the name")
})
screen(3122, "names-edit-no-code", async ({ page }) => {
  await page.goto("/#/edit/nosuchname")
  await shown(page, "The name code is not in this browser")
})
screen(3124, "names-edit-unreadable", async (r) => {
  await kept(r, `reg-${r.id}`, null, r.id)
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => answer(route, 503, "provider_unavailable"))
  await r.page.goto(`/#/edit/reg-${r.id}`)
  await shown(r.page, "The name could not be read now")
})
screen(3126, "names-edit-unreadable-reading", async (r) => {
  await kept(r, `reg-${r.id}`, null, r.id)
  let reads = 0
  await r.page.route(`**/api/registration/reg-${r.id}*`, (route) => reads++ === 0 ? answer(route, 503, "provider_unavailable") : held())
  await r.page.goto(`/#/edit/reg-${r.id}`)
  await shown(r.page, "The name could not be read now")
  await press(r.page, "Try again")
  await r.page.waitForTimeout(500)
})
screen(3128, "names-edit-expired-now", async (r) => {
  await editFaked(r, { phase: "registered", expiresAt: r.now - 200 * 86400 }, () => null)
  await shown(r.page, "This name has expired")
})
screen(3130, "names-edit-expired-from", async (r) => {
  await editFaked(r, { phase: "registered", expiresAt: r.now - 86400 }, (order) => registeredFor(order, r.now - 86400))
  await shown(r.page, "This name has expired")
})
screen(3132, "names-edit-expired-taken", async (r) => {
  await editFaked(r, { phase: "registered", expiresAt: r.now - 100 * 86400 }, (order) => registeredFor(order, r.now + YEAR_S, { owner: OTHER_OWNER }))
  await shown(r.page, "This name has expired")
})
screen(3134, "names-edit-other-owner", async (r) => {
  const expiresAt = START_S + 2 * YEAR_S
  await editFaked(r, { phase: "registered", expiresAt }, (order) => registeredFor(order, expiresAt, { owner: OTHER_OWNER }))
  await shown(r.page, "This name has another owner")
})
screen(3136, "names-edit-elsewhere", async (r) => {
  const registrationId = await registered(r, r.id)
  await ownerSetsResolver(await ownerCodeOf(r.page, registrationId), r.id, OTHER_OWNER)
  await r.page.goto(`/#/edit/${registrationId}`)
  await shown(r.page, "This name's links are kept elsewhere")
})
screen(3138, "names-edit-not-registered", async (r) => {
  await control(r.request, "search", { unsentSeconds: 120 })
  await useCode(r.page, await issued(r))
  await searchHere(r.page, r.id)
  await toReview(r.page)
  await press(r.page, "Register with your code")
  await r.page.waitForURL(/\?registration=/)
  await r.page.goto(`/#/edit/${new URL(r.page.url()).searchParams.get("registration")}`)
  await shown(r.page, "The name is not registered yet")
})
screen(3140, "names-edit-form-empty", async (r) => { await editOf(r) })
screen(3142, "names-edit-form-both", async (r) => { await editOf(r, { contact: contactLink("EB"), channel: channelLink("EB") }) })
screen(3144, "names-edit-form-one", async (r) => { await editOf(r, { contact: contactLink("L1"), channel: "" }) })
const editsUsed = async (r: Reach, count: number) => {
  const registrationId = await registered(r, r.id)
  await control(r.request, "edits", { label: r.id, count, at: r.now })
  await r.page.goto(`/#/edit/${registrationId}`)
  await heading(r.page, /Edit links/)
  await r.page.waitForTimeout(1000)
}
screen(3146, "names-edit-form-last-edit", (r) => editsUsed(r, 2))
screen(3148, "names-edit-form-none-left", (r) => editsUsed(r, 3))
const RECORDS = /\/api\/name\/records$/
const saveWith = async (r: Reach, refuse: ((route: Route) => Promise<unknown>) | null, says?: string) => {
  await editOf(r)
  await linkField(r.page).fill(contactLink("SV"))
  await previewsShown(r.page)
  if (refuse) await r.page.route("**/api/name/records", posting(RECORDS, refuse))
  await press(r.page, SAVE)
  if (says) await shown(r.page, says)
  await r.page.waitForTimeout(800)
}
screen(3150, "names-edit-sending", (r) => saveWith(r, held))
screen(3152, "names-edit-checking-link", async (r) => {
  const slow = contactLink("UnrSave")
  await control(r.request, "search", { fetchDelays: { [slow]: 120_000 } })
  await editOf(r)
  await linkField(r.page).fill(slow)
  await press(r.page, SAVE)
  await r.page.waitForTimeout(800)
})
screen(3154, "names-edit-nothing", async (r) => {
  await editOf(r)
  await press(r.page, SAVE)
  await shown(r.page, "Nothing has changed.")
})
screen(3156, "names-edit-saved", (r) => saveWith(r, null, "Links saved"))
screen(3158, "names-edit-unanswered", (r) => saveWith(r, (route) => route.abort(), "No answer yet"))
screen(3160, "names-edit-moved", async (r) => {
  await editOf(r)
  await linkField(r.page).fill(contactLink("SV"))
  await previewsShown(r.page)
  await r.page.route("**/api/name/records", posting(RECORDS, (route) => answer(route, 400, "bad_request")))
  await r.page.route(`**/api/name/${hex(labelHash(r.id))}*`, async (route) => {
    const res = await route.fetch()
    const json = await res.json()
    await route.fulfill({ response: res, json: { ...json, recordsNonce: (json.recordsNonce ?? 0) + 2, records: { contact: contactLink("MV"), channel: channelLink("MV") } } })
  })
  await press(r.page, SAVE)
  await shown(r.page, "An earlier save")
})
screen(3162, "names-edit-refused", (r) => saveWith(r, (route) => answer(route, 400, "bad_request"), "The links were not saved."))
screen(3164, "names-edit-held", (r) => saveWith(r, (route) => answer(route, 429, "rate_limited", 30), "Too many attempts"))
screen(3166, "names-edit-held-at-open", async (r) => {
  const registrationId = await registered(r, r.id)
  await control(r.request, "search", { findLimitSeconds: 60 })
  await checked(r.page, NO_ORDER_CODE)
  await r.page.locator("body > header").getByRole("link", { name: "Your names" }).click()
  await heading(r.page, "Your names")
  await listRow(r.page, r.id).getByRole("button", { name: /^(Edit|Add) links$/ }).click()
  await r.page.waitForURL((url) => url.hash === `#/edit/${registrationId}`)
  await r.page.waitForTimeout(1000)
})
screen(3168, "names-edit-limited", async (r) => {
  await editOf(r)
  await control(r.request, "edits", { label: r.id, count: 3, at: r.now })
  await linkField(r.page).fill(contactLink("SV"))
  await previewsShown(r.page)
  await press(r.page, SAVE)
  await shown(r.page, "You can edit links again on")
})
const editTyped = async (r: Reach, link: string, links: { contact: string; channel: string } | null = null) => {
  await editOf(r, links)
  await linkField(r.page).fill(link)
  await r.page.waitForTimeout(800)
  await blurred(r.page)
  await r.page.waitForTimeout(800)
}
screen(3170, "names-edit-field-not-a-link", (r) => editTyped(r, "https://bakery.example/menu"))
screen(3172, "names-edit-field-too-long", (r) => editTyped(r, `${contactLink("A")}?x=${"a".repeat(1100)}`))
screen(3174, "names-edit-field-kind-held-filled", (r) => editTyped(r, channelLink("X1"), { contact: contactLink("EB"), channel: channelLink("EB") }))
const editOne = async (r: Reach) => {
  await editOf(r, { contact: contactLink("L1"), channel: "" })
  await press(r.page, "Add a channel link")
}
screen(3176, "names-edit-field-kind-held-empty", async (r) => {
  await editOne(r)
  await linkField(r.page).fill(channelLink("X1"))
  await r.page.waitForTimeout(800)
})
screen(3178, "names-edit-field-other-kind-filled", async (r) => {
  await editOne(r)
  await linkField(r.page, "Channel").fill(contactLink("X2"))
  await r.page.waitForTimeout(800)
})
screen(3180, "names-edit-field-other-kind-empty", async (r) => {
  await editOne(r)
  await linkField(r.page).fill("")
  await linkField(r.page, "Channel").fill(contactLink("X2"))
  await r.page.waitForTimeout(800)
})
screen(3182, "names-edit-field-not-kind", async (r) => {
  await editOne(r)
  await linkField(r.page, "Channel").fill("hello")
  await r.page.waitForTimeout(800)
})
screen(3184, "names-edit-field-refused", async (r) => {
  await r.page.route("**/api/link/preview", (route) => answer(route, 400, "invalid_link"))
  await editTyped(r, contactLink("X3"))
})
screen(3186, "names-edit-field-unanswered", async (r) => {
  await editOf(r)
  await r.page.route("**/api/link/preview", (route) => answer(route, 503, "provider_unavailable", 30))
  await linkField(r.page).fill(contactLink("X4"))
  await r.page.waitForTimeout(1500)
})
screen(3188, "names-edit-field-several", async (r) => {
  const registrationId = await registered(r, r.id)
  const { ownerSetsText } = await import("./helpers.ts")
  await ownerSetsText(await ownerCodeOf(r.page, registrationId), r.id, "simplex.contact", `${contactLink("L1")};${contactLink("L2")}`)
  await r.page.goto(`/#/edit/${registrationId}`)
  await shown(r.page, "Several links.")
})
const editCamera = async (r: Reach, grant: boolean) => {
  const registrationId = await registered(r, r.id)
  const ownerCode = await ownerCodeOf(r.page, registrationId)
  const phone = await cameraPage(r, grant)
  await addNameCode(phone, ownerCode)
  await phone.goto(`/#/edit/${registrationId}`)
  await heading(phone, /Edit links/)
  await onStep(phone).getByRole("button", { name: "Scan QR code" }).click()
  return phone
}
screen(3190, "names-edit-field-camera-refused", async (r) => {
  const phone = await editCamera(r, false)
  await shown(phone, "Allow the camera, or paste the link.")
  return phone
}, { sizes: ["phone"] })
screen(3192, "names-edit-field-scanning", async (r) => {
  const phone = await editCamera(r, true)
  await expect.poll(() => phone.locator("video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0)
  return phone
}, { sizes: ["phone"] })

