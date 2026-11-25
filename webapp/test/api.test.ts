import { afterEach, describe, expect, it, vi } from "vitest"
import { keccak256, sha256, toHex, zeroHash } from "viem"
import {
  ApiError, cancelInvoice, checkCode, createOrder, currentTerms, editRecords, EditLimited, previewLink, readInvoice, readRegistration, registerWithCode, retryDelay, searchName, seenOf, selectName, TermsChanged,
  communityAgreed, readerUrl, type RegistrationView, selectable, signedHash, termsFor, termsLink, termsText, termYears,
} from "../src/api.ts"
import { LOCAL } from "../src/config.ts"

const HASH = "ab".repeat(32)
const COMMIT = "4cb24444a1f2e3d4c5b6a7980716253443526170"
const FORGEJO = `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${COMMIT}`
const GITHUB = `https://raw.githubusercontent.com/simplex-chat/simplex-chat/${COMMIT}`
const termsOf = (link: string) => ({ hash: keccak256(toHex(link)), link })

function answerWith(status: number, body: string, headers: Record<string, string> = {}): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers })))
}

const REVEAL = {
  label: "alicebakery", secret: `0x${"11".repeat(32)}`, records: { contact: null, channel: null }, nonce: 0, deadline: 1800000000, signature: "0x",
  acceptance: { termsHash: `0x${"ab".repeat(32)}`, nonce: 0, signature: "0x" },
}
const REGISTERED = { type: "registered", owner: "0x1", resolver: "0x2", expiresAt: 1, gracePeriod: 2, entities: [], records: { type: "other" } }

async function errorOf(): Promise<ApiError> {
  const e = await searchName(HASH, 8).then(() => null, (e: unknown) => e)
  expect(e).toBeInstanceOf(ApiError)
  return e as ApiError
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("termsLink", () => {
  const DIGEST = "0b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff001"
  it("takes a file at a commit of simplex-chat on git.simplex.chat or GitHub, with the sha256 of its bytes, on any chain", () => {
    for (const host of [FORGEJO, GITHUB]) {
      for (const path of ["docs/general-terms.md", "a.md", "x/.md", "docs/v1.2/general_terms-2.md"]) {
        expect(termsLink(`${host}/${path}#sha256=${DIGEST}`, 1), `${host}/${path}`).toEqual({ commit: COMMIT, digest: DIGEST })
      }
    }
  })
  it("takes a file on this machine only on the dev scripts' chain", () => {
    const local = `http://127.0.0.1:8098/terms/${DIGEST}.md#sha256=${DIGEST}`
    expect(termsLink(local, 31337)).toEqual({ commit: null, digest: DIGEST })
    expect(termsLink(local, 1)).toBeNull()
    expect(termsLink("http://127.0.0.1:65535/a.md#sha256=" + DIGEST, 31337)).not.toBeNull()
    for (const port of ["0", "65536", "08098", ""]) expect(termsLink(`http://127.0.0.1:${port}/a.md#sha256=${DIGEST}`, 31337), port).toBeNull()
  })
  it("refuses any other link", () => {
    for (const link of [
      `${FORGEJO}/docs/general-terms.md`, `${FORGEJO}/docs/general-terms.md#sha256=${DIGEST.toUpperCase()}`, `${FORGEJO}/docs/general-terms.md#sha256=${DIGEST.slice(1)}`,
      `${FORGEJO}/docs/general-terms.txt#sha256=${DIGEST}`, `${FORGEJO}/.md#sha256=${DIGEST}`, `${FORGEJO}/docs//general-terms.md#sha256=${DIGEST}`,
      `${FORGEJO}/docs/./general-terms.md#sha256=${DIGEST}`, `${FORGEJO}/docs/../general-terms.md#sha256=${DIGEST}`, `${FORGEJO}/docs/general%20terms.md#sha256=${DIGEST}`,
      `${FORGEJO}/docs/general-terms.md?raw=1#sha256=${DIGEST}`, `${FORGEJO.replace(COMMIT, COMMIT.toUpperCase())}/a.md#sha256=${DIGEST}`,
      `${FORGEJO.replace(COMMIT, COMMIT.slice(1))}/a.md#sha256=${DIGEST}`, `${FORGEJO.replace("https:", "http:")}/a.md#sha256=${DIGEST}`,
      `https://github.com/simplex-chat/simplex-chat/raw/commit/${COMMIT}/a.md#sha256=${DIGEST}`, `http://localhost:8098/a.md#sha256=${DIGEST}`,
      `${GITHUB}/docs/general-terms.md`, `${GITHUB.replace("https:", "http:")}/a.md#sha256=${DIGEST}`,
      `https://raw.githubusercontent.com/simplex-chat/simplex-chat/stable/a.md#sha256=${DIGEST}`,
      `https://raw.githubusercontent.com/simplex-chat/simplex-chat/refs/heads/stable/a.md#sha256=${DIGEST}`,
      `https://raw.githubusercontent.com/simplex-chat/simplexmq/${COMMIT}/a.md#sha256=${DIGEST}`,
      `https://raw.githubusercontent.com/someone/simplex-chat/${COMMIT}/a.md#sha256=${DIGEST}`,
      `https://github.com/simplex-chat/simplex-chat/blob/${COMMIT}/a.md#sha256=${DIGEST}`,
    ]) {
      expect(termsLink(link, 31337), link).toBeNull()
    }
  })
  it("opens a file at a commit on its page there, and a file on this machine as it is", () => {
    expect(readerUrl(`${FORGEJO}/docs/general-terms.md#sha256=${DIGEST}`)).toBe(`https://git.simplex.chat/simplex-chat/simplex-chat/src/commit/${COMMIT}/docs/general-terms.md`)
    expect(readerUrl(`${GITHUB}/docs/general-terms.md#sha256=${DIGEST}`)).toBe(`https://github.com/simplex-chat/simplex-chat/blob/${COMMIT}/docs/general-terms.md`)
    expect(readerUrl(`${GITHUB}/raw/commit/a.md#sha256=${DIGEST}`), "a GitHub path naming a Forgejo segment").toBe(`https://github.com/simplex-chat/simplex-chat/blob/${COMMIT}/raw/commit/a.md`)
    expect(readerUrl(`http://127.0.0.1:8098/terms/a.md#sha256=${DIGEST}`)).toBe("http://127.0.0.1:8098/terms/a.md")
  })
})

describe("termsText", () => {
  const TEXT = "# Community terms\n\nUse the name for its community, café included.\n"
  const LINK = `${FORGEJO}/docs/community-terms.md#sha256=${sha256(toHex(TEXT)).slice(2)}`
  const terms = termsOf(LINK)
  it("asks the service for the terms by their hash and reads the text once it is the file their link names", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ link: LINK, text: TEXT }), { status: 200 }))
    vi.stubGlobal("fetch", fetched)
    await expect(termsText(terms)).resolves.toBe(TEXT)
    expect((fetched.mock.calls[0] as unknown as [string])[0]).toBe(`/api/terms/${terms.hash}`)
  })
  it("is no answer for another text or link, terms whose hash is not their link's, or a link the page does not take", async () => {
    for (const [body, asked] of [
      [{ link: LINK, text: `${TEXT}more` }, terms], [{ link: LINK.replace("/docs/", "/doc/"), text: TEXT }, terms], [{ link: LINK }, terms],
      [{ link: LINK, text: TEXT }, { ...terms, hash: zeroHash }], [{ link: LINK.replace("https:", "http:"), text: TEXT }, termsOf(LINK.replace("https:", "http:"))],
    ] as const) {
      answerWith(200, JSON.stringify(body))
      await expect(termsText(asked), JSON.stringify(body)).rejects.toMatchObject({ code: "network" })
    }
  })
  it("passes the service's refusal, with its wait", async () => {
    answerWith(404, JSON.stringify({ type: "not_found" }))
    await expect(termsText(terms)).rejects.toMatchObject({ code: "not_found" })
    answerWith(503, JSON.stringify({ type: "terms_unavailable" }), { "retry-after": "30" })
    await expect(termsText(terms)).rejects.toMatchObject({ code: "terms_unavailable", retryAfter: 30 })
  })
})

