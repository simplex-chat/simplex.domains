// The store API contract's acceptance cases (plans/names-codes/2026-10-21-store-api.md) that the mock can show, against
// the worker's mock directly. The page's own flows build and sign the requests.
import { expect, type APIRequestContext } from "@playwright/test"
import type { Hex } from "viem"
import { CODE_LIMIT } from "../dev/mock/limits.ts"
import * as api from "../src/api.ts"
import { namesSite, readSite } from "../src/config.ts"
import { CHANNEL_KEY, CONTACT_KEY, labelHash, namehash, setTextDigest, YEAR_S } from "../src/crypto/registration.ts"
import { checksumAddress, fromHex, hex, personalDigest, signDigest } from "../src/crypto/wallet.ts"
import * as flow from "../src/flow.ts"
import * as store from "../src/store.ts"
import {
  acceptedOnChain, channelLink, COMMUNITY_TERMS, COMMUNITY_TERMS_HASH, contactLink, control, GENERAL_TERMS_HASH, LISTED_TERMS, MOCK, NAME_POLICY, newClient, oracleQuote, ownerSetsResolver, ownerSetsText,
  PLAIN_TERMS, relayedAhead, TERMS, test, textChangesOf, uniqueLabel,
} from "./helpers.ts"

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

type Quote = flow.Quote

async function quote(label: string): Promise<Quote> {
  const q = await flow.quoteOf(label)
  expect(q, `${label} is available`).not.toBeNull()
  return q!
}

async function draftOf(label: string, links = { contact: "", channel: "" }, method: flow.Draft["method"] = "btc"): Promise<flow.Draft> {
  const q = await quote(label)
  return { label, links, chain: flow.chainOf(readSite()), years: q.years, termStart: readSite().termStart, ownerCode: flow.newOwnerCode(), terms: api.currentTerms(q), method }
}

// a name selected for the order, under the terms the service has for that name now or `terms`
async function selectionOf(record: store.OrderRecord, to: string, terms?: string, method = record.method): Promise<api.RegistrationView> {
  const q = await quote(to)
  const draft: flow.Draft = { label: to, links: NO_LINKS, chain: flow.chainOf(readSite()), years: api.termYears(q.community, record.years), termStart: readSite().termStart, ownerCode: record.ownerCode,
    terms: terms ?? api.currentTerms(q), method }
  return flow.selectName(record, draft, await flow.orderRequest(draft))
}

// the order signed again by its owner at another time
async function signedAt(ownerCode: string, request: api.SignedOrder, timestamp: number): Promise<api.SignedOrder> {
  const sealedHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.sealed))))
  const message = `simplex.domains order ${request.labelHash} ${request.length} ${request.duration} ${request.commitment} ${sealedHash} ${request.terms} ${timestamp}`
  return { ...request, timestamp, signature: hex(signDigest(flow.walletOf(ownerCode)!.privateKey, personalDigest(message))) }
}

const invoiceBody = (request: api.SignedOrder, method: api.Method, price: number) => ({ kind: "name", order: api.orderOf(request), method, price, reveal: request.reveal })
const codeBody = (request: api.SignedOrder, code: unknown) => ({ order: api.orderOf(request), code, reveal: request.reveal })

const viewOf = async (id: string, seenVersion?: number) =>
  (await call("GET", `/api/registration/${id}${seenVersion === undefined ? "" : `?seenVersion=${seenVersion}`}`)).json as unknown as api.RegistrationView

// the registration's view once its phase is one of these, followed by the version long poll
async function untilPhase(id: string, phases: api.Phase[]): Promise<api.RegistrationView> {
  const end = Date.now() + PHASE_MS
  let view = await viewOf(id)
  while (!phases.includes(view.phase.type)) {
    expect(Date.now(), `${id} reaches ${phases.join(" or ")}, at ${view.phase.type}`).toBeLessThan(end)
    view = await viewOf(id, view.version)
  }
  return view
}

async function codeOrder(request: APIRequestContext, label: string): Promise<{ draft: flow.Draft; built: flow.BuiltOrder; id: string; code: string }> {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const res = await call("POST", "/api/name/register", codeBody(built.request, code))
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return { draft, built, id: res.json.registrationId as string, code }
}

// a committed view once its wait is over, with the sponsor's nonce read, as the page reveals it after its stored reveal was cleared
async function untilRevealable(id: string): Promise<api.RegistrationView> {
  const end = Date.now() + PHASE_MS
  let view = await untilPhase(id, ["committed"])
  while (api.committedOf(view)?.signature.type !== "awaiting") {
    expect(Date.now(), `${id} awaits its owner's signature`).toBeLessThan(end)
    view = await viewOf(id, view.version)
  }
  await new Promise((r) => setTimeout(r, Math.max(0, (api.committedOf(view)?.revealAfter ?? 0) * 1000 - Date.now())))
  return viewOf(id)
}

async function signAgain(request: APIRequestContext, id: string): Promise<api.RegistrationView> {
  await control(request, `stale/${id}`)
  return untilRevealable(id)
}

function acceptanceOf(view: api.RegistrationView): api.Acceptance {
  const toSign = api.toSignOf(view)
  if (toSign?.type !== "read") throw new Error(`${view.id} has nothing read to sign`)
  return toSign.acceptance
}

function withAcceptance(view: api.RegistrationView, acceptance: api.Acceptance): api.RegistrationView {
  const committed = api.committedOf(view)!
  const toSign = api.toSignOf(view)
  if (toSign?.type !== "read") throw new Error(`${view.id} has nothing read to sign`)
  return { ...view, phase: { ...committed, signature: { type: "awaiting", toSign: { ...toSign, acceptance } } } }
}

async function unacceptedReveal(view: api.RegistrationView, record: store.OrderRecord): Promise<Json> {
  const sending = globalThis.fetch
  let body: Json = {}
  globalThis.fetch = async (_, init) => {
    body = JSON.parse(String(init?.body))
    return new Response("{}", { status: 200 })
  }
  try {
    await flow.revealOrder(view, record)
  } finally {
    globalThis.fetch = sending
  }
  delete body.acceptance
  return body
}

