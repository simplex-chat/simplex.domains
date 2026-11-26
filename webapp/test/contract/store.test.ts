import { readFileSync } from "node:fs"
import { join } from "node:path"
import { keccak256, toHex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as api from "../../src/api.ts"
import { configOf, LOCAL, SITE } from "../../src/config.ts"
import { bitcoinProven, moneroProven, type ViewProof } from "../../src/crypto/payees.ts"
import { initialSearch, reduce } from "../../src/screens/search.ts"

const DIR = process.env.STORE_FIXTURES

vi.mock("../../src/config.ts", async (actual) => {
  const config = await actual<typeof import("../../src/config.ts")>()
  const dir = process.env.STORE_FIXTURES
  if (!dir) return config
  const fs = await import("node:fs")
  const path = await import("node:path")
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"))
  const termsOf = (name: string) => read(name).body.found.terms
  const { bitcoinHrp, bitcoinReceiveKeys, moneroSubaddressPrefix, moneroPrimaryAddresses } = read("deployment")
  return {
    ...config,
    SITE: { ...config.SITE, generalTerms: [termsOf("search-available")], communityTerms: [termsOf("search-available-community")], bitcoinHrp, bitcoinReceiveKeys, moneroSubaddressPrefix, moneroPrimaryAddresses },
  }
})

interface Fixture { status: number; body: unknown; retryAfter?: string }

const recorded = <T>(name: string): T => JSON.parse(readFileSync(join(DIR!, `${name}.json`), "utf8")) as T
const fixture = (name: string): Fixture => recorded<Fixture>(name)

function answering(name: string): Fixture {
  const f = fixture(name)
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(f.body), { status: f.status, headers: f.retryAfter ? { "retry-after": f.retryAfter } : {} })))
  return f
}

async function refusal(name: string, send: () => Promise<unknown>): Promise<api.ApiError> {
  answering(name)
  const e = await send().then(() => null, (e: unknown) => e)
  expect(e, name).toBeInstanceOf(api.ApiError)
  return e as api.ApiError
}

const HASH = `0x${"ab".repeat(32)}`
const SIGN: api.OrderSigner = () => ({ timestamp: 0, signature: "0x" })
const LABEL = "alicebakery"
const VIEW_FIELDS = ["balance", "commitTx", "commitment", "community", "disputeDays", "duration", "id", "label", "labelHash", "latePayment", "owner", "payment", "phase", "price",
  "registerTx", "sealed", "terms", "version", "years"]

