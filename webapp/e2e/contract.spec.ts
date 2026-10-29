// The store API contract's acceptance cases (plans/names-codes/2026-10-21-store-api.md) that the mock can show, against
// the worker's mock directly. The page's own flows build and sign the requests.
import { expect, type APIRequestContext } from "@playwright/test"
import type { Hex } from "viem"
import { CODE_LIMIT } from "../dev/mock/limits.ts"
import * as api from "../src/api.ts"
import { CHANNEL_KEY, CONTACT_KEY, labelHash, namehash, setTextDigest, YEAR_S } from "../src/crypto/registration.ts"
import { checksumAddress, fromHex, hex, personalDigest, signDigest } from "../src/crypto/wallet.ts"
import * as flow from "../src/flow.ts"
import * as store from "../src/store.ts"
import { channelLink, contactLink, control, MOCK, newClient, oracleQuote, ownerSetsResolver, ownerSetsText, test, textChangesOf, uniqueLabel } from "./helpers.ts"

type Json = Record<string, unknown>

// each case is a client of its own, as the page's tests are
let client = newClient()
test.beforeEach(() => { client = newClient() })
const asClient = (init?: RequestInit): RequestInit => ({ ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...client } })

// the flows' requests, made from this worker, go to its slot's mock
const ownFetch = globalThis.fetch
test.beforeAll(() => {
  globalThis.fetch = (input, init) => typeof input === "string" && input.startsWith("/") ? ownFetch(`${MOCK}${input}`, asClient(init)) : ownFetch(input, init)
})
test.afterAll(() => { globalThis.fetch = ownFetch })
// the cases speak to the service alone, so one browser's run of them is enough
test.skip(({ browserName }) => browserName !== "chromium", "API cases run once")

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return ownFetch(`${MOCK}${path}`, asClient({ method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }))
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await send(method, path, body)
  return { status: res.status, json: await res.json() as Json }
}

const TERM_START = Date.UTC(2027, 0, 1) / 1000
// the service's window for a signed timestamp, and how far an order's free days may be from its count
const SIGNED_WINDOW_S = 600
const TERM_SLACK_S = 3600
const PHASE_MS = 120_000
// a resolver that is not the store's, for a name pointed elsewhere
const ELSEWHERE: Hex = "0x000000000000000000000000000000000000dEaD"
const NO_LINKS = { contact: "", channel: "" }

type Quote = Extract<api.SearchAnswer, { status: "available" }>

async function quote(label: string): Promise<Quote> {
  const q = await flow.quoteOf(label)
  expect(q, `${label} is available`).not.toBeNull()
  return q!
}

async function draftOf(label: string, links = { contact: "", channel: "" }): Promise<flow.Draft> {
  const q = await quote(label)
  return { label, links, chain: flow.chainOf(q), years: q.years, termStart: q.termStart, ownerCode: flow.newOwnerCode(), terms: api.currentTerms(q) }
}

// the order moved to another name, or the same with other links, under the terms the service has for that name now
async function moveOf(record: store.OrderRecord, to: string, links = NO_LINKS): Promise<api.RegistrationView> {
  const q = await quote(to)
  return flow.retargetOrder(record, to, links, q, api.currentTerms(q))
}

// another name paid from the record's balance as read, under the terms the service has for it now
async function spendOn(record: store.OrderRecord, label: string, balance: number): Promise<store.OrderRecord> {
  const q = await quote(label)
  return flow.spendBalance(record, label, NO_LINKS, q, balance, "btc", api.currentTerms(q))
}

// the order signed again by its owner at another time
async function signedAt(ownerCode: string, request: api.SignedOrder, timestamp: number): Promise<api.SignedOrder> {
  const sealedHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.sealed))))
  const message = `simplex.domains order ${request.labelHash} ${request.length} ${request.duration} ${request.commitment} ${sealedHash} ${request.terms} ${timestamp}`
  return { ...request, timestamp, signature: hex(signDigest(flow.walletOf(ownerCode)!.privateKey, personalDigest(message))) }
}

const invoiceBody = (request: api.SignedOrder, method: api.Method, price: number) => ({ kind: "name", ...request, method, price })

const viewOf = async (id: string, seenVersion?: number) =>
  (await call("GET", `/api/registration/${id}${seenVersion === undefined ? "" : `?seenVersion=${seenVersion}`}`)).json as unknown as api.RegistrationView

// the registration's view once its phase is one of these, followed by the version long poll
async function untilPhase(id: string, phases: api.Phase[]): Promise<api.RegistrationView> {
  const end = Date.now() + PHASE_MS
  let view = await viewOf(id)
  while (!phases.includes(view.phase)) {
    expect(Date.now(), `${id} reaches ${phases.join(" or ")}, at ${view.phase}`).toBeLessThan(end)
    view = await viewOf(id, view.version)
  }
  return view
}

async function codeOrder(request: APIRequestContext, label: string): Promise<{ draft: flow.Draft; built: flow.BuiltOrder; id: string; code: string }> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const res = await call("POST", "/api/name/register", { ...built.request, code })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return { draft, built, id: res.json.registrationId as string, code }
}

// a committed view once its wait is over, with the sponsor's nonce read, as the page reveals it
async function untilRevealable(id: string): Promise<api.RegistrationView> {
  const view = await untilPhase(id, ["committed"])
  await new Promise((r) => setTimeout(r, Math.max(0, (view.revealAfter ?? 0) * 1000 - Date.now())))
  return viewOf(id)
}

// The order, as this worker's store keeps it, revealed with a register the service then fails: an order to try again or move.
async function failAtRegister(request: APIRequestContext, id: string): Promise<api.RegistrationView> {
  const view = await untilRevealable(id)
  await control(request, `fail/${id}`)
  await flow.revealOrder(view, store.orderByRegistration(id)!)
  return untilPhase(id, ["failed"])
}

async function failedOrder(request: APIRequestContext, label: string) {
  const order = await codeOrder(request, label)
  store.saveOrder(flow.recordFor(order.draft, order.built, "code", 0, { registrationId: order.id, invoiceId: null }))
  return { ...order, view: await failAtRegister(request, order.id) }
}

test("an order is answered again only for an exact resend, at any age of its signature; anything else meeting it is order_exists", async () => {
  const label = uniqueLabel("cx")
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const q = await quote(label)
  const first = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
  expect(first.status, JSON.stringify(first.json)).toBe(200)
  expect(first.json.amount, "the oracle's quote for the paid years").toBe(await oracleQuote(label, q.years))
  expect((await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))).json.invoiceId).toBe(first.json.invoiceId)
  // the same fields signed long after are the same order
  const late = await signedAt(draft.ownerCode, built.request, built.request.timestamp + 2 * SIGNED_WINDOW_S)
  expect((await call("POST", "/api/invoice", invoiceBody(late, "btc", q.price))).json.invoiceId).toBe(first.json.invoiceId)
  // sealed again, paid another way, or with other links, it says nothing of the order it met
  const others: [api.SignedOrder, api.Method][] = [
    [(await flow.orderRequest(draft)).request, "btc"], [built.request, "xmr"],
    [(await flow.orderRequest({ ...draft, links: { contact: contactLink("Cx"), channel: "" } })).request, "btc"],
  ]
  for (const [request, method] of others) {
    const met = await call("POST", "/api/invoice", invoiceBody(request, method, q.price))
    expect([met.status, met.json]).toEqual([409, { error: "order_exists" }])
  }
  // another wallet may order the same name
  const rival = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(label))).request, "btc", q.price))
  expect(rival.status).toBe(200)
  expect(rival.json.invoiceId).not.toBe(first.json.invoiceId)
})

test("an order refuses a wrong signer, a stale timestamp, free days off the term, a missing or oversized sealed, and a price the chain does not quote", async () => {
  const label = uniqueLabel("cr")
  const draft = await draftOf(label)
  const q = await quote(label)
  const { request } = await flow.orderRequest(draft)
  const stranger = flow.newOwnerCode()
  const off = (await flow.orderRequest({ ...draft, termStart: draft.termStart + TERM_SLACK_S + 100 })).request
  const refusals: [string, object, number, Json][] = [
    ["another key's signature", await signedAt(stranger, request, request.timestamp), 400, { error: "bad_request" }],
    ["a timestamp past the window", await signedAt(draft.ownerCode, request, request.timestamp - SIGNED_WINDOW_S - 100), 400, { error: "bad_request" }],
    ["free days more than an hour off", off, 400, { error: "bad_request" }],
    ["no sealed", { ...request, sealed: undefined }, 400, { error: "bad_request" }],
    ["a sealed over 11095 characters", { ...request, sealed: "a".repeat(11096) }, 400, { error: "bad_request" }],
    ["a name of 5 letters", { ...request, length: 5 }, 400, { error: "invalid_name" }],
  ]
  for (const [what, body, status, answer] of refusals) {
    const res = await call("POST", "/api/invoice", { kind: "name", ...body, method: "btc", price: q.price })
    expect([res.status, res.json], what).toEqual([status, answer])
  }
  const cheap = await call("POST", "/api/invoice", invoiceBody(request, "btc", q.price - 1))
  expect([cheap.status, cheap.json]).toEqual([409, { error: "catalog_changed", price: q.price }])
  // the free days are what is left until the term starts
  expect(Math.abs(request.duration - q.years * YEAR_S - (TERM_START - request.timestamp))).toBeLessThanOrEqual(1)
})