// The order with a register the service then fails.
async function failAtRegister(request: APIRequestContext, id: string): Promise<api.RegistrationView> {
  await control(request, `fail/${id}`)
  return untilPhase(id, ["failed"])
}

async function failedOrder(request: APIRequestContext, label: string) {
  const order = await codeOrder(request, label)
  store.saveOrder(flow.recordFor(order.draft, order.built, "code", 0, { registrationId: order.id, invoiceId: null }))
  return { ...order, view: await failAtRegister(request, order.id) }
}

// A paid order whose name a rival registered first: an order to select a name for.
async function takenPaid(request: APIRequestContext, label: string) {
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const { price } = await quote(label)
  const paid = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", price))
  expect(paid.status, JSON.stringify(paid.json)).toBe(200)
  const id = (paid.json.registration as Json).id as string
  store.saveOrder(flow.recordFor(draft, built, "btc", price, { registrationId: id, invoiceId: paid.json.invoiceId as string }))
  await control(request, "take", { label })
  await control(request, `settle/${paid.json.invoiceId}`)
  return { id, view: await untilPhase(id, ["taken"]) }
}

// A code order whose name a rival registered first, with its code.
async function takenCode(request: APIRequestContext, label: string, minLength: number) {
  const { code } = await control(request, "code", { minLength }) as { code: string }
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  await control(request, "take", { label })
  const res = await call("POST", "/api/name/register", codeBody(built.request, code))
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  const id = res.json.registrationId as string
  store.saveOrder(flow.recordFor(draft, built, "code", 0, { registrationId: id, invoiceId: null }))
  return { id, code, view: await untilPhase(id, ["taken"]) }
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
    expect([met.status, met.json]).toEqual([409, { type: "order_exists" }])
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
  const refusals: [string, api.SignedOrder, number, Json][] = [
    ["another key's signature", await signedAt(stranger, request, request.timestamp), 400, { type: "bad_request" }],
    ["a timestamp past the window", await signedAt(draft.ownerCode, request, request.timestamp - SIGNED_WINDOW_S - 100), 400, { type: "bad_request" }],
    ["free days more than an hour off", off, 400, { type: "bad_request" }],
    ["no sealed", { ...request, sealed: undefined as unknown as string }, 400, { type: "bad_request" }],
    ["a sealed over 11095 characters", { ...request, sealed: "a".repeat(11096) }, 400, { type: "bad_request" }],
    ["a name of 5 letters", { ...request, length: 5 }, 400, { type: "invalid_name" }],
  ]
  for (const [what, body, status, answer] of refusals) {
    const res = await call("POST", "/api/invoice", invoiceBody(body, "btc", q.price))
    expect([res.status, res.json], what).toEqual([status, answer])
  }
  const cheap = await call("POST", "/api/invoice", invoiceBody(request, "btc", q.price - 1))
  expect([cheap.status, cheap.json]).toEqual([409, { type: "catalog_changed", price: q.price }])
  // the free days are what is left until the term starts
  expect(Math.abs(request.duration - q.years * YEAR_S - (TERM_START - request.timestamp))).toBeLessThanOrEqual(1)
})

test("an order includes its owner's signed registration: a link of the other kind is invalid_link naming its kind, another name or nonce is bad_request, and a paid order registers with no reveal", async ({ request }) => {
  const label = uniqueLabel("cs")
  const q = await quote(label)
  const crossed = (await flow.orderRequest(await draftOf(label, { contact: channelLink("Cs"), channel: "" }))).request
  expect(await call("POST", "/api/invoice", invoiceBody(crossed, "btc", q.price))).toEqual({ status: 400, json: { type: "invalid_link", kind: "contact" } })
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const { reveal } = built.request
  for (const [what, changed] of [["another name", { ...reveal, label: uniqueLabel("ct") }], ["another nonce", { ...reveal, nonce: reveal.nonce + 1 }], ["no acceptance", { ...reveal, acceptance: undefined }]] as const) {
    expect(await call("POST", "/api/invoice", invoiceBody({ ...built.request, reveal: changed as api.RevealBody }, "btc", q.price)), what).toEqual({ status: 400, json: { type: "bad_request" } })
  }
  const signPath = (owner: string) => `/api/name/${built.request.labelHash}/sign?owner=${owner}`
  expect((await call("GET", signPath(built.owner))).json).toMatchObject({ type: "read", intentNonce: reveal.nonce, acceptance: { termsHash: reveal.acceptance.termsHash, nonce: reveal.acceptance.nonce } })
  expect(await call("GET", signPath(built.owner.toLowerCase())), "an owner not in its checksum case").toEqual({ status: 400, json: { type: "bad_request" } })
  const paid = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
  expect(paid.status, JSON.stringify(paid.json)).toBe(200)
  const id = (paid.json.registration as Json).id as string
  expect((await viewOf(id)).label, "no name before payment").toBeNull()
  await control(request, `settle/${paid.json.invoiceId}`)
  const done = await untilPhase(id, ["registered"])
  expect([done.label, done.registerTx === null], "the stored reveal's name, once paid").toEqual([label, false])
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
  // a payment reaching the closed invoice is late: the order stays closed, and the invoice closed, as BTCPay keeps it
  await control(request, `settle/${second.json.invoiceId}`)
  const late = await call("GET", `/api/invoice/${second.json.invoiceId}`)
  expect([late.json.status, late.json.paidInFull, (late.json.registration as Json).phase]).toEqual(["expired", true, { type: "closed", closedBy: "expired" }])
  expect((await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest({ ...draft, method: "card" })).request, "card", q.price))).status).toBe(200)
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
  expect(await order("btc"), "a paid order meeting the funded one").toEqual({ status: 409, json: { type: "order_exists" } })
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const coded = await call("POST", "/api/name/register", codeBody((await flow.orderRequest(draft)).request, code))
  expect(coded, "a code order meeting the funded one").toEqual({ status: 409, json: { type: "order_exists" } })
  const read = await call("GET", `/api/invoice/${funded.json.invoiceId}`)
  expect([read.json.status, read.json.cryptoAmountPaid], "a funded invoice past its expiry reads open").toEqual(["open", (Number(funded.json.cryptoAmount) / 2).toFixed(5)])
  expect(await call("POST", `/api/invoice/${funded.json.invoiceId}/cancel`)).toEqual({ status: 409, json: { type: "funded" } })
  await control(request, `settle/${funded.json.invoiceId}`)
  expect((await viewOf((funded.json.registration as Json).id as string)).phase.type, "settled into a registration").not.toBe("unpaid")
})

