import { describe, expect, it } from "vitest"
import {
  awaitsCode, balanceHeld, changeOf, codeEntry, heldForThisName, methodOf, methodsFor, payWaits, tookOwnOrder, type CheckoutEvent, type CheckoutKind, type CheckoutState, covered, FALLBACK_METHOD, initialState, reduce, screenOf, split, stepFor,
} from "../src/screens/checkout.ts"
import { timeOf } from "../src/format.ts"
import { BALANCE_READ_MS, CONFIRMING_READ_MS, heldWords, holderStill, holdWait } from "../src/screens/balance.ts"
import type { InvoiceView } from "../src/api.ts"
import { NO_LEAD } from "../src/screens/hold.ts"
import type { Checkout } from "../src/session.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const CODE = { display: "SN6-AAAAA-BBBBB-CCCCC", minLength: 6, years: 3 }
const WAITING = { registrationId: "reg-0", invoiceId: "inv-0" }
const OPEN_ORDER = { invoiceId: "inv-9", confirming: false }
const TERMS = { version: "2026-10-23", url: "https://simplex.chat/" }
const NEWER = { version: "2026-11-01", url: "https://simplex.chat/terms" }
const BAKERS = { for: "bakers and pastry chefs" }

function checkout(change: Partial<Checkout> = {}): Checkout {
  return {
    label: "alice1", price: 1500, years: 2, termStart: Date.UTC(2027, 0, 1) / 1000, chain: CHAIN, terms: TERMS, community: null, contact: "", channel: "", method: "btc", code: null, balance: null, ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF",
    saved: true, agreed: false, searchAt: 0, step: "review", ...change,
  }
}

const opened = (s: CheckoutState, change: Partial<Extract<CheckoutEvent, { type: "opened" }>> = {}): CheckoutEvent =>
  ({ type: "opened", step: s.step, checkout: s.checkout, sending: false, waiting: null, hold: null, ...change })
const open = (change: Partial<CheckoutState> = {}): CheckoutState => ({ ...initialState(checkout(), "review", false), ...change })
const CONTACT = "https://smp8.simplex.im/a#x"
const CHANNEL = "https://smp9.simplex.im/c#y"

const STATES: Record<CheckoutKind, CheckoutState> = {
  links: open({ step: "links", checkout: checkout({ saved: false }) }),
  code: open({ step: "code", checkout: checkout({ saved: false }) }),
  review: open(),
  "status:price-changed": open({ checkout: checkout({ price: 2500 }), refusal: "price-changed" }),
  "status:too-many": open({ hold: { until: NOW + 30_000, lead: NO_LEAD }, refusal: "too-many" }),
  "status:failed": open({ refusal: "failed" }),
  "status:taken": open({ refusal: "taken" }),
  "status:codes-only": open({ refusal: "codes-only" }),
}

describe("screenOf", () => {
  const cases: [string, CheckoutState, CheckoutKind][] = [
    ["the links step", STATES.links, "links"],
    ["the name code step", STATES.code, "code"],
    ["the review", open(), "review"],
    ["the review with its order on its way", open({ sending: true, busy: true }), "review"],
    ["the review with a code that pays", open({ checkout: checkout({ code: CODE }) }), "review"],
    ["the review during a wait", open({ hold: { until: NOW + 5000, lead: NO_LEAD } }), "review"],
    ["an order refused for a changed price", STATES["status:price-changed"], "status:price-changed"],
    ["an order that met a rate limit", STATES["status:too-many"], "status:too-many"],
    ["an order that did not go through", STATES["status:failed"], "status:failed"],
    ["an order for a name registered meanwhile", STATES["status:taken"], "status:taken"],
    ["an order the service takes only with a code for now", STATES["status:codes-only"], "status:codes-only"],
  ]
  it.each(cases)("%s", (_, state, kind) => {
    expect(screenOf(state)).toBe(kind)
  })
  it("is the step opened until the service refuses the order", () => {
    expect(screenOf(initialState(checkout(), "review", false))).toBe("review")
    expect(screenOf(reduce(initialState(checkout(), "review", false), { type: "order-refused", reason: "failed" }))).toBe("status:failed")
    expect(screenOf(reduce(initialState(checkout(), "review", false), { type: "hold-started", until: 5 }))).toBe("status:too-many")
  })
  it("a step opened anew ends the refusal the review showed", () => {
    const refused = reduce(open(), { type: "order-refused", reason: "failed" })
    expect(screenOf(reduce(refused, opened(refused, { step: "links" })))).toBe("links")
  })
  it("a code refused by the service stays on the review, which then pays another way", () => {
    const refused = reduce(initialState(checkout({ code: CODE }), "review", false), { type: "order-refused", reason: "code", error: "This code was already used." })
    expect(refused.checkout).toMatchObject({ code: null, codeError: "This code was already used." })
    expect(screenOf(refused)).toBe("review")
  })
})

