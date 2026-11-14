import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CONFIG_PATH, configOf, loadConfig, readConfig } from "../src/config.ts"
import { codesOnly, modeOf, pageMode, setPageMode } from "../src/mode.ts"
import { publishableKey, setPublishableKey } from "../src/stripe.ts"

const INDEX = readFileSync(new URL("../index.html", import.meta.url), "utf8")

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

describe("modeOf", () => {
  it("reads codes only from the word codes", () => {
    expect(modeOf("codes")).toBe("codes")
  })
  it("reads open from open, anything else and nothing", () => {
    expect(modeOf("open")).toBe("open")
    expect(modeOf("")).toBe("open")
    expect(modeOf(null)).toBe("open")
    expect(modeOf(undefined)).toBe("open")
    expect(modeOf("Codes"), "the service writes the word in lower case").toBe("open")
    expect(modeOf(" codes"), "the service sends the word alone").toBe("open")
  })
})

describe("configOf", () => {
  it("reads the service's answer in each mode, with and without a key", () => {
    expect(configOf({ mode: "codes", stripePublishableKey: "pk_test_x" })).toEqual({ mode: "codes", stripePublishableKey: "pk_test_x" })
    expect(configOf({ mode: "open", stripePublishableKey: null })).toEqual({ mode: "open", stripePublishableKey: "" })
    expect(configOf({ mode: "open", stripePublishableKey: " pk_test_y\n" })).toEqual({ mode: "open", stripePublishableKey: "pk_test_y" })
  })
  it("refuses an answer that is not the service's, as a portal's", () => {
    expect(configOf(null)).toBeNull()
    expect(configOf("<!doctype html>")).toBeNull()
    expect(configOf({ error: "not_found" })).toBeNull()
  })
})

describe("readConfig", () => {
  it("asks GET /api/config with the init given", async () => {
    const fetch = serviceAnswering(200, { mode: "codes", stripePublishableKey: null })
    expect(await readConfig({ cache: "no-store" })).toEqual({ mode: "codes", stripePublishableKey: "" })
    expect(fetch).toHaveBeenCalledWith(CONFIG_PATH, { cache: "no-store" })
  })
  it("is null when the service answers an error or the network fails", async () => {
    serviceAnswering(503, { error: "unavailable" })
    expect(await readConfig()).toBeNull()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await readConfig()).toBeNull()
  })
})

describe("loadConfig", () => {
  it("sets the page's mode and Stripe key from the service", async () => {
    serviceAnswering(200, { mode: "codes", stripePublishableKey: "pk_test_load" })
    await loadConfig()
    expect([pageMode(), codesOnly(), publishableKey()]).toEqual(["codes", true, "pk_test_load"])
  })
  it("leaves the page open with no card form when the service cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    await loadConfig()
    expect([pageMode(), codesOnly(), publishableKey()]).toEqual(["open", false, ""])
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
