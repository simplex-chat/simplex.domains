import { recoverAddress, recoverMessageAddress, type Hex } from "viem"
import type { Acceptance, Phase, RevealBody } from "../src/api.ts"
import type { CodeOrder } from "../src/flow.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LOCAL } from "../src/config.ts"
import { formatOwnerCode } from "../src/crypto/code.ts"
import { acceptTermsDigest, commitmentSecret, labelHash, makeCommitment, namehash, registerIntentDigest, setTextDigest, YEAR_S } from "../src/crypto/registration.ts"
import { seal, unseal } from "../src/crypto/seal.ts"
import { checksumAddress, hex, walletFromEntropy } from "../src/crypto/wallet.ts"
import { type ShortView, viewOf } from "./registration-view.ts"

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"))
const ENTROPY = fromHex("6f2d1c9a4b7e3f80d15a2c6e9b04f7a3")
const OWNER_CODE = formatOwnerCode(ENTROPY)
const WALLET = walletFromEntropy(ENTROPY)
const OWNER = checksumAddress(WALLET.address)
const TERMS = LOCAL.generalTerms[0]
const SIGNED = TERMS.hash.slice(2)
const COMMUNITY_HASH = LOCAL.communityTerms[0].hash
const COMMUNITY_SIGNED = `community/${COMMUNITY_HASH.slice(2)}`
const COMMUNITY_AGREED = { communityName: true, termsHash: COMMUNITY_HASH }
const QUOTE = { type: "available" as const, price: 20000, years: 2, community: null, terms: TERMS }
const LINKS = { contact: "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rSAAAAAAAAA", channel: "" }

type Call = { method: string; path: string; body: Record<string, unknown> }
let calls: Call[]
let answers: Record<string, unknown>
const GENERAL: Acceptance = { community: false, policy: LOCAL.namePolicy, termsHash: TERMS.hash, nonce: 1 }
const COMMUNITY: Acceptance = { community: true, policy: LOCAL.namePolicy, termsHash: COMMUNITY_HASH, nonce: 1 }
let acceptance: Acceptance
let signReads: string[]

// localStorage for store.ts, and a fetch that records each call and answers from `answers` by "METHOD path", and every
// signing read with `acceptance`
function fakeBrowser(): void {
  const data = new Map<string, string>()
  vi.stubGlobal("window", {
    localStorage: {
      get length() { return data.size },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  })
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (/^\/api\/name\/[^/]+\/sign\?/.test(path)) {
      signReads.push(path)
      return new Response(JSON.stringify({ type: "read", intentNonce: 5, acceptance }), { status: 200 })
    }
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, path, body })
    const key = `${method} ${path.split("?")[0]}`
    if (!(key in answers)) return new Response(JSON.stringify({ type: "not_found" }), { status: 404 })
    const answer = typeof answers[key] === "function" ? (answers[key] as () => unknown)() : answers[key]
    if (answer instanceof Response) return answer
    return new Response(JSON.stringify(answer), { status: 200 })
  })
}

async function modules() {
  vi.resetModules()
  return { flow: await import("../src/flow.ts"), store: await import("../src/store.ts") }
}

beforeEach(() => {
  calls = []
  answers = {}
  acceptance = GENERAL
  signReads = []
  fakeBrowser()
})
afterEach(() => vi.unstubAllGlobals())

const draft = (label = "dynamis", terms = SIGNED) => ({ label, links: LINKS, years: 2, ownerCode: OWNER_CODE, terms, method: "card" as const })

const view = (request: { labelHash: string; duration: number; commitment: string; sealed: string }, extra: ShortView = {}) => viewOf({
  id: "reg1", version: 1, labelHash: request.labelHash, label: null, owner: OWNER, commitment: request.commitment, sealed: request.sealed,
  years: 2, duration: request.duration, price: 20000, balance: null, commitTx: "0x01", registerTx: null, latePayment: null,
  community: null, terms: { communityName: false, termsHash: TERMS.hash },
}, { phase: "committed", revealAfter: 1000, revealBefore: 87400, intentNonce: 3, ...extra })

type SentReveal = Pick<RevealBody, "secret" | "nonce" | "deadline" | "signature">

const revealSigner = (sent: SentReveal, duration: number, days: number) => {
  const r = {
    label: "dynamis", tld: LOCAL.tld, owner: WALLET.address, duration: BigInt(duration), secret: fromHex(sent.secret),
    resolver: fromHex(LOCAL.resolver), contactLink: LINKS.contact, channelLink: null,
  }
  return recoverAddress({ hash: hex(registerIntentDigest(BigInt(LOCAL.chainId), fromHex(LOCAL.sponsor), r, BigInt(days), BigInt(sent.nonce), BigInt(sent.deadline))) as Hex, signature: sent.signature as Hex })
}