describe.skipIf(!DIR)("the names page reads the service's recorded answers", () => {
  afterEach(() => vi.unstubAllGlobals())

  const search = (name: string) => {
    answering(name)
    return api.searchName(HASH, LABEL.length)
  }
  const shown = (answer: api.SearchAnswer) => {
    const searching = reduce(initialSearch(), { type: "searched", label: LABEL, hold: null, minLength: null })
    return reduce(searching, { type: "answered", seq: searching.seq, label: LABEL, answer, mine: false, now: 0, downtime: false }).answer
  }

  it("reads the service's downtime alone, open and codes-only", () => {
    expect(configOf(fixture("config").body)).toEqual({ downtime: false })
    expect(configOf(fixture("config-codes-only").body)).toEqual({ downtime: false })
  })

  it.each([
    ["search-available", "available"], ["search-available-community", "available"], ["search-available-without-terms", "available"],
    ["search-reserved", "reserved"], ["search-reserved-community", "reserved"], ["search-taken", "taken"],
    ["search-registered", "registered"], ["search-registered-other", "registered"], ["search-registered-edits-0", "registered"], ["search-registered-edits-1", "registered"],
  ])("reads %s as a name %s and shows it found", async (name, type) => {
    const answer = await search(name)
    expect(answer.found.type).toBe(type)
    expect(shown(answer)).toMatchObject({ kind: "found", answer })
  })

  it("reads the community entry, the terms and the records of the answers that have them", async () => {
    expect((await search("search-available-community")).community).not.toBeNull()
    expect((await search("search-reserved-community")).community).not.toBeNull()
    expect((await search("search-available")).found).toMatchObject({ terms: { link: expect.any(String) } })
    expect((await search("search-available-without-terms")).found).toMatchObject({ terms: null })
    expect((await search("search-registered")).found).toMatchObject({ records: { type: "own" } })
    expect((await search("search-registered-other")).found).toMatchObject({ records: { type: "other" } })
    expect((await search("search-registered-edits-0")).found).toMatchObject({ records: { type: "own", edits: { left: 0, nextAt: expect.any(Number) } } })
  })

  it.each([
    ["search-rate-limited", "rate_limited"], ["search-provider-unavailable", "provider_unavailable"], ["search-invalid-name", "invalid_name"], ["search-bad-request", "bad_request"],
  ])("reads the refusal %s as %s", async (name, code) => {
    const e = await refusal(name, () => api.searchName(HASH, LABEL.length))
    expect(e.code).toBe(code)
  })

  it("waits out a rate limit for its Retry-After", async () => {
    expect((await refusal("search-rate-limited", () => api.searchName(HASH, LABEL.length))).retryAfter).toBeGreaterThan(0)
  })

  it.each([
    ["preview-contact", "contact", "ok"], ["preview-channel", "channel", "ok"], ["preview-bot", "bot", "ok"], ["preview-business", "business", "ok"], ["preview-unavailable", "contact", "unavailable"],
  ])("reads the preview %s as a %s, its profile %s", async (name, kind, profile) => {
    answering(name)
    expect(await api.previewLink("link")).toMatchObject({ kind, profile })
  })

  it("reads a refused preview as invalid_link", async () => {
    expect((await refusal("preview-invalid-link", () => api.previewLink("link"))).code).toBe("invalid_link")
  })

  it("reads the terms' text only as the file their link names, and their refusals", async () => {
    const { link } = fixture("terms").body as { link: string }
    answering("terms")
    expect(await api.termsText({ hash: keccak256(toHex(link)), link })).toEqual((fixture("terms").body as { text: string }).text)
    const terms = { hash: keccak256(toHex(link)), link }
    expect((await refusal("terms-not-found", () => api.termsText(terms))).code).toBe("not_found")
    const unavailable = await refusal("terms-unavailable", () => api.termsText(terms))
    expect([unavailable.code, unavailable.retryAfter]).toEqual(["terms_unavailable", 60])
  })

  it("reads a code's state and an unknown code", async () => {
    answering("code-unused")
    expect(await api.checkCode("code")).toMatchObject({ state: "unused" })
    expect((await refusal("code-invalid", () => api.checkCode("code"))).code).toBe("code_invalid")
  })

  it("reads an owner with no order as none", async () => {
    answering("find-none")
    expect(await api.findRegistrations("0x1", 0, "0x")).toEqual({ registrations: [] })
  })

  it("reads an owner's orders newest first, each with its phase", async () => {
    answering("find-orders")
    expect((await api.findRegistrations("0x1", 0, "0x")).registrations.map((r) => [r.registrationId, r.phase])).toEqual([["listed2", "queued"], ["listed1", "failed"]])
  })

  const edits = { labelHash: HASH, edits: [] }

  it("reads an applied link edit's transaction", async () => {
    answering("records-applied")
    expect(await api.editRecords(edits)).toMatchObject({ tx: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
  })

  it.each([
    ["records-reverted", "record_reverted"], ["records-pending", "edit_pending"], ["records-unavailable", "provider_unavailable"], ["records-rate-limited", "rate_limited"],
    ["records-bad-request", "bad_request"], ["records-stale-nonce", "stale_nonce"],
  ])("reads the link edit refusal %s as %s", async (name, code) => {
    expect((await refusal(name, () => api.editRecords(edits))).code).toBe(code)
  })

  it("reads the yearly edit limit with the time the next edit returns", async () => {
    const e = await refusal("records-edit-limit", () => api.editRecords(edits))
    expect(e).toBeInstanceOf(api.EditLimited)
    expect((e as api.EditLimited).nextAt).toBeGreaterThan(0)
  })

  const reveal = { label: LABEL, secret: HASH, records: { contact: null, channel: null }, nonce: 0, deadline: 1, signature: "0x", acceptance: { termsHash: HASH, nonce: 0, signature: "0x" } }
  const order = { labelHash: HASH, length: LABEL.length, duration: 1, owner: "0x1", commitment: HASH, sealed: "sealed", terms: "ab".repeat(32), timestamp: 0, signature: "0x", reveal }

  it("reads what the owner signs with an order, and the read refused while the chain is unread", async () => {
    answering("sign-read")
    expect(await api.signFor(HASH, "0x1")).toMatchObject({ type: "read", intentNonce: 4, acceptance: { community: false, nonce: 2 } })
    expect((await refusal("sign-unavailable", () => api.signFor(HASH, "0x1"))).code).toBe("name_check_unavailable")
  })

  it("reads a code order refused for changed terms with the terms and the community entry now", async () => {
    const e = await refusal("register-terms-changed", () => api.registerWithCode(order, "code"))
    expect(e).toBeInstanceOf(api.TermsChanged)
    expect((e as api.TermsChanged).community).not.toBeNull()
  })

  it.each([
    ["register-code-reserved", "code_reserved"], ["register-name-taken", "name_taken"], ["register-terms-unavailable", "terms_unavailable"],
  ])("reads the code order refusal %s as %s", async (name, code) => {
    expect((await refusal(name, () => api.registerWithCode(order, "code"))).code).toBe(code)
  })

  it.each([
    ["select-registration-changed", "registration_changed"], ["select-code-expired", "code_expired"], ["select-code-invalid", "code_invalid"],
  ])("reads the selection refusal %s as %s", async (name, code) => {
    expect((await refusal(name, () => api.selectName("r1", order))).code).toBe(code)
  })

  it("reads the order a selection met changed with the fields the mock's view has", async () => {
    const e = await refusal("select-registration-changed", () => api.selectName("r1", order))
    expect(Object.keys(e.body.registration as object).sort()).toEqual(VIEW_FIELDS)
  })

  it("reads a taken code order's view, for which a name is selected with its code, with no balance or price", async () => {
    answering("registration-taken-code")
    const view = await api.readRegistration("registration", SIGN)
    expect(Object.keys(view).sort(), "the fields the mock's view of a taken code order has").toEqual(VIEW_FIELDS)
    expect([view.phase, view.payment, view.price, view.balance, view.label]).toEqual([{ type: "taken" }, { type: "code" }, 0, null, expect.any(String)])
    expect(api.selectable(view)).toBe(true)
  })

  const viewOf = (name: string) => {
    answering(name)
    return api.readRegistration("r1", SIGN)
  }

  it.each([
    ["registration-unpaid", "unpaid"], ["registration-committed-awaiting", "committed"], ["registration-committed-awaiting-community", "committed"],
    ["registration-committed-unread", "committed"], ["registration-committed-signed", "committed"], ["registration-committed-lapsed", "committed"],
    ["registration-closed-cancelled", "closed"], ["registration-registered", "registered"], ["registration-failed", "failed"], ["registration-failed-held", "failed"],
  ])("reads the view %s, in phase %s, with the fields the mock's view has", async (name, type) => {
    const view = await viewOf(name)
    expect(view.phase.type).toBe(type)
    expect(Object.keys(view).sort()).toEqual(VIEW_FIELDS)
  })

  it("reads what a committed view asks the page to sign, a lapse, a registered name's expiry and a failed order's hold", async () => {
    expect(api.toSignOf(await viewOf("registration-committed-awaiting"))).toMatchObject({ type: "read", acceptance: { community: false } })
    expect(api.toSignOf(await viewOf("registration-committed-awaiting-community"))).toMatchObject({ type: "read", acceptance: { community: true } })
    expect(api.toSignOf(await viewOf("registration-committed-unread"))).toEqual({ type: "unread" })
    const signed = await viewOf("registration-committed-signed")
    expect([api.toSignOf(signed), api.lapsedOf(signed)]).toEqual([null, false])
    expect(api.lapsedOf(await viewOf("registration-committed-lapsed"))).toBe(true)
    expect(api.expiresAtOf(await viewOf("registration-registered"))).toEqual(expect.any(Number))
    expect((await viewOf("registration-closed-cancelled")).phase).toEqual({ type: "closed", closedBy: "cancelled" })
    expect((await viewOf("registration-failed")).phase).toEqual({ type: "failed", reason: "registryRefused" })
    expect((await viewOf("registration-failed-held")).phase).toEqual({ type: "failed", reason: "unread", heldUntil: expect.any(String) })
  })

  it("reads a name invoice for Bitcoin with its order's view, as made and as read again", async () => {
    answering("invoice-view-btc")
    const made = await api.createOrder(order, "btc", 10000)
    expect([made.status, made.cryptoCurrency, made.registration.phase]).toEqual(["open", "btc", { type: "unpaid" }])
    expect(Object.keys(made.registration).sort()).toEqual(VIEW_FIELDS)
    answering("invoice-view-btc")
    expect(await api.readInvoice(made.invoiceId, SIGN)).toEqual(made)
  })

  it("reads a name invoice refused in the service's downtime as downtime", async () => {
    expect((await refusal("invoice-downtime", () => api.createOrder(order, "btc", 10000))).code).toBe("downtime")
  })

  it("reads a reveal refused as an unknown id's as not_found", async () => {
    expect((await refusal("reveal-not-found", () => api.reveal("registration", reveal, SIGN))).code).toBe("not_found")
  })

  it.each(["registration-registered", "registration-registered-no-dispute"])("reads %s, with or without a dispute end, as registered until its expiry", async (name) => {
    answering(name)
    expect((await api.readRegistration("registration", SIGN)).phase).toMatchObject({ type: "registered", expiresAt: expect.any(Number) })
  })

  it("reads an order whose registration was ended", async () => {
    answering("registration-ended")
    expect((await api.readRegistration("registration", SIGN)).phase).toEqual({ type: "ended" })
  })

  it("holds in LOCAL the payee keys of the service's dev deployment, which the browser tests prove its addresses from", () => {
    const { bitcoinHrp, bitcoinReceiveKeys, moneroSubaddressPrefix, moneroPrimaryAddresses } = recorded<Record<string, unknown>>("deployment")
    expect([LOCAL.bitcoinHrp, LOCAL.bitcoinReceiveKeys, LOCAL.moneroSubaddressPrefix, LOCAL.moneroPrimaryAddresses]).toEqual([bitcoinHrp, bitcoinReceiveKeys, moneroSubaddressPrefix, moneroPrimaryAddresses])
  })

  it("proves each recorded address from the deployment's keys with its recorded proof", () => {
    const { bitcoin, monero } = recorded<{ bitcoin: { dev: { invoices: { address: string; keyTweak: string }[] } }; monero: { dev: { invoices: { address: string; spendTweak: string; viewProof: ViewProof }[] } } }>("vectors-address-proofs")
    for (const { address, keyTweak } of bitcoin.dev.invoices) expect(bitcoinProven(address, keyTweak, SITE.bitcoinReceiveKeys, SITE.bitcoinHrp), address).toBe(true)
    for (const { address, spendTweak, viewProof } of monero.dev.invoices) {
      expect(moneroProven(address, spendTweak, viewProof, SITE.moneroPrimaryAddresses, SITE.moneroSubaddressPrefix), address).toBe(true)
    }
  })

  it.each([["invoice-btc-open", "btc"], ["invoice-xmr-open", "xmr"]])("reads %s as an open invoice whose address its proof derives from the deployment's keys", async (name, coin) => {
    answering(name)
    const invoice = await api.readInvoice("invoice", SIGN)
    expect([invoice.status, api.invoiceMethod(invoice), api.addressProven(invoice)]).toEqual(["open", coin, true])
  })

  it("reads a selection of a name at another price with that name's price, the price the page holds for its length", async () => {
    const e = await refusal("select-catalog-changed", () => api.selectName("r1", { ...order, length: 7 }))
    expect([e.code, e.body.price]).toEqual(["catalog_changed", 20000])
    expect((await refusal("select-catalog-changed", () => api.selectName("r1", order))).code, "another length's price").toBe("network")
  })
})