describe("changeOf", () => {
  const s = STATES.review
  it("gives each change of the stored checkout", () => {
    expect(changeOf(s, { type: "link-set", kind: "contact", link: CONTACT })).toEqual({ contact: CONTACT })
    expect(changeOf(s, { type: "link-set", kind: "channel", link: CHANNEL })).toEqual({ channel: CHANNEL })
    expect(changeOf(s, { type: "saved", saved: false })).toEqual({ saved: false })
    expect(changeOf(s, { type: "agreed", agreed: true })).toEqual({ agreed: true })
    expect(changeOf(s, { type: "method-chosen", method: "xmr" })).toEqual({ method: "xmr" })
    expect(changeOf(s, { type: "order-refused", reason: "code", error: "This code was already used." })).toEqual({ code: null, codeError: "This code was already used." })
    expect(changeOf(s, { type: "price-changed", price: 2500 })).toEqual({ price: 2500 })
  })
  it("a method refused marks it unavailable and chooses the next one", () => {
    for (const method of ["card", "btc", "xmr"] as const) {
      expect(changeOf(open({ checkout: checkout({ method }) }), { type: "order-refused", reason: "method" })).toEqual({ unavailable: method, method: FALLBACK_METHOD[method] })
    }
    expect(FALLBACK_METHOD).toEqual({ card: "btc", btc: "xmr", xmr: "btc" })
  })
  it("a link is written even when the state has it, as a field saves it again before the page takes the first save", () => {
    expect(changeOf(open({ checkout: checkout({ contact: CONTACT }) }), { type: "link-set", kind: "contact", link: CONTACT })).toEqual({ contact: CONTACT })
  })
  it("the method already chosen, or one unavailable, changes nothing", () => {
    expect(changeOf(s, { type: "method-chosen", method: "btc" })).toBeNull()
    expect(changeOf(open({ checkout: checkout({ unavailable: "card" }) }), { type: "method-chosen", method: "card" })).toBeNull()
  })
  it("events that are not the stored checkout's change nothing in it", () => {
    const others: CheckoutEvent[] = [opened(s), { type: "waiting-settled" }, { type: "open-order-seen", order: OPEN_ORDER },
      { type: "send-started" }, { type: "order-refused", reason: "failed" }, { type: "order-refused", reason: "taken" }, { type: "hold-started", until: NOW }, { type: "hold-ended" }]
    for (const e of others) expect(changeOf(s, e), e.type).toBeNull()
  })
})

