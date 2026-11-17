import { describe, expect, it } from "vitest"
import { askFor, termsToSign, ticked } from "../src/screens/terms.ts"

const termsOf = (hash: string) => ({ hash: `0x${hash}`, link: `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${"83".repeat(20)}/docs/terms.md#sha256=${"02".repeat(32)}` })
const TERMS = termsOf("21".repeat(32))
const NEWER = termsOf("f6".repeat(32))
const NEWER_COMMUNITY = termsOf("d8".repeat(32))
const BAKERS = { for: "bakers and pastry chefs", years: 2 }
const PLAIN = "21".repeat(32)
const NEWER_PLAIN = "f6".repeat(32)
const SIGNED = `community/${"c7".repeat(32)}`
const NEWER_SIGNED = `community/${"d8".repeat(32)}`

describe("termsToSign", () => {
  it("signs a name again with the terms its order signed while they are the name's now, asking nothing", () => {
    expect(termsToSign("alice1", PLAIN, PLAIN, null)).toBe(PLAIN)
    expect(termsToSign("alice1", SIGNED, SIGNED, null)).toBe(SIGNED)
  })

  it("asks first when the order signed other terms, the general terms of a name now on the community list, a version an older page signed, or none", () => {
    expect(termsToSign("alice1", NEWER_PLAIN, PLAIN, null)).toBeNull()
    expect(termsToSign("alice1", SIGNED, PLAIN, null)).toBeNull()
    expect(termsToSign("alice1", PLAIN, SIGNED, null)).toBeNull()
    expect(termsToSign("alice1", SIGNED, NEWER_SIGNED, null), "other community terms").toBeNull()
    expect(termsToSign("alice1", PLAIN, "2026-10-23", null)).toBeNull()
    expect(termsToSign("alice1", PLAIN, null, null)).toBeNull()
    expect(termsToSign("alice1", PLAIN, undefined, null)).toBeNull()
  })

  it("signs the terms the buyer just ticked while they are the name's now", () => {
    expect(termsToSign("alice1", NEWER_PLAIN, PLAIN, { ...askFor("alice1", NEWER, null, false), agreed: true })).toBe(NEWER_PLAIN)
    expect(termsToSign("alice1", NEWER_SIGNED, null, { ...askFor("alice1", NEWER_COMMUNITY, BAKERS, true), accepted: true })).toBe(NEWER_SIGNED)
  })

  it("asks again for a community name until its own box is ticked, whatever the general terms' box says", () => {
    expect(termsToSign("alice1", NEWER_SIGNED, null, { ...askFor("alice1", NEWER_COMMUNITY, BAKERS, true), agreed: true })).toBeNull()
  })

  it("asks again for another name than the one the buyer ticked the terms for", () => {
    expect(termsToSign("bob123", NEWER_PLAIN, PLAIN, { ...askFor("alice1", NEWER, null, false), agreed: true })).toBeNull()
  })

  it("asks again when the buyer has not ticked, or ticked terms that are no longer the name's", () => {
    expect(termsToSign("alice1", NEWER_PLAIN, PLAIN, askFor("alice1", NEWER, null, false))).toBeNull()
    expect(termsToSign("alice1", NEWER_PLAIN, PLAIN, { ...askFor("alice1", TERMS, null, false), agreed: true })).toBeNull()
    expect(termsToSign("alice1", NEWER_SIGNED, PLAIN, { ...askFor("alice1", NEWER, null, false), agreed: true })).toBeNull()
  })
})

describe("askFor", () => {
  it("asks for the terms and the community entry unticked, saying whether they changed since the page showed them", () => {
    expect(askFor("alice1", NEWER, BAKERS, true)).toEqual({ label: "alice1", terms: NEWER, community: BAKERS, agreed: false, accepted: false, changed: true })
    expect(askFor("alice1", TERMS, null, false)).toEqual({ label: "alice1", terms: TERMS, community: null, agreed: false, accepted: false, changed: false })
  })
})

describe("ticked", () => {
  it("is the general terms' box ticked, or a community name's own box in its place", () => {
    expect(ticked({ agreed: true, accepted: false, community: null })).toBe(true)
    expect(ticked({ agreed: false, accepted: true, community: null })).toBe(false)
    expect(ticked({ agreed: false, accepted: true, community: BAKERS })).toBe(true)
    expect(ticked({ agreed: true, accepted: false, community: BAKERS })).toBe(false)
    expect(ticked({ agreed: true, community: BAKERS })).toBe(false)
  })
})