test("a code order closes an overdue invoice of its wallet and name with nothing received", async ({ request }) => {
  const label = uniqueLabel("cd")
  const draft = await draftOf(label)
  const paid = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "btc", (await quote(label)).price))
  await control(request, `overdue/${paid.json.invoiceId}`)
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const coded = await call("POST", "/api/name/register", codeBody((await flow.orderRequest(draft)).request, code))
  expect(coded.status, JSON.stringify(coded.json)).toBe(200)
  expect(await heldStatus(paid.json.invoiceId as string)).toBe("expired")
})

test("search quotes the oracle with the term's start, and a registered name carries its grace period", async () => {
  const label = uniqueLabel("cq")
  const answer = await quote(label)
  expect([answer.price, answer.years, (await namesSite()).termStart]).toEqual([await oracleQuote(label, 2), 2, TERM_START])
  for (const [length, cents] of [[6, 40000], [7, 20000], [12, 10000]]) {
    const res = await call("GET", `/api/name/${hex(labelHash("x".repeat(length)))}?length=${length}`)
    expect((res.json.found as Json).price, `${length} letters`).toBe(cents)
  }
  const bakery = await call("GET", `/api/name/${hex(labelHash("bakery"))}?length=6`)
  expect(bakery.json.found).toMatchObject({ type: "registered", gracePeriod: 90 * 86400 })
})

test("a code check answers every state, revoked included, and an unknown code is code_invalid", async ({ request }) => {
  for (const state of ["unused", "reserved", "used", "revoked", "expired", "unpaid"]) {
    const { code } = await control(request, "code", { minLength: 7, years: 3, state }) as { code: string }
    expect((await call("POST", "/api/code/check", { code })).json, state).toEqual({ minLength: 7, years: 3, state })
  }
  for (const code of ["SN7-BJTBP-29596-R3HJ8-25YM7", "SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G", "nonsense"]) {
    expect(await call("POST", "/api/code/check", { code }), code).toEqual({ status: 400, json: { type: "code_invalid" } })
  }
})

test("a code check whose body has no text code is bad_request", async () => {
  for (const body of [{}, { code: null }, { code: 6 }, { code: ["SN7-BJTBP-29596-R3HJ8-25YM7"] }]) {
    expect(await call("POST", "/api/code/check", body), JSON.stringify(body)).toEqual({ status: 400, json: { type: "bad_request" } })
  }
})

test("a code order without a text code is bad_request, even for a name too short", async () => {
  const { request } = await flow.orderRequest(await draftOf(uniqueLabel("ck")))
  for (const code of [undefined, null, 6, ["SN7-BJTBP-29596-R3HJ8-25YM7"]]) {
    for (const length of [request.length, 5]) {
      const res = await call("POST", "/api/name/register", codeBody({ ...request, length }, code))
      expect(res, `code ${JSON.stringify(code)}, length ${length}`).toEqual({ status: 400, json: { type: "bad_request" } })
    }
  }
})

test("a code order whose text is no issued code is code_invalid", async () => {
  const { request } = await flow.orderRequest(await draftOf(uniqueLabel("ci")))
  for (const code of ["SN7-BJTBP-29596-R3HJ8-25YM7", "SN-8M7X0-8Z533-AG8DP-RBN5T-BPQ6D-YH09G", "nonsense", ""]) {
    expect(await call("POST", "/api/name/register", codeBody(request, code)), code).toEqual({ status: 400, json: { type: "code_invalid" } })
  }
})