describe("reduce", () => {
  const s = STATES.review

  it("opened takes the checkout as stored and what the tab knew, ending a refusal and the page's own send", () => {
    const stored = checkout({ method: "card" })
    const refused = { ...s, refusal: "too-many" as const, busy: true, sending: true, openOrder: OPEN_ORDER }
    expect(reduce(refused, opened(s, { checkout: stored, sending: true, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD } }))).toEqual({
      ...refused, checkout: stored, sending: true, busy: false, waiting: WAITING, hold: { until: NOW + 1000, lead: NO_LEAD }, refusal: null,
    })
  })
  it("opened takes the step the page is on", () => {
    expect(reduce(s, opened(s, { step: "code" })).step).toBe("code")
  })
  it("link-set keeps the link typed, an emptied field too", () => {
    const links = STATES.links
    const set = reduce(links, { type: "link-set", kind: "contact", link: CONTACT })
    expect(set).toEqual({ ...links, checkout: { ...links.checkout, contact: CONTACT } })
    expect(reduce(set, { type: "link-set", kind: "contact", link: "" })).toEqual(links)
  })
  it("saved ticks and unticks the box that lets the buyer go on to the review", () => {
    const code = STATES.code
    const ticked = reduce(code, { type: "saved", saved: true })
    expect(ticked).toEqual({ ...code, checkout: { ...code.checkout, saved: true } })
    expect(reduce(ticked, { type: "saved", saved: false })).toEqual(code)
  })
  it("agreed ticks and unticks the terms box that lets the buyer send the order", () => {
    const review = STATES.review
    const ticked = reduce(review, { type: "agreed", agreed: true })
    expect(ticked).toEqual({ ...review, checkout: { ...review.checkout, agreed: true } })
    expect(reduce(ticked, { type: "agreed", agreed: false })).toEqual(review)
  })
  it("terms-changed takes the terms and community entry the service gave, unticks the box and says the terms changed, ending the send", () => {
    const sending = reduce({ ...s, checkout: { ...s.checkout, agreed: true } }, { type: "send-started" })
    const changed = reduce(sending, { type: "terms-changed", terms: NEWER, community: BAKERS })
    expect(changed).toEqual({ ...s, checkout: { ...s.checkout, terms: NEWER, community: BAKERS, agreed: false, termsChanged: true } })
    expect(screenOf(changed)).toBe("review")
  })
  it("agreed after the terms changed ends the notice, which stays off if the box is unticked again", () => {
    const changed = reduce(s, { type: "terms-changed", terms: NEWER, community: null })
    const ticked = reduce(changed, { type: "agreed", agreed: true })
    expect(ticked.checkout).toMatchObject({ terms: NEWER, agreed: true, termsChanged: undefined })
    expect(reduce(ticked, { type: "agreed", agreed: false }).checkout).toMatchObject({ agreed: false, termsChanged: undefined })
  })
  it("opened keeps the code the tab's checkout carries, as Back and Register for the same name give it", () => {
    expect(reduce(s, opened(s, { checkout: checkout({ code: CODE }) }))).toEqual({ ...s, checkout: checkout({ code: CODE }) })
  })
  it("method-chosen chooses the method", () => {
    expect(reduce(s, { type: "method-chosen", method: "card" }).checkout).toEqual(checkout({ method: "card" }))
  })
  it("method-chosen for the method chosen, or one unavailable, keeps the state", () => {
    expect(reduce(s, { type: "method-chosen", method: "btc" })).toBe(s)
    const off = open({ checkout: checkout({ unavailable: "card" }) })
    expect(reduce(off, { type: "method-chosen", method: "card" })).toBe(off)
  })
  it("waiting-settled lets the card order that blocked a second one go", () => {
    expect(reduce({ ...s, waiting: WAITING }, { type: "waiting-settled" })).toEqual(s)
  })
  it("open-order-seen points at an unpaid invoice", () => {
    expect(reduce(s, { type: "open-order-seen", order: OPEN_ORDER })).toEqual({ ...s, openOrder: OPEN_ORDER })
  })
  it("open-order-seen follows that invoice: confirming, then paid or closed, when nothing is pointed at", () => {
    const pointed = reduce(s, { type: "open-order-seen", order: OPEN_ORDER })
    const confirming = reduce(pointed, { type: "open-order-seen", order: { ...OPEN_ORDER, confirming: true } })
    expect(confirming.openOrder).toEqual({ ...OPEN_ORDER, confirming: true })
    expect(reduce(confirming, { type: "open-order-seen", order: null })).toEqual(s)
  })
  it("send-started marks the order on its way from this page", () => {
    expect(reduce(s, { type: "send-started" })).toEqual({ ...s, sending: true, busy: true })
  })
  it("order-refused for the code takes it off and says why, on the page it was sent from", () => {
    const sent = { ...s, sending: true, busy: true, checkout: checkout({ code: CODE }) }
    expect(reduce(sent, { type: "order-refused", reason: "code", error: "This code was already used." }))
      .toEqual({ ...s, checkout: checkout({ code: null, codeError: "This code was already used." }) })
  })
  it("order-refused for the method marks it unavailable and chooses another", () => {
    const sent = { ...s, sending: true, busy: true, checkout: checkout({ method: "card" }) }
    expect(reduce(sent, { type: "order-refused", reason: "method" })).toEqual({ ...s, checkout: checkout({ method: "btc", unavailable: "card" }) })
  })
  it("order-refused with no reason the checkout answers says it did not go through", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "order-refused", reason: "failed" })).toEqual({ ...s, refusal: "failed" })
  })
  it("order-refused for a name registered meanwhile says so, with the checkout as it was", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "order-refused", reason: "taken" })).toEqual({ ...s, refusal: "taken" })
  })
  it("price-changed keeps the new price and says so", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "price-changed", price: 2500 })).toEqual({ ...s, checkout: checkout({ price: 2500 }), refusal: "price-changed" })
  })
  it("hold-started holds the tab and says the order met a rate limit", () => {
    expect(reduce({ ...s, sending: true, busy: true }, { type: "hold-started", until: NOW + 30_000 })).toEqual({ ...s, hold: { until: NOW + 30_000, lead: NO_LEAD }, refusal: "too-many" })
  })
  it("hold-started with a shorter wait than the one running keeps the longer one", () => {
    expect(reduce({ ...s, hold: { until: NOW + 60_000, lead: NO_LEAD } }, { type: "hold-started", until: NOW + 30_000 }).hold).toEqual({ until: NOW + 60_000, lead: NO_LEAD })
  })
  it("hold-ended ends the wait, on the page that met it too", () => {
    expect(reduce(STATES["status:too-many"], { type: "hold-ended" })).toEqual({ ...STATES["status:too-many"], hold: null })
  })
  it("an invoice pointed at while the order is on its way stays pointed at once the order is refused", () => {
    const sent = reduce(s, { type: "send-started" })
    const failed = reduce(reduce(sent, { type: "open-order-seen", order: OPEN_ORDER }), { type: "order-refused", reason: "failed" })
    expect(failed).toEqual({ ...s, openOrder: OPEN_ORDER, refusal: "failed" })
  })
})

