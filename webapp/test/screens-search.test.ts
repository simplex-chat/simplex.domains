import { describe, expect, it } from "vitest"
import type { SearchAnswer, Terms } from "../src/api.ts"
import { type Hold, NO_LEAD } from "../src/screens/hold.ts"
import {
  codeCover, coverOf, initialSearch, type Opening, orderCode, type OrderRead, ownOrders, reduce, returnedTo, searchDue, type SearchEvent,
  searchLocked, type SearchKind, type SearchState, screenOf,
} from "../src/screens/search.ts"
import type { OrderRecord } from "../src/store.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const termsOf = (hash: string) => ({ hash: `0x${hash}`, link: `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${"83".repeat(20)}/docs/terms.md#sha256=${"02".repeat(32)}` })
const TERMS = termsOf("21".repeat(32))
const available = (terms: Terms | null = TERMS): SearchAnswer => ({ found: { type: "available", price: 1500, years: 2, terms }, community: null })
const AVAILABLE = available()
const TAKEN: SearchAnswer = { found: { type: "registered", entities: [], owner: OWNER, resolver: OWNER, expiresAt: 1830297600, gracePeriod: 7776000, records: { type: "other" } }, community: null }

function record(change: Partial<OrderRecord> = {}): OrderRecord {
  return {
    registrationId: "reg-1", invoiceId: "inv-1", label: "alice1", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: OWNER, contact: "", channel: "",
    method: "btc", paid: 1500, years: 2, request: { duration: 2 * 365 * 86400, labelHash: "0x4f1b", length: 6, owner: OWNER, commitment: "0x9c11", sealed: "sealed-box" },
    tld: "simplex", createdAt: "2026-10-17T11:59:00Z", ...change,
  }
}

const openedEvent = (change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}): Extract<SearchEvent, { type: "opened" }> =>
  ({ type: "opened", opening: "plain", name: "", order: null, hold: null, ...change })
const open = (change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}) => reduce(initialSearch(), openedEvent(change))
const wait = (until: number): Hold => ({ until, lead: NO_LEAD })
const searchedEvent = (label: string, hold: Hold | null = null, minLength: number | null = null): SearchEvent => ({ type: "searched", label, hold, minLength })
const answered = (s: SearchState, answer: SearchAnswer = AVAILABLE, label = s.searching!.label): SearchEvent => ({ type: "answered", seq: s.seq, label, answer, mine: false, now: NOW })
function shown(label = "alice1", answer: SearchAnswer = AVAILABLE, change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}): SearchState {
  const s = open({ name: label, ...change })
  const searching = reduce(s, searchedEvent(label))
  return reduce(searching, answered(searching, answer))
}

describe("screenOf", () => {
  const cases: [Opening, SearchKind][] = [["plain", "search:plain"], ["order", "search:order"]]
  it.each(cases)("a page opened %s shows %s", (opening, kind) => {
    expect(screenOf(open({ opening }))).toBe(kind)
  })
})

describe("searchDue", () => {
  it("is due for a name the link names and the field holds, not searched yet", () => {
    expect(searchDue(open({ name: "alice1" }))).toBe(true)
    expect(searchDue(open())).toBe(false)
    expect(searchDue(shown())).toBe(false)
  })
  it("is not due while the search is paused, or once another name is typed", () => {
    expect(searchDue(open({ name: "alice1", hold: wait(NOW + 5000) }))).toBe(false)
    expect(searchDue(reduce(open({ name: "alice1" }), { type: "typed", text: "bob" }))).toBe(false)
  })
  it("is due for a new name the link names on a page drawn again", () => {
    expect(searchDue(reduce(shown(), openedEvent({ name: "carol1" })))).toBe(true)
  })
  it("folds what is typed as a search does", () => {
    expect(searchDue(reduce(open({ name: "alice1" }), { type: "typed", text: "alice1.simplex" }))).toBe(true)
  })
})