test("a client's code checks and code orders past the code limit in a minute are rate_limited with the wait, whatever each answered, and another client's are not", async () => {
  for (let i = 0; i < CODE_LIMIT; i++) {
    const path = i % 2 ? "/api/code/check" : "/api/name/register"
    expect((await call("POST", path, {})).status, `${path}, request ${i + 1}`).toBe(400)
  }
  for (const path of ["/api/code/check", "/api/name/register"]) {
    const res = await send("POST", path, { code: "SN7-BJTBP-29596-R3HJ8-25YM7" })
    const wait = Number(res.headers.get("retry-after"))
    expect({ status: res.status, json: await res.json() }, path).toEqual({ status: 429, json: { type: "rate_limited", retryAfter: wait } })
    expect(wait, `${path}: the seconds left of the minute`).toBeGreaterThan(50)
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
  const nobody = flow.walletOf(flow.newOwnerCode())!
  const none = checksumAddress(nobody.address).toLowerCase()
  expect(await call("POST", "/api/registration/find", { owner: none, timestamp, signature: hex(signDigest(nobody.privateKey, personalDigest(`simplex.domains find ${none} ${timestamp}`))) }), "an owner of no order")
    .toEqual({ status: 200, json: { registrations: [] } })
})

test("a held poll wakes on a new version, and of two retries at once of a lapsed order one wins and the other is registration_changed with the view", async ({ request }) => {
  const { id } = await codeOrder(request, uniqueLabel("cv"))
  await signAgain(request, id)
  await control(request, `lapse/${id}`)
  const view = await viewOf(id)
  expect(api.committedOf(view)?.signature.type).toBe("lapsed")
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
  expect(lost.type).toBe("registration_changed")
  expect((lost.registration as Json).version).toBeGreaterThan(view.version)
  const woken = await held
  expect(woken.version).toBeGreaterThan(view.version)
})

test("a name is selected only for a paid order taken first, at its own price, again after each take with no limit; a repeat changes nothing", async ({ request }) => {
  const failed = await failedOrder(request, uniqueLabel("cmf"))
  await expect(selectionOf(store.orderByRegistration(failed.id)!, uniqueLabel("cmf2")), "a failed order").rejects.toMatchObject({ code: "bad_request" })
  const label = shortLabel(7)
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const paid = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", PRICE.seven))
  const id = (paid.json.registration as Json).id as string
  store.saveOrder(flow.recordFor(draft, built, "btc", PRICE.seven, { registrationId: id, invoiceId: paid.json.invoiceId as string }))
  await control(request, `stale/${id}`)
  await control(request, `settle/${paid.json.invoiceId}`)
  const select = async (to: string) => selectionOf(store.orderByRegistration(id)!, to)
  await untilPhase(id, ["committed"])
  await expect(select(shortLabel(7)), "a committed order").rejects.toMatchObject({ code: "bad_request" })
  await control(request, "take", { label })
  await flow.revealOrder(await untilRevealable(id), store.orderByRegistration(id)!)
  await untilPhase(id, ["taken"])
  await expect(select(shortLabel(6)), "a dearer name").rejects.toMatchObject({ code: "catalog_changed", body: { price: PRICE.six } })
  await expect(select(uniqueLabel("cm")), "a cheaper name").rejects.toMatchObject({ code: "catalog_changed", body: { price: PRICE.long } })
  const takenAgain = async () => {
    await control(request, "take", { label: store.orderByRegistration(id)!.label })
    await untilPhase(id, ["taken"])
  }
  // names of the same price, each registered first by a rival: four selections in all
  let view = await select(shortLabel(7))
  expect([view.phase, view.price, view.balance]).toEqual([{ type: "queued" }, PRICE.seven, free(0)])
  for (let n = 2; n <= 4; n++) {
    await takenAgain()
    view = await select(shortLabel(7))
    expect([view.phase, view.balance], `selection ${n}`).toEqual([{ type: "queued" }, free(0)])
  }
  await takenAgain()
  const repeat = await call("POST", `/api/registration/${id}/name`, await nameBody(store.orderByRegistration(id)!, view))
  expect([repeat.status, (repeat.json.phase as Json).type], "a repeat of the current fields").toEqual([200, "taken"])
})

test("a name selected for a code order taken first is one its code allows, its code kept reserved, while a shorter name is code_not_covering", async ({ request }) => {
  const label = uniqueLabel("cc")
  const { id, code, view: taken } = await takenCode(request, label, 10)
  expect(Object.keys(taken).sort(), "the fields of the service's view of a taken code order (registration-taken-code.json)").toEqual([
    "balance", "commitTx", "commitment", "community", "disputeDays", "duration", "id", "label", "labelHash", "latePayment", "owner", "payment", "phase", "price",
    "registerTx", "sealed", "terms", "version", "years",
  ])
  expect([taken.phase, taken.payment, taken.balance, taken.price, taken.label], "a code order has no balance").toEqual([{ type: "taken" }, { type: "code" }, null, 0, label])
  expect((await call("POST", "/api/code/check", { code })).json, "kept at the take").toMatchObject({ state: "reserved" })
  const select = (to: string) => selectionOf(store.orderByRegistration(id)!, to)
  await expect(select(shortLabel(7)), "a name shorter than the code allows").rejects.toMatchObject({ code: "code_not_covering" })
  const selected = await select(uniqueLabel("cc2"))
  expect([selected.phase, selected.price, selected.payment]).toEqual([{ type: "queued" }, 0, { type: "code" }])
  expect((await call("POST", "/api/code/check", { code })).json, "still reserved by the selection").toMatchObject({ state: "reserved" })
})

test("a taken code order's own code is accepted past its expiry within the month after the take, and refused once revoked", async ({ request }) => {
  const expired = await takenCode(request, uniqueLabel("cx"), 6)
  await control(request, "code/state", { code: expired.code, state: "expired" })
  expect((await selectionOf(store.orderByRegistration(expired.id)!, uniqueLabel("cx2"))).phase, "an expired code within the month").toEqual({ type: "queued" })
  const revoked = await takenCode(request, uniqueLabel("cr"), 6)
  await control(request, "code/state", { code: revoked.code, state: "revoked" })
  await expect(selectionOf(store.orderByRegistration(revoked.id)!, uniqueLabel("cr2")), "a revoked code").rejects.toMatchObject({ code: "code_invalid" })
})

// the /name body of the registration's current fields, under its own terms or `terms`, signed anew
async function nameBody(record: store.OrderRecord, view: api.RegistrationView, terms = api.signedTermsOf(view.terms), timestamp = Math.floor(Date.now() / 1000)): Promise<Json> {
  const sealedHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(view.sealed))))
  const length = record.label.length
  const message = `simplex.domains name ${view.id} ${view.labelHash} ${length} ${view.duration} ${view.commitment} ${sealedHash} ${terms} ${timestamp}`
  const reveal = await flow.revealFor(record, view.duration, await api.signFor(view.labelHash, view.owner))
  return { ...api.signedFields({ labelHash: view.labelHash, length, duration: view.duration, commitment: view.commitment, sealed: view.sealed, terms, timestamp,
    signature: hex(signDigest(flow.walletOf(record.ownerCode)!.privateKey, personalDigest(message))) }), reveal } as unknown as Json
}

// a name registered from a code order, without links, with what made it
async function registeredName(request: APIRequestContext, prefix: string) {
  const label = uniqueLabel(prefix)
  const { draft, built, id } = await codeOrder(request, label)
  await untilPhase(id, ["registered"])
  return { label, draft, labelHash: built.request.labelHash }
}

type RegisteredName = Awaited<ReturnType<typeof registeredName>>
type LinkEdit = { key: "contact" | "channel"; value: string; nonce: number; deadline: number; signature: string }

// one edit of a link of the name, signed by its key at this records nonce
function linkEdit(name: RegisteredName, key: LinkEdit["key"], value: string, nonce: number): LinkEdit {
  const deadline = Math.floor(Date.now() / 1000) + 3600
  const digest = setTextDigest(BigInt(name.draft.chain.chainId), fromHex(name.draft.chain.resolver), namehash("simplex", name.label), flow.KEYS[key], value, BigInt(nonce), BigInt(deadline))
  return { key, value, nonce, deadline, signature: hex(signDigest(flow.walletOf(name.draft.ownerCode)!.privateKey, digest)) }
}

