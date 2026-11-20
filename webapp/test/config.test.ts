import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CONFIG_PATH, configOf, loadConfig, readConfig } from "../src/config.ts"
import { codesOnly, pageMode, setPageMode } from "../src/mode.ts"
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
  setPageMode("open")
  setPublishableKey("")
})

describe("configOf", () => {
  it("reads the service's answer with and without a key and a names deployment", () => {
    expect(configOf({ stripePublishableKey: "pk_test_x", names: { ...NAMES, codesOnly: true } })).toEqual({ stripePublishableKey: "pk_test_x", names: { ...NAMES, codesOnly: true } })
    expect(configOf({ stripePublishableKey: null, names: NAMES })).toEqual({ stripePublishableKey: "", names: NAMES })
    expect(configOf({ stripePublishableKey: " pk_test_y\n", names: null })).toEqual({ stripePublishableKey: "pk_test_y", names: null })
  })
  it("refuses an answer that is not the service's, as a portal's, or a deployment it cannot use", () => {
    expect(configOf(null)).toBeNull()
    expect(configOf("<!doctype html>")).toBeNull()
    expect(configOf({ type: "not_found" })).toBeNull()
    expect(configOf({ stripePublishableKey: null })).toBeNull()
    for (const change of [{ codesOnly: "no" }, { chainId: -1 }, { chainId: "1" }, { resolver: 1 }, { sponsor: null }, { tld: undefined }, { termStart: 1.5 }]) {
      expect(configOf({ stripePublishableKey: null, names: { ...NAMES, ...change } }), JSON.stringify(change)).toBeNull()
    }
  })
})

describe("readConfig", () => {
  it("asks GET /api/config with the init given", async () => {
    const fetch = serviceAnswering(200, { stripePublishableKey: null, names: { ...NAMES, codesOnly: true } })
    expect(await readConfig({ cache: "no-store" })).toEqual({ stripePublishableKey: "", names: { ...NAMES, codesOnly: true } })
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
  it("sets the page's mode and Stripe key from the service", async () => {
    serviceAnswering(200, { stripePublishableKey: "pk_test_load", names: { ...NAMES, codesOnly: true } })
    await loadConfig()
    expect([pageMode(), codesOnly(), publishableKey()]).toEqual(["codes", true, "pk_test_load"])
  })
  it("leaves the page open with no card form when the service cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    await loadConfig()
    expect([pageMode(), codesOnly(), publishableKey()]).toEqual(["open", false, ""])
  })
})

describe("namesSite", () => {
  it("reads the deployment again when the load could not, with the page's mode and Stripe key, and asks no more once it has it", async () => {
    vi.resetModules()
    const config = await import("../src/config.ts")
    const mode = await import("../src/mode.ts")
    const stripe = await import("../src/stripe.ts")
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    await config.loadConfig()
    expect(config.loadedSite()).toBeNull()
    expect(() => config.readSite()).toThrow()
    await expect(config.namesSite()).rejects.toMatchObject({ code: "network" })
    expect([mode.pageMode(), stripe.publishableKey()]).toEqual(["open", ""])
    const codes = { ...NAMES, codesOnly: true }
    const fetch = serviceAnswering(200, { stripePublishableKey: "pk_test_again", names: codes })
    expect(await config.namesSite()).toEqual(codes)
    expect(await config.namesSite()).toEqual(codes)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(config.readSite()).toEqual(codes)
    expect([mode.pageMode(), stripe.publishableKey()]).toEqual(["codes", "pk_test_again"])
  })
  it("refuses a service that sells no names", async () => {
    vi.resetModules()
    const config = await import("../src/config.ts")
    serviceAnswering(200, { stripePublishableKey: null, names: null })
    await expect(config.namesSite()).rejects.toMatchObject({ code: "network" })
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