test("a cancelled or expired order gives way to a new one of the same wallet, and its exact resend answers it as it is now", async ({ request }) => {
  const label = uniqueLabel("cc")
  const draft = await draftOf(label)
  const q = await quote(label)
  const first = await flow.orderRequest(draft)
  const opened = await call("POST", "/api/invoice", invoiceBody(first.request, "btc", q.price))
  expect((await call("POST", `/api/invoice/${opened.json.invoiceId}/cancel`)).json.status).toBe("expired")
  const resent = await call("POST", "/api/invoice", invoiceBody(first.request, "btc", q.price))
  expect([resent.json.invoiceId, resent.json.status]).toEqual([opened.json.invoiceId, "expired"])
  const second = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "xmr", q.price))
  expect(second.status).toBe(200)
  await control(request, `expire/${second.json.invoiceId}`)
  // a payment reaching the closed invoice is late: the order stays unpaid, and the invoice closed, as BTCPay keeps it
  await control(request, `settle/${second.json.invoiceId}`)
  const late = await call("GET", `/api/invoice/${second.json.invoiceId}`)
  expect([late.json.status, late.json.paidInFull, (late.json.registration as Json).phase]).toEqual(["expired", true, "unpaid"])
  expect((await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "card", q.price))).status).toBe(200)
})

// an invoice's status as the mock holds it, which a read of the invoice would mark expired once due
async function heldStatus(invoiceId: string): Promise<string> {
  const { invoices } = (await call("GET", "/control/state")).json as { invoices: { id: string; status: string }[] }
  return invoices.find((i) => i.id === invoiceId)!.status
}

test("an order past its invoice's expiry is closed by the next order of its wallet and name only while nothing has reached it", async ({ request }) => {
  const label = uniqueLabel("co")
  const draft = await draftOf(label)
  const q = await quote(label)
  const order = async (method: api.Method) => call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, method, q.price))
  const empty = await order("btc")
  await control(request, `overdue/${empty.json.invoiceId}`)
  expect(await heldStatus(empty.json.invoiceId as string), "not marked before an order meets it").toBe("open")
  const funded = await order("xmr")
  expect(funded.status, JSON.stringify(funded.json)).toBe(200)
  expect(await heldStatus(empty.json.invoiceId as string), "closed by the new order").toBe("expired")

  await control(request, `partial/${funded.json.invoiceId}`)
  await control(request, `overdue/${funded.json.invoiceId}`)
  expect(await order("btc"), "a paid order meeting the funded one").toEqual({ status: 409, json: { error: "order_exists" } })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const coded = await call("POST", "/api/name/register", { ...(await flow.orderRequest(draft)).request, code })
  expect(coded, "a code order meeting the funded one").toEqual({ status: 409, json: { error: "order_exists" } })
  const read = await call("GET", `/api/invoice/${funded.json.invoiceId}`)
  expect([read.json.status, read.json.cryptoAmountPaid], "a funded invoice past its expiry reads open").toEqual(["open", (Number(funded.json.cryptoAmount) / 2).toFixed(5)])
  expect(await call("POST", `/api/invoice/${funded.json.invoiceId}/cancel`)).toEqual({ status: 409, json: { error: "funded" } })
  await control(request, `settle/${funded.json.invoiceId}`)
  expect((await viewOf((funded.json.registration as Json).id as string)).phase, "settled into a registration").not.toBe("unpaid")
})

test("a code order closes an overdue invoice of its wallet and name with nothing received", async ({ request }) => {
  const label = uniqueLabel("cd")
  const draft = await draftOf(label)
  const paid = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "btc", (await quote(label)).price))
  await control(request, `overdue/${paid.json.invoiceId}`)
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const coded = await call("POST", "/api/name/register", { ...(await flow.orderRequest(draft)).request, code })
  expect(coded.status, JSON.stringify(coded.json)).toBe(200)
  expect(await heldStatus(paid.json.invoiceId as string)).toBe("expired")
})

test("search quotes the oracle with the term's start, and a registered name carries its grace period", async () => {
  const label = uniqueLabel("cq")
  const answer = await quote(label)
  expect([answer.price, answer.years, answer.termStart]).toEqual([await oracleQuote(label, 2), 2, TERM_START])
  for (const [length, cents] of [[6, 40000], [7, 20000], [12, 10000]]) {
    const res = await call("GET", `/api/name/${hex(labelHash("x".repeat(length)))}?length=${length}`)
    expect(res.json.price, `${length} letters`).toBe(cents)
  }
  const bakery = await call("GET", `/api/name/${hex(labelHash("bakery"))}?length=6`)
  expect([bakery.json.status, bakery.json.gracePeriod]).toEqual(["registered", 90 * 86400])
})

test("a code check answers every state, revoked included, and an unknown code is code_invalid", async ({ request }) => {
  for (const state of ["unused", "reserved", "used", "revoked", "expired", "unpaid"]) {
    const { code } = await control(request, "code", { minLength: 7, years: 3, state }) as { code: string }
    expect((await call("POST", "/api/code/check", { code })).json, state).toEqual({ minLength: 7, years: 3, state })
  }
  for (const code of ["SN7-BJTBP-29596-R3HJ8-25YM7", "SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G", "nonsense"]) {
    expect(await call("POST", "/api/code/check", { code }), code).toEqual({ status: 400, json: { error: "code_invalid" } })
  }
})

test("a code check whose body has no text code is bad_request", async () => {
  for (const body of [{}, { code: null }, { code: 6 }, { code: ["SN7-BJTBP-29596-R3HJ8-25YM7"] }]) {
    expect(await call("POST", "/api/code/check", body), JSON.stringify(body)).toEqual({ status: 400, json: { error: "bad_request" } })
  }
})

test("a code order without a text code is bad_request, even for a name too short", async () => {
  const { request } = await flow.orderRequest(await draftOf(uniqueLabel("ck")))
  for (const code of [undefined, null, 6, ["SN7-BJTBP-29596-R3HJ8-25YM7"]]) {
    for (const length of [request.length, 5]) {
      const res = await call("POST", "/api/name/register", { ...request, length, code })
      expect(res, `code ${JSON.stringify(code)}, length ${length}`).toEqual({ status: 400, json: { error: "bad_request" } })
    }
  }
})

test("a code order whose text is no issued code is code_invalid", async () => {
  const { request } = await flow.orderRequest(await draftOf(uniqueLabel("ci")))
  for (const code of ["SN7-BJTBP-29596-R3HJ8-25YM7", "SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G", "nonsense", ""]) {
    expect(await call("POST", "/api/name/register", { ...request, code }), code).toEqual({ status: 400, json: { error: "code_invalid" } })
  }
})

test("a client's code checks and code orders past the code limit in a minute are rate_limited with the wait, whatever each answered, and another client's are not", async () => {
  for (let i = 0; i < CODE_LIMIT; i++) {
    const path = i % 2 ? "/api/code/check" : "/api/name/register"
    expect((await call("POST", path, {})).status, `${path}, request ${i + 1}`).toBe(400)
  }
  for (const path of ["/api/code/check", "/api/name/register"]) {
    const res = await send("POST", path, { code: "SN7-BJTBP-29596-R3HJ8-25YM7" })
    expect({ status: res.status, json: await res.json() }, path).toEqual({ status: 429, json: { error: "rate_limited" } })
    expect(Number(res.headers.get("retry-after")), `${path}: the seconds left of the minute`).toBeGreaterThan(50)
  }
  client = newClient()
  expect((await call("POST", "/api/code/check", {})).status, "another client").toBe(400)
})