const answerOf = async (name: RegisteredName) => (await call("GET", `/api/name/${name.labelHash}?length=${name.label.length}`)).json.found as Json
const recordsOf = async (name: RegisteredName) => (await answerOf(name)).records as { contact: string; channel: string; nonce: number; edits: { left: number } }

// a request of one contact link edit of the name, at the name's records nonce unless one is given
async function contactEdit(name: RegisteredName, value: string, nonce?: number): Promise<{ labelHash: string; edits: LinkEdit[] }> {
  return { labelHash: name.labelHash, edits: [linkEdit(name, "contact", value, nonce ?? (await recordsOf(name)).nonce)] }
}

test("a link edit repeated after it was mined is answered from the edit, not checked anew", async ({ request }) => {
  const name = await registeredName(request, "ce")
  const edit = await contactEdit(name, contactLink("Ce"))
  const first = await call("POST", "/api/name/records", edit)
  expect(first.status, JSON.stringify(first.json)).toBe(200)
  expect(await call("POST", "/api/name/records", edit)).toEqual(first)
  // the same nonce with another value is checked anew, and its nonce has moved
  const other = await contactEdit(name, contactLink("Cf"), edit.edits[0].nonce)
  expect(await call("POST", "/api/name/records", other)).toEqual({ status: 409, json: { type: "stale_nonce" } })
})

test("a Save's two link edits are one request and one multicall transaction, counted as one edit, and its exact resend answers it again", async ({ request }) => {
  const name = await registeredName(request, "ct")
  const before = await recordsOf(name)
  const nonce = before.nonce
  const [contact, channel] = [contactLink("Ct"), channelLink("Ct")]
  const save = { labelHash: name.labelHash, edits: [linkEdit(name, "contact", contact, nonce), linkEdit(name, "channel", channel, nonce + 1)] }
  const sent = await call("POST", "/api/name/records", save)
  expect(sent.status, JSON.stringify(sent.json)).toBe(200)
  expect(await textChangesOf(sent.json.tx as string)).toEqual({ multicall: true, changes: [[CONTACT_KEY, contact], [CHANNEL_KEY, channel]] })
  const after = await recordsOf(name)
  expect([after.contact, after.channel, after.nonce, after.edits.left]).toEqual([contact, channel, nonce + 2, before.edits.left - 1])
  expect(await call("POST", "/api/name/records", save)).toEqual(sent)
  expect((await recordsOf(name)).edits.left, "the resend counts nothing").toBe(after.edits.left)
  // the second edit alone is another request, checked anew against the nonce both spent
  expect(await call("POST", "/api/name/records", { labelHash: name.labelHash, edits: [save.edits[1]] })).toEqual({ status: 409, json: { type: "stale_nonce" } })
})

test("a relayed link edit that reverts on chain still counts toward the name's yearly edits, as the service counts every relayed edit", async ({ request }) => {
  const name = await registeredName(request, "cv")
  const before = await recordsOf(name)
  const value = contactLink("Cv")
  const edit = await contactEdit(name, value)
  const answer = await relayedAhead(name.label, edit.edits[0], () => call("POST", "/api/name/records", edit))
  expect(answer).toEqual({ status: 200, json: { tx: null } })
  const after = await recordsOf(name)
  expect(after.contact, "the other relayer's copy landed").toBe(value)
  expect(after.edits.left, "the reverted relay is counted").toBe(before.edits.left - 1)
})

test("a records request of no edit, three, one key twice, a clear, nonces not consecutive, or a record's key in place of its kind is bad_request", async () => {
  const signature = `0x${"11".repeat(64)}1b`
  const deadline = Math.floor(Date.now() / 1000) + 3600
  // a link that is not one, which would be invalid_link had the edits' formats passed
  const set = (key: string, nonce: number) => ({ key, value: "https://x/a", nonce, deadline, signature })
  const labelHash = `0x${"ab".repeat(32)}`
  for (const edits of [[], [set("contact", 1), set("channel", 2), set("contact", 3)], [set("channel", 1), set("channel", 2)],
    [{ clear: true, nonce: 1, deadline, signature }], [set("contact", 1), set("channel", 3)], [set("contact", 2), set("channel", 1)], [set(CONTACT_KEY, 1)]]) {
    expect(await call("POST", "/api/name/records", { labelHash, edits }), JSON.stringify(edits)).toEqual({ status: 400, json: { type: "bad_request" } })
  }
})

test("a link edit of a name pointed at another resolver is bad_request, and goes through once the name points back", async ({ request }) => {
  const name = await registeredName(request, "cg")
  const edit = await contactEdit(name, contactLink("Cg"))
  await ownerSetsResolver(name.draft.ownerCode, name.label, ELSEWHERE)
  expect(await call("POST", "/api/name/records", edit)).toEqual({ status: 400, json: { type: "bad_request" } })
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
  const answer = await answerOf(name)
  expect(answer.records).toMatchObject({ contact, channel })
  expect((answer.entities as Json[]).map((e) => [(e.preview as Json).kind, e.link])).toEqual([...contacts.slice(0, 5).map((link) => ["contact", link]), ["channel", channelLink("K1")]])
})

test("search answers a link whose data was not read now as unread with its deep link, and leaves out one the chat core cannot parse, whose preview is invalid_link", async ({ request }) => {
  const name = await registeredName(request, "cu")
  const unread = contactLink("Unr")
  const unparsed = "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm"
  await ownerSetsText(name.draft.ownerCode, name.label, CONTACT_KEY, unread)
  await ownerSetsText(name.draft.ownerCode, name.label, CHANNEL_KEY, unparsed)
  const answer = await answerOf(name)
  expect(answer.entities).toEqual([
    { preview: { kind: "contact", profile: { type: "unread" } }, link: unread, deepLink: `simplex:/a#${unread.split("#")[1]}?h=smp8.simplex.im` },
  ])
  expect((await call("POST", "/api/link/preview", { link: unread })).json, "a preview").toEqual({ kind: "contact", profile: { type: "unread" } })
  expect(await call("POST", "/api/link/preview", { link: unparsed }), "a link the chat core cannot parse").toEqual({ status: 400, json: { type: "invalid_link", kind: null } })
})

