import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mountCard, type Theme } from "../src/stripe.ts"

// Stripe's logo tone in an appearance: light on the dark theme, dark on the light one
type Appearance = { variables: { logoColor: string } }

// A Stripe.js whose form loads, or reports `loaderror`, once mounted; it records each appearance the elements are given.
function fakeStripe(loads: boolean) {
  const seen = { created: [] as Appearance[], updates: [] as Appearance[], mounts: 0, destroyed: 0 }
  const element = {
    mount: () => { seen.mounts++ },
    on: (event: string, handler: () => void) => { if (event === (loads ? "ready" : "loaderror")) queueMicrotask(handler) },
    destroy: () => { seen.destroyed++ },
  }
  const Stripe = () => ({
    elements: ({ appearance }: { appearance: Appearance }) => {
      seen.created.push(appearance)
      return { create: () => element, update: ({ appearance: next }: { appearance: Appearance }) => { seen.updates.push(next) } }
    },
    confirmPayment: async () => ({}),
  })
  return { Stripe, seen }
}

// The page's theme as the card form watches it: a test changes it with `set`.
function pageTheme(dark: boolean) {
  const followers = new Set<(dark: boolean) => void>()
  const theme: Theme = {
    dark: () => dark,
    watch: (follow) => {
      followers.add(follow)
      return () => { followers.delete(follow) }
    },
  }
  const set = (next: boolean) => {
    dark = next
    for (const follow of followers) follow(next)
  }
  return { theme, set, followers }
}

// Stripe.js comes from a script tag, which loads at once here
function stubScript(stripe: () => unknown): void {
  vi.stubGlobal("window", { Stripe: stripe })
  vi.stubGlobal("document", {
    readyState: "complete",
    createElement: () => {
      const loaded: (() => void)[] = []
      return { setAttribute: () => undefined, addEventListener: (event: string, handler: () => void) => { if (event === "load") loaded.push(handler) }, loaded }
    },
    head: { append: (tag: { loaded: (() => void)[] }) => queueMicrotask(() => tag.loaded.forEach((handler) => handler())) },
  })
}

const logos = (appearances: Appearance[]) => appearances.map((a) => a.variables.logoColor)
const TARGET = {} as HTMLElement

describe("the card form's theme", () => {
  let stripe: ReturnType<typeof fakeStripe>
  beforeEach(() => {
    stripe = fakeStripe(true)
    // Stripe.js loads once per page, so the global the page keeps calls the fake of the test at hand
    stubScript(() => stripe.Stripe())
  })
  afterEach(() => vi.unstubAllGlobals())

  it("is the page's theme as the form mounts, and follows each change of it in place, never mounting again", async () => {
    const page = pageTheme(true)
    const card = await mountCard("pk_test", "pi_secret", TARGET, page.theme)
    expect(card, "the form loaded").not.toBeNull()
    expect(logos(stripe.seen.created), "made in the dark theme").toEqual(["light"])
    page.set(false)
    page.set(true)
    expect(logos(stripe.seen.updates), "the light theme, then the dark one").toEqual(["dark", "light"])
    expect(stripe.seen.mounts, "mounted once").toBe(1)
    card!.destroy()
    expect(page.followers.size, "the theme no longer watched once the form is gone").toBe(0)
    page.set(false)
    expect(logos(stripe.seen.updates), "nothing updated after destroy").toEqual(["dark", "light"])
    expect(stripe.seen.destroyed).toBe(1)
  })

  it("stops watching the theme when the form fails to load", async () => {
    stripe = fakeStripe(false)
    const page = pageTheme(false)
    expect(await mountCard("pk_test", "pi_secret", TARGET, page.theme)).toBeNull()
    expect(page.followers.size, "nothing left watching the theme").toBe(0)
    page.set(true)
    expect(stripe.seen.updates).toEqual([])
  })
})