describe("a code entered on the review", () => {
  const OTHER = { display: "SN6-DDDDD-EEEEE-FFFFF", minLength: 6, years: 5 }
  const BALANCE = { source: "reg-1", amount: 500, held: false, heldUntil: null }
  const opened = reduce(open(), { type: "code-opened" })

  it("is offered as a link where the order is paid, never where the tab's code or a balance pays it", () => {
    expect(codeEntry(checkout(), false)).toBe("link")
    expect(codeEntry(checkout({ codeError: "This code was already used." }), false), "after the service refused a code").toBe("link")
    expect(codeEntry(checkout({ code: CODE }), false)).toBeNull()
    expect(codeEntry(checkout({ balance: BALANCE }), false)).toBeNull()
  })
  it("opens its field in place of the link, which stays open in the stored checkout and waits for a code", () => {
    expect(changeOf(open(), { type: "code-opened" })).toEqual({ codeHere: true })
    expect(codeEntry(opened.checkout, false)).toBe("field")
    expect(awaitsCode(opened.checkout, false)).toBe(true)
    expect(awaitsCode(checkout(), false), "a paid order").toBe(false)
    expect(awaitsCode(checkout({ code: CODE }), false), "the tab's code").toBe(false)
    expect(changeOf(open({ checkout: checkout({ code: CODE }) }), { type: "code-opened" }), "no field over the tab's code").toBeNull()
  })
  it("a code that covers the name makes the order a code order, and anything else typed after it makes it paid again", () => {
    const coded = reduce(opened, { type: "code-heard", code: OTHER })
    expect(coded.checkout).toMatchObject({ code: OTHER, codeHere: true })
    expect(codeEntry(coded.checkout, false), "the field stays to remove the code").toBe("field")
    expect(awaitsCode(coded.checkout, false)).toBe(false)
    expect(reduce(coded, { type: "code-heard", code: OTHER }), "the same code again changes nothing").toBe(coded)
    expect(reduce(coded, { type: "code-heard", code: null }).checkout).toMatchObject({ code: null, codeHere: true })
  })
  it("a code heard ends the service's refusal of the last one", () => {
    const refused = reduce(open({ checkout: checkout({ codeError: "This code was already used.", codeHere: true }) }), { type: "code-heard", code: OTHER })
    expect(refused.checkout.codeError).toBeUndefined()
  })
  it("a field never opened changes nothing, so the tab's code stays", () => {
    const tabs = open({ checkout: checkout({ code: CODE }) })
    expect(changeOf(tabs, { type: "code-heard", code: null })).toBeNull()
    expect(changeOf(tabs, { type: "code-heard", code: OTHER })).toBeNull()
  })
  it("removed, it takes the code off and closes the field, back to the paid choices", () => {
    const removed = reduce(reduce(opened, { type: "code-heard", code: OTHER }), { type: "code-removed" })
    expect(removed.checkout.code).toBeNull()
    expect(removed.checkout.codeHere).toBeUndefined()
    expect(codeEntry(removed.checkout, false)).toBe("link")
    expect(awaitsCode(removed.checkout, false)).toBe(false)
    expect(changeOf(open({ checkout: checkout({ code: CODE }) }), { type: "code-removed" }), "the tab's code is taken off in the header").toBeNull()
  })
  it("refused by the service as the order is sent, the code is taken off and the field closed", () => {
    const sent = reduce(reduce(opened, { type: "code-heard", code: OTHER }), { type: "send-started" })
    const refused = reduce(sent, { type: "order-refused", reason: "code", error: "This code was already used." })
    expect(refused.checkout).toMatchObject({ code: null, codeError: "This code was already used." })
    expect(codeEntry(refused.checkout, false)).toBe("link")
    expect(reduce(refused, { type: "code-opened" }).checkout, "another code opened ends the refusal's line").toMatchObject({ codeHere: true, codeError: undefined })
  })
})