describe("orderRequest", () => {
  it("commits to the label, the code's wallet, its derived secret and the links, and seals the name, the links and the payment asked for under the code", async () => {
    const { flow } = await modules()
    const { request, owner } = await flow.orderRequest(draft())
    expect(owner).toBe(OWNER)
    expect(request.labelHash).toBe(hex(labelHash("dynamis")))
    expect(request.length).toBe(7)
    // the paid years and the free days left until the term starts, by the clock at the order
    const free = request.duration - 2 * YEAR_S
    expect(Math.abs(free - Math.max(0, LOCAL.termStart - Date.now() / 1000))).toBeLessThan(2)
    const expected = makeCommitment({
      label: "dynamis", tld: LOCAL.tld, owner: WALLET.address, duration: BigInt(request.duration), secret: commitmentSecret(WALLET.seed, "dynamis"),
      resolver: fromHex(LOCAL.resolver), contactLink: LINKS.contact, channelLink: null,
    })
    expect(request.commitment).toBe(hex(expected))
    expect(await unseal(WALLET.seed, request.sealed)).toEqual({ label: "dynamis", ...LINKS, method: "card" })
  })

  it("is signed by the code's key over every field but the signature, the terms agreed to included, at the service's time", async () => {
    const { flow } = await modules()
    acceptance = COMMUNITY
    const { request } = await flow.orderRequest(draft("dynamis", COMMUNITY_SIGNED))
    expect(request.terms).toBe(COMMUNITY_SIGNED)
    expect(Math.abs(request.timestamp - Date.now() / 1000)).toBeLessThan(2)
    const sealedHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.sealed))).toString("hex")
    const message = `simplex.domains order ${request.labelHash} 7 ${request.duration} ${request.commitment} 0x${sealedHash} ${COMMUNITY_SIGNED} ${request.timestamp}`
    expect(await recoverMessageAddress({ message, signature: request.signature as Hex })).toBe(OWNER)
  })

  it("keeps the terms the order signed with its record", async () => {
    const { flow } = await modules()
    acceptance = COMMUNITY
    const built = await flow.orderRequest(draft("dynamis", COMMUNITY_SIGNED))
    expect(flow.recordFor(draft("dynamis", COMMUNITY_SIGNED), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" }).terms).toBe(COMMUNITY_SIGNED)
  })

  it.each([["card", 120], ["btc", 14], ["xmr", 14], ["code", 14]] as const)("includes the RegisterName, over the dispute days of a %s payment, %i, and the terms acceptance, signed with the code's key at what the service reads for the name and owner, a week ahead of the service's clock", async (method, days) => {
    const { flow } = await modules()
    const { request } = await flow.orderRequest({ ...draft(), method })
    expect(signReads).toEqual([`/api/name/${request.labelHash}/sign?owner=${OWNER}`])
    const { reveal } = request
    expect(reveal).toMatchObject({ label: "dynamis", secret: hex(commitmentSecret(WALLET.seed, "dynamis")), records: { contact: LINKS.contact, channel: null }, nonce: 5 })
    expect(Math.abs(reveal.deadline - (Date.now() / 1000 + 7 * 86400)), "the deadline's distance from a week ahead").toBeLessThan(2)
    expect(await revealSigner(reveal, request.duration, days)).toBe(OWNER)
    const a = GENERAL
    expect(reveal.acceptance).toMatchObject({ termsHash: a.termsHash, nonce: 1 })
    const accepted = acceptTermsDigest(false, BigInt(LOCAL.chainId), fromHex(LOCAL.namePolicy), fromHex(request.commitment), fromHex(a.termsHash), 1n, BigInt(reveal.deadline))
    expect(await recoverAddress({ hash: hex(accepted) as Hex, signature: reveal.acceptance.signature as Hex })).toBe(OWNER)
  })

  it.each([
    ["under another policy", { ...GENERAL, policy: LOCAL.sponsor }, SIGNED],
    ["of terms the page does not hold", { ...GENERAL, termsHash: `0x${"d8".repeat(32)}` }, SIGNED],
    ["of the other kind than the terms it names", { ...GENERAL, community: true }, SIGNED],
    ["for an order of terms the page does not hold", { ...GENERAL, termsHash: `0x${"d8".repeat(32)}` }, "d8".repeat(32)],
  ])("signs and sends nothing for a sign answer %s", async (_, asked, terms) => {
    const { flow } = await modules()
    acceptance = asked
    await expect(flow.orderRequest(draft("dynamis", terms))).rejects.toBeInstanceOf(flow.Unsignable)
    expect(calls).toEqual([])
  })

  it("signs the acceptance of the terms the buyer agreed to, whatever other terms the page holds the sign answer names, so the service asks for the terms changed", async () => {
    const { flow } = await modules()
    acceptance = { ...GENERAL, termsHash: LOCAL.generalTerms[1].hash }
    const { request } = await flow.orderRequest(draft())
    expect(request.reveal.acceptance).toMatchObject({ termsHash: TERMS.hash, nonce: 1 })
    const accepted = acceptTermsDigest(false, BigInt(LOCAL.chainId), fromHex(LOCAL.namePolicy), fromHex(request.commitment), fromHex(TERMS.hash), 1n, BigInt(request.reveal.deadline))
    expect(await recoverAddress({ hash: hex(accepted) as Hex, signature: request.reveal.acceptance.signature as Hex })).toBe(OWNER)
  })
})