test("find lists an owner's orders newest first, each with its label hash and sealed", async ({ request }) => {
  const { draft, built, id } = await codeOrder(request, uniqueLabel("cf"))
  const next = uniqueLabel("cf2")
  const later = (await flow.orderRequest({ ...draft, label: next })).request
  const second = await call("POST", "/api/invoice", invoiceBody(later, "btc", (await quote(next)).price))
  const wallet = flow.walletOf(draft.ownerCode)!
  const timestamp = Math.floor(Date.now() / 1000)
  const owner = built.owner.toLowerCase()
  const found = await call("POST", "/api/registration/find", { owner, timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(`simplex.domains find ${owner} ${timestamp}`))) })
  expect(found.json.registrations).toMatchObject([
    { invoiceId: second.json.invoiceId, phase: "unpaid", labelHash: later.labelHash, sealed: later.sealed },
    { registrationId: id, invoiceId: null, labelHash: built.request.labelHash, sealed: built.request.sealed },
  ])
  const stale = await call("POST", "/api/registration/find", { owner, timestamp: timestamp - 2 * SIGNED_WINDOW_S, signature: hex(signDigest(wallet.privateKey, personalDigest(`simplex.domains find ${owner} ${timestamp - 2 * SIGNED_WINDOW_S}`))) })
  expect(stale.status).toBe(400)
})

test("a held poll wakes on a new version, and of two retries at once one wins and the other is registration_changed with the view", async ({ request }) => {
  const { id, view } = await failedOrder(request, uniqueLabel("cv"))
  const held = viewOf(id, view.version)
  await control(request, "search", { writeDelayMs: 1500 })
  let answers: { status: number; json: Json }[]
  try {
    answers = await Promise.all([call("POST", `/api/registration/${id}/retry`), call("POST", `/api/registration/${id}/retry`)])
  } finally {
    await control(request, "search", { writeDelayMs: 0 })
  }
  expect(answers.map((a) => a.status).sort()).toEqual([200, 409])
  const lost = answers.find((a) => a.status === 409)!.json
  expect(lost.error).toBe("registration_changed")
  expect((lost.registration as Json).version).toBeGreaterThan(view.version)
  const woken = await held
  expect(woken.version).toBeGreaterThan(view.version)
})

test("another name or links: refused from an order with nothing to fix, a repeat changes nothing, a dearer name is price_too_high, and the fourth move is move_limit", async ({ request }) => {
  const label = uniqueLabel("cm")
  const q = await quote(label)
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const paid = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
  const id = (paid.json.registration as Json).id as string
  store.saveOrder(flow.recordFor(draft, built, "btc", q.price, { registrationId: id, invoiceId: paid.json.invoiceId as string }))
  await control(request, `settle/${paid.json.invoiceId}`)
  const move = async (to: string) => moveOf(store.orderByRegistration(id)!, to)
  await untilPhase(id, ["committed"])
  await expect(move(uniqueLabel("cm2")), "a committed order whose links were not refused").rejects.toMatchObject({ code: "bad_request" })
  // the service refuses the links at the reveal, which records the refusal and wakes the order's polls
  const before = await untilRevealable(id)
  await control(request, "search", { refuseLinks: true })
  await expect(flow.revealOrder(before, store.orderByRegistration(id)!)).rejects.toMatchObject({ code: "invalid_link" })
  expect((await viewOf(id)).version).toBeGreaterThan(before.version)
  const dearer = `q${Math.random().toString(36).slice(2, 7).padEnd(5, "q")}`
  await expect(move(dearer), "a 6-letter name dearer than the order").rejects.toMatchObject({ code: "price_too_high", body: { price: 40000 } })
  // the same name without links, then other names from failed orders: three moves in all
  let view = await move(label)
  expect([view.moves, view.phase, view.price]).toEqual([1, "queued", q.price])
  for (let n = 2; n <= 3; n++) {
    await failAtRegister(request, id)
    view = await move(uniqueLabel(`cm${n}`))
    expect(view.moves).toBe(n)
  }
  const repeat = await call("POST", `/api/registration/${id}/name`, await nameBody(store.orderByRegistration(id)!, view))
  expect([repeat.status, (repeat.json as unknown as api.RegistrationView).moves], "a repeat of the current fields").toEqual([200, 3])
  await failAtRegister(request, id)
  await expect(move(uniqueLabel("cm4"))).rejects.toMatchObject({ code: "move_limit", body: { registration: { id, moves: 3, phase: "failed" } } })
})

// the /name body of the registration's current fields, under its own terms or `terms`, signed anew
async function nameBody(record: store.OrderRecord, view: api.RegistrationView, terms = view.terms!, timestamp = Math.floor(Date.now() / 1000)): Promise<Json> {
  const sealedHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(view.sealed))))
  const length = record.label.length
  const message = `simplex.domains name ${view.id} ${view.labelHash} ${length} ${view.duration} ${view.commitment} ${sealedHash} ${terms} ${timestamp}`
  return { labelHash: view.labelHash, length, duration: view.duration, commitment: view.commitment, sealed: view.sealed, terms, timestamp,
    signature: hex(signDigest(flow.walletOf(record.ownerCode)!.privateKey, personalDigest(message))) }
}

// a name registered from a code order, without links, with what made it
async function registeredName(request: APIRequestContext, prefix: string) {
  const label = uniqueLabel(prefix)
  const { draft, built, id } = await codeOrder(request, label)
  await flow.revealOrder(await untilRevealable(id), flow.recordFor(draft, built, "code", 0, { registrationId: id, invoiceId: null }))
  await untilPhase(id, ["registered"])
  return { label, draft, labelHash: built.request.labelHash }
}

type RegisteredName = Awaited<ReturnType<typeof registeredName>>
type LinkEdit = { key: string; value: string; nonce: number; deadline: number; signature: string }

// one edit of a link of the name, signed by its key at this records nonce
function linkEdit(name: RegisteredName, key: string, value: string, nonce: number): LinkEdit {
  const deadline = Math.floor(Date.now() / 1000) + 3600
  const digest = setTextDigest(BigInt(name.draft.chain.chainId), fromHex(name.draft.chain.resolver), namehash("simplex", name.label), key, value, BigInt(nonce), BigInt(deadline))
  return { key, value, nonce, deadline, signature: hex(signDigest(flow.walletOf(name.draft.ownerCode)!.privateKey, digest)) }
}

const answerOf = async (name: RegisteredName) => (await call("GET", `/api/name/${name.labelHash}?length=${name.label.length}`)).json

// a request of one contact link edit of the name, at the name's records nonce unless one is given
async function contactEdit(name: RegisteredName, value: string, nonce?: number): Promise<{ labelHash: string; edits: LinkEdit[] }> {
  return { labelHash: name.labelHash, edits: [linkEdit(name, CONTACT_KEY, value, nonce ?? (await answerOf(name)).recordsNonce as number)] }
}

test("a link edit repeated after it was mined is answered from the edit, not checked anew", async ({ request }) => {
  const name = await registeredName(request, "ce")
  const edit = await contactEdit(name, contactLink("Ce"))
  const first = await call("POST", "/api/name/records", edit)
  expect(first.status, JSON.stringify(first.json)).toBe(200)
  expect(await call("POST", "/api/name/records", edit)).toEqual(first)
  // the same nonce with another value is checked anew, and its nonce has moved
  const other = await contactEdit(name, contactLink("Cf"), edit.edits[0].nonce)
  expect(await call("POST", "/api/name/records", other)).toEqual({ status: 400, json: { error: "bad_request" } })
})

test("a Save's two link edits are one request and one multicall transaction, counted as one edit, and its exact resend answers it again", async ({ request }) => {
  const name = await registeredName(request, "ct")
  const before = await answerOf(name)
  const nonce = before.recordsNonce as number
  const [contact, channel] = [contactLink("Ct"), channelLink("Ct")]
  const save = { labelHash: name.labelHash, edits: [linkEdit(name, CONTACT_KEY, contact, nonce), linkEdit(name, CHANNEL_KEY, channel, nonce + 1)] }
  const sent = await call("POST", "/api/name/records", save)
  expect(sent.status, JSON.stringify(sent.json)).toBe(200)
  expect(await textChangesOf(sent.json.tx as string)).toEqual({ multicall: true, changes: [[CONTACT_KEY, contact], [CHANNEL_KEY, channel]] })
  const after = await answerOf(name)
  expect([after.records, after.recordsNonce, (after.recordEdits as Json).left]).toEqual([{ contact, channel }, nonce + 2, (before.recordEdits as Json).left as number - 1])
  expect(await call("POST", "/api/name/records", save)).toEqual(sent)
  expect(((await answerOf(name)).recordEdits as Json).left, "the resend counts nothing").toBe((after.recordEdits as Json).left)
  // the second edit alone is another request, checked anew against the nonce both spent
  expect(await call("POST", "/api/name/records", { labelHash: name.labelHash, edits: [save.edits[1]] })).toEqual({ status: 400, json: { error: "bad_request" } })
})