describe("stepFor", () => {
  it("opens each step asked for once the name code is saved", () => {
    for (const step of ["links", "code", "review"] as const) expect(stepFor(checkout(), step)).toBe(step)
  })
  it("sends a review asked for before the code is saved, or made, to the name code step", () => {
    expect(stepFor(checkout({ saved: false }), "review")).toBe("code")
    expect(stepFor(checkout({ ownerCode: null, saved: false }), "review")).toBe("code")
    expect(stepFor(checkout({ ownerCode: null, saved: true }), "review")).toBe("code")
  })
  it("leaves the links and the code step open before the code is saved", () => {
    expect(stepFor(checkout({ saved: false }), "links")).toBe("links")
    expect(stepFor(checkout({ ownerCode: null, saved: false }), "code")).toBe("code")
  })
})

describe("initialState", () => {
  it("starts on its step with the checkout as stored and nothing else known", () => {
    expect(initialState(checkout(), "links", false)).toEqual({
      step: "links", checkout: checkout(), codesOnly: false, sending: false, busy: false, waiting: null, openOrder: null, hold: null, refusal: null, holder: null,
    })
  })
})

describe("a balance", () => {
  const BALANCE = { source: "reg-taken", amount: 1000, held: false, heldUntil: null }
  const read = (amount: number, held = false) => ({ amount, held, heldUntil: held ? "2026-10-17T12:30:00Z" : null, refunded: 0 })
  it("pays what it holds of the price, and the rest is left to pay", () => {
    expect(split(checkout({ balance: BALANCE }))).toEqual({ fromBalance: 1000, rest: 500 })
    expect(covered(checkout({ balance: BALANCE }))).toBe(false)
  })
  it("covers a price up to what it holds, paying the price only", () => {
    expect(split(checkout({ balance: { ...BALANCE, amount: 1500 } }))).toEqual({ fromBalance: 1500, rest: 0 })
    expect(split(checkout({ balance: { ...BALANCE, amount: 4000 } }))).toEqual({ fromBalance: 1500, rest: 0 })
    expect(covered(checkout({ balance: { ...BALANCE, amount: 4000 } }))).toBe(true)
  })
  it("pays nothing without a balance, which leaves the whole price", () => {
    expect(split(checkout())).toEqual({ fromBalance: 0, rest: 1500 })
    expect(covered(checkout())).toBe(false)
  })
  it("refused as changed takes the balance the service has now and says how it changed, ending the send", () => {
    const sending = reduce(open({ checkout: checkout({ balance: BALANCE }) }), { type: "send-started" })
    const changed = reduce(sending, { type: "balance-changed", balance: read(1500) })
    expect([changed.sending, changed.busy, changed.refusal]).toEqual([false, false, null])
    expect([changed.checkout.balance, changed.checkout.balanceChange]).toEqual([{ ...BALANCE, amount: 1500 }, "changed"])
    expect(covered(changed.checkout), "the balance now covers the price").toBe(true)
    const held = reduce(sending, { type: "balance-changed", balance: read(1000, true) })
    expect([held.checkout.balance, held.checkout.balanceChange], "the same amount, held").toEqual([{ ...BALANCE, held: true, heldUntil: "2026-10-17T12:30:00Z" }, undefined])
    expect([balanceHeld(held.checkout), held.sending]).toEqual([true, false])
  })
  it("refused as gone, spent, refunded or not there, leaves the order to be paid in full", () => {
    const s = open({ checkout: checkout({ balance: BALANCE }) })
    for (const balance of [null, read(0)]) {
      const gone = reduce(s, { type: "balance-changed", balance })
      expect([gone.checkout.balance, gone.checkout.balanceChange, split(gone.checkout).rest]).toEqual([null, "gone", 1500])
    }
  })
  it("read again as the review opens and while it is held, takes a hold, its release and a new amount, and changes nothing when it is as it was", () => {
    const s = open({ checkout: checkout({ balance: BALANCE }) })
    expect(reduce(s, { type: "balance-read", balance: read(1000) }), "as it was").toBe(s)
    const held = reduce(s, { type: "balance-read", balance: read(1000, true) })
    expect([balanceHeld(held.checkout), held.checkout.balanceChange]).toEqual([true, undefined])
    const released = reduce(held, { type: "balance-read", balance: read(1000) })
    expect([balanceHeld(released.checkout), released.checkout.balance]).toEqual([false, BALANCE])
    expect(reduce(held, { type: "balance-read", balance: read(0) }).checkout, "spent by the invoice that held it").toMatchObject({ balance: null, balanceChange: "gone" })
    expect(reduce(s, { type: "balance-read", balance: read(600) }).checkout).toMatchObject({ balance: { ...BALANCE, amount: 600 }, balanceChange: "changed" })
    const removed = open({ checkout: checkout() })
    expect(reduce(removed, { type: "balance-read", balance: read(1000, true) }), "a balance taken off meanwhile").toBe(removed)
  })
})