describe("quoteOf", () => {
  const answering = (found: Record<string, unknown>, community: Record<string, unknown> | null = null) => {
    answers[`GET /api/name/${hex(labelHash("dynamis"))}`] = { found: { type: "available", price: 20000, years: 2, terms: TERMS, ...found }, ...community ? { community } : {} }
  }

  it("quotes a name at the price the page holds for its length, for the paid years, under the terms the page holds", async () => {
    const { flow } = await modules()
    answering({})
    expect(await flow.quoteOf("dynamis")).toEqual(QUOTE)
    answering({ terms: LOCAL.communityTerms[0] }, { years: 2 })
    expect(await flow.quoteOf("dynamis")).toEqual({ ...QUOTE, terms: LOCAL.communityTerms[0], community: { years: 2 } })
  })

  it.each([
    ["another price", { price: 10000 }, null], ["a higher price", { price: 40000 }, null], ["other years", { years: 3 }, null],
    ["terms the page does not hold for the name's kind", { terms: LOCAL.communityTerms[0] }, null], ["a community name's other years", { terms: LOCAL.communityTerms[0] }, { years: 3 }],
  ])("takes a search answer with %s as names not orderable now", async (_, found, community) => {
    const { flow } = await modules()
    answering(found, community)
    await expect(flow.quoteOf("dynamis")).rejects.toMatchObject({ code: "terms_unavailable" })
  })
})

describe("revealOrder", () => {
  const general = { ...GENERAL, nonce: 0 }

  it.each([["card", 120], ["btc", 14], ["xmr", 14], ["code", 14]] as const)("sends the label, secret and links with a RegisterName signature from the code's key over the dispute days of a %s payment, %i, a week ahead of the service's clock", async (method, days) => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, method, 20000, { registrationId: "reg1", invoiceId: method === "code" ? null : "inv1" })
    answers["POST /api/registration/reg1/reveal"] = {}
    await flow.revealOrder(view(built.request, { acceptance: general }), record, record.terms)
    const body = calls[0].body as SentReveal
    expect(body).toMatchObject({ label: "dynamis", secret: hex(commitmentSecret(WALLET.seed, "dynamis")), records: { contact: LINKS.contact, channel: null }, nonce: 3 })
    expect(Math.abs(body.deadline - (Date.now() / 1000 + 7 * 86400)), "the deadline's distance from a week ahead").toBeLessThan(2)
    expect(await revealSigner(body, built.request.duration, days)).toBe(OWNER)
  })

  it.each([["name", false], ["community", true]] as const)("signs the acceptance of the %s terms on chain with the code's key, at the same deadline, as their kind's type", async (_, community) => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/registration/reg1/reveal"] = {}
    const accepted = { ...community ? COMMUNITY : GENERAL, nonce: 2 }
    await flow.revealOrder(view(built.request, { acceptance: accepted }), record, community ? COMMUNITY_SIGNED : SIGNED)
    const sent = calls[0].body as { deadline: number; acceptance: { termsHash: string; nonce: number; signature: Hex } }
    expect(sent.acceptance).toMatchObject({ termsHash: accepted.termsHash, nonce: 2 })
    const digest = acceptTermsDigest(community, BigInt(LOCAL.chainId), fromHex(LOCAL.namePolicy), fromHex(built.request.commitment), fromHex(accepted.termsHash), 2n, BigInt(sent.deadline))
    const other = acceptTermsDigest(!community, BigInt(LOCAL.chainId), fromHex(LOCAL.namePolicy), fromHex(built.request.commitment), fromHex(accepted.termsHash), 2n, BigInt(sent.deadline))
    expect(await recoverAddress({ hash: hex(digest) as Hex, signature: sent.acceptance.signature })).toBe(OWNER)
    expect(await recoverAddress({ hash: hex(other) as Hex, signature: sent.acceptance.signature })).not.toBe(OWNER)
  })

  type Flow = Awaited<ReturnType<typeof modules>>["flow"]
  const reopenedElsewhere = async (flow: Flow, request: { labelHash: string; duration: number; commitment: string; sealed: string }, invoiceId: string | null, named: "card" | "btc") => {
    const reopened = view(request, { acceptance: general, payment: { type: "invoice", method: named } })
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId, phase: "committed", createdAt: "2026-10-14T10:00:00Z", labelHash: request.labelHash,
      sealed: request.sealed }] }
    answers["GET /api/invoice/inv1"] = { invoiceId: "inv1", status: "paid", amount: 20000, currency: "usd", expiresAt: "2026-10-14T11:00:00Z", kind: "name", registration: reopened }
    answers["GET /api/registration/reg1"] = reopened
    answers["POST /api/registration/reg1/reveal"] = {}
    const record = (await flow.ownOrderFor(OWNER_CODE, request.labelHash))!
    await flow.revealOrder(reopened, record, record.terms)
    return { record, sent: calls.find((c) => c.path === "/api/registration/reg1/reveal")!.body as SentReveal }
  }

  it.each([["card", "btc", 120], ["btc", "card", 14], ["code", "card", 14]] as const)("takes the %s payment the order sealed, reopened with its code in another browser while the view's payment is %s, and signs the reveal over its %i dispute days", async (method, named, days) => {
    const { flow } = await modules()
    const built = await flow.orderRequest({ ...draft(), method })
    const { record, sent } = await reopenedElsewhere(flow, built.request, method === "code" ? null : "inv1", named)
    expect(record.method).toBe(method)
    expect(await revealSigner(sent, built.request.duration, days)).toBe(OWNER)
  })

  it("keeps the payment of this browser's own record when it reopens the order, whatever payment the sealed data served with its commitment names", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest({ ...draft(), method: "btc" })
    store.saveOrder(flow.recordFor({ ...draft(), method: "card" }, built, "card", 20000, { registrationId: "reg1", invoiceId: "inv1" }))
    const { record, sent } = await reopenedElsewhere(flow, built.request, "inv1", "btc")
    expect(record.method).toBe("card")
    expect(await revealSigner(sent, built.request.duration, 120)).toBe(OWNER)
  })

  it.each([["card", 120], ["btc", 14]] as const)("takes the service's %s payment for an order sealed before its payment was, reopened in another browser, and signs over its %i dispute days", async (named, days) => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const sealed = await seal(WALLET.seed, { label: "dynamis", ...LINKS })
    const { record, sent } = await reopenedElsewhere(flow, { ...built.request, sealed }, "inv1", named)
    expect(record.method).toBe(named)
    expect(await revealSigner(sent, built.request.duration, days)).toBe(OWNER)
  })

  it.each([
    ["of another term than the order's", { duration: 1 }, SIGNED],
    ["under another policy", { acceptance: { ...general, policy: LOCAL.sponsor } }, SIGNED],
    ["of other terms than the buyer agreed to", { acceptance: { ...general, termsHash: LOCAL.generalTerms[1].hash } }, SIGNED],
    ["of the other kind", { acceptance: { ...general, community: true } }, SIGNED],
    ["of terms the page does not hold", { acceptance: { ...general, termsHash: `0x${"d8".repeat(32)}` } }, "d8".repeat(32)],
  ])("signs and sends nothing for a view %s", async (_, change, agreed) => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/registration/reg1/reveal"] = {}
    const { duration = built.request.duration, ...shown } = change as ShortView
    await expect(flow.revealOrder(view({ ...built.request, duration }, { acceptance: general, ...shown }), record, agreed)).rejects.toBeInstanceOf(flow.Unsignable)
    expect(calls).toEqual([])
  })
})