test("a records request of no edit, three, one key twice, a clear beside a set, or nonces not consecutive is bad_request", async () => {
  const signature = `0x${"11".repeat(64)}1b`
  const deadline = Math.floor(Date.now() / 1000) + 3600
  // a link that is not one, which would be invalid_link had the edits' formats passed
  const set = (key: string, nonce: number) => ({ key, value: "https://x/a", nonce, deadline, signature })
  const labelHash = `0x${"ab".repeat(32)}`
  for (const edits of [[], [set(CONTACT_KEY, 1), set(CHANNEL_KEY, 2), set(CONTACT_KEY, 3)], [set(CHANNEL_KEY, 1), set(CHANNEL_KEY, 2)],
    [{ clear: true, nonce: 1, deadline, signature }, set(CONTACT_KEY, 2)], [set(CONTACT_KEY, 1), set(CHANNEL_KEY, 3)], [set(CONTACT_KEY, 2), set(CHANNEL_KEY, 1)]]) {
    expect(await call("POST", "/api/name/records", { labelHash, edits }), JSON.stringify(edits)).toEqual({ status: 400, json: { error: "bad_request" } })
  }
})

test("a link edit of a name pointed at another resolver is bad_request, and goes through once the name points back", async ({ request }) => {
  const name = await registeredName(request, "cg")
  const edit = await contactEdit(name, contactLink("Cg"))
  await ownerSetsResolver(name.draft.ownerCode, name.label, ELSEWHERE)
  expect(await call("POST", "/api/name/records", edit)).toEqual({ status: 400, json: { error: "bad_request" } })
  await ownerSetsResolver(name.draft.ownerCode, name.label, name.draft.chain.resolver as Hex)
  const sent = await call("POST", "/api/name/records", edit)
  expect(sent.status, JSON.stringify(sent.json)).toBe(200)
})

test("search splits a record set elsewhere on semicolons, trims each link, and answers the first five links of each key's kind", async ({ request }) => {
  const name = await registeredName(request, "cl")
  const contacts = ["L1", "L2", "L3", "L4", "L5", "L6"].map(contactLink)
  const contact = [`  ${contacts[0]}`, channelLink("Lx"), "not a link", "", ...contacts.slice(1)].join(" ; ")
  const channel = `${channelLink("K1")} ;${contactLink("K2")}; `
  await ownerSetsText(name.draft.ownerCode, name.label, CONTACT_KEY, contact)
  await ownerSetsText(name.draft.ownerCode, name.label, CHANNEL_KEY, channel)
  const answer = (await call("GET", `/api/name/${name.labelHash}?length=${name.label.length}`)).json
  expect(answer.records).toEqual({ contact, channel })
  expect((answer.entities as Json[]).map((e) => [e.type, e.link])).toEqual([...contacts.slice(0, 5).map((link) => ["address", link]), ["channel", channelLink("K1")]])
})

test("search answers a link whose data was not read now as unread with its deep link, and one the chat core cannot parse as unavailable without one", async ({ request }) => {
  const name = await registeredName(request, "cu")
  const unread = contactLink("Unr")
  const unparsed = "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm"
  await ownerSetsText(name.draft.ownerCode, name.label, CONTACT_KEY, unread)
  await ownerSetsText(name.draft.ownerCode, name.label, CHANNEL_KEY, unparsed)
  const answer = (await call("GET", `/api/name/${name.labelHash}?length=${name.label.length}`)).json
  const empty = { displayName: "", fullName: "", image: null, subscribers: null }
  expect(answer.entities).toEqual([
    { type: "address", kind: "contact", ...empty, profile: "unread", link: unread, deepLink: `simplex:/a#${unread.split("#")[1]}?h=smp8.simplex.im` },
    { type: "channel", kind: "channel", ...empty, profile: "unavailable", link: unparsed, deepLink: null },
  ])
  expect((await call("POST", "/api/link/preview", { link: unread })).json, "a preview").toEqual({ type: "address", kind: "contact", ...empty, profile: "unread" })
})

// --- balances

// the dev oracle's prices for 2 years: 6 letters, 7 letters, 8 or more
const PRICE = { six: 40000, seven: 20000, long: 10000 }

// a fresh name of exactly `length` letters, for the prices by length
const shortLabel = (length: number) => `q${Math.random().toString(36).slice(2).replace(/[^a-z]/g, "")}${"q".repeat(length)}`.slice(0, length)

const sha256Of = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))

type Paying = { draft: flow.Draft; record: store.OrderRecord; id: string; invoiceId: string; price: number }

// An order of a new code whose invoice closed with nothing received, then got its money: a closed order holding a balance of its price.
async function lateBalance(request: APIRequestContext, label = uniqueLabel("lb"), method: api.Method = "btc"): Promise<Paying> {
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const { price } = await quote(label)
  const opened = await call("POST", "/api/invoice", invoiceBody(built.request, method, price))
  expect(opened.status, JSON.stringify(opened.json)).toBe(200)
  const invoiceId = opened.json.invoiceId as string
  const id = (opened.json.registration as Json).id as string
  await control(request, `expire/${invoiceId}`)
  await control(request, `settle/${invoiceId}`)
  const record = flow.recordFor(draft, built, method, price, { registrationId: id, invoiceId })
  store.saveOrder(record)
  return { draft, record, id, invoiceId, price }
}

// a new name's order under the paying order's code
const orderOf = async (src: Paying, label: string, change: Partial<flow.Draft> = {}) =>
  (await flow.orderRequest({ ...await draftOf(label), ownerCode: src.draft.ownerCode, ...change })).request

async function spendBody(src: Paying, request: api.SignedOrder, money: Json, timestamp = request.timestamp, ownerCode = src.draft.ownerCode): Promise<Json> {
  const message = `simplex.domains spend ${src.id} ${request.labelHash} ${request.length} ${request.duration} ${request.commitment} ${await sha256Of(request.sealed)} ${request.terms} ${timestamp}`
  return {
    labelHash: request.labelHash, length: request.length, duration: request.duration, commitment: request.commitment, sealed: request.sealed, ...money, terms: request.terms, timestamp,
    signature: hex(signDigest(flow.walletOf(ownerCode)!.privateKey, personalDigest(message))),
  }
}

const spendCall = (id: string, body: Json) => call("POST", `/api/registration/${id}/spend`, body)
const balanceOf = async (id: string) => (await viewOf(id)).balance
const free = (amount: number, refunded = 0) => ({ amount, held: false, heldUntil: null, refunded })

// A difference spend from the paying order, holding its whole balance; its invoice.
async function holdBalance(src: Paying, balance: number): Promise<Json> {
  const res = await spendCall(src.id, await spendBody(src, await orderOf(src, shortLabel(7)), { price: PRICE.seven, balance, method: "btc" }))
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return res.json
}

async function findOf(ownerCode: string): Promise<{ registrationId: string; invoiceId: string | null }[]> {
  const owner = checksumAddress(flow.walletOf(ownerCode)!.address).toLowerCase()
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = hex(signDigest(flow.walletOf(ownerCode)!.privateKey, personalDigest(`simplex.domains find ${owner} ${timestamp}`)))
  return (await call("POST", "/api/registration/find", { owner, timestamp, signature })).json.registrations as never
}

test("a balance pays a cheaper name at once and keeps the rest, an exact price spends it to 0, and find lists those orders without an invoice", async ({ request }) => {
  const src = await lateBalance(request, shortLabel(7))
  expect(await balanceOf(src.id), "a late payment kept as the closed order's balance").toEqual(free(PRICE.seven))
  const first = uniqueLabel("sa")
  const covered = await spendOn(src.record, first, PRICE.seven)
  const view = await viewOf(covered.registrationId)
  expect([view.price, view.fromBalance, view.owner, view.balance]).toEqual([PRICE.long, PRICE.long, src.record.owner, null])
  expect(view.phase, "queued at once, and on its way").not.toBe("unpaid")
  expect(await balanceOf(src.id)).toEqual(free(PRICE.seven - PRICE.long))
  const second = uniqueLabel("sb")
  const exact = await spendOn(src.record, second, PRICE.seven - PRICE.long)
  expect(await balanceOf(src.id)).toEqual(free(0))
  expect(await findOf(src.draft.ownerCode)).toMatchObject([
    { registrationId: exact.registrationId, invoiceId: null }, { registrationId: covered.registrationId, invoiceId: null }, { registrationId: src.id, invoiceId: src.invoiceId },
  ])
})

