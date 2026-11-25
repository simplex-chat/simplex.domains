import { fileURLToPath } from "node:url"
import { build, type Rollup } from "vite"
import { describe, expect, it } from "vitest"
import { type Deployment, LOCAL, MAINNET } from "../src/config.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const STAND_IN_LABEL = "Test card form: no Stripe key is set, so Pay simulates a payment."
const STRIPE_NOTE = "The card form is Stripe's. Nothing is charged until you pay."
const BUILD_MS = 120_000

// the JavaScript a build of the page ships, in the mode given
async function shipped(mode: "development" | "production" | "devchain"): Promise<string> {
  const env = process.env.NODE_ENV
  // Vite takes NODE_ENV over the mode, and vitest's "test" would build development code
  process.env.NODE_ENV = mode === "development" ? mode : "production"
  try {
    const outputs = await build({ root: ROOT, mode, logLevel: "silent", build: { write: false } }) as Rollup.RollupOutput | Rollup.RollupOutput[]
    return [outputs].flat().flatMap((o) => o.output).map((file) => file.type === "chunk" ? file.code : "").join("\n")
  } finally {
    process.env.NODE_ENV = env
  }
}

const held = (d: Deployment) => [d.sponsor, d.resolver, d.namePolicy]

describe("the stand-in card form", () => {
  it("is labelled as a test in a development build, which the dev server serves", async () => {
    expect(await shipped("development")).toContain(STAND_IN_LABEL)
  }, BUILD_MS)

  it("never ships in a production build, which has the card page", async () => {
    const code = await shipped("production")
    expect(code, "the card page is in the build").toContain(STRIPE_NOTE)
    expect(code).not.toContain(STAND_IN_LABEL)
    expect(code).not.toContain("Pay simulates a payment")
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