describe("reduce: opened", () => {
  it("a page opened anew fills the field with the link's name", () => {
    const s = open({ name: "alice1" })
    expect(s).toMatchObject({ opening: "plain", name: "alice1", typed: "alice1", searched: null, answer: null, hold: null, paused: false })
  })
  it("keeps the order a name is selected for", () => {
    expect(open({ opening: "order", order: record() }).order).toEqual(record())
  })
  it("drawn again, a name searched keeps its answer and the field its name", () => {
    const s = shown()
    const next = reduce(s, openedEvent({ name: "alice1" }))
    expect(next).toMatchObject({ typed: "alice1", searched: "alice1", answer: s.answer })
  })
  it("drawn again with a name typed over the one searched, the answer gives way and the name typed stays", () => {
    const s = reduce(shown(), { type: "typed", text: "bobby1" })
    const next = reduce(s, openedEvent({ name: "alice1" }))
    expect(next).toMatchObject({ typed: "bobby1", answer: null, searching: null, bad: false })
    expect(next.seq).toBeGreaterThan(s.seq)
  })
  it("drawn again during a search for the name, the search goes on", () => {
    const s = reduce(open({ name: "alice1" }), searchedEvent("alice1"))
    const next = reduce(s, openedEvent({ name: "alice1" }))
    expect(next).toMatchObject({ seq: s.seq, searching: { label: "alice1" } })
    expect(reduce(next, answered(s)).answer).toMatchObject({ kind: "found", label: "alice1" })
  })
  it("a wait met elsewhere in the tab pauses the search, dropping what was shown", () => {
    const s = open({ name: "alice1", hold: wait(NOW + 5000) })
    expect(s).toMatchObject({ hold: { until: NOW + 5000, lead: NO_LEAD }, paused: true, answer: null })
    const later = reduce(shown(), openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))
    expect(later).toMatchObject({ paused: true, answer: null, searching: null })
  })
  it("a wait the page knows of goes on, and ends only by its own event", () => {
    const searching = reduce(shown(), searchedEvent("bobby1"))
    const held = reduce(searching, { type: "search-held", seq: searching.seq, until: NOW + 5000 })
    expect(reduce(held, openedEvent({ name: "bobby1", hold: wait(NOW + 9000) }))).toMatchObject({ paused: true, seq: held.seq, hold: held.hold })
    expect(reduce(held, openedEvent({ name: "bobby1", hold: null }))).toMatchObject({ paused: true, hold: held.hold })
  })
  it("a new name in the link, drawn again, goes into the field", () => {
    expect(reduce(shown(), openedEvent({ name: "carol1" }))).toMatchObject({ name: "carol1", typed: "carol1" })
  })
})

describe("reduce: typing and searching", () => {
  it("typed keeps the text and takes the rules' mark off the box", () => {
    const refused = reduce(open(), searchedEvent("abc"))
    expect(refused.bad).toBe(true)
    expect(reduce(refused, { type: "typed", text: "abcd" })).toMatchObject({ typed: "abcd", bad: false, answer: refused.answer })
  })
  it("searched starts a search, naming it in the link", () => {
    const s = open()
    expect(reduce(s, searchedEvent("alice1"))).toMatchObject({ seq: s.seq + 1, name: "alice1", searched: "alice1", searching: { label: "alice1" } })
  })
  it("a search writes the name it searched back into the field, as typed with \".simplex\" or in its own case", () => {
    const typed = reduce(open(), { type: "typed", text: "mynamehere.simplex" })
    expect(reduce(typed, searchedEvent("mynamehere"))).toMatchObject({ typed: "mynamehere", name: "mynamehere", searched: "mynamehere" })
    const short = reduce(reduce(open(), { type: "typed", text: "abc.simplex" }), searchedEvent("abc"))
    expect(short).toMatchObject({ typed: "abc", answer: { kind: "rule", label: "abc", problem: "short" } })
  })
  it("searched for a name the rules refuse answers it at once and marks the box", () => {
    const short = reduce(open(), searchedEvent("abc"))
    expect(short).toMatchObject({ searching: null, answer: { kind: "rule", label: "abc", problem: "short" }, bad: true, name: "abc" })
    expect(reduce(open(), searchedEvent("bad_name")).answer).toEqual({ kind: "rule", label: "bad_name", problem: "chars" })
    expect(reduce(open(), searchedEvent("a".repeat(64))).answer).toMatchObject({ problem: "long" })
  })
  it("searched with nothing typed, or while paused, changes nothing", () => {
    const s = open()
    expect(reduce(s, searchedEvent(""))).toBe(s)
    const paused = open({ hold: wait(NOW + 5000) })
    expect(reduce(paused, searchedEvent("alice1"))).toBe(paused)
  })
  it("searched during a wait met elsewhere in the tab pauses the search instead", () => {
    const s = shown()
    expect(reduce(s, searchedEvent("bobby1", wait(NOW + 9000)))).toMatchObject({ paused: true, hold: { until: NOW + 9000, lead: NO_LEAD }, answer: null, searching: null, searched: "alice1" })
  })
})