// --- balances

// the dev oracle's prices for 2 years: 6 letters, 7 letters, 8 or more
const PRICE = { six: 40000, seven: 20000, long: 10000 }

// a fresh name of exactly `length` letters, for the prices by length
const shortLabel = (length: number) => `q${Math.random().toString(36).slice(2).replace(/[^a-z]/g, "")}${"q".repeat(length)}`.slice(0, length)

type Paying = { draft: flow.Draft; record: store.OrderRecord; id: string; invoiceId: string; price: number }

// An order of a new code whose invoice closed with nothing received, then got its money: a closed order holding a balance of its price.
async function lateBalance(request: APIRequestContext, label = uniqueLabel("lb"), method: api.Method = "btc"): Promise<Paying> {
  const draft = await draftOf(label, undefined, method)
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

const balanceOf = async (id: string) => (await viewOf(id)).balance
const free = (amount: number, refunded = 0) => ({ amount, refunded })

async function findOf(ownerCode: string): Promise<{ registrationId: string; invoiceId: string | null }[]> {
  const owner = checksumAddress(flow.walletOf(ownerCode)!.address).toLowerCase()
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = hex(signDigest(flow.walletOf(ownerCode)!.privateKey, personalDigest(`simplex.domains find ${owner} ${timestamp}`)))
  return (await call("POST", "/api/registration/find", { owner, timestamp, signature })).json.registrations as never
}

test("support's refund takes the whole balance by invoice id or registration id, and refuses other cents or none left", async ({ request }) => {
  const src = await lateBalance(request)
  const refund = (reference: string, body: Json = {}) => call("POST", `/control/refund/${reference}`, body)
  expect(await refund(src.invoiceId, { cents: PRICE.long - 1 })).toEqual({ status: 409, json: { type: "balance_changed", balance: free(PRICE.long) } })
  for (const cents of [0, "100", 1.5]) expect(await refund(src.invoiceId, { cents }), String(cents)).toEqual({ status: 400, json: { type: "bad_request" } })
  expect((await refund("nope")).status).toBe(404)
  expect(await refund(src.invoiceId, { cents: PRICE.long })).toEqual({ status: 200, json: { registrationId: src.id, cents: PRICE.long } })
  expect(await balanceOf(src.id)).toEqual(free(0, PRICE.long))
  expect(await refund(src.id)).toEqual({ status: 409, json: { type: "no_balance" } })
})

test("a paid order taken first keeps its whole price as its balance until support refunds it, after which no name is selected for it", async ({ request }) => {
  const { id, view } = await takenPaid(request, shortLabel(7))
  expect(view.balance).toEqual(free(PRICE.seven))
  expect((await call("POST", `/control/refund/${id}`, {})).json).toEqual({ registrationId: id, cents: PRICE.seven })
  await expect(selectionOf(store.orderByRegistration(id)!, shortLabel(7)), "a refunded order").rejects.toMatchObject({ code: "bad_request" })
})

test("a late payment is credited once settled, each confirmed figure once, at the lower of its invoice's rate and the current one", async ({ request }) => {
  // an order whose invoice closed with nothing received
  const closed = async (method: api.Method) => {
    const label = uniqueLabel("lp")
    const res = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(label, undefined, method))).request, method, (await quote(label)).price))
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
  expect(await call("POST", `/api/invoice/${invoiceId}/cancel`)).toEqual({ status: 409, json: { type: "funded" } })
  await control(request, `expire/${invoiceId}`)
  expect([(await viewOf(id)).latePayment, await balanceOf(id)], "seen, not confirmed").toEqual(["confirming", null])
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
  expect((await viewOf(id)).phase.type).not.toBe("unpaid")
  expect(await balanceOf(id)).toEqual(free(PRICE.long / 2))
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

test("late money says what its credit waits on", async ({ request }) => {
  // late money: received and not confirmed, then a credit held back as the service's would wait, then credited
  const late = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(await draftOf(uniqueLabel("lw")))).request, "btc", PRICE.long))
  const lateId = (late.json.registration as Json).id as string
  await control(request, `expire/${late.json.invoiceId}`)
  expect([(await viewOf(lateId)).latePayment, (await viewOf(lateId)).balance], "nothing received").toEqual([null, null])
  await control(request, `confirming/${late.json.invoiceId}`)
  expect((await viewOf(lateId)).latePayment).toEqual("confirming")
  await control(request, `late/${late.json.invoiceId}`, { waiting: "support" })
  await control(request, `settle/${late.json.invoiceId}`)
  expect([(await viewOf(lateId)).latePayment, (await viewOf(lateId)).balance]).toEqual(["support", null])
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
  await untilPhase(id, ["registered"])
  const again = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "btc", price))
  expect([again.status, again.json.type]).toEqual([409, "name_taken"])
})

// --- terms and community names

// the e2e spec's community name, which dev/deploy.ts lists
const COMMUNITY_LABEL = "bakers"
const communityEntry = (text: unknown) => ({ for: text, years: 2 })

