import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { labelHash, YEAR_S } from "../src/crypto/registration.ts"
import { hex } from "../src/crypto/wallet.ts"
import {
  agreeToTerms, CHAIN, channelLink, codeField, contactLink, control, keepOrder, type KeptOrder, MOCK, mockRegistration, onStep, payButton, previewsShown,
  REGISTRATION_MS, registrationOf, registrationView, savedToReview, search, startOrder, takenOrder, test, toFullReview, toReview, useCode, waitRegistered,
} from "./helpers.ts"

const START_S = Date.UTC(2026, 10, 2, 8) / 1000
const STEP_S = 300
const SIZES = [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const
const FAILED = "The name could not be registered"
const LAPSED = "The name was not signed in time"
const TERMS_TEXT = "The general terms, changed for the screens"
const FLAT_BACKGROUND = fileURLToPath(new URL("screens.css", import.meta.url))

interface Reach { page: Page; request: APIRequestContext; browser: Browser; id: string; now: number }

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
  [page.locator("body > main .time"), page.locator("body > main .countdown b"), page.locator('body > main .sr-only + [aria-hidden="true"] > span')]

function screen(slot: number, id: string, reach: (r: Reach) => Promise<Page | void>): void {
  test(id, async ({ page, request, browser }) => {
    const now = START_S + slot * STEP_S
    await control(request, "clock", { now })
    await control(request, "seed", { seed: id })
    await page.clock.install({ time: now * 1000 })
    await page.addInitScript(seedPageRandom, id)
    await serviceFailureTexts(page)
    const shown = await reach({ page, request, browser, id, now }) ?? page
    await shown.evaluate(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined))))
    await shown.mouse.move(0, 0)
    for (const [size, viewport] of SIZES) {
      await shown.setViewportSize(viewport)
      await expect(shown).toHaveScreenshot(`${id}-${size}.png`, { fullPage: true, mask: countdowns(shown), stylePath: FLAT_BACKGROUND })
    }
  })
}

test.afterEach(async ({ page, request }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" })
  await control(request, "search", { chainDown: false, invoiceError: null, unsentSeconds: 0, refuseLinks: false, fetchDelays: {} })
  await control(request, "general-terms", { text: null })
  await control(request, "seed", { seed: null })
})

async function elsewhere({ browser, id, now }: Reach, url: string): Promise<Page> {
  const context = await browser.newContext()
  await context.clock.install({ time: now * 1000 })
  await context.addInitScript(seedPageRandom, `${id} elsewhere`)
  await serviceFailureTexts(context)
  const page = await context.newPage()
  await page.goto(url)
  return page
}

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
  await r.page.clock.fastForward("03:10")
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