describe("selectName", () => {
  it("signs the new name's request and the terms agreed for it with the order's key, and keeps the record's wallet", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    answers["POST /api/registration/reg1/name"] = view(built.request)
    const another = draft("another", COMMUNITY_SIGNED)
    acceptance = COMMUNITY
    await flow.selectName(record, another, await flow.orderRequest(another))
    const body = calls[0].body as { fields: { labelHash: string; length: number; duration: number; commitment: string; sealed: string; terms: unknown }; timestamp: number; signature: Hex }
    const { fields } = body
    expect(fields.labelHash).toBe(hex(labelHash("another")))
    expect(fields.terms).toEqual(COMMUNITY_AGREED)
    const sealedHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fields.sealed))).toString("hex")
    const message = `simplex.domains name reg1 ${fields.labelHash} 7 ${fields.duration} ${fields.commitment} 0x${sealedHash} ${COMMUNITY_SIGNED} ${body.timestamp}`
    expect(await recoverMessageAddress({ message, signature: body.signature })).toBe(OWNER)
    expect(store.orderByRegistration("reg1")).toMatchObject({ label: "another", owner: OWNER, request: { labelHash: fields.labelHash }, terms: COMMUNITY_SIGNED })
  })

  it("sends the request built for the name, and keeps the record's own years for a community name's shorter term", async () => {
    const { flow, store } = await modules()
    const fiveYears = { ...draft(), years: 5 }
    const record = flow.recordFor(fiveYears, await flow.orderRequest(fiveYears), "code", 0, { registrationId: "reg1", invoiceId: null })
    store.saveOrder(record)
    const community = { ...draft("another", COMMUNITY_SIGNED), years: 2 }
    acceptance = COMMUNITY
    const built = await flow.orderRequest(community)
    answers["POST /api/registration/reg1/name"] = view(built.request)
    await flow.selectName(record, community, built)
    const { fields, reveal } = calls[0].body as { fields: { duration: number; commitment: string }; reveal: unknown }
    expect([Math.floor(fields.duration / YEAR_S), fields.commitment, reveal]).toEqual([2, built.request.commitment, built.request.reveal])
    expect(store.orderByRegistration("reg1")?.years).toBe(5)
  })

  it("drafts a new invoice for the answer's years, or a community name's own", async () => {
    const { flow } = await modules()
    const record = flow.recordFor(draft(), await flow.orderRequest(draft()), "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    const community = { years: 2 }
    expect(flow.draftAgain(record, { ...QUOTE, years: 3 }, SIGNED, "btc").years).toBe(3)
    expect(flow.draftAgain(record, { ...QUOTE, years: 3, community }, SIGNED, "btc").years).toBe(2)
  })

  it.each([["card", "btc", 120], ["btc", "card", 14], ["xmr", "card", 14]] as const)("signs the reveal of a new invoice paid by %s for a closed %s order over %i dispute days", async (method, closed, days) => {
    const { flow } = await modules()
    const record = flow.recordFor(draft(), await flow.orderRequest(draft()), closed, 20000, { registrationId: "reg1", invoiceId: "inv1" })
    const { request } = await flow.orderRequest(flow.draftAgain(record, QUOTE, SIGNED, method))
    expect(await revealSigner(request.reveal, request.duration, days)).toBe(OWNER)
  })
})

