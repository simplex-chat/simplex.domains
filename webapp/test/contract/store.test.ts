import { readFileSync } from "node:fs"
import { join } from "node:path"
import { keccak256, toHex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as api from "../../src/api.ts"
import { configOf } from "../../src/config.ts"
import { initialSearch, reduce } from "../../src/screens/search.ts"

const DIR = process.env.STORE_FIXTURES

interface Fixture { status: number; body: unknown; retryAfter?: string }

const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(DIR!, `${name}.json`), "utf8")) as Fixture

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
const LABEL = "alicebakery"

describe.skipIf(!DIR)("the names page reads the service's recorded answers", () => {
  afterEach(() => vi.unstubAllGlobals())

  const chainId = () => configOf(fixture("config").body)!.names!.chainId
  const search = (name: string) => {
    answering(name)
    return api.searchName(HASH, LABEL.length, chainId())
  }
  const shown = (answer: api.SearchAnswer) => {
    const searching = reduce(initialSearch(), { type: "searched", label: LABEL, hold: null, minLength: null })
    return reduce(searching, { type: "answered", seq: searching.seq, label: LABEL, answer, mine: false, now: 0 }).answer
  }

  it("reads the deployment, open and codes-only", () => {
    expect(configOf(fixture("config").body)?.names?.codesOnly).toBe(false)
    expect(configOf(fixture("config-codes-only").body)?.names?.codesOnly).toBe(true)
  })

  it.each([
    ["search-available", "available"], ["search-available-community", "available"], ["search-available-without-terms", "available"],
    ["search-reserved", "reserved"], ["search-reserved-community", "reserved"], ["search-registering", "registering"],
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
    const e = await refusal(name, () => api.searchName(HASH, LABEL.length, chainId()))
    expect(e.code).toBe(code)
  })

  it("waits out a rate limit for its Retry-After", async () => {
    expect((await refusal("search-rate-limited", () => api.searchName(HASH, LABEL.length, chainId()))).retryAfter).toBeGreaterThan(0)
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
    expect(await api.termsText({ hash: keccak256(toHex(link)), link }, chainId())).toEqual((fixture("terms").body as { text: string }).text)
    const terms = { hash: keccak256(toHex(link)), link }
    expect((await refusal("terms-not-found", () => api.termsText(terms, chainId()))).code).toBe("not_found")
    const unavailable = await refusal("terms-unavailable", () => api.termsText(terms, chainId()))
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

  const order = { labelHash: HASH, length: LABEL.length, duration: 1, owner: "0x1", commitment: HASH, sealed: "sealed", terms: "ab".repeat(32), timestamp: 0, signature: "0x" }

  it("reads a code order refused for changed terms with the terms and the community entry now", async () => {
    const e = await refusal("register-terms-changed", () => api.registerWithCode(order, "code", chainId()))
    expect(e).toBeInstanceOf(api.TermsChanged)
    expect((e as api.TermsChanged).community).not.toBeNull()
  })

  it.each([
    ["register-code-reserved", "code_reserved"], ["register-name-taken", "name_taken"], ["register-terms-unavailable", "terms_unavailable"],
  ])("reads the code order refusal %s as %s", async (name, code) => {
    expect((await refusal(name, () => api.registerWithCode(order, "code", chainId()))).code).toBe(code)
  })

  it("reads a spend refused for its balance with the balance now, and for its price with the price now", async () => {
    const spending = { ...order, price: 1, balance: 1 }
    const e = await refusal("spend-balance-changed", () => api.spend("r1", spending, chainId()))
    expect(e).toBeInstanceOf(api.BalanceChanged)
    expect((e as api.BalanceChanged).balance).not.toBeNull()
    const price = await refusal("spend-catalog-changed", () => api.spend("r1", spending, chainId()))
    expect([price.code, price.body.price]).toEqual(["catalog_changed", 10000])
  })

  it.each([["move-limit", "move_limit"], ["move-registration-changed", "registration_changed"]])("reads the move refusal %s as %s with the order as it reads now", async (name, code) => {
    const e = await refusal(name, () => api.retarget("r1", order, chainId()))
    expect([e.code, api.changedView(e)?.id]).toEqual([code, "registration"])
  })

  it("reads a move to a dearer name with its price", async () => {
    const e = await refusal("move-price-too-high", () => api.retarget("r1", order, chainId()))
    expect([e.code, e.body.price]).toEqual(["price_too_high", 20000])
  })
})
