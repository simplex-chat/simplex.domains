import { describe, expect, it } from "vitest"
import type { SearchAnswer } from "../src/api.ts"
import { type Hold, NO_LEAD } from "../src/screens/hold.ts"
import {
  balanceHint, codeCover, coverOf, initialSearch, keptWords, moveBar, moveHint, type Opening, orderCode, type OrderRead, ownOrders, reduce, REGISTER_LEAD, returnedTo, searchDue, type SearchEvent,
  searchLocked, type SearchKind, type SearchState, screenOf,
} from "../src/screens/search.ts"
import { timeOf } from "../src/format.ts"
import type { OrderRecord } from "../src/store.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const termsOf = (hash: string) => ({ hash: `0x${hash}`, link: `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${"83".repeat(20)}/docs/terms.md#sha256=${"02".repeat(32)}` })
const TERMS = termsOf("21".repeat(32))
const NEWER = termsOf("f6".repeat(32))
const BAKERS = { for: "bakers and pastry chefs", years: 2 }
const AVAILABLE: SearchAnswer = { status: "available", price: 1500, currency: "usd", years: 2, termStart: Date.UTC(2027, 0, 1) / 1000, community: null, terms: TERMS, ...CHAIN }
const TAKEN: SearchAnswer = { status: "registered", entities: [], owner: OWNER, tld: "simplex", community: null }

function record(change: Partial<OrderRecord> = {}): OrderRecord {
  return {
    registrationId: "reg-1", invoiceId: "inv-1", label: "alice1", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: OWNER, contact: "", channel: "",
    method: "btc", paid: 1500, years: 2, request: { duration: 2 * 365 * 86400, labelHash: "0x4f1b", length: 6, owner: OWNER, commitment: "0x9c11", sealed: "sealed-box" },
    tld: "simplex", createdAt: "2026-10-17T11:59:00Z", ...change,
  }
}

const openedEvent = (change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}): Extract<SearchEvent, { type: "opened" }> =>
  ({ type: "opened", opening: "plain", name: "", retarget: null, balance: null, hold: null, ...change })
const open = (change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}) => reduce(initialSearch(), openedEvent(change))
const run = (s: SearchState, ...events: SearchEvent[]) => events.reduce(reduce, s)
const wait = (until: number): Hold => ({ until, lead: NO_LEAD })
const searchedEvent = (label: string, hold: Hold | null = null, minLength: number | null = null): SearchEvent => ({ type: "searched", label, hold, minLength })
const answered = (s: SearchState, answer: SearchAnswer = AVAILABLE, label = s.searching!.label): SearchEvent => ({ type: "answered", seq: s.seq, label, answer, mine: false, now: NOW })
function shown(label = "alice1", answer: SearchAnswer = AVAILABLE, change: Partial<Extract<SearchEvent, { type: "opened" }>> = {}): SearchState {
  const s = open({ name: label, ...change })
  const searching = reduce(s, searchedEvent(label))
  return reduce(searching, answered(searching, answer))
}