// The name policy's terms of a kind changed to the link of this text while `f` runs, then back to the deployed ones.
async function withTerms<T>(request: APIRequestContext, kind: "general-terms" | "community-terms", text: string, f: (terms: api.Terms) => Promise<T>): Promise<T> {
  const { link, hash } = await control(request, kind, { text }) as unknown as api.Terms
  try {
    return await f({ hash, link })
  } finally {
    await control(request, kind, { text: null })
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

const termsChanged = (terms: api.Terms, community: Json | null) => ({ type: "terms_changed", terms, community })

test("a community name's search answer has its community entry, and the available one the terms of its kind to agree to", async () => {
  const listed = (await call("GET", `/api/name/${hex(labelHash(COMMUNITY_LABEL))}?length=${COMMUNITY_LABEL.length}`)).json
  expect(listed).toMatchObject({ found: { type: "available", terms: LISTED_TERMS }, community: communityEntry(expect.any(String)) })
  const other = uniqueLabel("ta")
  const plain = (await call("GET", `/api/name/${hex(labelHash(other))}?length=${other.length}`)).json
  expect([plain.found, plain.community]).toEqual([expect.objectContaining({ type: "available", terms: TERMS }), undefined])
  for (const [name, type] of [["bakery", "registered"], ["support", "reserved"]]) {
    const answer = (await call("GET", `/api/name/${hex(labelHash(name))}?length=${name.length}`)).json
    expect([(answer.found as Json).type, answer.community], name).toEqual([type, undefined])
  }
})

test("an order signs the terms of its name's kind: the other kind or other terms is terms_changed with the terms and community now, a malformed one bad_request", async ({ request }) => {
  const community = await quote(COMMUNITY_LABEL)
  const plain = { ...await draftOf(COMMUNITY_LABEL), terms: PLAIN_TERMS }
  const refused = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(plain)).request, "btc", community.price))
  expect([refused.status, refused.json]).toEqual([409, termsChanged(LISTED_TERMS, community.community as Json | null)])
  const label = uniqueLabel("tb")
  const q = await quote(label)
  const claimed = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest({ ...await draftOf(label), terms: COMMUNITY_TERMS })).request, "btc", q.price))
  expect([claimed.status, claimed.json]).toEqual([409, termsChanged(TERMS, null)])
  const draft = await draftOf(label)
  const { request: signed } = await flow.orderRequest(draft)
  const body = invoiceBody(signed, "btc", q.price)
  const { termsHash } = body.order.fields.terms
  for (const terms of [undefined, "", 5, { termsHash }, { communityName: "no", termsHash }, { communityName: false, termsHash: "2026 10 23" }, { communityName: false, termsHash: `0x${"t".repeat(64)}` }]) {
    const res = await call("POST", "/api/invoice", { ...body, order: { ...body.order, fields: { ...body.order.fields, terms } } })
    expect([res.status, res.json], JSON.stringify(terms)).toEqual([400, { type: "bad_request" }])
  }
  await withTerms(request, "general-terms", `the general terms, changed for ${label}`, async (terms) => {
    // a stale timestamp is checked before the terms
    const stale = await signedAt(draft.ownerCode, signed, signed.timestamp - SIGNED_WINDOW_S - 100)
    expect((await call("POST", "/api/invoice", invoiceBody(stale, "btc", q.price))).json, "a stale timestamp").toEqual({ type: "bad_request" })
    const res = await call("POST", "/api/invoice", invoiceBody(signed, "btc", q.price))
    expect([res.status, res.json]).toEqual([409, termsChanged(terms, null)])
  })
  const ok = await call("POST", "/api/invoice", invoiceBody(signed, "btc", q.price))
  expect(ok.status, JSON.stringify(ok.json)).toBe(200)
  expect(api.signedTermsOf((ok.json.registration as unknown as api.RegistrationView).terms)).toBe(PLAIN_TERMS)
})

test("an exact resend is answered after the terms changed, and two orders differing only in terms are different orders", async ({ request }) => {
  const label = uniqueLabel("tc")
  const q = await quote(label)
  const draft = await draftOf(label)
  const built = await flow.orderRequest(draft)
  const first = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
  expect(first.status).toBe(200)
  await withTerms(request, "general-terms", `the general terms, changed for ${label}`, async (terms) => {
    const again = await call("POST", "/api/invoice", invoiceBody(built.request, "btc", q.price))
    expect([again.status, again.json.invoiceId]).toEqual([200, first.json.invoiceId])
    const other = await signedAt(draft.ownerCode, { ...built.request, terms: terms.hash.slice(2) }, built.request.timestamp)
    expect((await call("POST", "/api/invoice", invoiceBody(other, "btc", q.price))).json).toEqual({ type: "order_exists" })
  })
})

test("a code order meets changed terms before the code's state", async ({ request }) => {
  const label = uniqueLabel("td")
  const { code } = await control(request, "code", { minLength: 6, state: "used" }) as { code: string }
  const coded = await call("POST", "/api/name/register", codeBody((await flow.orderRequest({ ...await draftOf(label), terms: COMMUNITY_TERMS })).request, code))
  expect([coded.status, coded.json]).toEqual([409, termsChanged(TERMS, null)])
})

test("a selection signs the new name's terms: a community name needs the community terms, which are stored; the same body again is a repeat, also after the terms changed", async ({ request }) => {
  const label = uniqueLabel("tf")
  await listed(request, label, async () => {
    const { id, view } = await takenPaid(request, uniqueLabel("tg"))
    expect([api.signedTermsOf(view.terms), view.community]).toEqual([PLAIN_TERMS, null])
    const q = await quote(label)
    expect(q.community).toEqual(communityEntry("test bakers"))
    await expect(selectionOf(store.orderByRegistration(id)!, label, PLAIN_TERMS)).rejects.toMatchObject({ code: "terms_changed", terms: LISTED_TERMS, community: { for: "test bakers" } })
    const selected = await selectionOf(store.orderByRegistration(id)!, label, COMMUNITY_TERMS)
    await control(request, "take", { label })
    expect([api.signedTermsOf(selected.terms), selected.community]).toEqual([COMMUNITY_TERMS, communityEntry("test bakers")])
    const record = store.orderByRegistration(id)!
    expect(record.terms).toBe(COMMUNITY_TERMS)
    const repeat = await call("POST", `/api/registration/${id}/name`, await nameBody(record, selected))
    expect([repeat.status, repeat.json.version], "a repeat answers the view unchanged").toEqual([200, (await viewOf(id)).version])
    const taken = await untilPhase(id, ["taken"])
    await withTerms(request, "community-terms", `the community terms, changed for ${label}`, async () => {
      // the current fields under the terms they were signed with are still a repeat, answered before the terms
      const again = await call("POST", `/api/registration/${id}/name`, await nameBody(record, taken))
      expect([again.status, (again.json.phase as Json).type]).toEqual([200, "taken"])
    })
  })
})