test("a dearer name holds the whole balance until its invoice for the difference is paid, its exact resend answers it in any phase, and settlement spends the hold", async ({ request }) => {
  const src = await lateBalance(request)
  const order = await orderOf(src, shortLabel(7))
  const money = { price: PRICE.seven, balance: PRICE.long, method: "btc" }
  const res = await spendCall(src.id, await spendBody(src, order, money))
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  const registration = res.json.registration as api.RegistrationView
  expect([res.json.amount, registration.phase, registration.price, registration.fromBalance]).toEqual([PRICE.seven - PRICE.long, "unpaid", PRICE.seven, PRICE.long])
  expect(await balanceOf(src.id)).toEqual({ amount: PRICE.long, held: true, heldUntil: res.json.expiresAt, refunded: 0 })
  // signed again long after, with the balance held since: the same order
  const again = await spendBody(src, order, money, order.timestamp + 2 * SIGNED_WINDOW_S)
  expect((await spendCall(src.id, again)).json.invoiceId).toBe(res.json.invoiceId)
  expect(await call("POST", "/api/invoice", invoiceBody(order, "btc", PRICE.seven)), "an invoice order of the same fields is another order").toEqual({ status: 409, json: { error: "order_exists" } })
  await control(request, `settle/${res.json.invoiceId}`)
  expect(await balanceOf(src.id), "spent by the settlement").toEqual(free(0))
  expect((await viewOf(registration.id)).phase).not.toBe("unpaid")
  const resent = await spendCall(src.id, again)
  expect([resent.json.invoiceId, resent.json.status]).toEqual([res.json.invoiceId, "paid"])
})

test("a spend refuses in the contract's order: formats, the paying order, its owner, existing orders, the time, the balance, the chain, the price, the provider", async ({ request }) => {
  const src = await lateBalance(request)
  const label = shortLabel(7)
  const order = await orderOf(src, label)
  const difference = { price: PRICE.seven, balance: PRICE.long, method: "btc" }
  const signed = (money: Json, request = order) => spendBody(src, request, money)
  const unpaid = await call("POST", "/api/invoice", invoiceBody(await orderOf(src, shortLabel(7)), "btc", PRICE.seven))
  const unpaidId = (unpaid.json.registration as Json).id as string
  // a name the code already has a live order for
  const ordered = shortLabel(7)
  await call("POST", "/api/invoice", invoiceBody(await orderOf(src, ordered), "btc", PRICE.seven))
  const off = await orderOf(src, label, { termStart: (await quote(label)).termStart + TERM_SLACK_S + 100 })
  const refusals: [string, string, Json | Promise<Json>, number, Json][] = [
    ["a method for a covered price", src.id, signed({ price: PRICE.long, balance: PRICE.long, method: "btc" }), 400, { error: "bad_request" }],
    ["no method for a difference", src.id, signed({ price: PRICE.seven, balance: PRICE.long }), 400, { error: "bad_request" }],
    ["a price of 0", src.id, signed({ price: 0, balance: PRICE.long }), 400, { error: "bad_request" }],
    ["a balance as text", src.id, signed({ ...difference, balance: String(PRICE.long) }), 400, { error: "bad_request" }],
    ["no sealed", src.id, signed(difference).then((b) => ({ ...b, sealed: undefined })), 400, { error: "bad_request" }],
    ["a sealed over 11095 characters", src.id, signed(difference).then((b) => ({ ...b, sealed: "a".repeat(11096) })), 400, { error: "bad_request" }],
    ["a name of 5 letters", src.id, signed(difference).then((b) => ({ ...b, length: 5 })), 400, { error: "invalid_name" }],
    ["an unknown order", "nope", signed(difference), 404, { error: "not_found" }],
    ["another key's signature", src.id, spendBody(src, order, difference, order.timestamp, flow.newOwnerCode()), 400, { error: "bad_request" }],
    ["a live order of the code for the name", src.id, signed(difference, await orderOf(src, ordered)), 409, { error: "order_exists" }],
    // checks run in order, so a request with two flaws meets the earlier one
    ["a live order and a balance other than the order's", src.id, signed({ ...difference, balance: PRICE.long - 1 }, await orderOf(src, ordered)), 409, { error: "order_exists" }],
    ["a stale timestamp and a balance other than the order's", src.id, spendBody(src, order, { ...difference, balance: PRICE.long - 1 }, order.timestamp - SIGNED_WINDOW_S - 100), 400, { error: "bad_request" }],
    ["a timestamp past the window", src.id, spendBody(src, order, difference, order.timestamp - SIGNED_WINDOW_S - 100), 400, { error: "bad_request" }],
    ["free days more than an hour off", src.id, signed(difference, off), 400, { error: "bad_request" }],
    ["a balance other than the order's", src.id, signed({ ...difference, balance: PRICE.long - 1 }), 409, { error: "balance_changed", balance: free(PRICE.long) }],
    ["an order with no balance", unpaidId, spendBody({ ...src, id: unpaidId }, await orderOf(src, shortLabel(7)), difference), 409, { error: "balance_changed", balance: null }],
    ["a name registered", src.id, signed({ ...difference, price: PRICE.six }, await orderOf(src, shortLabel(7), { label: "bakery" })), 409, { error: "name_taken" }],
    ["a price the chain does not quote", src.id, signed({ ...difference, price: PRICE.seven + 1 }), 409, { error: "catalog_changed", price: PRICE.seven }],
  ]
  for (const [what, id, body, status, answer] of refusals) {
    const res = await spendCall(id, await body)
    expect([res.status, res.json], what).toEqual([status, answer])
  }
  const [unread, unpayable] = [await signed(difference, await orderOf(src, shortLabel(7))), await signed(difference, await orderOf(src, shortLabel(7)))]
  try {
    await control(request, "search", { chainDown: true })
    expect(await spendCall(src.id, unread), "the chain unread").toEqual({ status: 503, json: { error: "name_check_unavailable" } })
  } finally {
    await control(request, "search", { chainDown: false })
  }
  try {
    await control(request, "search", { invoiceError: "provider_unavailable" })
    expect(await spendCall(src.id, unpayable), "the payment method down").toEqual({ status: 503, json: { error: "provider_unavailable" } })
  } finally {
    await control(request, "search", { invoiceError: null })
  }
  expect(await balanceOf(src.id), "nothing held or spent").toEqual(free(PRICE.long))
})

test("of two spends of one balance at once, one wins and the other is balance_changed with the balance it left", async ({ request }) => {
  const src = await lateBalance(request)
  const money = { price: PRICE.long, balance: PRICE.long }
  const answers = await Promise.all([uniqueLabel("sc"), uniqueLabel("sd")].map(async (label) => spendCall(src.id, await spendBody(src, await orderOf(src, label), money))))
  expect(answers.map((a) => a.status).sort()).toEqual([200, 409])
  expect(answers.find((a) => a.status === 409)!.json).toEqual({ error: "balance_changed", balance: free(0) })
})

test("a cancel or an expiry releases a held balance; an overdue holder reads free and the next spend closes it, while a refund waits for it", async ({ request }) => {
  const src = await lateBalance(request, uniqueLabel("lc"), "card")
  const cancelled = await holdBalance(src, PRICE.long)
  expect((await balanceOf(src.id))!.held).toBe(true)
  expect((await call("POST", `/api/invoice/${cancelled.invoiceId}/cancel`)).status).toBe(200)
  expect(await balanceOf(src.id), "released by the cancel").toEqual(free(PRICE.long))
  const expired = await holdBalance(src, PRICE.long)
  await control(request, `expire/${expired.invoiceId}`)
  expect(await balanceOf(src.id), "released by the expiry").toEqual(free(PRICE.long))
  const overdue = await holdBalance(src, PRICE.long)
  await control(request, `overdue/${overdue.invoiceId}`)
  expect(await balanceOf(src.id), "an overdue holder holds nothing").toEqual(free(PRICE.long))
  expect(await heldStatus(overdue.invoiceId as string), "not closed by reading the balance").toBe("open")
  const { invoices } = (await call("GET", "/control/state")).json as { invoices: { id: string; expiresAt: string }[] }
  const refused = await call("POST", `/control/refund/${src.invoiceId}`, {})
  expect([refused.status, refused.json]).toEqual([409, { error: "balance_held", holder: (overdue.registration as Json).id, expiresAt: invoices.find((i) => i.id === overdue.invoiceId)!.expiresAt }])
  const covered = await spendCall(src.id, await spendBody(src, await orderOf(src, uniqueLabel("se")), { price: PRICE.long, balance: PRICE.long }))
  expect(covered.status, JSON.stringify(covered.json)).toBe(200)
  expect(await heldStatus(overdue.invoiceId as string), "closed by the spend").toBe("expired")
  expect(await balanceOf(src.id)).toEqual(free(0))
})