describe("selectable", () => {
  const view = (change: Partial<RegistrationView>) => ({ phase: { type: "taken" }, price: 10000, payment: { type: "invoice", method: "btc" },
    balance: { amount: 10000, refunded: 0 }, ...change }) as RegistrationView
  const coded = (change: Partial<RegistrationView> = {}) => view({ payment: { type: "code" }, price: 0, balance: null, ...change })
  it("is a taken order: a paid one while its balance holds its price, a code one", () => {
    expect(selectable(view({}))).toBe(true)
    expect(selectable(coded())).toBe(true)
    expect(selectable(view({ balance: { amount: 0, refunded: 10000 } })), "a paid order refunded").toBe(false)
  })
  it("is no order in another phase", () => {
    expect(selectable(coded({ phase: { type: "failed", reason: "registryRefused" } }))).toBe(false)
    expect(selectable(view({ phase: { type: "queued" } }))).toBe(false)
  })
})

describe("retryDelay", () => {
  const USUAL = 5000
  it("waits what the service asks, or the usual pause for a rate limit without a wait, a server failure or no answer", () => {
    expect(retryDelay(new ApiError("rate_limited", 429, 12, {}), USUAL)).toBe(12_000)
    expect(retryDelay(new ApiError("rate_limited", 429, null, {}), USUAL)).toBe(USUAL)
    expect(retryDelay(new ApiError("provider_unavailable", 503, null, {}), USUAL)).toBe(USUAL)
    expect(retryDelay(new ApiError("network", 0, null, {}), USUAL)).toBe(USUAL)
    expect(retryDelay(new TypeError("Failed to fetch"), USUAL)).toBe(USUAL)
  })
  it("gives up on a refusal that asking again cannot change", () => {
    expect(retryDelay(new ApiError("not_found", 404, null, {}), USUAL)).toBeNull()
    expect(retryDelay(new ApiError("bad_request", 400, null, {}), USUAL)).toBeNull()
  })
})

