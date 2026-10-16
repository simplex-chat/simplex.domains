import { describe, expect, it } from "vitest"
import { clock, dateOf, dollars, letters, methodName, seconds, shortAddress, termText, untilFromNow } from "../src/format.ts"
import { foldLabel, labelProblem, linkKind, linkProblem, LINK_MAX_BYTES, priceFor } from "../src/names.ts"

describe("label rules", () => {
  it("folds case and spaces, and accepts 6 to 63 letters with single inner hyphens", () => {
    expect(foldLabel("  Bakery ")).toBe("bakery")
    expect(foldLabel("Bakery.SimpleX")).toBe("bakery")
    expect(labelProblem(foldLabel("bak.ery"))).toBe("chars")
    expect(labelProblem("bakery")).toBeNull()
    expect(labelProblem("bak-ery-2")).toBeNull()
    expect(labelProblem("a".repeat(63))).toBeNull()
  })

  it("names each problem", () => {
    expect(labelProblem("abcde")).toBe("short")
    expect(labelProblem("a".repeat(64))).toBe("long")
    expect(labelProblem("-bakery")).toBe("chars")
    expect(labelProblem("bakery-")).toBe("chars")
    expect(labelProblem("bak--ery")).toBe("chars")
    expect(labelProblem("bäkery")).toBe("chars")
    expect(labelProblem("Bakery")).toBe("chars")
  })
})

describe("link rules", () => {
  const contact = "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS"
  const channel = "simplex:/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm?v=1"

  it("accepts one short link of the field's kind", () => {
    expect(linkProblem("contact", contact)).toBeNull()
    expect(linkProblem("channel", channel)).toBeNull()
    expect(linkKind(contact)).toBe("contact")
    expect(linkKind(channel)).toBe("channel")
  })

  it("refuses the other kind, full links, two links and oversized links", () => {
    expect(linkProblem("channel", contact)).toBe("kind")
    expect(linkProblem("contact", "https://simplex.chat/contact#/?v=2&smp=smp%3A%2F%2Fabc")).toBe("kind")
    expect(linkProblem("contact", `${contact};${contact}`)).toBe("kind")
    expect(linkProblem("contact", `${contact}?x=${"a".repeat(LINK_MAX_BYTES)}`)).toBe("long")
    expect(linkKind("hello")).toBeNull()
  })
})

describe("prices", () => {
  it("prices a code's term at the search's rate for its own term, to the cent", () => {
    expect(priceFor(10000, 2)).toBe(10000)
    expect(priceFor(10000, 5)).toBe(25000)
    expect(priceFor(40000, 3, 2)).toBe(60000)
    expect(priceFor(10001, 5)).toBe(25003)
  })
})

describe("formatting", () => {
  it("writes cents as dollars", () => {
    expect(dollars(40000)).toBe("$400")
    expect(dollars(10050, true)).toBe("$100.50")
  })

  it("shortens an address and writes a UTC date", () => {
    expect(shortAddress("0x014f9c09CcEeDEF1B713110d04D3a07d5B5D9b73")).toBe("0x014f\u2060…\u20609b73")
    expect([letters(1), letters(7)]).toEqual(["1 letter", "7 letters"])
    expect(dateOf(Date.UTC(2028, 10, 12) / 1000)).toBe("12\u00a0November 2028")
    expect(dateOf(Date.UTC(2028, 10, 12) / 1000, true)).toBe("12\u00a0Nov 2028")
  })

  it("counts the term with its 30 bonus days", () => {
    const now = Math.floor(Date.now() / 1000)
    expect(untilFromNow(2) - now).toBeGreaterThanOrEqual((2 * 365 + 30) * 86400 - 1)
    expect(untilFromNow(2) - now).toBeLessThanOrEqual((2 * 365 + 30) * 86400 + 1)
    expect(termText(5)).toBe("5 years + 30 days")
  })

  it("writes seconds in the singular and the plural", () => {
    expect(seconds(1)).toBe("1 second")
    expect(seconds(30)).toBe("30 seconds")
  })

  it("writes a countdown that never goes negative, and method names", () => {
    expect(clock(65.9)).toBe("1:05")
    expect(clock(-3)).toBe("0:00")
    expect(methodName("xmr")).toBe("Monero")
    expect(methodName("code")).toBe("Code")
  })
})
