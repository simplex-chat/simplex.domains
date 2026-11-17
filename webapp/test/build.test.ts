import { fileURLToPath } from "node:url"
import { build, type Rollup } from "vite"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const STAND_IN_LABEL = "Test card form: no Stripe key is set, so Pay simulates a payment."
const STRIPE_NOTE = "The card form is Stripe's. Nothing is charged until you pay."
const BUILD_MS = 120_000

// the JavaScript a build of the page ships, in the mode given
async function shipped(mode: "development" | "production"): Promise<string> {
  const env = process.env.NODE_ENV
  // Vite takes NODE_ENV over the mode, and vitest's "test" would build development code
  process.env.NODE_ENV = mode
  try {
    const outputs = await build({ root: ROOT, mode, logLevel: "silent", build: { write: false } }) as Rollup.RollupOutput | Rollup.RollupOutput[]
    return [outputs].flat().flatMap((o) => o.output).map((file) => file.type === "chunk" ? file.code : "").join("\n")
  } finally {
    process.env.NODE_ENV = env
  }
}

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