test("a holder that money reached keeps the hold past its expiry until it settles, and the next order of a holder's wallet and name closes an empty one", async ({ request }) => {
  const src = await lateBalance(request)
  const funded = await holdBalance(src, PRICE.long)
  await control(request, `partial/${funded.invoiceId}`)
  await control(request, `overdue/${funded.invoiceId}`)
  expect((await balanceOf(src.id))!.held, "money reached it, so it still holds").toBe(true)
  const met = await spendCall(src.id, await spendBody(src, await orderOf(src, uniqueLabel("sf")), { price: PRICE.long, balance: PRICE.long }))
  expect([met.status, (met.json.balance as Json).held]).toEqual([409, true])
  await control(request, `settle/${funded.invoiceId}`)
  expect(await balanceOf(src.id)).toEqual(free(0))

  const other = await lateBalance(request)
  const label = shortLabel(7)
  const holder = await spendCall(other.id, await spendBody(other, await orderOf(other, label), { price: PRICE.seven, balance: PRICE.long, method: "xmr" }))
  await control(request, `overdue/${holder.json.invoiceId}`)
  const next = await call("POST", "/api/invoice", invoiceBody(await orderOf(other, label), "btc", PRICE.seven))
  expect(next.status, JSON.stringify(next.json)).toBe(200)
  expect(await heldStatus(holder.json.invoiceId as string)).toBe("expired")
  expect(await balanceOf(other.id), "released when the next order closed its holder").toEqual(free(PRICE.long))
})

test("support's refund takes the whole balance by invoice id or registration id, refuses other cents or none left, and a cheaper move credits the rest again", async ({ request }) => {
  const src = await lateBalance(request)
  const refund = (reference: string, body: Json = {}) => call("POST", `/control/refund/${reference}`, body)
  expect(await refund(src.invoiceId, { cents: PRICE.long - 1 })).toEqual({ status: 409, json: { error: "balance_changed", balance: free(PRICE.long) } })
  for (const cents of [0, "100", 1.5]) expect(await refund(src.invoiceId, { cents }), String(cents)).toEqual({ status: 400, json: { error: "bad_request" } })
  expect((await refund("nope")).status).toBe(404)
  expect(await refund(src.invoiceId, { cents: PRICE.long })).toEqual({ status: 200, json: { registrationId: src.id, cents: PRICE.long, chain: [
    { registrationId: src.id, invoiceId: src.invoiceId, method: "btc", fromBalance: 0, invoiced: 0, late: PRICE.long },
  ] } })
  expect(await balanceOf(src.id)).toEqual(free(0, PRICE.long))
  expect(await refund(src.id)).toEqual({ status: 409, json: { error: "no_balance" } })

  // a paid order that failed, moved to cheaper names twice: each move keeps the rest, and each refund adds to what was refunded
  const label = shortLabel(6)
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const paid = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", PRICE.six))
  const id = (paid.json.registration as Json).id as string
  store.saveOrder(flow.recordFor(draft, built, "btc", PRICE.six, { registrationId: id, invoiceId: paid.json.invoiceId as string }))
  await control(request, `settle/${paid.json.invoiceId}`)
  await failAtRegister(request, id)
  const move = async (to: string) => moveOf(store.orderByRegistration(id)!, to)
  expect((await move(shortLabel(7))).balance).toEqual(free(PRICE.six - PRICE.seven))
  expect((await refund(id)).json).toMatchObject({ registrationId: id, cents: PRICE.six - PRICE.seven })
  await failAtRegister(request, id)
  const moved = await move(uniqueLabel("cr"))
  expect([moved.price, moved.balance]).toEqual([PRICE.long, free(PRICE.seven - PRICE.long, PRICE.six - PRICE.seven)])
  expect((await refund(paid.json.invoiceId as string, { cents: PRICE.seven - PRICE.long })).status).toBe(200)
  expect(await balanceOf(id)).toEqual(free(0, PRICE.six - PRICE.long))
})

test("a paid order taken first keeps its whole price as a balance of its own, also when a balance paid it, moves no more, and its refund names what paid it", async ({ request }) => {
  const src = await lateBalance(request)
  const label = uniqueLabel("st")
  const next = await spendOn(src.record, label, PRICE.long)
  await control(request, "take", { label })
  await flow.revealOrder(await untilRevealable(next.registrationId), next)
  const view = await untilPhase(next.registrationId, ["taken"])
  expect([view.fromBalance, view.balance]).toEqual([PRICE.long, free(PRICE.long)])
  const other = uniqueLabel("st2")
  await expect(moveOf(next, other), "a taken order keeps its balance and moves no more").rejects.toMatchObject({ code: "bad_request" })
  expect(await balanceOf(src.id), "the paying order's balance untouched").toEqual(free(0))
  expect((await call("POST", `/control/refund/${next.registrationId}`, {})).json).toEqual({ registrationId: next.registrationId, cents: PRICE.long, chain: [
    { registrationId: next.registrationId, invoiceId: null, method: "balance", fromBalance: PRICE.long, invoiced: 0, late: 0 },
    { registrationId: src.id, invoiceId: src.invoiceId, method: "btc", fromBalance: 0, invoiced: 0, late: PRICE.long },
  ] })
})

test("a late payment is credited once settled, each confirmed figure once, at the lower of its invoice's rate and the current one", async ({ request }) => {
  // an order whose invoice closed with nothing received
  const closed = async (method: api.Method) => {
    const label = uniqueLabel("lp")
    const res = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(label))).request, method, (await quote(label)).price))
    await control(request, `expire/${res.json.invoiceId}`)
    return { invoiceId: res.json.invoiceId as string, id: (res.json.registration as Json).id as string, cryptoAmount: res.json.cryptoAmount }
  }
  const btc = await closed("btc")
  for (const unconfirmed of ["partial", "confirming"]) {
    await control(request, `${unconfirmed}/${btc.invoiceId}`)
    expect(await balanceOf(btc.id), `${unconfirmed} on a closed invoice`).toBeNull()
  }
  await control(request, `settle/${btc.invoiceId}`)
  await control(request, `settle/${btc.invoiceId}`)
  expect(await balanceOf(btc.id), "the same figure settled twice").toEqual(free(PRICE.long))
  const settled = await call("GET", `/api/invoice/${btc.invoiceId}`)
  expect([settled.json.status, settled.json.paidInFull, settled.json.cryptoAmountDue, (settled.json.registration as Json).latePayment], "kept closed, all of it credited")
    .toEqual(["expired", true, "0", null])
  const card = await closed("card")
  await control(request, `settle/${card.invoiceId}`)
  expect(await balanceOf(card.id)).toEqual(free(PRICE.long))
  // received while open, held when the invoice closed, then confirmed
  const label = uniqueLabel("lq")
  const open = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(label))).request, "xmr", (await quote(label)).price))
  await control(request, `partial/${open.json.invoiceId}`)
  await control(request, `expire/${open.json.invoiceId}`)
  await control(request, `settle/${open.json.invoiceId}`)
  expect(await balanceOf((open.json.registration as Json).id as string)).toEqual(free(PRICE.long))
  try {
    // the coins' prices halved and doubled since the invoices: 0.00156 BTC at $32000, and 0.625 XMR at its invoice's rate
    await control(request, "rate", { btc: 32000, xmr: 320 })
    const fallen = await closed("btc")
    expect(fallen.cryptoAmount).toBe("0.00156")
    await control(request, `settle/${fallen.invoiceId}`)
    expect(await balanceOf(fallen.id)).toEqual(free(4992))
    const risen = await closed("xmr")
    expect(risen.cryptoAmount).toBe("0.625")
    await control(request, `settle/${risen.invoiceId}`)
    expect(await balanceOf(risen.id)).toEqual(free(PRICE.long))
  } finally {
    await control(request, "rate", { btc: null, xmr: null })
  }
  for (const rate of [0, -1, 1.5, "32000"]) expect((await call("POST", "/control/rate", { btc: rate })).status, String(rate)).toBe(400)
})

test("a part payment confirmed on a closed invoice, also after a cancel, is credited at its share of the price, and the rest once it arrives", async ({ request }) => {
  const label = uniqueLabel("lpp")
  const res = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(label))).request, "btc", PRICE.long))
  const [invoiceId, id] = [res.json.invoiceId as string, (res.json.registration as Json).id as string]
  expect(res.json.cryptoAmount).toBe("0.00156")
  await control(request, `partial/${invoiceId}`)
  expect(await call("POST", `/api/invoice/${invoiceId}/cancel`)).toEqual({ status: 409, json: { error: "funded" } })
  await control(request, `expire/${invoiceId}`)
  expect([(await viewOf(id)).latePayment, await balanceOf(id)], "seen, not confirmed").toEqual([{ waiting: "confirming" }, null])
  await control(request, `settle/${invoiceId}`, { paid: "0.00078" })
  const part = await call("GET", `/api/invoice/${invoiceId}`)
  expect([part.json.status, part.json.paidInFull, part.json.cryptoAmountPaid, part.json.cryptoAmountDue]).toEqual(["expired", false, "0.00078", "0.00078"])
  expect([(await viewOf(id)).latePayment, await balanceOf(id)]).toEqual([null, free(PRICE.long / 2)])
  await control(request, `settle/${invoiceId}`)
  const whole = await call("GET", `/api/invoice/${invoiceId}`)
  expect([whole.json.status, whole.json.paidInFull, whole.json.cryptoAmountPaid, whole.json.cryptoAmountDue]).toEqual(["expired", true, "0.00156", "0"])
  expect(await balanceOf(id)).toEqual(free(PRICE.long))

  const cancelled = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(uniqueLabel("lpc")))).request, "xmr", PRICE.long))
  await call("POST", `/api/invoice/${cancelled.json.invoiceId}/cancel`)
  await control(request, `settle/${cancelled.json.invoiceId}`, { paid: "0.125" })
  const after = await call("GET", `/api/invoice/${cancelled.json.invoiceId}`)
  expect([after.json.status, after.json.paidInFull], "a cancelled invoice stays closed").toEqual(["expired", false])
  expect(await balanceOf((cancelled.json.registration as Json).id as string)).toEqual(free(PRICE.long / 5))
})

