import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { ed25519 } from "@noble/curves/ed25519"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak256, toHex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ALTERNATE_COMMUNITY_TERMS, ALTERNATE_GENERAL_TERMS } from "../e2e/terms.ts"
import { CONFIG_PATH, configOf, heldPrice, LOCAL, MAINNET, readConfig, SITE } from "../src/config.ts"
import { moneroKeys } from "../src/crypto/payees.ts"

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
})

describe("configOf", () => {
  it("reads the service's downtime", () => {
    expect(configOf({ stripePublishableKey: null, names: { ...NAMES, downtime: true } })).toEqual({ downtime: true })
    expect(configOf({ stripePublishableKey: null, names: { ...NAMES, downtime: false } })).toEqual({ downtime: false })
    expect(configOf({ stripePublishableKey: null, names: null })).toEqual({ downtime: false })
    expect(configOf({ stripePublishableKey: null, names: NAMES }), "a service from before the downtime").toEqual({ downtime: false })
    expect(configOf({ names: { downtime: true } }), "an answer without the badge page's Stripe key").toEqual({ downtime: true })
  })
  it("takes nothing else the service answers: with another sponsor, resolver, chain, TLD, term, mode or Stripe key, only the downtime differs", () => {
    const changes = [{ sponsor: "0x000000000000000000000000000000000000dEaD" }, { resolver: "0x000000000000000000000000000000000000dEaD" }, { chainId: 1 }, { tld: "other" },
      { termStart: 0 }, { codesOnly: true }, { namePolicy: "0x000000000000000000000000000000000000dEaD" }]
    for (const downtime of [false, true]) {
      for (const change of changes) expect(configOf({ stripePublishableKey: null, names: { ...NAMES, ...change, downtime } }), JSON.stringify(change)).toEqual({ downtime })
      expect(configOf({ stripePublishableKey: "pk_live_other", names: { ...NAMES, downtime } }), "another Stripe key").toEqual({ downtime })
    }
  })
  it("refuses an answer that is not the service's, as a portal's", () => {
    expect(configOf(null)).toBeNull()
    expect(configOf("<!doctype html>")).toBeNull()
    expect(configOf({ type: "not_found" })).toBeNull()
    expect(configOf({ stripePublishableKey: null })).toBeNull()
    expect(configOf({ stripePublishableKey: null, names: "simplex" })).toBeNull()
    expect(configOf({ stripePublishableKey: null, names: [{ downtime: true }] })).toBeNull()
  })
})

describe("readConfig", () => {
  it("asks GET /api/config with the init given", async () => {
    const fetch = serviceAnswering(200, { stripePublishableKey: null, names: { ...NAMES, downtime: true } })
    expect(await readConfig({ cache: "no-store" })).toEqual({ downtime: true })
    expect(fetch).toHaveBeenCalledWith(CONFIG_PATH, { cache: "no-store" })
  })
  it("is null when the service answers an error or the network fails", async () => {
    serviceAnswering(503, { type: "unavailable" })
    expect(await readConfig()).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await readConfig()).toBeNull()
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
  it("prices a name for its paid years at the exception of its length, else at the base, as the price oracle does", () => {
    expect([6, 7, 8, 63].map(heldPrice)).toEqual([40000, 20000, 10000, 10000])
    expect([MAINNET.priceBaseCentsPerYear * MAINNET.paidYears, MAINNET.priceExceptions], "mainnet: $100 for every name").toEqual([10000, []])
  })
  it("holds the card page's origin and the names page's, in production on https, and a test key in no build but a dev one", () => {
    expect([MAINNET.cardOrigin, MAINNET.pageOrigins, MAINNET.stripeLive]).toEqual(["https://pay.simplex.domains", ["https://simplex.domains"], true])
    expect(MAINNET.stripeKey === "" || MAINNET.stripeKey.startsWith("pk_live_"), "a live key, once set").toBe(true)
    expect([new URL(LOCAL.cardOrigin).hostname, LOCAL.stripeKey, LOCAL.stripeLive]).toEqual(["127.0.0.1", "", false])
    for (const origin of [...MAINNET.pageOrigins, ...LOCAL.pageOrigins]) expect(new URL(origin).origin, origin).toBe(origin)
  })
  it("takes payments in production only with a live Stripe key and the keys of both coins' wallets", () => {
    expect(MAINNET.codesOnly || (MAINNET.stripeKey.startsWith("pk_live_") && MAINNET.bitcoinReceiveKeys.length > 0 && MAINNET.moneroPrimaryAddresses.length > 0)).toBe(true)
  })
  it("holds each payee key as a public key of its curve: a compressed Bitcoin key, and a Monero primary address of its network", () => {
    for (const [d, primaryPrefix, subaddressPrefix, hrp] of [[MAINNET, 18, 42, "bc"], [LOCAL, 24, 36, "bcrt"]] as const) {
      expect([d.currency, d.bitcoinHrp, d.moneroSubaddressPrefix]).toEqual(["usd", hrp, subaddressPrefix])
      for (const key of d.bitcoinReceiveKeys) {
        expect(key).toMatch(/^0x0[23][0-9a-f]{64}$/)
        expect(() => secp256k1.Point.fromHex(key.slice(2)), key).not.toThrow()
      }
      for (const address of d.moneroPrimaryAddresses) {
        const keys = moneroKeys(address)
        expect(keys?.prefix, address).toBe(primaryPrefix)
        for (const key of [keys!.spend, keys!.view]) expect(ed25519.Point.fromBytes(key).isTorsionFree(), address).toBe(true)
      }
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
