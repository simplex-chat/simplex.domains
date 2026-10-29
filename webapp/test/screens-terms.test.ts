import { describe, expect, it } from "vitest"
import { askFor, termsToSign } from "../src/screens/terms.ts"

const TERMS = { version: "2026-10-23", url: "https://simplex.chat/" }
const NEWER = { version: "2026-11-01", url: "https://simplex.chat/" }
const BAKERS = { for: "bakers and pastry chefs" }

describe("termsToSign", () => {
  it("signs a name again with the terms its order signed while they are the name's now, asking nothing", () => {
    expect(termsToSign("alice1", "2026-10-23", "2026-10-23", null)).toBe("2026-10-23")
    expect(termsToSign("alice1", "2026-10-23/community", "2026-10-23/community", null)).toBe("2026-10-23/community")
  })

  it("asks first when the order signed an older version, the plain terms of a name now on the community list, or none", () => {
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", null)).toBeNull()
    expect(termsToSign("alice1", "2026-10-23/community", "2026-10-23", null)).toBeNull()
    expect(termsToSign("alice1", "2026-10-23", "2026-10-23/community", null)).toBeNull()
    expect(termsToSign("alice1", "2026-10-23", null, null)).toBeNull()
    expect(termsToSign("alice1", "2026-10-23", undefined, null)).toBeNull()
  })

  it("signs the terms the buyer just ticked while they are the name's now", () => {
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", { ...askFor("alice1", NEWER, null, false), agreed: true })).toBe("2026-11-01")
    expect(termsToSign("alice1", "2026-11-01/community", null, { ...askFor("alice1", NEWER, BAKERS, true), agreed: true })).toBe("2026-11-01/community")
  })

  it("asks again for another name than the one the buyer ticked the terms for", () => {
    expect(termsToSign("bob123", "2026-11-01", "2026-10-23", { ...askFor("alice1", NEWER, null, false), agreed: true })).toBeNull()
  })

  it("asks again when the buyer has not ticked, or ticked terms that are no longer the name's", () => {
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", askFor("alice1", NEWER, null, false))).toBeNull()
    expect(termsToSign("alice1", "2026-11-01", "2026-10-23", { ...askFor("alice1", TERMS, null, false), agreed: true })).toBeNull()
    expect(termsToSign("alice1", "2026-11-01/community", "2026-10-23", { ...askFor("alice1", NEWER, null, false), agreed: true })).toBeNull()
  })
})

describe("askFor", () => {
  it("asks for the terms and the community entry unticked, saying whether they changed since the page showed them", () => {
    expect(askFor("alice1", NEWER, BAKERS, true)).toEqual({ label: "alice1", terms: NEWER, community: BAKERS, agreed: false, changed: true })
    expect(askFor("alice1", TERMS, null, false)).toEqual({ label: "alice1", terms: TERMS, community: null, agreed: false, changed: false })
  })
})