describe("restore", () => {
  it("finds the code's order with a signed request, checks the commitment, and saves the record", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest({ ...draft(), method: "xmr" })
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: "inv1", phase: "committed", createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed }] }
    answers["GET /api/invoice/inv1"] = {
      invoiceId: "inv1", status: "open", amount: 20000, currency: "usd", expiresAt: "2026-10-14T11:00:00Z", kind: "name", cryptoCurrency: "xmr",
      registration: view(built.request, { payment: { type: "invoice", method: "xmr" } }),
    }
    const { record } = (await flow.restore(OWNER_CODE.toLowerCase().replaceAll("-", " ")))!
    expect(record).toMatchObject({ registrationId: "reg1", invoiceId: "inv1", label: "dynamis", ownerCode: OWNER_CODE, owner: OWNER, ...LINKS, paid: 20000, method: "xmr", terms: SIGNED })
    const find = calls[0].body as { owner: string; timestamp: number; signature: Hex }
    expect(await recoverMessageAddress({ message: `simplex.domains find ${OWNER.toLowerCase()} ${find.timestamp}`, signature: find.signature })).toBe(OWNER)
    expect(store.orderByInvoice("inv1")?.ownerCode).toBe(OWNER_CODE)
  })

  it("signs each read of the order it restores with the code's key, and any order's request by its id, action and time", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: null, phase: "committed", createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed }] }
    answers["GET /api/registration/reg1"] = view(built.request)
    await flow.restore(OWNER_CODE)
    const read = new URL(`http://x${calls.find((c) => c.path.startsWith("/api/registration/reg1"))!.path}`).searchParams
    expect(await recoverMessageAddress({ message: `simplex.domains order reg1 read ${read.get("timestamp")}`, signature: read.get("signature") as Hex })).toBe(OWNER)
    const { timestamp, signature } = flow.orderSigner({ ownerCode: OWNER_CODE })("inv9", "cancel")
    expect(await recoverMessageAddress({ message: `simplex.domains order inv9 cancel ${timestamp}`, signature: signature as Hex })).toBe(OWNER)
  })

  it("restores the terms the order signed", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: null, phase: "queued", createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed }] }
    answers["GET /api/registration/reg1"] = view(built.request, { phase: "queued", terms: COMMUNITY_AGREED })
    expect((await flow.restore(OWNER_CODE))!.record.terms).toBe(COMMUNITY_SIGNED)
    answers["GET /api/registration/reg1"] = view(built.request, { phase: "queued" })
    expect((await flow.restore(OWNER_CODE))!.record.terms).toBe(SIGNED)
  })

  it("restores the newest order when none is paid, a closed one counting as unpaid", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const found = (registrationId: string, phase: string) =>
      ({ registrationId, invoiceId: `inv-${registrationId}`, phase, createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed })
    answers["POST /api/registration/find"] = { registrations: [found("reg2", "unpaid"), found("reg1", "closed")] }
    answers["GET /api/invoice/inv-reg2"] = {
      invoiceId: "inv-reg2", status: "open", amount: 20000, currency: "usd", expiresAt: "2026-10-14T11:00:00Z", kind: "name", cryptoCurrency: "btc",
      registration: view(built.request, { id: "reg2" }),
    }
    expect((await flow.restore(OWNER_CODE))!.record.registrationId).toBe("reg2")
  })

  it("restores nothing for a code find lists no order of", async () => {
    const { flow, store } = await modules()
    answers["POST /api/registration/find"] = { registrations: [] }
    expect(await flow.restore(OWNER_CODE)).toBeNull()
    expect(store.orders()).toEqual([])
  })

  it("refuses an order whose commitment the code does not open", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: null, phase: "committed", createdAt: "2026-10-14T10:00:00Z", labelHash: built.request.labelHash, sealed: built.request.sealed }] }
    answers["GET /api/registration/reg1"] = view({ ...built.request, commitment: `0x${"00".repeat(32)}` })
    await expect(flow.restore(OWNER_CODE)).rejects.toThrow("commitment")
    expect(store.orders()).toEqual([])
  })

  it("refuses a prepaid code", async () => {
    const { flow } = await modules()
    await expect(flow.restore("SN7-BJTBP-29596-R3HJ8-25YM7")).rejects.toThrow("not an owner code")
    expect(calls).toEqual([])
  })
})