describe("service errors", () => {
  it("reads the service's own refusal, tagged by type on the names endpoints and by error on the others, whatever the status", async () => {
    answerWith(503, JSON.stringify({ type: "provider_unavailable" }))
    const e = await errorOf()
    expect([e.code, e.status]).toEqual(["provider_unavailable", 503])
    answerWith(409, JSON.stringify({ type: "order_exists" }))
    expect((await errorOf()).code).toBe("order_exists")
  })

  it("reads the service's downtime, which refuses new orders, as its own refusal and not a gateway's failure", async () => {
    answerWith(503, JSON.stringify({ type: "downtime" }))
    const e = await createOrder({ labelHash: HASH, length: 8, duration: 1, owner: "0x1", commitment: HASH, sealed: "s", terms: HASH, timestamp: 1, signature: "0x", reveal: REVEAL }, "btc", 10000)
      .then(() => null, (e: unknown) => e)
    expect([(e as ApiError).code, (e as ApiError).status]).toEqual(["downtime", 503])
  })

  it("takes a refusal the page does not know as the service's own failure, or the network's under a gateway status", async () => {
    answerWith(409, JSON.stringify({ type: "weird" }))
    expect((await errorOf()).code).toBe("internal")
    answerWith(503, JSON.stringify({ type: "weird" }))
    expect((await errorOf()).code).toBe("network")
  })

  it("takes a proxy's gateway failure, with no code of the service's, as the network failing", async () => {
    for (const status of [502, 503, 504]) {
      answerWith(status, "<html><body>504 Gateway Time-out</body></html>", { "content-type": "text/html" })
      expect((await errorOf()).code, `status ${status}`).toBe("network")
    }
  })

  it("takes any other failure with no code as the service's own", async () => {
    answerWith(500, "")
    expect((await errorOf()).code).toBe("internal")
  })

  it("reads a proxy's rate limit and its wait, with no body", async () => {
    answerWith(429, "", { "retry-after": "12" })
    const e = await errorOf()
    expect([e.code, e.retryAfter]).toEqual(["rate_limited", 12])
  })

  it("reads the service's edit_limit as its own refusal, with when the next edit fits in seconds, and no wait to hold", async () => {
    const edit = { labelHash: `0x${HASH}`, edits: [{ key: "channel" as const, value: "", nonce: 3, deadline: 1, signature: "0x" }] }
    answerWith(409, JSON.stringify({ type: "edit_limit", nextAt: "2027-10-23T00:00:00Z" }))
    const e = await editRecords(edit).then(() => null, (e: unknown) => e)
    expect(e).toBeInstanceOf(EditLimited)
    expect([(e as EditLimited).code, (e as EditLimited).status, (e as EditLimited).nextAt]).toEqual(["edit_limit", 409, 1824249600])
    expect(retryDelay(e, 5000), "asking again cannot change it").toBeNull()
    for (const body of [{ type: "edit_limit" }, { type: "edit_limit", nextAt: "soon" }, { type: "edit_limit", nextAt: 1824249600 }]) {
      answerWith(409, JSON.stringify(body))
      const bad = await editRecords(edit).then(() => null, (e: unknown) => e)
      expect((bad as ApiError).code, JSON.stringify(body)).toBe("network")
    }
    // a 429 is a rate limit, whatever its body says
    answerWith(429, JSON.stringify({ type: "edit_limit", nextAt: "2027-10-23T00:00:00Z" }), { "retry-after": "4" })
    const limited = await editRecords(edit).then(() => null, (e: unknown) => e)
    expect([(limited as ApiError).code, (limited as ApiError).retryAfter, limited instanceof EditLimited]).toEqual(["rate_limited", 4, false])
  })

  it("passes a registered name's record edits, with when the next returns in seconds, and takes ones that cannot be so as no answer", async () => {
    const own = { type: "own", contact: "", channel: "", nonce: 2 }
    for (const [edits, read] of [[{ left: 3 }, { left: 3, nextAt: null }], [{ left: 0, nextAt: "2027-10-23T00:00:00Z" }, { left: 0, nextAt: 1824249600 }],
      [{ left: 1, nextAt: "2027-10-23T00:00:00Z" }, { left: 1, nextAt: 1824249600 }]] as const) {
      answerWith(200, JSON.stringify({ found: { ...REGISTERED, records: { ...own, edits } } }))
      expect(await searchName(HASH, 8), JSON.stringify(edits)).toMatchObject({ found: { records: { ...own, edits: read } } })
    }
    for (const edits of [{ left: 0 }, { left: -1 }, { left: 1.5 }, {}, { left: 2, nextAt: "soon" }, { left: 2, nextAt: 1824249600 }, 3, undefined]) {
      answerWith(200, JSON.stringify({ found: { ...REGISTERED, records: { ...own, edits } } }))
      expect((await errorOf()).code, JSON.stringify(edits)).toBe("network")
    }
  })

  it("takes a search answer the page cannot draw as no answer", async () => {
    for (const found of [
      { type: "weird" }, { type: "registered" }, [], "registered", undefined, { ...REGISTERED, owner: undefined }, { ...REGISTERED, records: undefined }, { ...REGISTERED, records: { type: "own" } },
      { ...REGISTERED, records: null }, { ...REGISTERED, entities: [{}] }, { ...REGISTERED, entities: [null] },
      { type: "available", price: "100", years: 2 }, { type: "available", price: 5 },
    ]) {
      answerWith(200, JSON.stringify({ found }))
      expect((await errorOf()).code, JSON.stringify(found)).toBe("network")
    }
    for (const body of [[], "registered", { status: "available", price: 5, years: 2 }]) {
      answerWith(200, JSON.stringify(body))
      expect((await errorOf()).code, JSON.stringify(body)).toBe("network")
    }
  })

  const TERMS = LOCAL.generalTerms[0]
  const GROUP ={ kind: "channel", displayName: "Alice", fullName: "Alice's news", subscribers: 12 }
  const channelPreview = (profile: Record<string, unknown> = GROUP) => ({ kind: "channel", profile: { type: "ok", linkProfile: profile } })
  const PREVIEW = channelPreview()
  // the profile as the page draws it
  const DRAWN = { type: "channel", kind: "channel", displayName: "Alice", fullName: "Alice's news", image: null, subscribers: 12, profile: "ok" }
  const LINK = { link: "https://simplex.chat/c#x", deepLink: "simplex:/c#x" }
  const registeredWith = (...entities: unknown[]) => JSON.stringify({ found: { ...REGISTERED, entities } })

  it("passes a search answer the page can draw", async () => {
    const available = { type: "available", price: 10000, years: 2, terms: TERMS }
    answerWith(200, JSON.stringify({ found: available }))
    expect(await searchName("ab".repeat(32), 8)).toEqual({ found: available, community: null })
    answerWith(200, JSON.stringify({ found: { type: "available", price: 10000, years: 2 } }))
    expect(await searchName("ab".repeat(32), 8), "terms that can't be read now").toEqual({ found: { type: "available", price: 10000, years: 2, terms: null }, community: null })
    answerWith(200, registeredWith({ preview: PREVIEW, ...LINK }))
    expect(await searchName("ab".repeat(32), 8)).toEqual({ found: { ...REGISTERED, entities: [{ ...DRAWN, ...LINK }] }, community: null })
    for (const type of ["taken", "reserved"]) {
      answerWith(200, JSON.stringify({ found: { type } }))
      expect(await searchName("ab".repeat(32), 8)).toEqual({ found: { type }, community: null })
    }
  })

  it("takes a linked chat without its names, a type the app has not, a member count that cannot be, or a link not as text, as no answer", async () => {
    const previews = [
      { ...PREVIEW, kind: "group" }, { ...PREVIEW, kind: undefined }, { ...PREVIEW, profile: undefined }, { ...PREVIEW, profile: { type: "lost" } },
      { ...PREVIEW, profile: { type: "ok" } }, channelPreview({ ...GROUP, displayName: undefined }), channelPreview({ ...GROUP, fullName: undefined }), channelPreview({ ...GROUP, kind: "group" }),
      channelPreview({ ...GROUP, kind: undefined }), channelPreview({ ...GROUP, subscribers: -1 }), channelPreview({ ...GROUP, subscribers: "many" }),
    ]
    for (const preview of previews) {
      answerWith(200, registeredWith({ preview, ...LINK }))
      expect((await errorOf()).code, JSON.stringify(preview)).toBe("network")
    }
    for (const change of [{ deepLink: undefined }, { deepLink: null }, { deepLink: 5 }, { link: null }, { preview: undefined }]) {
      answerWith(200, registeredWith({ preview: PREVIEW, ...LINK, ...change }))
      expect((await errorOf()).code, JSON.stringify(change)).toBe("network")
    }
    // a link whose data the service did not read is still a chat, drawn without its profile
    for (const [kind, type] of [["contact", "address"], ["channel", "channel"]]) {
      for (const profile of ["unread", "unavailable"]) {
        answerWith(200, registeredWith({ preview: { kind, profile: { type: profile } }, ...LINK }))
        expect(await searchName("ab".repeat(32), 8), `${kind} ${profile}`).toMatchObject({ found: { entities: [{ type, kind, displayName: "", fullName: "", image: null, subscribers: null, profile, ...LINK }] } })
      }
    }
    // an address opens a contact, a business or a bot, as the service tells them apart
    const contactPreview = (kind: unknown) => ({ kind: "contact", profile: { type: "ok", linkProfile: { kind, displayName: "Alice", fullName: "" } } })
    for (const kind of ["contact", "business", "bot"]) {
      answerWith(200, registeredWith({ preview: contactPreview(kind), ...LINK }))
      expect(await searchName("ab".repeat(32), 8), kind).toMatchObject({ found: { entities: [{ type: "address", kind, displayName: "Alice", subscribers: null, ...LINK }] } })
    }
    for (const kind of [undefined, "robot", 5]) {
      answerWith(200, registeredWith({ preview: contactPreview(kind), ...LINK }))
      expect((await errorOf()).code, JSON.stringify(kind)).toBe("network")
    }
  })

  it("takes a code check the page cannot draw as no answer, and passes one it can", async () => {
    for (const body of [{}, [], { state: "weird", minLength: 6, years: 2 }, { minLength: "x", years: null, state: "unused" }]) {
      answerWith(200, JSON.stringify(body))
      const e = await checkCode("SN6-X").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(body)).toBe("network")
    }
    answerWith(200, JSON.stringify({ state: "unused", minLength: 6, years: 2 }))
    expect(await checkCode("SN6-X")).toEqual({ state: "unused", minLength: 6, years: 2 })
  })

  it("takes a code check only for the years a code may give", async () => {
    for (const years of [LOCAL.minCodeYears, LOCAL.maxCodeYears]) {
      answerWith(200, JSON.stringify({ state: "unused", minLength: 6, years }))
      expect((await checkCode("SN6-X")).years).toBe(years)
    }
    for (const years of [LOCAL.minCodeYears - 1, LOCAL.maxCodeYears + 1]) {
      answerWith(200, JSON.stringify({ state: "unused", minLength: 6, years }))
      expect(((await checkCode("SN6-X").then(() => null, (e: unknown) => e)) as ApiError).code, String(years)).toBe("network")
    }
  })

  it("takes a success whose body was cut off as no answer", async () => {
    answerWith(200, '{"status":"avail')
    expect((await errorOf()).code).toBe("network")
  })

  const REGISTRATION = {
    id: "r1", version: 4, phase: { type: "unpaid" }, labelHash: `0x${"ab".repeat(32)}`, label: null, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: `0x${"cd".repeat(32)}`,
    sealed: "sealed", years: 2, duration: 2 * 365 * 86400, price: 10000, payment: { type: "invoice", method: "btc" }, balance: null, commitTx: null, registerTx: null, latePayment: null,
    community: null, terms: { communityName: false, termsHash: TERMS.hash },
  }
  const INVOICE = { invoiceId: "inv1", status: "open", amount: 10000, currency: "usd", expiresAt: "2026-10-16T12:00:00Z", kind: "name", registration: REGISTRATION, cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bc1q" }

  it("passes an invoice the page can draw, and takes one it cannot, or one that cannot be so, as no answer", async () => {
    answerWith(200, JSON.stringify(INVOICE))
    expect(await readInvoice("inv1")).toMatchObject({ invoiceId: "inv1", registration: { id: "r1" } })
    for (const body of [
      {}, { ...INVOICE, registration: undefined }, { ...INVOICE, registration: { ...REGISTRATION, phase: { type: "lost" } } }, { ...INVOICE, status: "weird" },
      { ...INVOICE, amount: "lots" }, { ...INVOICE, amount: -1 }, { ...INVOICE, cryptoAmount: "a lot" }, { ...INVOICE, registration: { ...REGISTRATION, years: 0 } },
      { ...INVOICE, registration: { ...REGISTRATION, version: "4" } }, { ...INVOICE, registration: { ...REGISTRATION, phase: "unpaid" } },
    ]) {
      answerWith(200, JSON.stringify(body))
      const e = await readInvoice("inv1").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(body).slice(0, 120)).toBe("network")
    }
  })

  it("takes an overpaid invoice's negative due as nothing left to pay, from every request that answers an invoice", async () => {
    const overpaid = { ...INVOICE, cryptoAmountPaid: "0.00256", cryptoAmountDue: "-0.001", paidInFull: true }
    const reads: [string, () => Promise<unknown>][] = [
      ["a read", () => readInvoice("inv1")], ["a cancel", () => cancelInvoice("inv1")],
    ]
    for (const [name, read] of reads) {
      answerWith(200, JSON.stringify(overpaid))
      expect(await read(), name).toMatchObject({ cryptoAmountPaid: "0.00256", cryptoAmountDue: "0", paidInFull: true })
    }
    for (const cryptoAmountDue of ["-", "--0.001", "-0.001x", "- 0.001"]) {
      answerWith(200, JSON.stringify({ ...overpaid, cryptoAmountDue }))
      const e = await readInvoice("inv1").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, cryptoAmountDue).toBe("network")
    }
  })

  const BALANCE = { amount: 10000, refunded: 2500 }

  it("passes what a late payment waits on", async () => {
    for (const waiting of ["confirming", "crediting", "support"]) {
      answerWith(200, JSON.stringify({ ...REGISTRATION, latePayment: waiting }))
      expect((await readRegistration("r1")).latePayment).toEqual(waiting)
    }
  })

  it("passes each phase with what it holds, and takes a phase that cannot be so as no answer", async () => {
    const acceptance = { community: false, policy: "0x3", termsHash: TERMS.hash, nonce: 0 }
    const committed = (signature: unknown) => ({ type: "committed", revealAfter: 1, revealBefore: 2, signature })
    for (const phase of [
      { type: "unpaid" }, { type: "closed", closedBy: "expired" }, { type: "closed", closedBy: "cancelled" }, { type: "closed", closedBy: "reversed" }, { type: "queued" }, { type: "committing" },
      committed({ type: "awaiting", toSign: { type: "unread" } }), committed({ type: "awaiting", toSign: { type: "read", intentNonce: 4, acceptance } }), committed({ type: "signed" }),
      committed({ type: "lapsed" }), { type: "registering" }, { type: "registered", expiresAt: 3 }, { type: "registered", expiresAt: 3, disputeUntil: 2 },
      { type: "ended" }, { type: "taken" },
      { type: "failed", reason: "registryRefused" }, { type: "failed", reason: "signatureRefused" },
      { type: "failed", reason: "monthEnded" }, { type: "failed", reason: "unread" },
    ]) {
      answerWith(200, JSON.stringify({ ...REGISTRATION, phase }))
      expect((await readRegistration("r1")).phase, JSON.stringify(phase)).toEqual(phase)
    }
    for (const phase of [
      { type: "closed" }, { type: "closed", closedBy: "paid" }, { type: "committed", revealAfter: 1, revealBefore: 2 }, committed({ type: "awaiting" }),
      committed({ type: "awaiting", toSign: { type: "read", intentNonce: 4 } }), committed({ type: "awaiting", toSign: { type: "read", intentNonce: -1, acceptance } }),
      { ...committed({ type: "signed" }), revealAfter: null }, { type: "registered" }, { type: "failed" }, { type: "failed", reason: "not_registered" }, { type: "failed", reason: "linksRefused" },
    ]) {
      answerWith(200, JSON.stringify({ ...REGISTRATION, phase }))
      const e = await readRegistration("r1").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(phase)).toBe("network")
    }
  })

  it("passes an order's balance and how it was paid, and takes either malformed as no answer", async () => {
    for (const payment of [{ type: "invoice", method: "btc" }, { type: "code" }]) {
      answerWith(200, JSON.stringify({ ...REGISTRATION, payment, balance: BALANCE }))
      expect(await readRegistration("r1"), JSON.stringify(payment)).toMatchObject({ payment, balance: BALANCE })
    }
    for (const change of [
      { payment: undefined }, { payment: { type: "invoice" } }, { payment: { type: "invoice", method: "eth" } },
      { payment: { type: "balance" } }, { payment: { type: "gift" } }, { balance: undefined }, { balance: {} }, { balance: { ...BALANCE, amount: -5 } },
      { balance: { ...BALANCE, refunded: null } },
      { latePayment: undefined }, { latePayment: {} }, { latePayment: "later" },
    ]) {
      answerWith(200, JSON.stringify({ ...REGISTRATION, ...change }))
      const e = await readRegistration("r1").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(change)).toBe("network")
    }
  })

  it("holds a poll on the registration's version and the payment marks it has seen", async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify(INVOICE), { status: 200 }))
    vi.stubGlobal("fetch", fetched)
    const invoice = await readInvoice("inv1")
    await readInvoice("inv1", seenOf({ ...invoice, cryptoAmountPaid: "0.5", paidInFull: true }))
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(REGISTRATION), { status: 200 })))
    await readRegistration("r1", 4)
    await readRegistration("r1", 0)
    const urls = [...fetched.mock.calls, ...(fetch as unknown as typeof fetched).mock.calls].map((c) => (c as unknown as [string])[0])
    expect(urls).toEqual(["/api/invoice/inv1", "/api/invoice/inv1?wait=open&seenVersion=4&seenPaid=0.5&seenFull=1", "/api/registration/r1?seenVersion=4", "/api/registration/r1?seenVersion=0"])
  })

  it("takes a link preview whose image is no image the page can show as no answer, and an image the service dropped as none", async () => {
    answerWith(200, JSON.stringify(channelPreview({ ...GROUP, image: "data:image/png;base64,iVBORw0KGgo=" })))
    expect(await previewLink("x")).toMatchObject({ displayName: "Alice", kind: "channel", subscribers: 12, image: "data:image/png;base64,iVBORw0KGgo=" })
    answerWith(200, JSON.stringify(channelPreview(GROUP)))
    expect(await previewLink("x")).toMatchObject({ displayName: "Alice", image: null })
    for (const image of ["javascript:alert(1)", "http://example.com/a.png", "https://example.com/a.png", 5, null]) {
      answerWith(200, JSON.stringify(channelPreview({ ...GROUP, image })))
      const e = await previewLink("x").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, String(image)).toBe("network")
    }
  })

  it("takes a search or code answer with values that cannot be so as no answer", async () => {
    for (const found of [
      { type: "available", price: -500, years: 2 }, { type: "available", price: 500, years: 0 },
      { ...REGISTERED, owner: 5 }, { ...REGISTERED, records: { type: "own", contact: 1, channel: "", nonce: 0, edits: { left: 1 } } },
    ]) {
      answerWith(200, JSON.stringify({ found }))
      expect((await errorOf()).code, JSON.stringify(found)).toBe("network")
    }
    answerWith(200, JSON.stringify({ state: "unused", minLength: -3, years: -1 }))
    expect(((await checkCode("SN6-X").then(() => null, (e: unknown) => e)) as ApiError).code).toBe("network")
  })

  describe("terms and community names", () => {
    const COMMUNITY = { for: "bakers and pastry chefs", years: 2 }
    const COMMUNITY_TERMS = LOCAL.communityTerms[2]
    const LOCAL_TERMS = LOCAL.communityTerms[0]
    const SIGNED = `community/${COMMUNITY_TERMS.hash.slice(2)}`
    const OLDER_SIGNED = `2026-10-23/community/${"c7".repeat(32)}`
    const AVAILABLE = { found: { type: "available", price: 10000, years: 2, terms: COMMUNITY_TERMS }, community: COMMUNITY }
    const availableWith = (terms: unknown) => ({ ...AVAILABLE, found: { ...AVAILABLE.found, terms } })
    const ORDER = { labelHash: `0x${"ab".repeat(32)}`, length: 6, duration: 2 * 365 * 86400, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: `0x${"cd".repeat(32)}`, sealed: "sealed", terms: SIGNED, timestamp: 1, signature: "0x", reveal: REVEAL }

    it("signs the general terms' hash for a name not on the community list, and community/ with the community terms' hash for one on it", () => {
      expect(termsFor(TERMS, null)).toBe(TERMS.hash.slice(2))
      expect(termsFor(COMMUNITY_TERMS, COMMUNITY)).toBe(SIGNED)
      expect(currentTerms({ terms: COMMUNITY_TERMS, community: COMMUNITY })).toBe(SIGNED)
    })

    it("reads the hash of the terms an order signed, and none from the version an older page signed", () => {
      expect(signedHash(SIGNED)).toBe(COMMUNITY_TERMS.hash)
      expect(signedHash(TERMS.hash.slice(2))).toBe(TERMS.hash)
      for (const terms of ["2026-10-23", OLDER_SIGNED, TERMS.hash, TERMS.hash.slice(2).toUpperCase(), null, undefined]) {
        expect(signedHash(terms), String(terms)).toBeNull()
      }
    })

    it("registers a community name for its own years, whatever years a code or an order pays for", () => {
      expect(termYears(COMMUNITY, 5)).toBe(2)
      expect(termYears(null, 5)).toBe(5)
    })

    it("tells signed terms that agreed to a community name's wording, also under the version an older page signed", () => {
      for (const terms of [SIGNED, OLDER_SIGNED]) expect(communityAgreed(terms), terms).toBe(true)
      for (const terms of [TERMS.hash.slice(2), "2026-10-23", null, undefined]) expect(communityAgreed(terms), String(terms)).toBe(false)
    })

    it("passes the community entry of a community name's search answer, and the terms of the name's kind in the available one", async () => {
      for (const body of [
        AVAILABLE, { found: { type: "reserved" }, community: COMMUNITY }, { found: REGISTERED, community: COMMUNITY },
        { ...AVAILABLE, community: { years: 2 } }, { ...availableWith(TERMS), community: null }, availableWith(LOCAL_TERMS),
      ]) {
        answerWith(200, JSON.stringify(body))
        expect(await searchName(HASH, 6), JSON.stringify(body)).toEqual(body)
      }
      answerWith(200, JSON.stringify({ found: REGISTERED }))
      expect(await searchName(HASH, 6), "a name off the community list").toEqual({ found: REGISTERED, community: null })
    })

    it("reads the terms of an available answer as none unless they are the page's own terms of the name's kind", async () => {
      const unheld = termsOf(`${FORGEJO}/docs/general-terms.md#sha256=${"0b".repeat(32)}`)
      for (const body of [availableWith(TERMS), availableWith(LOCAL.generalTerms[1]), { ...availableWith(COMMUNITY_TERMS), community: null }, { ...availableWith(unheld), community: null }]) {
        answerWith(200, JSON.stringify(body))
        expect((await searchName(HASH, 6)).found, JSON.stringify(body)).toEqual({ ...body.found, terms: null })
      }
    })

    it("takes a community entry that cannot be so, or the available answer with terms whose link the page does not take or whose hash is not their link's, as no answer", async () => {
      for (const body of [
        { ...AVAILABLE, community: "bakers" }, { ...AVAILABLE, community: { ...COMMUNITY, for: 5 } }, { ...AVAILABLE, community: { ...COMMUNITY, for: "" } }, { ...AVAILABLE, community: { ...COMMUNITY, for: null } },
        { ...AVAILABLE, community: { ...COMMUNITY, years: 0 } }, { ...AVAILABLE, community: { for: COMMUNITY.for } }, availableWith({ link: TERMS.link }), availableWith({ hash: TERMS.hash }),
        availableWith(null), availableWith({ ...TERMS, hash: COMMUNITY_TERMS.hash }), availableWith({ ...TERMS, hash: TERMS.hash.toUpperCase().replace("0X", "0x") }),
        availableWith(termsOf(COMMUNITY_TERMS.link.replace("https:", "http:"))), availableWith(termsOf("https://simplex.chat/terms")),
        { found: { type: "registered" } }, { community: COMMUNITY },
      ]) {
        answerWith(200, JSON.stringify(body))
        expect((await errorOf()).code, JSON.stringify(body)).toBe("network")
      }
    })

    it("passes an order's community entry and the terms it signed", async () => {
      const agreed = { communityName: true, termsHash: COMMUNITY_TERMS.hash }
      for (const change of [{ community: COMMUNITY, terms: agreed }, { community: null, terms: { communityName: false, termsHash: TERMS.hash } }]) {
        answerWith(200, JSON.stringify({ ...REGISTRATION, ...change }))
        expect(await readRegistration("r1"), JSON.stringify(change)).toMatchObject(change)
      }
      for (const change of [{ community: undefined }, { community: { ...COMMUNITY, for: 1 } }, { terms: undefined }, { terms: null }, { terms: SIGNED }, { terms: { ...agreed, communityName: "yes" } },
        { terms: { ...agreed, termsHash: COMMUNITY_TERMS.hash.slice(2) } }, { terms: { communityName: true } }]) {
        answerWith(200, JSON.stringify({ ...REGISTRATION, ...change }))
        const e = await readRegistration("r1").then(() => null, (e: unknown) => e)
        expect((e as ApiError).code, JSON.stringify(change)).toBe("network")
      }
    })

    it("passes the acceptance a committed name's reveal signs, of either kind, and takes one it cannot sign as no answer", async () => {
      const acceptance = { community: true, policy: "0x3", termsHash: COMMUNITY_TERMS.hash, nonce: 0 }
      const withAcceptance = (accepted: unknown) => ({ ...REGISTRATION, phase: { type: "committed", revealAfter: 1, revealBefore: 2,
        signature: { type: "awaiting", toSign: { type: "read", intentNonce: 0, acceptance: accepted } } } })
      for (const accepted of [acceptance, { ...acceptance, community: false, termsHash: TERMS.hash }]) {
        answerWith(200, JSON.stringify(withAcceptance(accepted)))
        expect(await readRegistration("r1"), JSON.stringify(accepted)).toMatchObject(withAcceptance(accepted))
      }
      for (const accepted of [undefined, null, { ...acceptance, termsHash: "0x1" }, { ...acceptance, nonce: -1 }, { ...acceptance, nonce: 1.5 },
        { ...acceptance, policy: 3 }, { ...acceptance, community: undefined }, { ...acceptance, community: "community" }]) {
        answerWith(200, JSON.stringify(withAcceptance(accepted)))
        const e = await readRegistration("r1").then(() => null, (e: unknown) => e)
        expect((e as ApiError).code, JSON.stringify(accepted)).toBe("network")
      }
    })

    const SENDS: [string, () => Promise<unknown>][] = [
      ["an order", () => createOrder(ORDER, "btc", 10000)],
      ["a code order", () => registerWithCode(ORDER, "SN6-X")],
      ["a selection", () => selectName("r1", ORDER)],
    ]

    it.each(SENDS)("sends %s with the terms the buyer agreed to and the reveal", async (_, send) => {
      const fetched = vi.fn(async () => new Response(JSON.stringify({ type: "name_taken" }), { status: 409 }))
      vi.stubGlobal("fetch", fetched)
      await send().catch(() => undefined)
      const [, init] = fetched.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(String(init.body))
      expect((body.order ?? body).fields.terms).toEqual({ communityName: true, termsHash: COMMUNITY_TERMS.hash })
      expect(body.reveal).toEqual(REVEAL)
    })

    it.each(SENDS)("gives %s refused for changed terms the terms of the name's kind and the community entry as they are now", async (_, send) => {
      for (const [terms, community] of [[COMMUNITY_TERMS, COMMUNITY], [TERMS, null], [LOCAL_TERMS, COMMUNITY]] as const) {
        answerWith(409, JSON.stringify({ type: "terms_changed", terms, community }))
        const e = await send().then(() => null, (e: unknown) => e)
        expect(e).toBeInstanceOf(TermsChanged)
        expect(e).toMatchObject({ code: "terms_changed", status: 409, terms, community })
      }
      for (const body of [{ type: "terms_changed" }, { type: "terms_changed", terms: TERMS }, { type: "terms_changed", terms: null, community: null },
        { type: "terms_changed", terms: { ...TERMS, hash: COMMUNITY_TERMS.hash }, community: null }, { type: "terms_changed", terms: termsOf("ftp://x"), community: null }]) {
        answerWith(409, JSON.stringify(body))
        const e = await send().then(() => null, (e: unknown) => e)
        expect((e as ApiError).code, JSON.stringify(body)).toBe("network")
      }
    })

    it.each(SENDS)("takes %s refused for changed terms as no answer unless they are the page's own terms of the name's kind", async (_, send) => {
      const unheld = termsOf(`${FORGEJO}/docs/general-terms.md#sha256=${"0b".repeat(32)}`)
      for (const [terms, community] of [[TERMS, COMMUNITY], [COMMUNITY_TERMS, null], [unheld, null]] as const) {
        answerWith(409, JSON.stringify({ type: "terms_changed", terms, community }))
        const e = await send().then(() => null, (e: unknown) => e)
        expect((e as ApiError).code, JSON.stringify(terms)).toBe("network")
      }
    })

    it.each(SENDS.filter(([name]) => name !== "a code order"))("takes %s refused for a changed price only at the price the page holds for the name's length", async (_, send) => {
      const held = LOCAL.priceExceptions.find((e) => e.labelLength === ORDER.length)!.centsPerYear * LOCAL.paidYears
      answerWith(409, JSON.stringify({ type: "catalog_changed", price: held }))
      expect(await send().then(() => null, (e: unknown) => e)).toMatchObject({ code: "catalog_changed", body: { price: held } })
      for (const price of [held - 1, LOCAL.priceBaseCentsPerYear * LOCAL.paidYears, undefined]) {
        answerWith(409, JSON.stringify({ type: "catalog_changed", price }))
        const e = await send().then(() => null, (e: unknown) => e)
        expect((e as ApiError).code, String(price)).toBe("network")
      }
    })

    it.each(SENDS)("passes %s refused while the terms can't be read, with the service's wait", async (_, send) => {
      answerWith(503, JSON.stringify({ type: "terms_unavailable" }), { "retry-after": "30" })
      const e = await send().then(() => null, (e: unknown) => e)
      expect(e).not.toBeInstanceOf(TermsChanged)
      expect(e).toMatchObject({ code: "terms_unavailable", status: 503, retryAfter: 30 })
    })
  })
})