describe("holderStill", () => {
  const holder = (change: Partial<InvoiceView>) => ({ invoiceId: "inv-9", status: "open", amount: 1000, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", cryptoCurrency: "btc",
    cryptoAmount: "0.0002", cryptoAmountPaid: "0", ...change }) as InvoiceView
  const UNTIL = "2026-10-17T12:30:00Z"
  it("follows an open holder that nothing reached", () => {
    expect(holderStill(holder({}), UNTIL)).toBe(true)
  })
  it("reads the view again once money reaches the holder whose hold the page shows with a time, or the holder closes", () => {
    expect(holderStill(holder({ cryptoAmountPaid: "0.0001" }), UNTIL)).toBe(false)
    expect(holderStill(holder({ paidInFull: true }), UNTIL)).toBe(false)
    expect(holderStill(holder({ status: "expired" }), UNTIL)).toBe(false)
    expect(holderStill(null, UNTIL), "a holder the service forgot").toBe(false)
  })
  it("keeps following a holder already shown as confirming", () => {
    expect(holderStill(holder({ paidInFull: true }), null)).toBe(true)
  })
})

describe("holdWait", () => {
  const AT = Date.parse("2026-10-17T12:00:00Z")
  it("reads a hold again as it can end, by its holder's expiry", () => {
    expect(holdWait("2026-10-17T12:10:00Z", false, AT, AT + 1000)).toBe(10 * 60_000 - 1000)
  })
  it("never reads sooner than the minimum: a hold past its end, a holder followed until it closed at once", () => {
    expect(holdWait("2026-10-17T11:00:00Z", false, AT, AT)).toBe(BALANCE_READ_MS)
    expect(holdWait("2026-10-17T12:10:00Z", true, AT, AT + 200)).toBe(BALANCE_READ_MS - 200)
    expect(holdWait(null, true, AT, AT + 60_000), "a holder followed for a minute").toBe(0)
  })
  it("reads at a pause while the holder's payment is being confirmed, which has no end", () => {
    expect(holdWait(null, false, AT, AT)).toBe(CONFIRMING_READ_MS)
  })
  it("says until when a hold lasts, or that the holder's payment is being confirmed", () => {
    expect(heldWords("2026-10-17T12:10:00Z")).toBe(`until ${timeOf(Date.parse("2026-10-17T12:10:00Z"))}`)
    expect(heldWords(null)).toBe("while its payment is being confirmed")
  })
})