describe("codeOrderOf and addOrder", () => {
  const found = (registrationId: string, phase: Phase, request: { labelHash: string; sealed: string }) =>
    ({ registrationId, invoiceId: null, phase, createdAt: "2026-10-14T10:00:00Z", labelHash: request.labelHash, sealed: request.sealed })

  it("names the order the code restores, passing over an order whose sealed name is another's or does not open", async () => {
    const { flow, store } = await modules()
    const mine = (await flow.orderRequest(draft())).request
    const other = (await flow.orderRequest(draft("another"))).request
    answers["POST /api/registration/find"] = { registrations: [
      found("reg4", "unpaid", other), found("reg3", "committed", { labelHash: mine.labelHash, sealed: other.sealed }),
      found("reg2", "queued", { labelHash: mine.labelHash, sealed: "not-sealed" }), found("reg1", "taken", mine), found("reg0", "unpaid", mine),
    ] }
    const opened = await flow.codeOrderOf(OWNER_CODE.toLowerCase()) as CodeOrder
    expect([opened.code, opened.name, opened.order.registrationId]).toEqual([OWNER_CODE, "dynamis", "reg1"])
    answers["GET /api/registration/reg1"] = view(mine, { id: "reg1", phase: "taken" })
    expect(await flow.addOrder(opened)).toMatchObject({ registrationId: "reg1", label: "dynamis", ownerCode: OWNER_CODE })
    expect(store.orders().map((o) => o.registrationId)).toEqual(["reg1"])
  })

  it("tells a code find lists no order of from one find lists only orders the code does not open", async () => {
    const { flow } = await modules()
    answers["POST /api/registration/find"] = { registrations: [] }
    expect(await flow.codeOrderOf(OWNER_CODE)).toBe("none")
    const other = (await flow.orderRequest({ ...draft(), ownerCode: formatOwnerCode(new Uint8Array(16).fill(7)) })).request
    answers["POST /api/registration/find"] = { registrations: [found("reg3", "committed", other)] }
    expect(await flow.codeOrderOf(OWNER_CODE)).toBe("other")
  })
})

describe("ownOrderFor", () => {
  const found = (registrationId: string, phase: string, labelHash: string, sealed: string) =>
    ({ registrationId, invoiceId: null, phase, createdAt: "2026-10-14T10:00:00Z", labelHash, sealed })

  it("opens the code's order on its way for the name, passing over its other names and its finished orders", async () => {
    const { flow, store } = await modules()
    const mine = (await flow.orderRequest(draft())).request
    const other = (await flow.orderRequest(draft("another"))).request
    answers["POST /api/registration/find"] = { registrations: [
      found("reg3", "committed", other.labelHash, other.sealed), found("reg2", "taken", mine.labelHash, mine.sealed),
      found("reg1", "queued", mine.labelHash, mine.sealed), found("reg0", "unpaid", mine.labelHash, mine.sealed),
    ] }
    answers["GET /api/registration/reg1"] = view(mine, { id: "reg1", phase: "queued" })
    const record = await flow.ownOrderFor(OWNER_CODE, mine.labelHash)
    expect(record).toMatchObject({ registrationId: "reg1", label: "dynamis", ownerCode: OWNER_CODE })
    expect(store.orderByRegistration("reg1")?.label).toBe("dynamis")
  })

  it("opens the code's unpaid order for the name, passing over an older one whose registration was ended", async () => {
    const { flow } = await modules()
    const mine = (await flow.orderRequest(draft())).request
    answers["POST /api/registration/find"] = { registrations: [found("reg2", "unpaid", mine.labelHash, mine.sealed), found("reg1", "ended", mine.labelHash, mine.sealed)] }
    answers["GET /api/registration/reg2"] = view(mine, { id: "reg2", phase: "unpaid" })
    expect(await flow.ownOrderFor(OWNER_CODE, mine.labelHash)).toMatchObject({ registrationId: "reg2", label: "dynamis" })
  })

  it("finds nothing when the code has no order for the name", async () => {
    const { flow } = await modules()
    const other = (await flow.orderRequest(draft("another"))).request
    answers["POST /api/registration/find"] = { registrations: [found("reg3", "committed", other.labelHash, other.sealed)] }
    expect(await flow.ownOrderFor(OWNER_CODE, hex(labelHash("dynamis")))).toBeNull()
  })
})

describe("syncRecord", () => {
  it("reads a name selected for the order elsewhere back into the record", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    expect(await flow.syncRecord(record, view(built.request))).toBe(record)
    const selected = await flow.orderRequest({ ...draft("another"), links: { contact: "", channel: "" } })
    const synced = await flow.syncRecord(record, view(selected.request))
    expect(synced).toMatchObject({ label: "another", contact: "", channel: "", request: { commitment: selected.request.commitment } })
    expect(store.orderByRegistration("reg1")?.label).toBe("another")
  })

  it("keeps the terms the order signed in this browser, whatever terms a view of its commitment names", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    expect(await flow.syncRecord(record, view(built.request, { terms: COMMUNITY_AGREED }))).toBe(record)
    expect(store.orderByRegistration("reg1")?.terms).toBe(SIGNED)
  })

  it("gives up on an order the code does not open", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    expect(await flow.syncRecord(record, view({ ...built.request, commitment: `0x${"00".repeat(32)}` }))).toBeNull()
    expect(store.orderByRegistration("reg1")?.request.commitment).toBe(built.request.commitment)
  })
})

