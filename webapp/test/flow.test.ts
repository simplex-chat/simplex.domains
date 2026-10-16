import { recoverAddress, recoverMessageAddress, type Hex } from "viem"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { codeHash, formatOwnerCode, parseNameCode } from "../src/crypto/code.ts"
import { commitmentSecret, durationFor, labelHash, makeCommitment, namehash, registerIntentDigest, setTextDigest } from "../src/crypto/registration.ts"
import { unseal } from "../src/crypto/seal.ts"
import { checksumAddress, hex, walletFromEntropy } from "../src/crypto/wallet.ts"

const fromHex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"))
const ENTROPY = fromHex("6f2d1c9a4b7e3f80d15a2c6e9b04f7a3")
const OWNER_CODE = formatOwnerCode(ENTROPY)
const WALLET = walletFromEntropy(ENTROPY)
const OWNER = checksumAddress(WALLET.address)
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const LINKS = { contact: "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS", channel: "" }

type Call = { method: string; path: string; body: Record<string, unknown> }
let calls: Call[]
let answers: Record<string, unknown>

// localStorage for store.ts, and a fetch that records each call and answers from `answers` by "METHOD path"
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
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, path, body })
    const key = `${method} ${path.split("?")[0]}`
    if (!(key in answers)) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
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
  fakeBrowser()
})
afterEach(() => vi.unstubAllGlobals())

const draft = (label = "dynamis") => ({ label, links: LINKS, chain: CHAIN, years: 2, ownerCode: OWNER_CODE })

function view(request: { labelHash: string; commitment: string; sealed: string | null }, extra: Record<string, unknown> = {}) {
  return {
    id: "reg1", phase: "committed", labelHash: request.labelHash, label: null, owner: OWNER, commitment: request.commitment, sealed: request.sealed,
    years: 2, price: 20000, commitTx: "0x01", registerTx: null, revealAfter: 1000, revealBefore: 87400, intentNonce: 3, expiresAt: null, error: null,
    ...CHAIN, ...extra,
  }
}

describe("orderRequest", () => {
  it("commits to the label, the code's wallet, its derived secret and the links, and seals the name for the code", async () => {
    const { flow } = await modules()
    const { request, owner, secret } = await flow.orderRequest(draft())
    expect(owner).toBe(OWNER)
    expect(secret).toBeNull()
    expect(request.labelHash).toBe(hex(labelHash("dynamis")))
    expect(request.length).toBe(7)
    const expected = makeCommitment({
      label: "dynamis", tld: "simplex", owner: WALLET.address, duration: durationFor(2), secret: commitmentSecret(WALLET.seed, "dynamis"),
      resolver: fromHex(CHAIN.resolver), contactLinks: [LINKS.contact], channelLinks: [],
    })
    expect(request.commitment).toBe(hex(expected))
    expect(await unseal(WALLET.seed, request.sealed!)).toEqual({ label: "dynamis", ...LINKS })
  })

  it("opened from the app, commits to the app's wallet and the page's secret, and seals nothing", async () => {
    const { flow } = await modules()
    const appOwner = "0x00000000000000000000000000000000000000aa"
    const appSecret = `0x${"22".repeat(32)}`
    const { request, owner, secret } = await flow.orderRequest({ ...draft(), ownerCode: null, appOwner, appSecret })
    expect(owner).toBe(appOwner)
    expect(secret).toBe(appSecret)
    expect(request.sealed).toBeNull()
    const expected = makeCommitment({
      label: "dynamis", tld: "simplex", owner: fromHex(appOwner), duration: durationFor(2), secret: fromHex(appSecret),
      resolver: fromHex(CHAIN.resolver), contactLinks: [LINKS.contact], channelLinks: [],
    })
    expect(request.commitment).toBe(hex(expected))
  })
})

describe("revealOrder", () => {
  it("sends the label, secret and links with a RegisterName signature from the code's key, at the commitment's deadline", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/registration/reg1/reveal"] = {}
    await flow.revealOrder(view(built.request) as never, record)
    const body = calls[0].body as { label: string; secret: string; records: unknown; nonce: number; deadline: number; signature: Hex }
    expect(body).toMatchObject({ label: "dynamis", secret: hex(commitmentSecret(WALLET.seed, "dynamis")), records: { contact: [LINKS.contact], channel: [] }, nonce: 3, deadline: 87400 })
    const r = {
      label: "dynamis", tld: "simplex", owner: WALLET.address, duration: durationFor(2), secret: fromHex(body.secret),
      resolver: fromHex(CHAIN.resolver), contactLinks: [LINKS.contact], channelLinks: [],
    }
    const digest = registerIntentDigest(31337n, fromHex(CHAIN.sponsor), r, 3n, 87400n)
    expect(await recoverAddress({ hash: hex(digest) as Hex, signature: body.signature })).toBe(OWNER)
  })
})