describe("a held balance and Pay", () => {
  const HELD = { source: "reg-taken", amount: 1000, held: true, heldUntil: "2026-10-17T12:30:00Z" }
  const holder = (label: string) => ({ label, tld: "simplex", url: "/?order=inv-9" })
  it("waits while another name's order holds it, or an order find has not named yet", () => {
    expect(payWaits(open({ checkout: checkout({ balance: HELD }) }))).toBe(true)
    expect(payWaits(open({ checkout: checkout({ balance: HELD }), holder: holder("bakery7") }))).toBe(true)
  })
  it("stays on while this name's own order holds it, as after a spend whose answer was lost, which sending again opens", () => {
    const own = open({ checkout: checkout({ balance: HELD }), holder: holder("alice1") })
    expect([heldForThisName(own), payWaits(own)]).toEqual([true, false])
    expect(heldForThisName(open({ checkout: checkout({ balance: { ...HELD, held: false, heldUntil: null } }), holder: holder("alice1") })), "a balance free again").toBe(false)
  })
})

describe("tookOwnOrder", () => {
  const own = { label: "alice1", tld: "simplex", url: "/?registration=reg-9" }
  it("is a balance gone to an order of this name, as a covered spend whose answer was lost makes", () => {
    expect(tookOwnOrder(open({ checkout: checkout({ balance: null, balanceChange: "gone" }), holder: own }))).toBe(true)
  })
  it("is not a balance gone elsewhere, one still there, or one gone before its order is found", () => {
    expect(tookOwnOrder(open({ checkout: checkout({ balance: null, balanceChange: "gone" }), holder: { ...own, label: "bakery7" } }))).toBe(false)
    expect(tookOwnOrder(open({ checkout: checkout({ balance: null, balanceChange: "gone" }) }))).toBe(false)
    expect(tookOwnOrder(open({ checkout: checkout({ balance: { source: "s", amount: 500, held: false, heldUntil: null }, balanceChange: "changed" }), holder: own }))).toBe(false)
  })
})