describe("reduce: searching", () => {
  it("a search under way keeps the last answer on screen until the new one comes", () => {
    const found = reduce(reduce(initialSearch(), { type: "searched", label: "bakery", hold: null, minLength: null }), { type: "answered", seq: 1, label: "bakery", answer: AVAILABLE, mine: false, now: 0 })
    const next = reduce({ ...found, typed: "harbour" }, { type: "searched", label: "harbour", hold: null, minLength: null })
    expect(next.searching).toEqual({ label: "harbour" })
    expect(next.answer).toEqual(found.answer)
  })
  it("the opened event carries no code", () => {
    expect(Object.keys(initialSearch())).not.toContain("applied")
  })
})

describe("reduce: answers", () => {
  it("answered shows the answer with what the page knew of it", () => {
    const s = reduce(open(), searchedEvent("alice1"))
    const next = reduce(s, { type: "answered", seq: s.seq, label: "alice1", answer: TAKEN, mine: true, now: NOW })
    expect(next).toMatchObject({ searching: null, answer: { kind: "found", label: "alice1", answer: TAKEN, mine: true, now: NOW } })
  })
  it("a slower answer to an earlier search never replaces the latest one", () => {
    const first = reduce(open(), searchedEvent("slower1"))
    const second = reduce(first, searchedEvent("bakery"))
    const latest = reduce(second, answered(second, TAKEN))
    expect(reduce(latest, answered(first, AVAILABLE, "slower1"))).toBe(latest)
    const early = reduce(second, answered(first, AVAILABLE, "slower1"))
    expect(early).toBe(second)
    expect(reduce(early, answered(second, TAKEN)).answer).toMatchObject({ label: "bakery" })
  })
  it("an answer for the same name keeps the order it points at; one for another name drops it", () => {
    const pointed = reduce(shown(), { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" })
    const again = reduce(pointed, searchedEvent("alice1"))
    expect(reduce(again, answered(again)).ownOrder).toBe("/?order=inv-1")
    const other = reduce(pointed, searchedEvent("bobby1"))
    expect(reduce(other, answered(other)).ownOrder).toBeNull()
  })
  it("unanswered says the name could not be checked, for the latest search only", () => {
    const first = reduce(open(), searchedEvent("alice1"))
    expect(reduce(first, { type: "unanswered", seq: first.seq })).toMatchObject({ searching: null, answer: { kind: "unchecked" } })
    const second = reduce(first, searchedEvent("bobby1"))
    expect(reduce(second, { type: "unanswered", seq: first.seq })).toBe(second)
  })
  it("search-held pauses the search for the service's wait, for the latest search only", () => {
    const s = reduce(shown(), searchedEvent("bobby1"))
    expect(reduce(s, { type: "search-held", seq: s.seq, until: NOW + 30_000 })).toMatchObject({ paused: true, hold: { until: NOW + 30_000, lead: NO_LEAD }, answer: null, searching: null })
    const later = reduce(s, searchedEvent("carol1"))
    expect(reduce(later, { type: "search-held", seq: s.seq, until: NOW })).toBe(later)
  })
  it("hold-ended lifts the pause and the wait", () => {
    const s = open({ name: "alice1", hold: wait(NOW + 5000) })
    expect(reduce(s, { type: "hold-ended" })).toMatchObject({ hold: null, paused: false })
  })
  it("a pause that ends with a name in the field says it is checked until the answer comes, rather than leave the place empty", () => {
    const ended = reduce(open({ name: "alice1", hold: wait(NOW + 5000) }), { type: "hold-ended" })
    expect(ended.answer).toEqual({ kind: "checking" })
    const searching = reduce(ended, searchedEvent("alice1"))
    expect(searching.answer).toEqual({ kind: "checking" })
    expect(reduce(searching, answered(searching)).answer).toMatchObject({ kind: "found", answer: AVAILABLE })
    expect(reduce(searching, { type: "search-held", seq: searching.seq, until: NOW + 9000 })).toMatchObject({ answer: null, paused: true })
    expect(reduce(open({ hold: wait(NOW + 5000) }), { type: "hold-ended" }).answer).toBeNull()
  })
  it("own-order-seen points at the order for the name shown, and not for another", () => {
    const s = shown()
    expect(reduce(s, { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" }).ownOrder).toBe("/?order=inv-1")
    expect(reduce(s, { type: "own-order-seen", label: "bobby1", url: "/?order=inv-1" })).toBe(s)
    expect(reduce(open(), { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" }).ownOrder).toBeNull()
  })
})

describe("reduce: the order a name is selected for", () => {
  it("order-read takes the order as the service has it", () => {
    const s = open({ opening: "order", order: record() })
    expect(reduce(s, { type: "order-read", record: record({ paid: 2500 }) }).order).toEqual(record({ paid: 2500 }))
  })
  it("order-read for another order, or on a page with none, changes nothing", () => {
    const s = open({ opening: "order", order: record() })
    expect(reduce(s, { type: "order-read", record: record({ registrationId: "reg-2" }) })).toBe(s)
    const plain = open()
    expect(reduce(plain, { type: "order-read", record: record() })).toBe(plain)
  })
})

describe("returnedTo", () => {
  it("a search gone back to for the same name shows its last answer again, with nothing searched again", () => {
    const s = shown("alice1", TAKEN)
    const back = returnedTo(s, "plain", "alice1", "simplex", [])
    expect(back).toEqual(s)
    expect(searchDue(reduce(back, openedEvent({ name: "alice1" })))).toBe(false)
    expect(reduce(back, openedEvent({ name: "alice1" })).answer).toEqual(s.answer)
  })
  it("a search under way on the page left ended with it", () => {
    const s = shown()
    const left = { ...reduce(s, searchedEvent("bobby1")), name: "alice1" }
    expect(left.searching).not.toBeNull()
    expect(returnedTo(left, "plain", "alice1", "simplex", [])).toEqual({ ...left, searching: null })
  })
  it("starts anew for another name, another way of opening, or a page that showed no answer", () => {
    const s = shown()
    expect(returnedTo(s, "plain", "bobby1", "simplex", [])).toEqual(initialSearch())
    expect(returnedTo(s, "order", "alice1", "simplex", [])).toEqual(initialSearch())
    expect(returnedTo(open({ name: "alice1" }), "plain", "alice1", "simplex", [])).toEqual(initialSearch())
    const ruled = reduce(open({ name: "abc" }), searchedEvent("abc"))
    expect(returnedTo(ruled, "plain", "abc", "simplex", [])).toEqual(initialSearch())
  })
  it("a wait met elsewhere in the tab still pauses a search gone back to", () => {
    const back = returnedTo(shown(), "plain", "alice1", "simplex", [])
    expect(reduce(back, openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))).toMatchObject({ paused: true, answer: null })
  })
  it("an available name this browser has ordered since is checked again before anything is offered for it", () => {
    const back = returnedTo(shown(), "plain", "alice1", "simplex", [record()])
    expect(back.answer).toEqual({ kind: "checking" })
    expect(back.searching).toBeNull()
    expect(reduce(reduce(back, openedEvent({ name: "alice1" })), answered({ ...back, searching: { label: "alice1" } }, TAKEN)).answer).toMatchObject({ kind: "found", answer: TAKEN })
    expect(returnedTo(shown("alice1", TAKEN), "plain", "alice1", "simplex", [record()]).answer).toMatchObject({ kind: "found", answer: TAKEN })
  })
  it("an order for the same letters under another TLD leaves the answer shown", () => {
    const back = returnedTo(shown(), "plain", "alice1", "simplex", [record({ tld: "other" })])
    expect(back.answer).toMatchObject({ kind: "found", answer: AVAILABLE })
  })
  it("a search gone back to whose check again fails no longer shows its remembered answer", () => {
    const back = reduce(returnedTo(shown(), "plain", "alice1", "simplex", []), openedEvent({ name: "alice1" }))
    expect(back.answer).toMatchObject({ kind: "found", answer: AVAILABLE })
    expect(reduce(back, { type: "unanswered", seq: back.seq })).toMatchObject({ answer: { kind: "unchecked" }, paused: false })
    expect(reduce(back, { type: "search-held", seq: back.seq, until: NOW + 10_000 })).toMatchObject({ answer: null, paused: true, hold: { until: NOW + 10_000, lead: NO_LEAD } })
  })
})

describe("a name selected for a code order", () => {
  const PREPAID = "SN9-BJTBP-29596-R3HJ8-25YM5"
  const coded = (change: Partial<OrderRecord> = {}) => record({ invoiceId: null, method: "code", paid: 0, prepaidCode: PREPAID, label: "alice1bakes", ...change })
  it("is bounded by the order's code: names of the code's length or more, for the order's years", () => {
    expect(codeCover(coded())).toEqual({ minLength: 9, years: 2 })
    expect(codeCover(coded({ years: 5 }))).toEqual({ minLength: 9, years: 5 })
    expect(codeCover(record()), "a paid order").toBeNull()
  })
  it("is searched only among the names its code covers, in either mode, while the tab's code bounds nothing", () => {
    const selecting = open({ opening: "order", order: coded() })
    expect(coverOf(false, selecting, null)).toBe(9)
    expect(coverOf(true, selecting, { display: "SN7-AAAAA-BBBBB-CCCCC", minLength: 7, years: 2 })).toBe(9)
    expect(reduce(selecting, searchedEvent("alice1ba", null, 9)).answer).toEqual({ kind: "uncovered", label: "alice1ba", minLength: 9 })
  })
  it("restored without its code states no length and leaves the code's check to the service", () => {
    const restored = coded({ prepaidCode: undefined })
    expect(codeCover(restored)).toEqual({ minLength: null, years: 2 })
    expect(coverOf(false, open({ opening: "order", order: restored }), null)).toBeNull()
  })
})

describe("ownOrders", () => {
  const CODES = { a: "SN-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA", b: "SN-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB", c: "SN-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC" }
  const order = (id: string, change: Partial<OrderRecord> = {}) => record({ registrationId: id, invoiceId: `inv-${id}`, ...change })
  // each order's read, by registration id; an order missing here could not be read
  function reader(reads: Record<string, OrderRead>) {
    const asked: string[] = []
    const read = async (o: OrderRecord) => {
      asked.push(o.registrationId)
      return reads[o.registrationId] ?? null
    }
    return { asked, read }
  }
  const unpaid = (invoice: OrderRead["invoice"]): OrderRead => ({ phase: "unpaid", failure: null, invoice })

  it("finds nothing for a name this browser never ordered", async () => {
    expect(await ownOrders([], reader({}).read)).toEqual({ open: null, closed: null })
  })
  it("takes a cancelled order as closed without reading it", async () => {
    const cancelled = order("r1", { cancelled: true, ownerCode: CODES.a })
    const { asked, read } = reader({})
    expect(await ownOrders([cancelled], read)).toEqual({ open: null, closed: cancelled })
    expect(asked, "a cancelled order is not read").toEqual([])
  })
  it("takes an order whose invoice expired, or was paid after it closed, unpaid, as closed", async () => {
    const expired = order("r1")
    expect(await ownOrders([expired], reader({ r1: unpaid("expired") }).read)).toEqual({ open: null, closed: expired })
    expect(await ownOrders([expired], reader({ r1: unpaid("paid") }).read), "a late payment registers nothing").toEqual({ open: null, closed: expired })
  })
  it("keeps the newest closed order of several, as the list comes newest first", async () => {
    const newest = order("r1", { ownerCode: CODES.a })
    const cancelled = order("r2", { ownerCode: CODES.b, cancelled: true })
    const oldest = order("r3", { ownerCode: CODES.c })
    const reads = { r1: unpaid("expired"), r3: unpaid("expired") }
    expect(await ownOrders([newest, cancelled, oldest], reader(reads).read)).toEqual({ open: null, closed: newest })
    expect(await ownOrders([cancelled, oldest], reader(reads).read)).toEqual({ open: null, closed: cancelled })
  })
  it("stops at an order that can still register the name: an open invoice, or a payment on its way to the chain", async () => {
    const closed = order("r1", { cancelled: true })
    const open = order("r2")
    const older = order("r3")
    for (const live of [unpaid("open"), { phase: "queued", failure: null, invoice: "paid" }, { phase: "committed", failure: null, invoice: null },
      { phase: "failed", failure: "registryRefused", invoice: "paid" }] as OrderRead[]) {
      const { asked, read } = reader({ r2: live, r3: unpaid("expired") })
      expect(await ownOrders([closed, open, older], read), JSON.stringify(live)).toEqual({ open, closed })
      expect(asked, "nothing older is read").toEqual(["r2"])
    }
  })
  it("takes a registered or taken order, or one failed at its month's end, as neither open nor closed", async () => {
    for (const [phase, failure] of [["registered", null], ["taken", null], ["failed", "monthEnded"]] as const) {
      expect(await ownOrders([order("r1")], reader({ r1: { phase, failure, invoice: "paid" } }).read), phase).toEqual({ open: null, closed: null })
    }
  })
  it("takes an order with no invoice as never closed, whatever its phase", async () => {
    expect(await ownOrders([order("r1", { invoiceId: null })], reader({ r1: unpaid(null) }).read)).toEqual({ open: null, closed: null })
  })
  it("passes over an order that could not be read, for an older one", async () => {
    const unread = order("r1", { ownerCode: CODES.a })
    const older = order("r2", { ownerCode: CODES.b })
    expect(await ownOrders([unread, older], reader({ r2: unpaid("expired") }).read)).toEqual({ open: null, closed: older })
  })
})

describe("orderCode", () => {
  const CLOSED = "SN-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC"
  it("leaves a new name code to the code step when nothing names one", () => {
    expect(orderCode(null)).toEqual({ ownerCode: null, saved: false })
  })
  it("keeps a closed order's name code, which the buyer saved already", () => {
    expect(orderCode(CLOSED)).toEqual({ ownerCode: CLOSED, saved: true })
  })
})

describe("codes-only mode", () => {
  const CODE = { display: "SN7-AAAAA-BBBBB-CCCCC", minLength: 7, years: 2 }

  it("locks a plain search until the tab holds a prepaid code", () => {
    expect(searchLocked(true, open(), null)).toBe(true)
    expect(searchLocked(true, open(), CODE)).toBe(false)
    expect(searchLocked(false, open(), null), "open mode searches without a code").toBe(false)
  })
  it("leaves the search for a paid order's name open, which its own payment registers", () => {
    const selecting = open({ opening: "order", order: record() })
    expect(searchLocked(true, selecting, null)).toBe(false)
    expect(coverOf(true, selecting, CODE), "the tab's code bounds none of its names").toBeNull()
  })
  it("bounds a plain search by the letters the tab's code covers, in codes-only mode only", () => {
    expect(coverOf(true, open(), CODE)).toBe(7)
    expect(coverOf(true, open(), null)).toBeNull()
    expect(coverOf(false, open(), CODE)).toBeNull()
  })
  it("answers a name shorter than the code covers at once, without searching it", () => {
    const s = reduce(open({ name: "alice1" }), searchedEvent("alice1", null, 7))
    expect(s).toMatchObject({ searching: null, searched: "alice1", answer: { kind: "uncovered", label: "alice1", minLength: 7 }, bad: true })
    expect(searchDue(s)).toBe(false)
  })
  it("searches a name the code covers", () => {
    const s = reduce(open({ name: "alice12" }), searchedEvent("alice12", null, 7))
    expect(s).toMatchObject({ searching: { label: "alice12" }, answer: null, bad: false })
  })
  it("says a name's own fault first, as a name of 3 letters breaks the rule before the code", () => {
    const s = reduce(open({ name: "ali" }), searchedEvent("ali", null, 7))
    expect(s.answer).toEqual({ kind: "rule", label: "ali", problem: "short" })
  })
  it("leaves no uncovered answer to return to, so a name searched again is bounded again", () => {
    const s = reduce(open({ name: "alice1" }), searchedEvent("alice1", null, 7))
    expect(returnedTo(s, "plain", "alice1", "simplex", [])).toEqual(initialSearch())
  })
})
