import { sha256 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
import { expect, type Page, type Route, test } from "@playwright/test"
import { withMode } from "../dev/mode.ts"
import { labelHash, YEAR_S } from "../src/crypto/registration.ts"
import { checksumAddress, hex } from "../src/crypto/wallet.ts"
import { walletOf } from "../src/flow.ts"

const NOW = Date.UTC(2026, 10, 2, 9, 30)
const DATE = { date: new Date(NOW).toUTCString() }
const TERM_START = Date.UTC(2027, 0, 1) / 1000
const EXPIRES_AT = Date.UTC(2029, 0, 1) / 1000
const CREATED = "2026-10-30T09:00:00.000Z"
const LABEL = "bakeryhouse"
const OWNER_CODE = "SN-DWPHS-6JBFR-ZR1MA-T5HQ9-P17QM-F5GM5"
const OWNER = checksumAddress(walletOf(OWNER_CODE)!.address)
const RIVAL = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const COMMITMENT = `0x${"01".repeat(32)}`
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const TERMS_TEXT = "## Community names\n\nA community name is held for its community, not for one person or business.\n\n- Its owner uses it for the community it names.\n- Its links open the community's own chats."
const TERMS_LINK = `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${"5d43ed1c".repeat(5)}/docs/names/terms.md#sha256=${bytesToHex(sha256(utf8ToBytes(TERMS_TEXT)))}`
const TERMS = { hash: `0x${bytesToHex(keccak_256(utf8ToBytes(TERMS_LINK)))}`, link: TERMS_LINK }
const COMMUNITY = { for: "the bakers of Lisbon", years: 2 }
const CONTACT = "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9"
const CHANNEL = "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4"
const LINKS = { contact: CONTACT, channel: CHANNEL }
const PROFILES: Record<string, object> = {
  [CONTACT]: { type: "address", kind: "contact", displayName: "Bakery House", fullName: "Bread and pastries in Lisbon", image: null, subscribers: null, profile: "ok" },
  [CHANNEL]: { type: "channel", kind: "channel", displayName: "Bakery News", fullName: "", image: null, subscribers: 1280, profile: "ok" },
}
const BALANCE = { amount: 10000, held: false, heldUntil: null, refunded: 0 }
const REGISTERED = { phase: "registered", commitTx: "0x02", registerTx: "0x03", expiresAt: EXPIRES_AT }
const ARRIVED = { cryptoAmountPaid: "0.00142857", paidInFull: true }
const PAID = { ...ARRIVED, status: "paid" }
const CODE = { display: "SN8-7QKXM-2HV9D-RT4WN-C8JPE", minLength: 8, years: 5 }

const NAME = `/api/name/${hex(labelHash(LABEL))}`
const SEARCH = `/#/?name=${LABEL}`
const AVAILABLE = { status: "available", price: 10000, currency: "USD", years: 2, termStart: TERM_START, community: null, terms: TERMS, ...CHAIN }

const registered = (owner: string) => ({
  status: "registered", entities: [CONTACT, CHANNEL].map((link) => ({ ...PROFILES[link], link, deepLink: null })), owner, resolver: CHAIN.resolver, chainId: CHAIN.chainId,
  records: LINKS, recordsNonce: 0, recordEdits: { left: 3, nextAt: null }, expiresAt: EXPIRES_AT, tld: "simplex", community: null,
})

const view = (id: string, label: string, change: object = {}) => ({
  ...CHAIN, id, version: 1, phase: "unpaid", labelHash: hex(labelHash(label)), label, owner: OWNER, commitment: COMMITMENT, sealed: "sealed", years: 2, duration: 2 * YEAR_S, price: 10000,
  fromBalance: 0, balance: null, latePayment: null, moves: 0, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, acceptance: null, unread: [],
  expiresAt: null, error: null, linksRefused: false, community: null, terms: TERMS.hash.slice(2), ...change,
})

const invoice = (id: string, registration: object, change: object = {}) => ({
  invoiceId: id, status: "open", amount: 10000, currency: "USD", expiresAt: new Date(NOW + 15 * 60_000).toISOString(), kind: "name", registration,
  cryptoCurrency: "btc", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", cryptoAmount: "0.00142857", requiredConfirmations: 1, ...change,
})

const order = (id: string, invoiceId: string | null, label = LABEL, change: object = {}) => ({
  registrationId: id, invoiceId, label, ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: invoiceId ? "btc" : "code", paid: 10000, years: 2, tld: "simplex",
  terms: TERMS.hash.slice(2), createdAt: CREATED, request: { labelHash: hex(labelHash(label)), length: label.length, duration: 2 * YEAR_S, owner: OWNER, commitment: COMMITMENT, sealed: "sealed" },
  ...change,
})

const checkout = (change: object = {}) => ({
  label: LABEL, price: 10000, years: 2, termStart: TERM_START, chain: CHAIN, terms: TERMS, community: null, contact: "", channel: "", method: "btc", code: null, balance: null,
  ownerCode: OWNER_CODE, saved: true, agreed: false, searchAt: 0, step: "review", ...change,
})

interface Scene {
  name: string
  url: string
  ready: string
  api?: Record<string, unknown>
  orders?: ReturnType<typeof order>[]
  codes?: { code: string; minLength: number; years: number; addedAt: string }[]
  checkout?: ReturnType<typeof checkout>
  activeCode?: typeof CODE
  codesOnly?: boolean
  phone?: boolean
  act?: (page: Page) => Promise<unknown>
}

const invoiceScene = (name: string, ready: string, change: object, registration: object = {}, api: Record<string, unknown> = {}): Scene => ({
  name, ready, url: "/?order=inv-1", orders: [order("reg-1", "inv-1")], api: { "/api/invoice/inv-1": invoice("inv-1", view("reg-1", LABEL, registration), change), ...api },
})

const SCENES: Scene[] = [
  { name: "home", url: "/#/", ready: "text=One name for your public channel" },
  { name: "search-available", url: SEARCH, ready: ".answer .price", api: { [NAME]: AVAILABLE } },
  { name: "search-taken", url: SEARCH, ready: ".answer .chat", api: { [NAME]: registered(RIVAL) } },
  { name: "search-reserved", url: SEARCH, ready: "text=Reserved names are not sold here", api: { [NAME]: { status: "reserved", community: null } } },
  { name: "search-rule", url: "/#/?name=abc", ready: "text=A name has 6 letters or more" },
  { name: "codes-only", url: "/#/", ready: "text=Register with code", codesOnly: true },
  { name: "offline", url: "/#/", ready: "text=You are offline", act: (page) => page.context().setOffline(true) },
  { name: "menu", url: "/#/", ready: "#menu", phone: true, act: (page) => page.getByRole("button", { name: "Menu" }).click() },
  { name: "links", url: "/#/checkout/links", ready: "text=Paste your SimpleX contact address", checkout: checkout({ step: "links" }) },
  { name: "links-filled", url: "/#/checkout/links", ready: ".link-field .entity", checkout: checkout({ step: "links", ...LINKS }) },
  { name: "name-code", url: "/#/checkout/code", ready: "text=Save your name code", checkout: checkout({ step: "code", saved: false }) },
  { name: "community-terms", url: "/#/checkout/community", ready: ".terms-text", checkout: checkout({ step: "community", community: COMMUNITY }),
    api: { [`/api/terms/${TERMS.hash}`]: { link: TERMS.link, text: TERMS_TEXT } } },
  { name: "review", url: "/#/checkout", ready: ".order .chat", checkout: checkout(LINKS) },
  { name: "review-code", url: "/#/checkout", ready: "text=Free SimpleX name", checkout: checkout({ code: CODE }), activeCode: CODE },
  invoiceScene("pay-bitcoin", ".name-check:not(.unchecked)", {}, {}, { [NAME]: AVAILABLE }),
  invoiceScene("confirming", "text=Confirming your payment", ARRIVED),
  invoiceScene("taken", ".stage.failed", PAID, { phase: "taken", commitTx: "0x02", balance: BALANCE }, { [NAME]: registered(RIVAL) }),
  invoiceScene("failed", "text=Paid, not registered", PAID, { phase: "failed", commitTx: "0x02" }, { [NAME]: AVAILABLE }),
  invoiceScene("invoice-closed", "text=Invoice closed", { status: "expired", expiresAt: new Date(NOW - 60_000).toISOString() }),
  invoiceScene("card-failed", "text=Card payment not confirmed", { cryptoCurrency: undefined, address: undefined, cryptoAmount: undefined, requiredConfirmations: undefined, clientSecret: "pi_1_secret_1" }),
  { name: "registering", url: "/?registration=reg-1", ready: ".countdown", orders: [order("reg-1", null)],
    api: { "/api/registration/reg-1": view("reg-1", LABEL, { phase: "committed", label: null, commitTx: "0x02", revealAfter: NOW / 1000 + 90 }) } },
  { name: "registered", url: "/?registration=reg-1", ready: ".card.use", orders: [order("reg-1", null, LABEL, LINKS)], api: { "/api/registration/reg-1": view("reg-1", LABEL, REGISTERED) } },
  { name: "names-empty", url: "/#/names", ready: ".card.none" },
  { name: "names", url: "/#/names", ready: ".code-row .chip.ok",
    orders: [order("reg-a", null, LABEL, { ...LINKS, createdAt: "2026-10-31T09:00:00.000Z" }), order("reg-b", "inv-b", "bakerylisbon"), order("reg-c", "inv-c", "bakery-shop", { createdAt: "2026-10-29T09:00:00.000Z" })],
    codes: [{ code: CODE.display, minLength: CODE.minLength, years: CODE.years, addedAt: CREATED }],
    api: { "/api/registration/reg-a": view("reg-a", LABEL, REGISTERED), [NAME]: registered(OWNER), "/api/invoice/inv-b": invoice("inv-b", view("reg-b", "bakerylisbon")),
      "/api/invoice/inv-c": invoice("inv-c", view("reg-c", "bakery-shop", { phase: "taken", commitTx: "0x02", balance: BALANCE }), PAID),
      "/api/code/check": { minLength: CODE.minLength, years: CODE.years, state: "unused" } } },
  { name: "check-code", url: "/#/code", ready: "text=A code from SimpleX lets you register a free name" },
  { name: "edit-links", url: "/#/edit/reg-a", ready: "text=3 edits left this year", orders: [order("reg-a", null, LABEL, LINKS)],
    api: { "/api/registration/reg-a": view("reg-a", LABEL, REGISTERED), [NAME]: registered(OWNER) } },
  { name: "trademarks", url: "/#/trademarks", ready: "text=If you own a trademark" },
]

function answer(route: Route, api: Record<string, unknown>): Promise<void> {
  const request = route.request()
  const path = new URL(request.url()).pathname
  const json = path === "/api/link/preview" ? PROFILES[request.postDataJSON().link] : api[path]
  return route.fulfill(json === undefined ? { status: 404, json: { error: "not_found" }, headers: DATE } : { json, headers: DATE })
}

async function codesOnlyPage(route: Route): Promise<void> {
  const res = await route.fetch()
  await route.fulfill({ response: res, body: withMode(await res.text(), "codes") })
}

const storage = (scene: Scene) => ({
  local: Object.fromEntries([
    ...(scene.orders ?? []).map((o) => [`simplex-names:order:${o.registrationId}`, o] as const),
    ...(scene.codes ?? []).map((c) => [`simplex-names:code:${c.code}`, c] as const),
  ]),
  session: Object.fromEntries(Object.entries({ "simplex-names-checkout": scene.checkout, "simplex-names-code": scene.activeCode }).filter(([, value]) => value)),
})

for (const scene of SCENES) {
  test(scene.name, async ({ page }, testInfo) => {
    test.skip(scene.phone === true && !testInfo.project.name.startsWith("phone"), "the menu button shows on a phone only")
    await page.clock.setFixedTime(NOW)
    await page.addInitScript(({ local, session }) => {
      for (const [key, value] of Object.entries(local)) localStorage.setItem(key, JSON.stringify(value))
      for (const [key, value] of Object.entries(session)) sessionStorage.setItem(key, JSON.stringify(value))
    }, storage(scene))
    await page.route("https://js.stripe.com/**", (route) => route.abort())
    await page.route("**/api/**", (route) => answer(route, scene.api ?? {}))
    if (scene.codesOnly) await page.route((url) => url.pathname === "/", codesOnlyPage)
    await page.goto(scene.url)
    await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined))) })
    await scene.act?.(page)
    await expect(page.locator(scene.ready).first()).toBeVisible()
    await expect(page.locator(".skeleton")).toHaveCount(0)
    await expect(page).toHaveScreenshot(`${scene.name}.png`, { fullPage: true })
  })
}
