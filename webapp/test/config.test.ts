import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { keccak256, toHex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ALTERNATE_COMMUNITY_TERMS, ALTERNATE_GENERAL_TERMS } from "../e2e/terms.ts"
import { CONFIG_PATH, configOf, LOCAL, loadConfig, MAINNET, readConfig, SITE } from "../src/config.ts"
import { publishableKey, setPublishableKey } from "../src/stripe.ts"

const INDEX = readFileSync(new URL("../index.html", import.meta.url), "utf8")

const NAMES = { codesOnly: false, chainId: 31337, resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", tld: "simplex", termStart: 1798761600 }

// a service answering GET /api/config with this status and body, or a network that fails
function serviceAnswering(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal("fetch", fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
  setPublishableKey("")
})

describe("configOf", () => {
  it("reads the service's Stripe key and its downtime", () => {
    expect(configOf({ stripePublishableKey: "pk_test_x", names: { ...NAMES, downtime: true } })).toEqual({ stripePublishableKey: "pk_test_x", downtime: true })
    expect(configOf({ stripePublishableKey: null, names: { ...NAMES, downtime: false } })).toEqual({ stripePublishableKey: "", downtime: false })
    expect(configOf({ stripePublishableKey: " pk_test_y\n", names: null })).toEqual({ stripePublishableKey: "pk_test_y", downtime: false })
    expect(configOf({ stripePublishableKey: null, names: NAMES }), "a service from before the downtime").toEqual({ stripePublishableKey: "", downtime: false })
  })
  it("takes nothing else the service answers: with another sponsor, resolver, chain, TLD, term or mode, only the downtime differs", () => {
    const changes = [{ sponsor: "0x000000000000000000000000000000000000dEaD" }, { resolver: "0x000000000000000000000000000000000000dEaD" }, { chainId: 1 }, { tld: "other" },
      { termStart: 0 }, { codesOnly: true }, { namePolicy: "0x000000000000000000000000000000000000dEaD" }]
    for (const downtime of [false, true]) {
      for (const change of changes) {
        expect(configOf({ stripePublishableKey: null, names: { ...NAMES, ...change, downtime } }), JSON.stringify(change)).toEqual({ stripePublishableKey: "", downtime })
      }
    }
  })
  it("refuses an answer that is not the service's, as a portal's", () => {
    expect(configOf(null)).toBeNull()
    expect(configOf("<!doctype html>")).toBeNull()
    expect(configOf({ type: "not_found" })).toBeNull()
    expect(configOf({ stripePublishableKey: null })).toBeNull()
    expect(configOf({ stripePublishableKey: null, names: "simplex" })).toBeNull()
  })
})

describe("readConfig", () => {
  it("asks GET /api/config with the init given", async () => {
    const fetch = serviceAnswering(200, { stripePublishableKey: null, names: { ...NAMES, downtime: true } })
    expect(await readConfig({ cache: "no-store" })).toEqual({ stripePublishableKey: "", downtime: true })
    expect(fetch).toHaveBeenCalledWith(CONFIG_PATH, { cache: "no-store" })
  })
  it("is null when the service answers an error or the network fails", async () => {
    serviceAnswering(503, { type: "unavailable" })
    expect(await readConfig()).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await readConfig()).toBeNull()
  })
})

describe("loadConfig", () => {
  it("sets the page's Stripe key from the service", async () => {
    serviceAnswering(200, { stripePublishableKey: "pk_test_load", names: NAMES })
    expect(await loadConfig()).toEqual({ stripePublishableKey: "pk_test_load", downtime: false })
    expect(publishableKey()).toBe("pk_test_load")
  })
  it("leaves the page with no card form when the service cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await loadConfig()).toBeNull()
    expect(publishableKey()).toBe("")
  })
})

describe("the deployment the page holds", () => {
  it("is LOCAL outside a production build", () => {
    expect(SITE).toEqual(LOCAL)
  })
  it("holds each terms by the keccak of their link", () => {
    for (const terms of [MAINNET, LOCAL].flatMap((d) => [...d.generalTerms, ...d.communityTerms])) expect(keccak256(toHex(terms.link)), terms.link).toBe(terms.hash)
  })
  it("holds the terms the browser tests switch to, at the links of their texts", () => {
    for (const [held, text] of [[LOCAL.generalTerms[1], ALTERNATE_GENERAL_TERMS], [LOCAL.communityTerms[1], ALTERNATE_COMMUNITY_TERMS]] as const) {
      const digest = createHash("sha256").update(text).digest("hex")
      expect(held.link).toBe(`http://127.0.0.1:8098/terms/${digest}.md#sha256=${digest}`)
    }
  })
})

describe("index.html", () => {
  it("preloads the config before the page's module, as the fetch that reads it asks for it, and carries no setting itself", () => {
    const preload = INDEX.indexOf('<link rel="preload" href="/api/config" as="fetch" crossorigin>')
    expect(preload).toBeGreaterThan(0)
    expect(preload).toBeLessThan(INDEX.indexOf('<script type="module"'))
    expect(INDEX).not.toContain("simplex-names-mode")
    expect(INDEX).not.toContain("stripe-publishable-key")
  })
})
