import { describe, expect, it } from "vitest"
import {
  activeCode, checkout as tabCheckout, dropActiveCode, isSending, scrolled, setActiveCode, setCheckout, setScrolled,
  startSending, stopSending, type Checkout,
} from "../src/session.ts"

const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const TERMS = { hash: `0x${"21".repeat(32)}`, link: `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${"83".repeat(20)}/docs/general-terms.md#sha256=${"02".repeat(32)}` }

function checkout(label: string, ownerCode: string | null): Checkout {
  return { label, price: 10000, years: 2, termStart: Date.UTC(2027, 0, 1) / 1000, chain: CHAIN, terms: TERMS, community: null, contact: "", channel: "", method: "btc", code: null, ownerCode, saved: false, agreed: false, searchAt: 0, step: "code" }
}

describe("orders on their way", () => {
  it("holds each checkout until its own order is answered, whatever finishes first", () => {
    const alpha = checkout("alphaname", "SN-AAAAA")
    const beta = checkout("betaname", "SN-BBBBB")
    startSending(alpha)
    startSending(beta)
    stopSending(alpha)
    expect(isSending(alpha)).toBe(false)
    expect(isSending(beta)).toBe(true)
    stopSending(beta)
    expect(isSending(beta)).toBe(false)
  })

  it("tells apart checkouts of one name by their owner code", () => {
    startSending(checkout("samename", "SN-AAAAA"))
    expect(isSending(checkout("samename", "SN-AAAAA"))).toBe(true)
    expect(isSending(checkout("samename", "SN-CCCCC"))).toBe(false)
    expect(isSending(checkout("samename", null))).toBe(false)
    stopSending(checkout("samename", "SN-AAAAA"))
  })
})

describe("scroll places", () => {
  it("writes each history entry's place on its own, keeping the others", () => {
    setScrolled(0, 120)
    setScrolled(3, 40)
    expect(scrolled()).toEqual({ 0: 120, 3: 40 })
    setScrolled(0, 0)
    expect(scrolled()).toEqual({ 0: 0, 3: 40 })
  })
})

describe("the tab's checkout", () => {
  it("one kept before the step was kept opens at the review, which sends it on to the step it is at", () => {
    const { step: _, ...older } = checkout("oldername", "SN-AAAAA")
    setCheckout(older as Checkout)
    expect(tabCheckout()).toEqual({ ...older, step: "review" })
    setCheckout(checkout("newername", "SN-BBBBB"))
    expect(tabCheckout()!.step).toBe("code")
    const { terms: ___, ...unagreeable } = checkout("noterms", "SN-AAAAA")
    setCheckout(unagreeable as Checkout)
    expect(tabCheckout(), "one kept before terms has nothing to ask the buyer to agree to, so it is a leftover").toBeNull()
    setCheckout({ ...checkout("versioned", "SN-AAAAA"), terms: { version: "2026-10-23", url: "https://simplex.chat/" } } as never)
    expect(tabCheckout(), "one kept with the terms version an older page kept is a leftover").toBeNull()
    setCheckout(null)
    expect(tabCheckout()).toBeNull()
  })
})

describe("the tab's active code", () => {
  it("is none until one is chosen, keeps the one chosen last, and is none again once taken off", () => {
    expect(activeCode()).toBeNull()
    setActiveCode({ display: "SN8-AAAAA", minLength: 8, years: 5 })
    setActiveCode({ display: "SN6-BBBBB", minLength: 6, years: 2 })
    expect(activeCode()).toEqual({ display: "SN6-BBBBB", minLength: 6, years: 2 })
    setActiveCode(null)
    expect(activeCode()).toBeNull()
  })
  it("is dropped for a code an order took only while it is that code, not one chosen since", () => {
    setActiveCode({ display: "SN6-BBBBB", minLength: 6, years: 2 })
    dropActiveCode("SN8-AAAAA")
    expect(activeCode(), "another code chosen since stays").toEqual({ display: "SN6-BBBBB", minLength: 6, years: 2 })
    dropActiveCode("SN6-BBBBB")
    expect(activeCode()).toBeNull()
  })
})