describe("saveLinks", () => {
  it("signs each changed link from the resolver nonce up, with one deadline, and sends them in one request", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/name/records"] = { tx: "0xabc" }
    const tx = await flow.saveLinks(record, 5, { contact: "", channel: "simplex:/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4LmAAAAAAAAA?h=smp9.simplex.im" })
    expect(tx).toBe("0xabc")
    expect(calls).toHaveLength(1)
    const { labelHash: sentHash, edits } = calls[0].body as { labelHash: string; edits: { key: "contact" | "channel"; value: string; nonce: number; deadline: number; signature: Hex }[] }
    expect(sentHash).toBe(hex(labelHash("dynamis")))
    expect(edits.map((e) => [e.key, e.value, e.nonce])).toEqual([["contact", "", 5], ["channel", "simplex:/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4LmAAAAAAAAA?h=smp9.simplex.im", 6]])
    expect(new Set(edits.map((e) => e.deadline)).size, "one deadline for the Save").toBe(1)
    const node = namehash(LOCAL.tld, "dynamis")
    for (const e of edits) {
      const digest = setTextDigest(BigInt(LOCAL.chainId), fromHex(LOCAL.resolver), node, flow.KEYS[e.key], e.value, BigInt(e.nonce), BigInt(e.deadline))
      expect(await recoverAddress({ hash: hex(digest) as Hex, signature: e.signature })).toBe(OWNER)
    }
  })

  it("sends one link changed alone at the resolver nonce", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/name/records"] = { tx: null }
    expect(await flow.saveLinks(record, 5, { channel: "" })).toBeNull()
    expect((calls[0].body as { edits: { key: string; nonce: number }[] }).edits.map((e) => [e.key, e.nonce])).toEqual([["channel", 5]])
  })
})

describe("saveLinks after a refusal", () => {
  it("sends nothing more, as the Save went in one request", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/name/records"] = () => new Response(JSON.stringify({ type: "bad_request" }), { status: 400 })
    await expect(flow.saveLinks(record, 5, { contact: "", channel: "" })).rejects.toMatchObject({ code: "bad_request" })
    expect(calls).toHaveLength(1)
  })
})

describe("restore of an order this browser holds", () => {
  it("keeps the terms the record agreed to, whatever terms the service reports for the same commitment", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    store.saveOrder(flow.recordFor(draft(), built, "card", 20000, { registrationId: "reg1", invoiceId: "inv1" }))
    const other = { communityName: false, termsHash: LOCAL.generalTerms[1].hash }
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: "inv1", phase: "committed", createdAt: "2026-10-14T10:00:00Z",
      labelHash: built.request.labelHash, sealed: built.request.sealed }] }
    answers["GET /api/invoice/inv1"] = { invoiceId: "inv1", status: "paid", amount: 20000, currency: "usd", expiresAt: "2026-10-14T11:00:00Z", kind: "name",
      registration: view(built.request, { terms: other }) }
    const { record } = (await flow.restore(OWNER_CODE))!
    expect(record.terms).toBe(SIGNED)
  })
})

