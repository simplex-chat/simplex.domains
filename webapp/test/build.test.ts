import { createHash } from "node:crypto"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build, type Rollup } from "vite"
import { describe, expect, it } from "vitest"
import { type Deployment, LOCAL, MAINNET } from "../src/config.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const STAND_IN_LABEL = "Test card form: no Stripe key is set, so Pay simulates a payment."
const STRIPE_NOTE = "The card form is provided by Stripe. Your card will be charged only when you press Pay."
const BUILD_MS = 120_000

// the JavaScript a build of the names page, or of the card page, ships, in the mode given
async function shipped(mode: "development" | "production" | "devchain", configFile?: string): Promise<string> {
  const env = process.env.NODE_ENV
  // Vite takes NODE_ENV over the mode, and vitest's "test" would build development code
  process.env.NODE_ENV = mode === "development" ? mode : "production"
  try {
    const outputs = await build({ ...configFile ? { configFile } : { root: ROOT }, mode, logLevel: "silent", build: { write: false } }) as Rollup.RollupOutput | Rollup.RollupOutput[]
    return [outputs].flat().flatMap((o) => o.output).map((file) => file.type === "chunk" ? file.code : "").join("\n")
  } finally {
    process.env.NODE_ENV = env
  }
}
const CARD_CONFIG = join(ROOT, "card", "vite.config.ts")

async function pageOf(mode: "production" | "devchain"): Promise<string> {
  const env = process.env.NODE_ENV
  process.env.NODE_ENV = "production"
  try {
    const outputs = await build({ root: ROOT, mode, logLevel: "silent", build: { write: false } }) as Rollup.RollupOutput | Rollup.RollupOutput[]
    const page = [outputs].flat().flatMap((o) => o.output).find((file) => file.fileName === "index.html")!
    return page.type === "asset" ? String(page.source) : ""
  } finally {
    process.env.NODE_ENV = env
  }
}
const inlineHashes = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`)
const policyIn = (html: string) => /<head>\s*<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1] ?? null

describe("the page's own policy", () => {
  it("is the first element of a production build's head: the API's and the card page's origins, and the hashes of its inline scripts", async () => {
    const html = await pageOf("production")
    const policy = policyIn(html)
    expect(policy, "a meta element first in the head").not.toBeNull()
    expect(policy).toContain(`frame-src ${MAINNET.cardOrigin};`)
    expect(policy).toContain(`connect-src 'self' ${MAINNET.apiOrigin};`)
    expect(policy).not.toContain("stripe")
    const hashes = inlineHashes(html)
    expect(hashes.length, "the inline scripts").toBeGreaterThan(0)
    for (const hash of hashes) expect(policy).toContain(hash)
    expect(html).toContain('<meta name="referrer" content="strict-origin-when-cross-origin">')
    expect(html).toContain(`<link rel="preload" href="${MAINNET.apiOrigin}/api/config"`)
  }, BUILD_MS)

  it("asks the page's own origin in a build for the dev chain, through Vite's proxy", async () => {
    const html = await pageOf("devchain")
    expect(policyIn(html)).toContain(`frame-src ${LOCAL.cardOrigin}; connect-src 'self';`)
    expect(html).toContain('<link rel="preload" href="/api/config"')
  }, BUILD_MS)
})

const held = (d: Deployment) => [d.sponsor, d.resolver, d.namePolicy, d.baseRegistrar, ...[...d.generalTerms, ...d.communityTerms].map((t) => t.link), ...d.bitcoinReceiveKeys, ...d.moneroPrimaryAddresses,
  d.cardOrigin, ...d.apiOrigin ? [d.apiOrigin] : []]

describe("the card form", () => {
  it("is the card page's, which loads Stripe.js; the names page frames it from the card page's origin and never loads Stripe.js", async () => {
    const names = await shipped("production")
    expect(names, "Stripe's note under Pay").toContain(STRIPE_NOTE)
    expect(names).toContain(MAINNET.cardOrigin)
    expect(names).not.toContain("js.stripe.com")
    expect(await shipped("devchain", CARD_CONFIG), "a card page with a key to mount with").toContain("https://js.stripe.com/")
  }, BUILD_MS)

  it("has a stand-in labelled as a test in the card page's development build, which the dev server serves, and in no other build", async () => {
    expect(await shipped("development", CARD_CONFIG)).toContain(STAND_IN_LABEL)
    for (const config of [undefined, CARD_CONFIG]) {
      const code = await shipped("production", config)
      expect(code).not.toContain(STAND_IN_LABEL)
      expect(code).not.toContain("Pay simulates a payment")
    }
  }, BUILD_MS)

  it("takes a test key from the browser only in a card page built for the dev chain", async () => {
    expect(await shipped("production", CARD_CONFIG)).not.toContain("stripeTestKey")
    expect(await shipped("devchain", CARD_CONFIG)).toContain("stripeTestKey")
  }, BUILD_MS)
})

describe("the deployment a build holds", () => {
  it("is MAINNET alone in a production build", async () => {
    const code = await shipped("production")
    for (const value of held(MAINNET)) expect(code, "MAINNET's").toContain(value)
    for (const value of held(LOCAL)) expect(code, "LOCAL's").not.toContain(value)
  }, BUILD_MS)

  it("is LOCAL in a build for the dev chain", async () => {
    const code = await shipped("devchain")
    for (const value of held(LOCAL)) expect(code, "LOCAL's").toContain(value)
    for (const value of held(MAINNET)) expect(code, "MAINNET's").not.toContain(value)
  }, BUILD_MS)
})