describe("retargetOrder and takeCodeFor", () => {
  it("signs the new name's request with the order's key and keeps the record's wallet", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    answers["POST /api/registration/reg1/name"] = view(built.request)
    await flow.retargetOrder(record, "another", LINKS, CHAIN)
    const body = calls[0].body as { labelHash: string; length: number; commitment: string; sealed: string; timestamp: number; signature: Hex }
    expect(body.labelHash).toBe(hex(labelHash("another")))
    const sealedHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.sealed))).toString("hex")
    const message = `simplex.domains name reg1 ${body.labelHash} 7 ${body.commitment} 0x${sealedHash} ${body.timestamp}`
    expect(await recoverMessageAddress({ message, signature: body.signature })).toBe(OWNER)
    expect(store.orderByRegistration("reg1")).toMatchObject({ label: "another", owner: OWNER, request: { labelHash: body.labelHash } })
  })

  it("derives the taken order's code from the owner code, sends only its hash, and keeps the code", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    answers["POST /api/registration/reg1/code"] = {}
    const code = await flow.takeCodeFor(record, view(built.request, { phase: "taken" }) as never)
    expect(code).toBe(flow.takenCodeOf(record, "reg1"))
    const parsed = parseNameCode(code)
    expect(parsed?.kind === "prepaid" && parsed.minLength).toBe(7)
    const body = calls[0].body as { codeHash: string; timestamp: number; signature: Hex }
    expect(body.codeHash).toBe(codeHash(parsed!.kind === "prepaid" ? parsed!.canonical : ""))
    expect(await recoverMessageAddress({ message: `simplex.domains code reg1 ${body.codeHash} ${body.timestamp}`, signature: body.signature })).toBe(OWNER)
    expect(store.codes().map((c) => c.code)).toEqual([code])
    expect(store.orderByRegistration("reg1")?.takenCode).toBe(code)
  })
})

describe("restore", () => {
  it("finds the code's order with a signed request, checks the commitment, and saves the record", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: "inv1", phase: "committed", createdAt: "2026-10-14T10:00:00Z" }] }
    answers["GET /api/invoice/inv1"] = {
      invoiceId: "inv1", status: "open", amount: 20000, currency: "usd", expiresAt: "2026-10-14T11:00:00Z", kind: "name", cryptoCurrency: "xmr", registration: view(built.request),
    }
    const { record } = await flow.restore(OWNER_CODE.toLowerCase().replaceAll("-", " "))
    expect(record).toMatchObject({ registrationId: "reg1", invoiceId: "inv1", label: "dynamis", ownerCode: OWNER_CODE, owner: OWNER, ...LINKS, paid: 20000, method: "xmr" })
    const find = calls[0].body as { owner: string; timestamp: number; signature: Hex }
    expect(await recoverMessageAddress({ message: `simplex.domains find ${OWNER.toLowerCase()} ${find.timestamp}`, signature: find.signature })).toBe(OWNER)
    expect(store.orderByInvoice("inv1")?.ownerCode).toBe(OWNER_CODE)
  })

  it("refuses an order whose commitment the code does not open", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    answers["POST /api/registration/find"] = { registrations: [{ registrationId: "reg1", invoiceId: null, phase: "committed", createdAt: "2026-10-14T10:00:00Z" }] }
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

describe("paidWith", () => {
  it("records an answered invoice's own method and amount, and a code registration as paid by code", async () => {
    const { flow } = await modules()
    expect(flow.paidWith({ invoiceId: "inv", amount: 20000, cryptoCurrency: "xmr" } as never)).toEqual({ method: "xmr", paid: 20000 })
    expect(flow.paidWith({ invoiceId: "inv", amount: 10000 } as never)).toEqual({ method: "card", paid: 10000 })
    expect(flow.paidWith({ invoiceId: null, kind: "name" } as never)).toEqual({ method: "code", paid: 0 })
  })
})

describe("syncRecord", () => {
  it("reads an order moved to another name elsewhere back into the record", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    expect(await flow.syncRecord(record, view(built.request) as never)).toBe(record)
    const moved = await flow.orderRequest({ ...draft("another"), links: { contact: "", channel: "" } })
    const synced = await flow.syncRecord(record, view(moved.request) as never)
    expect(synced).toMatchObject({ label: "another", contact: "", channel: "", request: { commitment: moved.request.commitment } })
    expect(store.orderByRegistration("reg1")?.label).toBe("another")
  })

  it("gives up on an order the code does not open", async () => {
    const { flow, store } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    store.saveOrder(record)
    expect(await flow.syncRecord(record, view({ ...built.request, commitment: `0x${"00".repeat(32)}` }) as never)).toBeNull()
    expect(store.orderByRegistration("reg1")?.request.commitment).toBe(built.request.commitment)
  })
})