test("an overpaid invoice registers its name, leaves nothing to pay, and credits the extra at its share of the price or the lower current rate", async ({ request }) => {
  const overpaid = async (paid: string) => {
    const label = uniqueLabel("op")
    const draft = await draftOf(label)
    const built = await flow.orderRequest(draft)
    const res = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", PRICE.long))
    const [invoiceId, id] = [res.json.invoiceId as string, (res.json.registration as Json).id as string]
    store.saveOrder(flow.recordFor(draft, built, "btc", PRICE.long, { registrationId: id, invoiceId }))
    await control(request, `settle/${invoiceId}`, { paid })
    return { invoiceId, id }
  }
  const { invoiceId, id } = await overpaid("0.00234")
  const read = await call("GET", `/api/invoice/${invoiceId}`)
  expect([read.json.status, read.json.paidInFull, read.json.cryptoAmountPaid, read.json.cryptoAmountDue]).toEqual(["paid", true, "0.00234", "0"])
  expect((await viewOf(id)).phase).not.toBe("unpaid")
  expect(await balanceOf(id)).toEqual(free(PRICE.long / 2))
  await flow.revealOrder(await untilRevealable(id), store.orderByRegistration(id)!)
  expect((await untilPhase(id, ["registered"])).balance, "kept once registered").toEqual(free(PRICE.long / 2))
  try {
    await control(request, "rate", { btc: 32000 })
    expect(await balanceOf((await overpaid("0.00234")).id), "0.00078 BTC at $32000").toEqual(free(2496))
  } finally {
    await control(request, "rate", { btc: null, xmr: null })
  }
  const short = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(uniqueLabel("os")))).request, "btc", PRICE.long))
  for (const paid of ["0.00078", "lots", "-1", 5]) {
    expect((await call("POST", `/control/settle/${short.json.invoiceId}`, { paid })).status, `${paid} on an open invoice`).toBe(400)
  }
})

test("find lists the 50 newest orders of a code and then every older one holding a balance", async ({ request }) => {
  const draft = await draftOf(uniqueLabel("fa"))
  const { price } = await quote(draft.label)
  const order = async (label: string) => {
    const res = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest({ ...draft, label })).request, "btc", price))
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json
  }
  const plain = await order(draft.label)
  const kept = await order(uniqueLabel("fb"))
  await control(request, `expire/${kept.invoiceId}`)
  await control(request, `settle/${kept.invoiceId}`)
  const newest: Json[] = []
  for (let i = 0; i < 50; i++) newest.unshift(await order(uniqueLabel(`f${i}x`)))
  const found = await findOf(draft.ownerCode)
  expect(found.map((f) => f.invoiceId)).toEqual([...newest.map((n) => n.invoiceId), kept.invoiceId])
  expect(found.map((f) => f.invoiceId)).not.toContain(plain.invoiceId)
})

test("a hold by an invoice money reached has no end, find names each order's paying balance and holder, and late money says what its credit waits on", async ({ request }) => {
  const src = await lateBalance(request)
  const holder = await holdBalance(src, PRICE.long)
  const holderId = (holder.registration as Json).id as string
  expect(await balanceOf(src.id)).toEqual({ amount: PRICE.long, held: true, heldUntil: holder.expiresAt, refunded: 0 })
  expect(await findOf(src.draft.ownerCode)).toMatchObject([
    { registrationId: holderId, balanceSource: src.id, heldBy: null }, { registrationId: src.id, balanceSource: null, heldBy: holderId },
  ])
  // money reached the holder's invoice and is confirming past its expiry: the hold has no end until it settles
  await control(request, `partial/${holder.invoiceId}`)
  await control(request, `overdue/${holder.invoiceId}`)
  expect(await balanceOf(src.id)).toEqual({ amount: PRICE.long, held: true, heldUntil: null, refunded: 0 })
  expect((await findOf(src.draft.ownerCode))[1]).toMatchObject({ registrationId: src.id, heldBy: holderId })

  // an overdue holder that nothing reached holds nothing, and find names none
  const other = await lateBalance(request)
  const unfunded = await holdBalance(other, PRICE.long)
  await control(request, `overdue/${unfunded.invoiceId}`)
  expect(await balanceOf(other.id)).toEqual(free(PRICE.long))
  expect((await findOf(other.draft.ownerCode))[1]).toMatchObject({ registrationId: other.id, heldBy: null })

  // late money: received and not confirmed, then a credit held back as the service's would wait, then credited
  const late = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(uniqueLabel("lw")))).request, "btc", PRICE.long))
  const lateId = (late.json.registration as Json).id as string
  await control(request, `expire/${late.json.invoiceId}`)
  expect([(await viewOf(lateId)).latePayment, (await viewOf(lateId)).balance], "nothing received").toEqual([null, null])
  await control(request, `confirming/${late.json.invoiceId}`)
  expect((await viewOf(lateId)).latePayment).toEqual({ waiting: "confirming" })
  await control(request, `late/${late.json.invoiceId}`, { waiting: "support" })
  await control(request, `settle/${late.json.invoiceId}`)
  expect([(await viewOf(lateId)).latePayment, (await viewOf(lateId)).balance]).toEqual([{ waiting: "support" }, null])
  await control(request, `late/${late.json.invoiceId}`, { waiting: null })
  expect([(await viewOf(lateId)).latePayment, (await viewOf(lateId)).balance]).toEqual([null, free(PRICE.long)])
})

test("a wallet's registered order is not live: ordering the name again meets the name on chain, not the order", async ({ request }) => {
  const label = uniqueLabel("rl")
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const { price } = await quote(label)
  const paid = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", price))
  const id = (paid.json.registration as Json).id as string
  store.saveOrder(flow.recordFor(draft, built, "btc", price, { registrationId: id, invoiceId: paid.json.invoiceId as string }))
  await control(request, `settle/${paid.json.invoiceId}`)
  await flow.revealOrder(await untilRevealable(id), store.orderByRegistration(id)!)
  await untilPhase(id, ["registered"])
  const again = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "btc", price))
  expect([again.status, again.json.error]).toEqual([409, "name_taken"])
})

test("money paid after a difference invoice closed goes to that order's own balance, leaving the released balance that paid part of it as it was", async ({ request }) => {
  const src = await lateBalance(request)
  const holder = await holdBalance(src, PRICE.long)
  const holderId = (holder.registration as Json).id as string
  await control(request, `expire/${holder.invoiceId}`)
  expect(await balanceOf(src.id), "the close released the hold").toEqual(free(PRICE.long))
  await control(request, `settle/${holder.invoiceId}`)
  expect([await balanceOf(holderId), await balanceOf(src.id)]).toEqual([free(PRICE.seven - PRICE.long), free(PRICE.long)])
})

test("a spend whose difference is below the card's least charge refuses the card and takes coin", async ({ request }) => {
  const label = uniqueLabel("mc")
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const opened = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", PRICE.long))
  const id = (opened.json.registration as Json).id as string
  store.saveOrder(flow.recordFor(draft, built, "btc", PRICE.long, { registrationId: id, invoiceId: opened.json.invoiceId as string }))
  await control(request, `expire/${opened.json.invoiceId}`)
  try {
    // a coin's price a little below the invoice's, so the late payment credits 40-odd cents short of the price
    await control(request, "rate", { btc: Math.floor((PRICE.long - 40) / (Number(opened.json.cryptoAmount) * 100)) })
    await control(request, `settle/${opened.json.invoiceId}`)
  } finally {
    await control(request, "rate", { btc: null, xmr: null })
  }
  const amount = (await balanceOf(id))!.amount
  expect(PRICE.long - amount).toBeGreaterThan(0)
  expect(PRICE.long - amount).toBeLessThan(50)
  const src: Paying = { draft, record: store.orderByRegistration(id)!, id, invoiceId: opened.json.invoiceId as string, price: PRICE.long }
  const spendFor = async (method: api.Method) => spendCall(id, await spendBody(src, await orderOf(src, uniqueLabel("mcn")), { price: PRICE.long, balance: amount, method }))
  expect(await spendFor("card")).toEqual({ status: 400, json: { error: "bad_request" } })
  const coin = await spendFor("btc")
  expect([coin.status, coin.json.amount], "the difference in Bitcoin").toEqual([200, PRICE.long - amount])
})

