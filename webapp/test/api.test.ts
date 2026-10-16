import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, checkCode, previewLink, readInvoice, searchName } from "../src/api.ts"

const HASH = "ab".repeat(32)

function answerWith(status: number, body: string, headers: Record<string, string> = {}): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers })))
}

async function errorOf(): Promise<ApiError> {
  const e = await searchName(HASH, 8).then(() => null, (e: unknown) => e)
  expect(e).toBeInstanceOf(ApiError)
  return e as ApiError
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("service errors", () => {
  it("reads the service's own error code, whatever the status", async () => {
    answerWith(503, JSON.stringify({ error: "provider_unavailable" }))
    const e = await errorOf()
    expect([e.code, e.status]).toEqual(["provider_unavailable", 503])
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

  it("takes a search answer the page cannot draw as no answer", async () => {
    const chain = { resolver: "0x1", sponsor: "0x2", chainId: 31337, tld: "simplex" }
    for (const body of [
      { status: "weird" }, { status: "registered", tld: "simplex" }, [], "registered",
      { status: "registered", tld: "simplex", entities: [{}] }, { status: "registered", tld: "simplex", entities: [null] },
      { status: "available", price: "100", years: 2, currency: "USD", ...chain }, { status: "available", price: 5, currency: "USD", ...chain },
    ]) {
      answerWith(200, JSON.stringify(body))
      expect((await errorOf()).code, JSON.stringify(body)).toBe("network")
    }
  })

  it("passes a search answer the page can draw", async () => {
    const entity = { type: "channel", displayName: "Alice", image: null, link: "https://simplex.chat/c#x", deepLink: "simplex:/c#x" }
    answerWith(200, JSON.stringify({ status: "registered", tld: "simplex", entities: [entity] }))
    expect(await searchName("ab".repeat(32), 8)).toMatchObject({ status: "registered", entities: [entity] })
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

  it("takes a success whose body was cut off as no answer", async () => {
    answerWith(200, '{"status":"avail')
    expect((await errorOf()).code).toBe("network")
  })

  const REGISTRATION = {
    id: "r1", phase: "unpaid", labelHash: `0x${"ab".repeat(32)}`, label: null, owner: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", commitment: `0x${"cd".repeat(32)}`,
    sealed: null, years: 2, price: 10000, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, intentNonce: null, expiresAt: null, error: null,
    resolver: "0x1", sponsor: "0x2", chainId: 31337, tld: "simplex",
  }
  const INVOICE = { invoiceId: "inv1", status: "open", amount: 10000, currency: "usd", expiresAt: "2026-10-16T12:00:00Z", kind: "name", registration: REGISTRATION, cryptoCurrency: "btc", cryptoAmount: "0.00156", address: "bc1q" }

  it("passes an invoice the page can draw, and takes one it cannot, or one that cannot be so, as no answer", async () => {
    answerWith(200, JSON.stringify(INVOICE))
    expect(await readInvoice("inv1")).toMatchObject({ invoiceId: "inv1", registration: { id: "r1" } })
    for (const body of [
      {}, { ...INVOICE, registration: undefined }, { ...INVOICE, registration: { ...REGISTRATION, phase: "lost" } }, { ...INVOICE, status: "weird" },
      { ...INVOICE, amount: "lots" }, { ...INVOICE, amount: -1 }, { ...INVOICE, cryptoAmount: "a lot" }, { ...INVOICE, registration: { ...REGISTRATION, years: 0 } },
    ]) {
      answerWith(200, JSON.stringify(body))
      const e = await readInvoice("inv1").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, JSON.stringify(body).slice(0, 120)).toBe("network")
    }
  })

  it("takes a link preview whose image is no image the page can show as no answer", async () => {
    answerWith(200, JSON.stringify({ type: "channel", displayName: "Alice", image: "data:image/png;base64,iVBORw0KGgo=" }))
    expect(await previewLink("x")).toMatchObject({ displayName: "Alice" })
    for (const image of ["javascript:alert(1)", "http://example.com/a.png", 5]) {
      answerWith(200, JSON.stringify({ type: "channel", displayName: "Alice", image }))
      const e = await previewLink("x").then(() => null, (e: unknown) => e)
      expect((e as ApiError).code, String(image)).toBe("network")
    }
  })

  it("takes a search or code answer with values that cannot be so as no answer", async () => {
    const chain = { resolver: "0x1", sponsor: "0x2", chainId: 31337, tld: "simplex" }
    for (const body of [
      { status: "available", price: -500, years: 2, currency: "usd", ...chain }, { status: "available", price: 500, years: 0, currency: "usd", ...chain },
      { status: "registered", tld: "simplex", entities: [], owner: 5 }, { status: "registered", tld: "simplex", entities: [], records: { contact: 1 } },
    ]) {
      answerWith(200, JSON.stringify(body))
      expect((await errorOf()).code, JSON.stringify(body)).toBe("network")
    }
    answerWith(200, JSON.stringify({ state: "unused", minLength: -3, years: -1 }))
    expect(((await checkCode("SN6-X").then(() => null, (e: unknown) => e)) as ApiError).code).toBe("network")
  })
})
