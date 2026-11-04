import { describe, expect, it } from "vitest"
import { bonusDays, bonusHint, clock, dateOf, dollars, freeDays, letters, methodName, seconds, shortAddress, termEnd, timeOf } from "../src/format.ts"
import { deepLinkOf } from "../dev/mock/links.ts"
import { foldLabel, labelProblem, linkKind, linkProblem, LINK_MAX_BYTES, linkTooLong } from "../src/names.ts"

describe("label rules", () => {
  it("folds case and spaces, and accepts 6 to 63 letters with single inner hyphens", () => {
    expect(foldLabel("  Bakery ")).toBe("bakery")
    expect(foldLabel("Bakery.SimpleX")).toBe("bakery")
    expect(foldLabel("bak\u200Bery\uFEFF")).toBe("bakery")
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

  it("accepts a link of several servers, their hosts joined by an escaped comma, and no other escape", () => {
    const hosts = "smp4.simplex.im%2Co5vmywmrnaxalvz6wi3zicyftgio6psuvyniis6gco6bp6ekl4cqj4id.onion"
    const multi = `simplex:/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS?h=${hosts}&p=5223&c=1234-w`
    expect(linkKind(multi)).toBe("contact")
    expect(linkKind(`https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2Jk4Lm?h=${hosts}`)).toBe("channel")
    expect(linkKind(multi.replace("%2C", ","))).toBeNull()
    expect(linkKind(multi.replace("%2C", "%2F"))).toBeNull()
  })

  it("refuses the other kind, full links, two links and oversized links", () => {
    expect(linkProblem("channel", contact)).toBe("kind")
    expect(linkProblem("contact", "https://simplex.chat/contact#/?v=2&smp=smp%3A%2F%2Fabc")).toBe("kind")
    expect(linkProblem("contact", `${contact};${contact}`)).toBe("kind")
    expect(linkProblem("contact", `${contact}?x=${"a".repeat(LINK_MAX_BYTES)}`)).toBe("long")
    expect(linkKind("hello")).toBeNull()
  })

  it("tells a link too long by its bytes, whatever its kind, so a link of no kind can be refused for its length", () => {
    const long = `${contact}?x=${"a".repeat(LINK_MAX_BYTES)}`
    expect(linkKind(long)).toBeNull()
    expect(linkTooLong(long)).toBe(true)
    expect(linkTooLong(`${contact}?x=${"\u00e9".repeat(LINK_MAX_BYTES / 2)}`), "two bytes a letter").toBe(true)
    expect(linkTooLong(contact)).toBe(false)
  })
})

describe("the mock's deep link", () => {
  const key = "wg3qTYdrW4-woYFLQwFwMM6m1KwwstmucbQE0vq6SbU"
  const onion = "o5vmywmrnaxalvz6wi3zicyftgio6psuvyniis6gco6bp6ekl4cqj4id.onion"

  it("keeps the server as the chat core writes it, so the app can open the link", () => {
    expect(deepLinkOf(`https://smp8.simplex.im/a#${key}`)).toBe(`simplex:/a#${key}?h=smp8.simplex.im`)
    expect(deepLinkOf(`https://smp9.simplex.im/c#${key}`)).toBe(`simplex:/c#${key}?h=smp9.simplex.im`)
  })

  it("puts the link's host before its other hosts, then its port and key hash, and passes a page-accepted link", () => {
    const deep = `simplex:/a#${key}?h=smp4.simplex.im%2C${onion}&p=5223&c=1234-w`
    expect(deepLinkOf(`https://smp4.simplex.im/a#${key}?c=1234-w&h=${onion}&p=5223`)).toBe(deep)
    expect(linkKind(deep)).toBe("contact")
    expect(deepLinkOf(deep), "a simplex:/ link is in that form already").toBe(deep)
  })

  it("is null for a link the chat core cannot parse", () => {
    expect(deepLinkOf("https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7pQ9rS"), "a stray last character").toBeNull()
    expect(deepLinkOf(`https://smp8.simplex.im/a#${key.slice(0, 41)}`), "a length no bytes encode to").toBeNull()
    expect(deepLinkOf(`simplex:/a#${key}`), "a simplex:/ link without its server").toBeNull()
    expect(deepLinkOf(`https://smp8.simplex.im/x#${key}`), "neither a contact address nor a channel").toBeNull()
  })
})

describe("formatting", () => {
  it("writes cents as dollars, with cents only where an amount has them", () => {
    expect(dollars(40000)).toBe("$400")
    expect(dollars(10050)).toBe("$100.50")
    expect(dollars(10005)).toBe("$100.05")
    expect(dollars(123456700)).toBe("$1,234,567")
  })

  it("shortens an address and writes a UTC date", () => {
    expect(shortAddress("0x014f9c09CcEeDEF1B713110d04D3a07d5B5D9b73")).toBe("0x014f\u2060…\u20609b73")
    expect([letters(1), letters(7)]).toEqual(["1 letter", "7 letters"])
    expect(dateOf(Date.UTC(2028, 10, 12) / 1000)).toBe("12\u00a0November 2028")
  })

  const TERM_START = Date.UTC(2027, 0, 1) / 1000

  it("counts the free days to the term's start, a part day as a whole one, and none once it has started", () => {
    const day = 86400
    expect(freeDays(TERM_START, Date.UTC(2026, 9, 21) / 1000)).toBe(72)
    expect(freeDays(TERM_START, TERM_START - day / 2)).toBe(1)
    expect([freeDays(TERM_START, TERM_START), freeDays(TERM_START, TERM_START + 5 * day)]).toEqual([0, 0])
  })

  it("writes the free days that follow the term's years, a single day in the singular", () => {
    expect(`2 years ${bonusDays(72)}`).toBe("2 years and 72 days")
    expect(`5 years ${bonusDays(1)}`).toBe("5 years and 1 day")
  })

  it("explains the free days by the date the paid years start, as the order has it", () => {
    expect(bonusHint(2, TERM_START)).toBe("Early adopter bonus: your 2 years start on 1\u00a0January 2027.")
    expect(bonusHint(5, Date.UTC(2027, 2, 15) / 1000)).toBe("Early adopter bonus: your 5 years start on 15\u00a0March 2027.")
  })

  it("writes a time of day in 24 hours, its hour and minute in two digits", () => {
    const at = new Date(2026, 9, 22, 9, 5, 59).getTime()
    expect(timeOf(at)).toBe("09:05")
    expect(timeOf(new Date(2026, 9, 22, 22, 47).getTime())).toBe("22:47")
  })

  it("ends a term its years of 365 days after its start, or after now once the start has passed", () => {
    expect(termEnd(2, TERM_START, Date.UTC(2026, 9, 21) / 1000)).toBe(1861833600)
    expect(dateOf(termEnd(2, TERM_START, Date.UTC(2026, 9, 21) / 1000))).toBe("31\u00a0December 2028")
    expect(dateOf(termEnd(5, TERM_START, Date.UTC(2026, 9, 21) / 1000))).toBe("31\u00a0December 2031")
    expect(dateOf(termEnd(2, TERM_START, Date.UTC(2027, 5, 15) / 1000))).toBe("14\u00a0June 2029")
  })

  it("writes seconds in the singular and the plural", () => {
    expect(seconds(1)).toBe("1 second")
    expect(seconds(30)).toBe("30 seconds")
  })

  it("writes a countdown that rounds up, so it reads 0:00 only once the time is over, never negative, and method names", () => {
    expect(clock(65.1)).toBe("1:06")
    expect(clock(60)).toBe("1:00")
    expect(clock(0.02)).toBe("0:01")
    expect(clock(0)).toBe("0:00")
    expect(clock(-3)).toBe("0:00")
    expect(methodName("xmr")).toBe("Monero")
    expect(methodName("code")).toBe("Code")
  })
})