describe("orderOfCodes", () => {
  it("asks each held code's orders once for a link, so a rate limit met at a later code goes on from that code", async () => {
    const { flow, store } = await modules()
    const other = formatOwnerCode(fromHex("0123456789abcdef0123456789abcdef"))
    const record = flow.recordFor(draft(), await flow.orderRequest(draft()), "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder({ ...record, createdAt: "2026-01-02T00:00:00Z" })
    store.saveOrder({ ...record, registrationId: "reg2", invoiceId: "inv2", ownerCode: other, createdAt: "2026-01-01T00:00:00Z" })
    let finds = 0
    answers["POST /api/registration/find"] = () => finds++ === 0 ? { registrations: [] } : new Response(JSON.stringify({ type: "rate_limited" }), { status: 429 })
    calls = []
    for (let i = 0; i < 2; i++) await expect(flow.orderOfCodes("inv9")).rejects.toMatchObject({ code: "rate_limited" })
    const asked = calls.filter((c) => c.path === "/api/registration/find").map((c) => c.body.owner)
    expect(asked).toEqual([OWNER, checksumAddress(flow.walletOf(other)!.address), checksumAddress(flow.walletOf(other)!.address)])
  })
})

describe("walletOf", () => {
  it("keeps each code's wallet until the codes are forgotten", async () => {
    const { flow } = await modules()
    const kept = flow.walletOf(OWNER_CODE)
    expect(flow.walletOf(OWNER_CODE)).toBe(kept)
    flow.forgetWallets()
    expect(flow.walletOf(OWNER_CODE)).not.toBe(kept)
  })
})

describe("store", () => {
  it("keeps orders newest first, updates by registration, and forgets everything", async () => {
    const { store } = await modules()
    const base = { invoiceId: null, label: "a", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, tld: "simplex",
      request: { labelHash: "0x", length: 6, duration: 2 * YEAR_S, owner: OWNER, commitment: "0x", sealed: "sealed" } }
    expect(store.saveOrder({ ...base, registrationId: "old", createdAt: "2026-01-01T00:00:00Z" })).toBe(true)
    store.saveOrder({ ...base, registrationId: "new", createdAt: "2026-02-01T00:00:00Z" })
    store.updateOrder("old", { cancelled: true })
    expect(store.orders().map((o) => [o.registrationId, o.cancelled ?? false])).toEqual([["new", false], ["old", true]])
    store.forgetEverything()
    expect(store.orders()).toEqual([])
  })

  it("keeps a shown owner code until an order with that code is saved", async () => {
    const { flow, store } = await modules()
    store.addPending({ ownerCode: OWNER_CODE, label: "dynamis", tld: "simplex", createdAt: "2026-01-01T00:00:00Z" })
    store.addPending({ ownerCode: "SN-OTHER", label: "another", tld: "simplex", createdAt: "2026-01-01T00:00:00Z" })
    expect(store.pendingCodes().map((p) => p.label).sort()).toEqual(["another", "dynamis"])
    const built = await flow.orderRequest(draft())
    store.saveOrder(flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" }))
    expect(store.pendingCodes().map((p) => p.label)).toEqual(["another"])
    store.dropPending("SN-OTHER")
    expect(store.pendingCodes()).toEqual([])
  })

  it("keeps another tab's writes: every write starts from what storage holds now", async () => {
    const { store: tabA } = await modules()
    vi.resetModules()
    const tabB = await import("../src/store.ts")
    expect(tabA.orders()).toEqual([])
    const base = { invoiceId: null, label: "b", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, tld: "simplex",
      request: { labelHash: "0x", length: 6, duration: 2 * YEAR_S, owner: OWNER, commitment: "0x", sealed: "sealed" } }
    tabB.saveOrder({ ...base, registrationId: "fromB", createdAt: "2026-01-01T00:00:00Z" })
    tabA.addCode({ code: "SN6-X", minLength: 6, years: 2, addedAt: "2026-01-01T00:00:00Z" })
    expect(tabB.orders().map((o) => o.registrationId)).toEqual(["fromB"])
    expect(tabB.codes().map((c) => c.code)).toEqual(["SN6-X"])
    tabA.saveOrder({ ...base, registrationId: "fromA", createdAt: "2026-02-01T00:00:00Z" })
    expect(tabB.orders().map((o) => o.registrationId)).toEqual(["fromA", "fromB"])
    tabB.forgetEverything()
    expect([tabA.orders(), tabA.codes()]).toEqual([[], []])
  })

  it("keeps what Your names last read of each order for every tab, no record among the orders, until everything is forgotten", async () => {
    const { store: tabA } = await modules()
    vi.resetModules()
    const tabB = await import("../src/store.ts")
    expect(tabB.seen()).toEqual({})
    tabA.setSeen({ "reg-1": { view: { phase: "registered" }, invoice: null } })
    expect(tabB.seen<{ view: { phase: string } }>()["reg-1"].view.phase).toBe("registered")
    expect(tabB.orders()).toEqual([])
    tabB.forgetEverything()
    expect(tabA.seen()).toEqual({})
  })

  it("keeps serving what a full storage holds, moves new writes to memory, and forgets both", async () => {
    const { store } = await modules()
    const base = { invoiceId: null, label: "a", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, tld: "simplex",
      request: { labelHash: "0x", length: 6, duration: 2 * YEAR_S, owner: OWNER, commitment: "0x", sealed: "sealed" } }
    store.saveOrder({ ...base, registrationId: "kept", createdAt: "2026-01-01T00:00:00Z" })
    const storage = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    const setItem = storage.setItem
    storage.setItem = () => { throw new DOMException("full", "QuotaExceededError") }
    expect(store.orders().map((o) => o.registrationId)).toEqual(["kept"])
    expect(store.canPersist()).toBe(false)
    expect(store.orders().map((o) => o.registrationId)).toEqual(["kept"])
    expect(store.saveOrder({ ...base, registrationId: "new", createdAt: "2026-02-01T00:00:00Z" })).toBe(false)
    expect(store.orders().map((o) => o.registrationId)).toEqual(["new", "kept"])
    store.forgetEverything()
    expect(store.orders()).toEqual([])
    storage.setItem = setItem
    expect(storage.length).toBe(0)
  })

  it("falls back to memory and says so when storage is refused", async () => {
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("blocked") } })
    const { store } = await modules()
    expect(store.canPersist()).toBe(false)
    store.addCode({ code: "SN6-X", minLength: 6, years: 2, addedAt: "2026-01-01T00:00:00Z" })
    expect(store.codes()).toHaveLength(1)
  })
})