test("a committed community name's view asks for the owner's acceptance of the community terms on chain; its reveal without one, or with one for another nonce, terms, kind or policy, is bad_request, and with it the register records it", async ({ request }) => {
  const label = uniqueLabel("tk")
  await listed(request, label, async () => {
    const { draft, built, id } = await codeOrder(request, label)
    expect(draft.terms).toBe(COMMUNITY_TERMS)
    const record = flow.recordFor(draft, built, "code", 0, { registrationId: id, invoiceId: null })
    const view = await signAgain(request, id)
    const accept = acceptanceOf(view)
    expect(accept).toEqual({ community: true, policy: NAME_POLICY, termsHash: COMMUNITY_TERMS_HASH, nonce: 0 })
    expect(await call("POST", `/api/registration/${id}/reveal`, await unacceptedReveal(view, record)), "none").toEqual({ status: 400, json: { type: "bad_request" } })
    for (const [what, acceptance] of [["another nonce", { ...accept, nonce: accept.nonce + 1 }], ["other terms", { ...accept, termsHash: `0x${"d8".repeat(32)}` }],
      ["the other kind", { ...accept, community: false }], ["another policy", { ...accept, policy: readSite().sponsor }]] as const) {
      await expect(flow.revealOrder(withAcceptance(view, acceptance), record), what).rejects.toMatchObject({ code: "bad_request" })
    }
    await flow.revealOrder(view, record)
    const done = await untilPhase(id, ["registered"])
    expect(api.toSignOf(done), "no acceptance asked once registered").toBeNull()
    expect(await acceptedOnChain(done.registerTx!)).toEqual({ kind: "community", name: label, holder: record.owner, termsHash: COMMUNITY_TERMS_HASH })
  })
})

test("a plain name's committed view asks for the owner's acceptance of the general terms; its reveal without one or with the other kind is bad_request, and with it the register records it", async ({ request }) => {
  const label = uniqueLabel("tl")
  const { draft, built, id } = await codeOrder(request, label)
  const record = flow.recordFor(draft, built, "code", 0, { registrationId: id, invoiceId: null })
  const view = await signAgain(request, id)
  expect(acceptanceOf(view)).toEqual({ community: false, policy: NAME_POLICY, termsHash: GENERAL_TERMS_HASH, nonce: 0 })
  expect(await call("POST", `/api/registration/${id}/reveal`, await unacceptedReveal(view, record)), "none").toEqual({ status: 400, json: { type: "bad_request" } })
  await expect(flow.revealOrder(withAcceptance(view, { ...acceptanceOf(view), community: true }), record), "the other kind").rejects.toMatchObject({ code: "bad_request" })
  await flow.revealOrder(view, record)
  const done = await untilPhase(id, ["registered"])
  expect(await acceptedOnChain(done.registerTx!)).toEqual({ kind: "general", name: label, holder: record.owner, termsHash: GENERAL_TERMS_HASH })
})

test("an order signed over other dispute days than its payment's is bad_request, and a card order's view contains a card's days", async () => {
  const label = uniqueLabel("dd")
  const draft = await draftOf(label)
  const { price } = await quote(label)
  expect(await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest({ ...draft, method: "card" })).request, "btc", price)), "a card's days for Bitcoin").toEqual({ status: 400, json: { type: "bad_request" } })
  expect(await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest(draft)).request, "card", price)), "Bitcoin's days for a card").toEqual({ status: 400, json: { type: "bad_request" } })
  const card = await call("POST", "/api/invoice", invoiceBody((await flow.orderRequest({ ...draft, method: "card" })).request, "card", price))
  expect([card.status, (card.json.registration as Json).disputeDays]).toEqual([200, 120])
})

test("a selection signed over other dispute days than its order's payment's is bad_request, and its view contains the payment's days", async ({ request }) => {
  const { id } = await takenPaid(request, uniqueLabel("dt"))
  const record = store.orderByRegistration(id)!
  const next = uniqueLabel("dt2")
  await expect(selectionOf(record, next, undefined, "card"), "a card's days for a Bitcoin order").rejects.toMatchObject({ code: "bad_request" })
  await selectionOf(record, next)
  expect((await call("GET", `/api/registration/${id}`)).json.disputeDays).toBe(14)
})

test("a code order whose reveal is signed over other dispute days than a code's is bad_request, and one signed over a code's is registered, its view containing a code's days", async ({ request }) => {
  const { code } = await control(request, "code", { minLength: 6 }) as { code: string }
  const over = await flow.orderRequest(await draftOf(uniqueLabel("tu"), undefined, "card"))
  expect(await call("POST", "/api/name/register", codeBody(over.request, code))).toEqual({ status: 400, json: { type: "bad_request" } })
  const { id } = await codeOrder(request, uniqueLabel("tu"))
  expect((await call("GET", `/api/registration/${id}`)).json.disputeDays).toBe(14)
  await untilPhase(id, ["registered"])
})

test("a reveal signed over other dispute days than its order's payment's is bad_request, and the name is registered with the reveal over its payment's", async ({ request }) => {
  const { draft, built, id } = await codeOrder(request, uniqueLabel("tu"))
  const recordAs = (method: store.OrderRecord["method"]) => flow.recordFor(draft, built, method, 0, { registrationId: id, invoiceId: null })
  const view = await signAgain(request, id)
  await expect(flow.revealOrder(view, recordAs("card")), "a card's days for a code order").rejects.toMatchObject({ code: "bad_request" })
  await flow.revealOrder(view, recordAs("code"))
  await untilPhase(id, ["registered"])
})

test("a selection repeat is answered however old its signature, while a selection signed too long ago is bad_request", async ({ request }) => {
  const { id, view } = await takenPaid(request, uniqueLabel("th"))
  const record = store.orderByRegistration(id)!
  const old = Math.floor(Date.now() / 1000) - 2 * SIGNED_WINDOW_S
  const repeat = await call("POST", `/api/registration/${id}/name`, await nameBody(record, view, api.signedTermsOf(view.terms), old))
  expect([repeat.status, repeat.json.version]).toEqual([200, view.version])
  const stale = await call("POST", `/api/registration/${id}/name`, await nameBody(record, view, COMMUNITY_TERMS, old))
  expect([stale.status, stale.json]).toEqual([400, { type: "bad_request" }])
})