describe("screenOf", () => {
  const cases: [Opening, SearchKind][] = [["plain", "search:plain"], ["retarget", "search:retarget"]]
  it.each(cases)("a page opened %s shows %s", (opening, kind) => {
    expect(screenOf(open({ opening }))).toBe(kind)
  })
  it("a retarget page whose order went elsewhere stays the retarget page", () => {
    const s = open({ opening: "retarget", retarget: record() })
    expect(screenOf(reduce(s, { type: "retarget-read", record: record(), moved: { url: "/?order=inv-1", label: "other1", tld: "simplex" } }))).toBe("search:retarget")
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
  it("keeps the order a retarget search moves", () => {
    expect(open({ opening: "retarget", retarget: record() }).retarget).toEqual(record())
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
  it("drawn again, the refusal its register showed is done with, and a register under way goes on", () => {
    const s = run(shown(), { type: "register-started" })
    expect(reduce(s, openedEvent({ name: "alice1" })).register).toEqual({ busy: true, refusal: null })
    const refused = reduce(s, { type: "register-refused", refusal: { why: "failed" } })
    expect(reduce(refused, openedEvent({ name: "alice1" })).register).toEqual({ busy: false, refusal: null })
  })
  it("a wait met elsewhere in the tab pauses the search, dropping what was shown", () => {
    const s = open({ name: "alice1", hold: wait(NOW + 5000) })
    expect(s).toMatchObject({ hold: { until: NOW + 5000, lead: NO_LEAD }, paused: true, answer: null })
    const later = reduce(shown(), openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))
    expect(later).toMatchObject({ paused: true, answer: null, searching: null })
  })
  it("a wait the page knows of keeps what the page shows, and ends only by its own event", () => {
    const held = reduce(shown(), { type: "register-held", until: NOW + 5000 })
    expect(reduce(held, openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))).toMatchObject({ paused: false, answer: held.answer, hold: held.hold })
    expect(reduce(held, openedEvent({ name: "alice1", hold: null }))).toMatchObject({ hold: held.hold })
  })
  it("an order that went elsewhere stays gone when the page is drawn again", () => {
    const moved = { url: "/?order=inv-1", label: "other1", tld: "simplex" }
    const s = reduce(open({ opening: "retarget", retarget: record() }), { type: "retarget-read", record: record(), moved })
    expect(reduce(s, openedEvent({ opening: "retarget", retarget: record() }))).toMatchObject({ retarget: null, moved })
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
  it("searched ends the refusal the last register showed", () => {
    const refused = run(shown(), { type: "register-refused", refusal: { why: "taken" } })
    expect(reduce(refused, searchedEvent("bobby1")).register).toEqual({ busy: false, refusal: null })
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
  it("a shorter wait met meanwhile does not cut a longer one", () => {
    const held = reduce(shown(), { type: "register-held", until: NOW + 30_000 })
    expect(reduce(held, searchedEvent("bobby1", wait(NOW + 1000))).hold!.until).toBe(NOW + 30_000)
    const s = reduce(held, { type: "hold-ended" })
    const searching = reduce(s, searchedEvent("bobby1"))
    expect(reduce(run(searching, { type: "register-held", until: NOW + 60_000 }), { type: "search-held", seq: searching.seq, until: NOW + 1000 }).hold!.until).toBe(NOW + 60_000)
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
  it("a wait on Register that ends keeps the answer shown", () => {
    const held = reduce(shown(), { type: "register-held", until: NOW + 30_000 })
    expect(reduce(held, { type: "hold-ended" }).answer).toEqual(held.answer)
  })
  it("own-order-seen points at the order for the name shown, and not for another", () => {
    const s = shown()
    expect(reduce(s, { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" }).ownOrder).toBe("/?order=inv-1")
    expect(reduce(s, { type: "own-order-seen", label: "bobby1", url: "/?order=inv-1" })).toBe(s)
    expect(reduce(open(), { type: "own-order-seen", label: "alice1", url: "/?order=inv-1" }).ownOrder).toBeNull()
  })
})

describe("reduce: retargets", () => {
  it("retarget-read takes the order as the service has it", () => {
    const s = open({ opening: "retarget", retarget: record() })
    expect(reduce(s, { type: "retarget-read", record: record({ paid: 2500 }), moved: null }).retarget).toEqual(record({ paid: 2500 }))
  })
  it("retarget-read for an order gone elsewhere says where, and the search is a plain one", () => {
    const s = run(open({ opening: "retarget", retarget: record() }), { type: "register-started" })
    const moved = { url: "/?order=inv-1", label: "other1", tld: "simplex" }
    expect(reduce(s, { type: "retarget-read", record: record(), moved })).toMatchObject({ retarget: null, moved, register: { busy: false, refusal: null } })
  })
  it("retarget-read for another order, or on a page with none, changes nothing", () => {
    const s = open({ opening: "retarget", retarget: record() })
    expect(reduce(s, { type: "retarget-read", record: record({ registrationId: "reg-2" }), moved: null })).toBe(s)
    const plain = open()
    expect(reduce(plain, { type: "retarget-read", record: record(), moved: null })).toBe(plain)
  })
})

describe("reduce: the terms of a move", () => {
  const moving = () => shown("alice1", AVAILABLE, { opening: "retarget", retarget: record() })

  it("agreed ticks and unticks the terms box a move to another name waits for", () => {
    const ticked = reduce(moving(), { type: "agreed", agreed: true })
    expect(ticked.agreed).toBe(true)
    expect(reduce(ticked, { type: "agreed", agreed: false }).agreed).toBe(false)
  })
  it("accepted ticks and unticks a community name's own box beside it", () => {
    const ticked = reduce(moving(), { type: "accepted", accepted: true })
    expect(ticked.accepted).toBe(true)
    expect(reduce(ticked, { type: "accepted", accepted: false }).accepted).toBe(false)
  })
  it("terms-changed takes the terms and community entry the service gave into the answer, unticks the boxes and says so, ending the move", () => {
    const s = run(moving(), { type: "agreed", agreed: true }, { type: "accepted", accepted: true }, { type: "register-started" })
    const changed = reduce(s, { type: "terms-changed", label: "alice1", terms: NEWER, community: BAKERS })
    expect(changed).toMatchObject({ agreed: false, accepted: false, termsChanged: true, register: { busy: false, refusal: null }, answer: { kind: "found", label: "alice1", answer: { ...AVAILABLE, terms: NEWER, community: BAKERS } } })
  })
  it("terms-changed for a name no longer shown changes nothing", () => {
    const s = moving()
    expect(reduce(s, { type: "terms-changed", label: "bob123", terms: NEWER, community: null })).toBe(s)
  })
  it("an answer for another name, or with other terms, unticks the boxes and ends the notice; the same answer again keeps them", () => {
    const ticked = run(moving(), { type: "agreed", agreed: true }, { type: "accepted", accepted: true })
    const again = run(ticked, searchedEvent("alice1"))
    expect(reduce(again, answered(again))).toMatchObject({ agreed: true, accepted: true })
    const other = run(ticked, searchedEvent("carol1"))
    expect(reduce(other, answered(other))).toMatchObject({ agreed: false, accepted: false, termsChanged: false })
    const changed = run(moving(), { type: "terms-changed", label: "alice1", terms: NEWER, community: null }, searchedEvent("alice1"))
    expect(reduce({ ...changed, agreed: true }, answered(changed, { ...AVAILABLE, terms: termsOf("d8".repeat(32)) }))).toMatchObject({ agreed: false })
    expect(reduce({ ...changed, agreed: true }, answered(changed, { ...AVAILABLE, terms: null })), "terms that can't be read now").toMatchObject({ agreed: false })
  })
})

describe("reduce: register", () => {
  it("register-started works, and a refusal ends it", () => {
    const s = reduce(shown(), { type: "register-started" })
    expect(s.register).toEqual({ busy: true, refusal: null })
    expect(reduce(s, { type: "register-refused", refusal: { why: "other", url: "/?order=inv-9" } }).register).toEqual({ busy: false, refusal: { why: "other", url: "/?order=inv-9" } })
  })
  it("register-held holds the tab, saying nothing changed, and keeps the answer shown", () => {
    const s = reduce(shown(), { type: "register-started" })
    expect(reduce(s, { type: "register-held", until: NOW + 5000 })).toMatchObject({ register: { busy: false, refusal: null }, hold: { until: NOW + 5000, lead: REGISTER_LEAD }, paused: false, answer: s.answer })
  })
})

describe("returnedTo", () => {
  it("a search gone back to for the same name shows its last answer again, with nothing searched again", () => {
    const s = shown("alice1", TAKEN)
    const back = returnedTo(s, "plain", "alice1", [])
    expect(back).toEqual(s)
    expect(searchDue(reduce(back, openedEvent({ name: "alice1" })))).toBe(false)
    expect(reduce(back, openedEvent({ name: "alice1" })).answer).toEqual(s.answer)
  })
  it("what was under way on the page left ended with it: a search, and a register at work", () => {
    const s = shown()
    const left = { ...reduce(reduce(s, { type: "register-started" }), searchedEvent("bobby1")), name: "alice1" }
    expect(left.searching).not.toBeNull()
    expect(returnedTo(left, "plain", "alice1", [])).toEqual({ ...left, searching: null, register: { busy: false, refusal: null } })
  })
  it("starts anew for another name, another way of opening, or a page that showed no answer", () => {
    const s = shown()
    expect(returnedTo(s, "plain", "bobby1", [])).toEqual(initialSearch())
    expect(returnedTo(s, "retarget", "alice1", [])).toEqual(initialSearch())
    expect(returnedTo(open({ name: "alice1" }), "plain", "alice1", [])).toEqual(initialSearch())
    const ruled = reduce(open({ name: "abc" }), searchedEvent("abc"))
    expect(returnedTo(ruled, "plain", "abc", [])).toEqual(initialSearch())
  })
  it("a wait met elsewhere in the tab still pauses a search gone back to", () => {
    const back = returnedTo(shown(), "plain", "alice1", [])
    expect(reduce(back, openedEvent({ name: "alice1", hold: wait(NOW + 5000) }))).toMatchObject({ paused: true, answer: null })
  })
  it("an available name this browser has ordered since is checked again before anything is offered for it", () => {
    const back = returnedTo(shown(), "plain", "alice1", [record()])
    expect(back.answer).toEqual({ kind: "checking" })
    expect(back.searching).toBeNull()
    expect(reduce(reduce(back, openedEvent({ name: "alice1" })), answered({ ...back, searching: { label: "alice1" } }, TAKEN)).answer).toMatchObject({ kind: "found", answer: TAKEN })
    expect(returnedTo(shown("alice1", TAKEN), "plain", "alice1", [record()]).answer).toMatchObject({ kind: "found", answer: TAKEN })
  })
  it("an order for the same letters under another TLD leaves the answer shown", () => {
    const back = returnedTo(shown(), "plain", "alice1", [record({ tld: "other" })])
    expect(back.answer).toMatchObject({ kind: "found", answer: AVAILABLE })
  })
  it("a search gone back to whose check again fails no longer shows its remembered answer", () => {
    const back = reduce(returnedTo(shown(), "plain", "alice1", []), openedEvent({ name: "alice1" }))
    expect(back.answer).toMatchObject({ kind: "found", answer: AVAILABLE })
    expect(reduce(back, { type: "unanswered", seq: back.seq })).toMatchObject({ answer: { kind: "unchecked" }, paused: false })
    expect(reduce(back, { type: "search-held", seq: back.seq, until: NOW + 10_000 })).toMatchObject({ answer: null, paused: true, hold: { until: NOW + 10_000, lead: NO_LEAD } })
  })
})

describe("a balance", () => {
  const BALANCE = { source: "reg-taken", amount: 10000, held: false, heldUntil: null }
  it("is the tab's as the page opens, and as its order reads now", () => {
    const s = open({ balance: BALANCE })
    expect(s.balance).toEqual(BALANCE)
    expect(reduce(s, { type: "balance-read", balance: { ...BALANCE, amount: 2500 } }).balance).toEqual({ ...BALANCE, amount: 2500 })
    expect(reduce(s, { type: "balance-read", balance: null }).balance, "spent or refunded meanwhile").toBeNull()
    expect(reduce(s, openedEvent({ balance: null })).balance, "taken off in the header").toBeNull()
  })
  it("pays a name of its amount, saying what stays of a larger one", () => {
    expect(balanceHint(BALANCE, 10000)).toEqual(["Paid from your balance.", null])
    expect(balanceHint(BALANCE, 4000)).toEqual(["Paid from your balance.", "$60 stays in it."])
  })
  it("pays part of a dearer name, saying what is left to pay", () => {
    expect(balanceHint(BALANCE, 20000)).toEqual(["Your balance covers $100.", "You pay $100."])
    expect(balanceHint({ ...BALANCE, amount: 2550 }, 10000)).toEqual(["Your balance covers $25.50.", "You pay $74.50."])
  })
  it("held by another order's invoice says until when, or that its payment is being confirmed, whatever the price", () => {
    const until = "2026-10-17T12:30:00Z"
    expect(balanceHint({ ...BALANCE, held: true, heldUntil: until }, 4000)).toEqual([`Your balance is in use by another order until ${timeOf(Date.parse(until))}.`, null])
    expect(balanceHint({ ...BALANCE, held: true, heldUntil: null }, 4000)).toEqual(["Your balance is in use by another order while its payment is being confirmed.", null])
  })
})

describe("a move", () => {
  const PREPAID = "SN9-BJTBP-29596-R3HJ8-25YM5"
  const coded = (change: Partial<OrderRecord> = {}) => record({ invoiceId: null, method: "code", paid: 0, prepaidCode: PREPAID, label: "alice1bakes", ...change })
  it("of a code order is paid by its code, for names of the code's length or more and the order's years", () => {
    expect(codeCover(coded())).toEqual({ minLength: 9, years: 2 })
    expect(codeCover(coded({ years: 5 }))).toEqual({ minLength: 9, years: 5 })
  })
  it("of a code order restored without its code states no length, offers every name and leaves the cover to the service", () => {
    const restored = coded({ prepaidCode: undefined })
    expect(codeCover(restored)).toEqual({ minLength: null, years: 2 })
    expect(moveBar(restored, "alice2", 20000)).toBeNull()
    expect(moveHint(restored, "alice2", 20000), "shorter than the order's own name").toEqual(["Free with your code, if it covers a name this long", null])
    expect(moveHint(restored, "alice1bakes", 20000), "as long as the order's own name, which the code covers").toEqual(["Covered by your code", null])
    expect(moveHint(restored, "alice1bakery", 20000)).toEqual(["Covered by your code", null])
    expect(keptWords(restored)).toEqual(["Your code is kept.", "It pays for another name of 11 or more letters, for 2 years."])
  })
  it("of a paid order has no code to pay for it", () => {
    expect(codeCover(record())).toBeNull()
    expect(codeCover(record({ method: "balance" }))).toBeNull()
  })
  it("of a code order is barred only for a name shorter than its code covers, whatever the name costs", () => {
    expect(moveBar(coded(), "alice1bak", 10000)).toBeNull()
    expect(moveBar(coded(), "alice1ba", 1)).toBe("uncovered")
  })
  it("of a paid order is barred only for a name dearer than the order is worth, whatever its length", () => {
    expect(moveBar(record(), "alice2", 1500)).toBeNull()
    expect(moveBar(record(), "alice2", 1501)).toBe("dearer")
  })
  it("of a code order says its code pays, or why it does not, never naming money", () => {
    expect(moveHint(coded(), "alice1bak", 10000)).toEqual(["Covered by your code", null])
    expect(moveHint(coded(), "alice2", 20000)).toEqual(["Your code pays for a name of 9 or more letters.", "This name has 6."])
  })
  it("of a paid order says what its payment covers", () => {
    expect(moveHint(record(), "alice2", 1500)).toEqual(["Covered by your payment", null])
    expect(moveHint(record(), "alice2", 1000)).toEqual(["Uses $10 of your $15; the rest stays as your balance.", null])
    expect(moveHint(record(), "alice2", 2000)).toEqual(["This name costs more than the $15 your order is worth.", null])
  })
  it("opens saying what the order keeps: its code, or its payment", () => {
    expect(keptWords(coded())).toEqual(["Your code is kept.", "It pays for another name of 9 or more letters, for 2 years."])
    expect(keptWords(record())).toEqual(["Your payment is kept: $15.", "Choose another name of up to $15; nothing more is charged."])
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
  const unpaid = (invoice: OrderRead["invoice"]): OrderRead => ({ phase: "unpaid", invoice })

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
    for (const live of [unpaid("open"), { phase: "queued", invoice: "paid" }, { phase: "committed", invoice: null }] as OrderRead[]) {
      const { asked, read } = reader({ r2: live, r3: unpaid("expired") })
      expect(await ownOrders([closed, open, older], read), JSON.stringify(live)).toEqual({ open, closed })
      expect(asked, "nothing older is read").toEqual(["r2"])
    }
  })
  it("takes a registered, taken or failed order as neither open nor closed", async () => {
    for (const phase of ["registered", "taken", "failed"] as const) {
      expect(await ownOrders([order("r1")], reader({ r1: { phase, invoice: "paid" } }).read), phase).toEqual({ open: null, closed: null })
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
  const PAYING = "SN-PPPPP-PPPPP-PPPPP-PPPPP-PPPPP-PPPPP"
  const CLOSED = "SN-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC"
  it("leaves a new name code to the code step when nothing names one", () => {
    expect(orderCode(null, null)).toEqual({ ownerCode: null, saved: false })
  })
  it("keeps a closed order's name code, which the buyer saved already", () => {
    expect(orderCode(null, CLOSED)).toEqual({ ownerCode: CLOSED, saved: true })
  })
  it("never overrides the name code of the balance that pays, which the buyer is asked to save", () => {
    expect(orderCode(PAYING, null)).toEqual({ ownerCode: PAYING, saved: false })
    expect(orderCode(PAYING, CLOSED)).toEqual({ ownerCode: PAYING, saved: false })
  })
  it("takes the paying code as saved when it is the closed order's own", () => {
    expect(orderCode(CLOSED, CLOSED)).toEqual({ ownerCode: CLOSED, saved: true })
  })
})

describe("codes-only mode", () => {
  const CODE = { display: "SN7-AAAAA-BBBBB-CCCCC", minLength: 7, years: 2 }

  it("locks a plain search until the tab holds a prepaid code", () => {
    expect(searchLocked(true, open(), null)).toBe(true)
    expect(searchLocked(true, open(), CODE)).toBe(false)
    expect(searchLocked(false, open(), null), "open mode searches without a code").toBe(false)
  })
  it("leaves a code order's move to another name open, which its own code pays for", () => {
    const moving = open({ opening: "retarget", retarget: record({ method: "code", prepaidCode: CODE.display, paid: 0 }) })
    expect(searchLocked(true, moving, null)).toBe(false)
    expect(coverOf(true, moving, CODE), "the move's own code bounds its names").toBeNull()
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
    expect(returnedTo(s, "plain", "alice1", [])).toEqual(initialSearch())
  })
})