describe("methods for a small difference", () => {
  const BALANCE = { source: "reg-taken", amount: 1460, held: false, heldUntil: null }
  it("leaves out the card for a difference below its least charge, paying in Bitcoin what was chosen as card", () => {
    const small = checkout({ balance: BALANCE, method: "card" })
    expect([methodsFor(small), methodOf(small)]).toEqual([["btc", "xmr"], "btc"])
    expect(methodOf(checkout({ balance: BALANCE, method: "xmr" }))).toBe("xmr")
  })
  it("offers every method for a difference of the least charge or more, and for an order no balance pays", () => {
    expect(methodsFor(checkout({ balance: { ...BALANCE, amount: 1450 }, method: "card" }))).toEqual(["card", "btc", "xmr"])
    expect(methodsFor(checkout({ method: "card" }))).toEqual(["card", "btc", "xmr"])
    expect(methodOf(checkout({ method: "card" }))).toBe("card")
  })
  it("falls back from the method in use, not a card it no longer offers, when that one is down", () => {
    const s = open({ checkout: checkout({ balance: BALANCE, method: "card" }) })
    expect(changeOf(s, { type: "order-refused", reason: "method" })).toEqual({ unavailable: "btc", method: "xmr" })
  })
})

describe("codes-only mode", () => {
  const OTHER = { display: "SN6-DDDDD-EEEEE-FFFFF", minLength: 6, years: 5 }
  const codes = (change: Partial<Checkout> = {}) => initialState(checkout(change), "review", true)

  it("keeps the mode it opened in", () => {
    expect(codes().codesOnly).toBe(true)
    expect(initialState(checkout(), "review", false).codesOnly).toBe(false)
  })
  it("pays with the tab's code alone, with no field or link for another", () => {
    expect(codeEntry(checkout({ code: CODE }), true)).toBeNull()
    expect(awaitsCode(checkout({ code: CODE }), true)).toBe(false)
  })
  it("without a code, shows the code field in place of the payment choices and waits for a code there", () => {
    expect(codeEntry(checkout(), true)).toBe("field")
    expect(awaitsCode(checkout(), true)).toBe(true)
    expect(codeEntry(checkout({ codeError: "This code was already used." }), true), "after the service refused a code").toBe("field")
  })
  it("takes a covering code heard in that field, which keeps the field open", () => {
    const coded = reduce(codes(), { type: "code-heard", code: OTHER })
    expect(coded.checkout).toMatchObject({ code: OTHER, codeHere: true })
    expect(codeEntry(coded.checkout, true)).toBe("field")
    expect(awaitsCode(coded.checkout, true)).toBe(false)
    const unheard = reduce(coded, { type: "code-heard", code: null })
    expect(unheard.checkout.code).toBeNull()
    expect(awaitsCode(unheard.checkout, true)).toBe(true)
  })
  it("ends the service's refusal of the last code once another is heard", () => {
    const refused = reduce(codes({ code: CODE }), { type: "order-refused", reason: "code", error: "This code was already used." })
    expect(codeEntry(refused.checkout, true)).toBe("field")
    expect(reduce(refused, { type: "code-heard", code: OTHER }).checkout).toMatchObject({ code: OTHER, codeError: undefined })
  })
  it("leaves the tab's code alone when nothing was typed", () => {
    expect(changeOf(codes({ code: CODE }), { type: "code-heard", code: null })).toBeNull()
  })
  it("says an order refused for codes only on a screen of its own, changing nothing in the checkout", () => {
    const sent = reduce(open(), { type: "send-started" })
    const refused = reduce(sent, { type: "order-refused", reason: "codes-only" })
    expect(screenOf(refused)).toBe("status:codes-only")
    expect(refused).toMatchObject({ sending: false, busy: false, checkout: sent.checkout })
    expect(screenOf(reduce(refused, opened(refused))), "the review opened again").toBe("review")
  })
})