describe("saveLinks", () => {
  it("sends one SetText per changed key, each with the next resolver nonce, signed by the name's key", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    answers["POST /api/name/records"] = { tx: "0xabc" }
    const saved: string[] = []
    const txs = await flow.saveLinks(record, CHAIN, 5, { contact: "", channel: "simplex:/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm" }, (kind) => saved.push(kind))
    expect(txs).toEqual(["0xabc", "0xabc"])
    expect(saved).toEqual(["contact", "channel"])
    const node = namehash("simplex", "dynamis")
    for (const [i, call] of calls.entries()) {
      const body = call.body as { key: string; value: string; nonce: number; deadline: number; signature: Hex }
      expect(body.nonce).toBe(5 + i)
      const digest = setTextDigest(31337n, fromHex(CHAIN.resolver), node, body.key, body.value, BigInt(body.nonce), BigInt(body.deadline))
      expect(await recoverAddress({ hash: hex(digest) as Hex, signature: body.signature })).toBe(OWNER)
    }
    expect(calls.map((c) => c.body.key)).toEqual([flow.KEYS.contact, flow.KEYS.channel])
  })
})

describe("saveLinks after a refusal", () => {
  it("reports only the keys saved before the refused one", async () => {
    const { flow } = await modules()
    const built = await flow.orderRequest(draft())
    const record = flow.recordFor(draft(), built, "btc", 20000, { registrationId: "reg1", invoiceId: "inv1" })
    let sent = 0
    answers["POST /api/name/records"] = () => (++sent === 1 ? { tx: "0x1" } : new Response(JSON.stringify({ error: "bad_request" }), { status: 400 }))
    const saved: string[] = []
    await expect(flow.saveLinks(record, CHAIN, 5, { contact: "", channel: "" }, (kind) => saved.push(kind))).rejects.toMatchObject({ code: "bad_request" })
    expect(saved).toEqual(["contact"])
  })
})

describe("store", () => {
  it("keeps orders newest first, updates by registration, and forgets everything", async () => {
    const { store } = await modules()
    const base = { invoiceId: null, label: "a", ownerCode: null, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, secret: null, tld: "simplex",
      request: { labelHash: "0x", length: 6, owner: OWNER, commitment: "0x", sealed: null } }
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
    const base = { invoiceId: null, label: "b", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, secret: null, tld: "simplex",
      request: { labelHash: "0x", length: 6, owner: OWNER, commitment: "0x", sealed: null } }
    tabB.saveOrder({ ...base, registrationId: "fromB", createdAt: "2026-01-01T00:00:00Z" })
    tabA.addCode({ code: "SN6-X", minLength: 6, years: 2, addedAt: "2026-01-01T00:00:00Z" })
    expect(tabB.orders().map((o) => o.registrationId)).toEqual(["fromB"])
    expect(tabB.codes().map((c) => c.code)).toEqual(["SN6-X"])
    tabA.saveOrder({ ...base, registrationId: "fromA", createdAt: "2026-02-01T00:00:00Z" })
    expect(tabB.orders().map((o) => o.registrationId)).toEqual(["fromA", "fromB"])
    tabB.forgetEverything()
    expect([tabA.orders(), tabA.codes()]).toEqual([[], []])
  })

  it("keeps serving what a full storage holds, moves new writes to memory, and forgets both", async () => {
    const { store } = await modules()
    const base = { invoiceId: null, label: "a", ownerCode: OWNER_CODE, owner: OWNER, contact: "", channel: "", method: "code" as const, paid: 0, years: 2, secret: null, tld: "simplex",
      request: { labelHash: "0x", length: 6, owner: OWNER, commitment: "0x", sealed: null } }
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