// --- terms and community names

// the e2e spec's community name, which the service's contract run lists too
const COMMUNITY_LABEL = "bakers"
const TERMS_VERSION = "2026-10-23"
const COMMUNITY_TERMS = `${TERMS_VERSION}/community`

// The service's terms at another version while `f` runs, as after a restart with a new terms_version.
async function atVersion<T>(request: APIRequestContext, version: string, f: () => Promise<T>): Promise<T> {
  await control(request, "terms", { version })
  try {
    return await f()
  } finally {
    await control(request, "terms", { version: TERMS_VERSION })
  }
}

// A name of its own on the community list while `f` runs.
async function listed<T>(request: APIRequestContext, label: string, f: () => Promise<T>): Promise<T> {
  await control(request, "community", { label, for: "test bakers" })
  try {
    return await f()
  } finally {
    await control(request, "community", { label, for: null })
  }
}

const termsChanged = (version: string, community: Json | null) => ({ error: "terms_changed", terms: { version, url: expect.stringMatching(/^https:\/\//) }, community })

test("every search answer carries the name's community entry, and the available one the terms to agree to", async () => {
  const listed = (await call("GET", `/api/name/${hex(labelHash(COMMUNITY_LABEL))}?length=${COMMUNITY_LABEL.length}`)).json
  expect(listed).toMatchObject({ status: "available", community: { for: expect.any(String) }, terms: { version: TERMS_VERSION, url: expect.stringMatching(/^https:\/\//) } })
  const other = uniqueLabel("ta")
  expect((await call("GET", `/api/name/${hex(labelHash(other))}?length=${other.length}`)).json).toMatchObject({ status: "available", community: null, terms: { version: TERMS_VERSION } })
  for (const [name, status] of [["bakery", "registered"], ["support", "reserved"]]) {
    const answer = (await call("GET", `/api/name/${hex(labelHash(name))}?length=${name.length}`)).json
    expect([answer.status, answer.community], name).toEqual([status, null])
  }
})

test("an order signs the terms for its name: another variant or an old version is terms_changed with the terms and community now, a malformed one bad_request", async ({ request }) => {
  const community = await quote(COMMUNITY_LABEL)
  const plain = { ...await draftOf(COMMUNITY_LABEL), terms: TERMS_VERSION }
  const refused = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(plain)).request, "btc", community.price))
  expect([refused.status, refused.json]).toEqual([409, termsChanged(TERMS_VERSION, community.community as Json | null)])
  const label = uniqueLabel("tb")
  const q = await quote(label)
  const claimed = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest({ ...await draftOf(label), terms: COMMUNITY_TERMS })).request, "btc", q.price))
  expect([claimed.status, claimed.json]).toEqual([409, termsChanged(TERMS_VERSION, null)])
  const draft = await draftOf(label)
  const { request: signed } = await flow.orderRequest(draft)
  for (const terms of [undefined, "", "2026 10 23", "t".repeat(49), 5]) {
    const res = await call("POST", "/api/invoice", invoiceBody({ ...signed, terms } as never, "btc", q.price))
    expect([res.status, res.json], String(terms)).toEqual([400, { error: "bad_request" }])
  }
  await atVersion(request, "2026-11-01", async () => {
    // a stale timestamp is checked before the terms
    const stale = await signedAt(draft.ownerCode, signed, signed.timestamp - SIGNED_WINDOW_S - 100)
    expect((await call("POST", "/api/invoice", invoiceBody(stale, "btc", q.price))).json, "a stale timestamp").toEqual({ error: "bad_request" })
    const res = await call("POST", "/api/invoice", invoiceBody(signed, "btc", q.price))
    expect([res.status, res.json]).toEqual([409, termsChanged("2026-11-01", null)])
  })
  const ok = await call("POST", "/api/invoice", invoiceBody(signed, "btc", q.price))
  expect(ok.status, JSON.stringify(ok.json)).toBe(200)
  expect((ok.json.registration as Json).terms).toBe(TERMS_VERSION)
})

test("an exact resend is answered after the terms changed, and two orders differing only in terms are different orders", async ({ request }) => {
  const label = uniqueLabel("tc")
  const q = await quote(label)
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const first = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
  expect(first.status).toBe(200)
  await atVersion(request, "2026-11-01", async () => {
    const again = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
    expect([again.status, again.json.invoiceId]).toEqual([200, first.json.invoiceId])
    const other = await signedAt(draft.ownerCode, { ...built.request, terms: "2026-11-01" }, built.request.timestamp)
    expect((await call("POST", "/api/invoice", invoiceBody(other, "btc", q.price))).json).toEqual({ error: "order_exists" })
  })
})

test("a code order meets changed terms before the code's state, and a spend before its balance", async ({ request }) => {
  const label = uniqueLabel("td")
  const { code } = await control(request, "code", { minLength: 6, state: "used" }) as { code: string }
  const coded = await call("POST", "/api/name/register", { ...(await flow.orderRequest({ ...await draftOf(label), terms: COMMUNITY_TERMS })).request, code })
  expect([coded.status, coded.json]).toEqual([409, termsChanged(TERMS_VERSION, null)])
  const src = await lateBalance(request)
  const spent = await spendCall(src.id, await spendBody(src, await orderOf(src, shortLabel(7), { terms: COMMUNITY_TERMS }), { price: PRICE.seven, balance: PRICE.long - 1, method: "btc" }))
  expect([spent.status, spent.json]).toEqual([409, termsChanged(TERMS_VERSION, null)])
  const covered = await spendCall(src.id, await spendBody(src, await orderOf(src, uniqueLabel("te")), { price: PRICE.long, balance: PRICE.long }))
  expect(covered.status, JSON.stringify(covered.json)).toBe(200)
  expect((await viewOf(covered.json.registrationId as string)).terms).toBe(TERMS_VERSION)
})

test("a move signs the new name's terms: a community name needs the community wording, which is stored; the same body again is a repeat, also after the terms changed, and one differing only in terms a move", async ({ request }) => {
  const label = uniqueLabel("tf")
  await listed(request, label, async () => {
    const { id, view } = await failedOrder(request, uniqueLabel("tg"))
    expect([view.terms, view.community]).toEqual([TERMS_VERSION, null])
    const q = await quote(label)
    expect(q.community).toEqual({ for: "test bakers" })
    await expect(flow.retargetOrder(store.orderByRegistration(id)!, label, NO_LINKS, q, TERMS_VERSION)).rejects.toMatchObject({ code: "terms_changed", terms: { version: TERMS_VERSION }, community: { for: "test bakers" } })
    const moved = await flow.retargetOrder(store.orderByRegistration(id)!, label, NO_LINKS, q, COMMUNITY_TERMS)
    expect([moved.moves, moved.terms, moved.community]).toEqual([1, COMMUNITY_TERMS, { for: "test bakers" }])
    const record = store.orderByRegistration(id)!
    expect(record.terms).toBe(COMMUNITY_TERMS)
    const repeat = await call("POST", `/api/registration/${id}/name`, await nameBody(record, moved))
    expect([repeat.status, repeat.json.moves, repeat.json.version], "a repeat answers the view unchanged").toEqual([200, 1, (await viewOf(id)).version])
    const failed = await failAtRegister(request, id)
    await atVersion(request, "2026-11-01", async () => {
      // the current fields under the terms they were signed with are still a repeat, answered before the terms
      const again = await call("POST", `/api/registration/${id}/name`, await nameBody(record, failed))
      expect([again.status, again.json.moves, again.json.phase]).toEqual([200, 1, "failed"])
      const bumped = await call("POST", `/api/registration/${id}/name`, await nameBody(record, failed, "2026-11-01/community"))
      expect([bumped.status, bumped.json.moves, bumped.json.terms, bumped.json.commitment]).toEqual([200, 2, "2026-11-01/community", failed.commitment])
    })
  })
})

test("a move repeat is answered however old its signature, while a move signed too long ago is bad_request", async ({ request }) => {
  const { id, view } = await failedOrder(request, uniqueLabel("th"))
  const record = store.orderByRegistration(id)!
  const old = Math.floor(Date.now() / 1000) - 2 * SIGNED_WINDOW_S
  const repeat = await call("POST", `/api/registration/${id}/name`, await nameBody(record, view, view.terms!, old))
  expect([repeat.status, repeat.json.moves, repeat.json.version]).toEqual([200, 0, view.version])
  const stale = await call("POST", `/api/registration/${id}/name`, await nameBody(record, view, COMMUNITY_TERMS, old))
  expect([stale.status, stale.json]).toEqual([400, { error: "bad_request" }])
})
