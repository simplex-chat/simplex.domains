import { describe, expect, it } from "vitest"
import type { InvoiceView, RegistrationView } from "../src/api.ts"
import { NO_LEAD } from "../src/screens/hold.ts"
import {
  CARD_SLOW_MS, closedBalance, type ClosedCase, closedCase, costOf, failedAlert, failedLead, finished, newInvoiceBy, initialState, type Note, type OrderEvent, type OrderKind,
  type OrderState, reduce, refusalsOf, RETRY_MS, retryRefusal, REVEAL_ATTEMPTS, revealDue, revealKey, sameStep, screenOf, spendCovers, STALL_MARGIN_MS, stalledAt, TX_STALL_MS, unreadDelay, wakeAt,
} from "../src/screens/order.ts"
import type { CodeRefusal, OrderRecord } from "../src/store.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const COMMITMENT = "0x9c1185a5c5e9fc54612808977ee8f548b2258d31b6c0a94e1ab9e1e8c4d6a0f1"
const USED: Note = { tone: "warn", icon: "key", title: "Your code was used for another name", text: "A code registers one name only." }
const WARN: Note = { tone: "warn", icon: "alert", title: null, text: "The invoice could not be cancelled now. Try again in a moment." }

function registration(change: Partial<RegistrationView> = {}): RegistrationView {
  return {
    ...CHAIN, id: "reg-1", version: 1, phase: "unpaid", labelHash: "0x4f1b", label: null, owner: OWNER, commitment: COMMITMENT, sealed: "sealed-box", years: 2, duration: 2 * 365 * 86400,
    price: 1500, fromBalance: 0, balance: null, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, moves: 0, intentNonce: null, unread: [], expiresAt: null, error: null, linksRefused: false, latePayment: null,
    community: null, terms: "2026-10-23", ...change,
  }
}

const crypto = (change: Partial<InvoiceView> = {}, reg: Partial<RegistrationView> = {}): InvoiceView => ({
  invoiceId: "inv-1", status: "open", amount: 1500, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", registration: registration(reg),
  address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", cryptoAmount: "0.00025", cryptoCurrency: "btc", cryptoAmountPaid: "0", cryptoAmountDue: "0.00025",
  paidInFull: false, requiredConfirmations: 1, ...change,
})

const card = (change: Partial<InvoiceView> = {}, reg: Partial<RegistrationView> = {}): InvoiceView => ({
  invoiceId: "inv-1", status: "open", amount: 1500, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", registration: registration(reg),
  clientSecret: "pi_1_secret_2", cryptoCurrency: "card", amountPaid: 0, ...change,
})

function record(change: Partial<OrderRecord> = {}): OrderRecord {
  return {
    registrationId: "reg-1", invoiceId: "inv-1", label: "alice", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: OWNER, contact: "", channel: "",
    method: "btc", paid: 1500, years: 2, request: { labelHash: "0x4f1b", length: 5, duration: 2 * 365 * 86400, owner: OWNER, commitment: COMMITMENT, sealed: "sealed-box" },
    tld: "simplex", createdAt: "2026-10-17T11:59:00Z", ...change,
  }
}

function read(invoice: InvoiceView | null, view: RegistrationView = invoice!.registration, change: Partial<OrderState> = {}): OrderState {
  return { ...initialState("inv-1", null), seq: 1, now: NOW, invoice, view, record: record(), ...change }
}

const answered = (s: OrderState, next: OrderState): Extract<OrderEvent, { type: "answered" }> =>
  ({ type: "answered", seq: s.seq + 1, now: next.now, invoice: next.invoice, view: next.view!, record: next.record, cardSubmittedAt: next.cardSubmittedAt, reserved: next.reserved })

const submittedAgo = (ms: number) => new Date(NOW - ms).toISOString()
const committed = { phase: "committed", commitTx: "0xc0", revealAfter: NOW / 1000 - 1, revealBefore: NOW / 1000 + 3600, intentNonce: 4 } as const

const SLOW = read(card(), undefined, { record: record({ method: "card" }), cardSubmittedAt: submittedAgo(CARD_SLOW_MS + 1000) })

const STATES: Record<OrderKind, OrderState> = {
  "pay-crypto": read(crypto()),
  "pay-card": read(card(), undefined, { record: record({ method: "card" }) }),
  confirming: read(crypto({ paidInFull: true, cryptoAmountPaid: "0.00025" })),
  registering: read(null, registration({ phase: "committing" })),
  "links-refused": read(null, registration(committed), { record: record({ linksRefused: true }) }),
  registered: read(null, registration({ phase: "registered", label: "alice", registerTx: "0xe9", expiresAt: NOW / 1000 + 63072000 })),
  taken: read(crypto({ status: "paid", paidInFull: true }, { phase: "taken" })),
  failed: read(crypto({ status: "paid", paidInFull: true }, { phase: "failed", error: "The registration ran out of gas" })),
  "not-on-device": read(null, registration({ phase: "committing" }), { record: null }),
  "status:closed": read(crypto({ status: "expired" })),
  "status:card-unconfirmed": read(card(), undefined, { record: record({ method: "card" }), cardFailed: true }),
  "status:paid-by-invoice": read(null, registration(), { reference: "reg-1" }),
  "status:unreadable": initialState("inv-1", null),
  "status:unknown-link": read(crypto({ status: "expired" }), undefined, { gone: true }),
  "status:price-changed": read(crypto({ status: "expired" }), undefined, { price: 2500 }),
}

describe("screenOf", () => {
  const cases: [string, OrderState, OrderKind][] = [
    ["a link the service does not know", STATES["status:unknown-link"], "status:unknown-link"],
    ["a new invoice refused for a changed price", STATES["status:price-changed"], "status:price-changed"],
    ["an order not read yet", initialState("inv-1", null), "status:unreadable"],
    ["an open crypto invoice", STATES["pay-crypto"], "pay-crypto"],
    ["a crypto invoice paid in full", STATES.confirming, "confirming"],
    ["a card invoice with nothing submitted", STATES["pay-card"], "pay-card"],
    ["a card form that did not load", STATES["status:card-unconfirmed"], "status:card-unconfirmed"],
    ["a card submitted a moment ago", read(card(), undefined, { cardSubmittedAt: submittedAgo(1000) }), "confirming"],
    ["a card submitted longer ago than Stripe takes", SLOW, "status:card-unconfirmed"],
    ["a card submitted long ago from a browser without the record", read(card(), undefined, { record: null, cardSubmittedAt: submittedAgo(CARD_SLOW_MS * 2) }), "confirming"],
    ["a card payment the service has seen", read(card({ amountPaid: 1500 })), "confirming"],
    ["a payment after the invoice closed", read(crypto({ status: "paid", paidInFull: true })), "status:closed"],
    ["an invoice cancelled with nothing received", read(crypto({ status: "expired" }), undefined, { record: record({ cancelled: true }) }), "status:closed"],
    ["a cancelled invoice that money reached", read(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }), undefined, { record: record({ cancelled: true }) }), "status:closed"],
    ["an expired invoice with nothing received", STATES["status:closed"], "status:closed"],
    ["a registration link of an unpaid order", STATES["status:paid-by-invoice"], "status:paid-by-invoice"],
    ["a registered order", STATES.registered, "registered"],
    ["a name taken first", STATES.taken, "taken"],
    ["a failed registration", STATES.failed, "failed"],
    ["a failed registration whose links the service refused, as its view says", read(null, registration({ phase: "failed", linksRefused: true })), "links-refused"],
    ["a failed registration whose links this browser saw refused", read(null, registration({ phase: "failed" }), { record: record({ linksRefused: true }) }), "links-refused"],
    ["a failed registration with refused links, seen without the name code", read(null, registration({ phase: "failed", linksRefused: true }), { record: null }), "failed"],
    ["a commit whose links another browser saw refused", read(null, registration({ ...committed, linksRefused: true })), "links-refused"],
    ["a commit in a browser without the name code", STATES["not-on-device"], "not-on-device"],
    ["a commit in the browser with the name code", STATES.registering, "registering"],
    ["a registration being sent, seen without the name code", read(null, registration({ phase: "registering" }), { record: null }), "registering"],
    ["a revealed name, seen without the name code", read(null, registration({ phase: "committed", label: "alice" }), { record: null }), "registering"],
  ]
  it.each(cases)("%s", (_, state, kind) => {
    expect(screenOf(state)).toBe(kind)
  })
})

// all of the amount, which reached the invoice after it closed
const LATE_FULL: Partial<InvoiceView> = { status: "expired", cryptoAmountPaid: "0.00025", cryptoAmountDue: "0", paidInFull: true }

describe("closedCase", () => {
  const cases: [string, ClosedCase, OrderState][] = [
    ["a payment after the invoice closed", "paid-late", read(crypto({ status: "paid", paidInFull: true }))],
    ["a whole payment after the close, credited, which BTCPay keeps expired", "paid-late", read(crypto(LATE_FULL))],
    ["a whole payment after a cancel, credited", "paid-late", read(crypto(LATE_FULL), undefined, { record: record({ cancelled: true }) })],
    ["a whole payment after the close that only support can credit", "paid-late", read(crypto(LATE_FULL, { latePayment: { waiting: "support" } }))],
    ["a whole payment after the close, still confirming", "received", read(crypto(LATE_FULL, { latePayment: { waiting: "confirming" } }))],
    ["a whole payment after the close, confirmed and not yet credited", "received", read(crypto(LATE_FULL, { latePayment: { waiting: "crediting" } }))],
    ["a cancelled invoice that closed with nothing received", "cancelled", read(crypto({ status: "expired" }), undefined, { record: record({ cancelled: true }) })],
    ["an expired invoice that money reached", "received", read(crypto({ status: "expired", cryptoAmountPaid: "0.0001", cryptoAmountDue: "0.00015" }))],
    ["a cancelled invoice that money reached", "received", read(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }), undefined, { record: record({ cancelled: true }) })],
    ["an expired card invoice with nothing paid", "expired", read(card({ status: "expired" }))],
    ["an expired invoice with nothing received", "expired", read(crypto({ status: "expired" }))],
  ]
  it.each(cases)("%s is %s, on the one closed screen", (_, expected, s) => {
    expect(closedCase(s)).toBe(expected)
    expect(screenOf(s)).toBe("status:closed")
  })
  it.each([
    ["an open invoice nobody cancelled", STATES["pay-crypto"]],
    ["a paid invoice whose registration went on", STATES.taken],
    ["a registration link without an invoice", STATES["status:paid-by-invoice"]],
    ["an order not read yet", initialState("inv-1", null)],
  ])("%s is not closed", (_, s) => {
    expect(closedCase(s)).toBeNull()
  })
})

describe("card not confirmed", () => {
  it("a form that failed and a confirmation past CARD_SLOW_MS are one screen", () => {
    const failed = reduce(STATES["pay-card"], { type: "card-failed" })
    expect(screenOf(failed)).toBe("status:card-unconfirmed")
    expect(screenOf(SLOW)).toBe("status:card-unconfirmed")
  })
  it("a form that failed after Stripe saw a payment waits for it rather than offering the form again", () => {
    expect(screenOf(read(card({ amountPaid: 1500 }), undefined, { cardFailed: true }))).toBe("confirming")
  })
})

describe("reduce", () => {
  const paying = STATES["pay-crypto"]

  it("answered takes the newer answer whole", () => {
    const next = read(crypto({ cryptoAmountPaid: "0.0001" }), undefined, { now: NOW + 5000, record: record({ contact: "https://smp8.simplex.im/a#x" }) })
    expect(reduce(paying, answered(paying, next))).toEqual({ ...paying, seq: 2, now: NOW + 5000, invoice: next.invoice, view: next.view, record: next.record, since: { stage: "reg-1 unpaid", at: NOW + 5000 } })
  })
  it("answered to an earlier read changes nothing", () => {
    const later = reduce(paying, answered(paying, STATES.confirming))
    expect(reduce(later, { ...answered(paying, STATES["status:closed"]), seq: 1 })).toBe(later)
  })
  it("record-changed takes this browser's record and card submission", () => {
    expect(reduce(paying, { type: "record-changed", record: null, cardSubmittedAt: submittedAgo(5) })).toEqual({ ...paying, record: null, cardSubmittedAt: submittedAgo(5) })
  })
  it("read-failed keeps what the page knows", () => {
    expect(reduce(paying, { type: "read-failed" })).toBe(paying)
  })
  it("not-found marks the order gone", () => {
    expect(reduce(paying, { type: "not-found" }).gone).toBe(true)
  })
  it("tick moves the page's time on", () => {
    expect(reduce(paying, { type: "tick", now: NOW + 1000 })).toEqual({ ...paying, now: NOW + 1000 })
  })
  it("card-submitted keeps when the card was submitted", () => {
    expect(reduce(STATES["pay-card"], { type: "card-submitted", at: submittedAgo(0) }).cardSubmittedAt).toBe(submittedAgo(0))
  })
  it("card-failed marks the card form failed and shows the card-unconfirmed page", () => {
    const failed = reduce(STATES["pay-card"], { type: "card-failed" })
    expect(failed.cardFailed).toBe(true)
    expect(screenOf(failed)).toBe("status:card-unconfirmed")
  })
  it("card-started marks the card's confirm at work; card-refused ends it with Stripe's words as the note", () => {
    const note: Note = { tone: "danger", icon: "alert", title: null, text: "Your card was declined." }
    const confirming = reduce(STATES["pay-card"], { type: "card-started" })
    expect(confirming).toEqual({ ...STATES["pay-card"], busy: "card" })
    expect(reduce(confirming, { type: "card-refused", note })).toEqual({ ...STATES["pay-card"], note })
  })
  it("card-refused without a note, as for a mistake Stripe shows in its own form, ends the confirm and clears the last note", () => {
    const confirming = reduce({ ...STATES["pay-card"], note: WARN }, { type: "card-started" })
    expect(reduce(confirming, { type: "card-refused", note: null })).toEqual({ ...STATES["pay-card"], note: null })
  })
  it("card-refused of a confirm no longer at work changes nothing", () => {
    expect(reduce(STATES["pay-card"], { type: "card-refused", note: WARN })).toBe(STATES["pay-card"])
  })

  describe("reveal", () => {
    const view = registration(committed)
    const key = revealKey(view)
    const waiting = read(null, view)
    it("reveal-sent marks the commit's reveal on its way, keeping its refusals", () => {
      const refused = { ...waiting, reveal: { key, sending: false, refusals: 2 } }
      expect(reduce(refused, { type: "reveal-sent", key }).reveal).toEqual({ key, sending: true, refusals: 2 })
    })
    it("reveal-sent for another commit starts its count anew", () => {
      const old = { ...waiting, reveal: { key: "reg-1 0xold 3 1", sending: false, refusals: 2 } }
      expect(reduce(old, { type: "reveal-sent", key }).reveal).toEqual({ key, sending: true, refusals: 0 })
    })
    it("reveal-refused counts a refusal", () => {
      const sent = reduce(waiting, { type: "reveal-sent", key })
      expect(reduce(sent, { type: "reveal-refused", key }).reveal).toEqual({ key, sending: false, refusals: 1 })
    })
    it("reveal-failed counts nothing", () => {
      const sent = reduce(waiting, { type: "reveal-sent", key })
      expect(reduce(sent, { type: "reveal-failed", key }).reveal).toEqual({ key, sending: false, refusals: 0 })
    })
    it("an answer about another commit's reveal changes nothing", () => {
      const sent = reduce(waiting, { type: "reveal-sent", key })
      expect(reduce(sent, { type: "reveal-refused", key: "reg-1 0xold 3 1" })).toBe(sent)
    })
    it("reveal-retried forgets the refusals", () => {
      const refused = { ...waiting, reveal: { key, sending: false, refusals: REVEAL_ATTEMPTS } }
      expect(reduce(refused, { type: "reveal-retried" }).reveal).toEqual({ key, sending: false, refusals: 0 })
    })
  })

  describe("actions", () => {
    const failing = { ...STATES.failed, note: WARN }
    const cases: [OrderEvent["type"], OrderEvent["type"], OrderState, OrderState["busy"]][] = [
      ["cancel-started", "cancel-failed", { ...paying, note: WARN }, "cancel"],
      ["reorder-started", "reorder-failed", { ...STATES["status:closed"], note: WARN }, "reorder"],
      ["retry-started", "retry-failed", failing, "retry"],
      ["move-started", "move-failed", { ...STATES["links-refused"], note: WARN }, "move"],
    ]
    it.each(cases)("%s marks the action at work and clears the note; %s ends it with its note", (started, failed, s, busy) => {
      const working = reduce(s, { type: started } as OrderEvent)
      expect(working).toEqual({ ...s, busy, note: null })
      expect(reduce(working, { type: failed, note: WARN, codeRefused: false } as OrderEvent)).toEqual({ ...s, busy: null, note: WARN })
    })
    it("retry-failed for a code refused for good says so, and only for the retry at work", () => {
      const working = reduce(STATES.failed, { type: "retry-started" })
      expect(reduce(working, { type: "retry-failed", note: WARN, codeRefused: true })).toEqual({ ...STATES.failed, note: WARN, codeRefused: true })
      expect(reduce(STATES.failed, { type: "retry-failed", note: WARN, codeRefused: true })).toBe(STATES.failed)
    })
    it("a refusal kept with the order shows with the failed page from its first answer, its Try again off", () => {
      const kept = record({ codeRefusal: "code_used" })
      const opened = reduce(initialState("inv-1", null), answered(initialState("inv-1", null), { ...STATES.failed, record: kept }))
      expect(opened).toMatchObject({ note: USED, codeRefused: true })
      expect(reduce(STATES.failed, { type: "record-changed", record: kept, cardSubmittedAt: null })).toMatchObject({ note: USED, codeRefused: true })
    })
    it("a kept refusal belongs to the failed page and waits out a retry at work", () => {
      const kept = record({ codeRefusal: "code_used" })
      expect(reduce(STATES.registering, { type: "record-changed", record: kept, cardSubmittedAt: null })).toMatchObject({ codeRefused: false, note: null })
      const working = reduce(STATES.failed, { type: "retry-started" })
      expect(reduce(working, { type: "record-changed", record: kept, cardSubmittedAt: null })).toMatchObject({ busy: "retry", codeRefused: false })
      const refused = reduce(STATES.failed, { type: "record-changed", record: kept, cardSubmittedAt: null })
      expect(reduce(refused, { type: "tick", now: NOW + 1000 })).toMatchObject({ codeRefused: true, note: USED })
    })
    it("retryRefusal: each code error of a retry has its note, saying why for each kept for good; all but one held elsewhere are kept", () => {
      expect(retryRefusal("code_used")).toEqual({ note: USED, kept: "code_used" })
      expect(retryRefusal("code_invalid")).toEqual({ note: { ...USED, title: "This code is not valid", text: "The service no longer accepts it." }, kept: "code_invalid" })
      expect(retryRefusal("code_expired")).toEqual({ note: { ...USED, title: "This code has expired", text: "An expired code cannot register a name." }, kept: "code_expired" })
      expect(retryRefusal("code_reserved")).toEqual({ note: { ...USED, title: "Your code is held by another registration; try again later", text: "" }, kept: null })
      for (const other of ["network", "bad_request", "constructor", "toString"]) expect(retryRefusal(other), other).toBeNull()
    })
    it("a kept value that is no service error, as a title an older page kept, is no refusal", () => {
      const old = record({ codeRefusal: "Your code was used for another name" as CodeRefusal })
      expect(reduce(STATES.failed, { type: "record-changed", record: old, cardSubmittedAt: null })).toMatchObject({ codeRefused: false, note: null })
    })
    it("a code refused stays refused through a hold and a read of the same failed order", () => {
      const refused = { ...STATES.failed, codeRefused: true }
      expect(reduce(refused, { type: "hold-started", until: NOW + 2000, lead: "Nothing changed. " }).codeRefused).toBe(true)
      expect(reduce(refused, answered(refused, STATES.failed)).codeRefused).toBe(true)
    })
    it("code-checked marks the failed order's code kept, which a read of the same failed order keeps and another screen forgets", () => {
      const checked = reduce(STATES.failed, { type: "code-checked" })
      expect(checked).toEqual({ ...STATES.failed, codeKept: true })
      expect(reduce(checked, answered(checked, STATES.failed)).codeKept).toBe(true)
      expect(reduce(checked, answered(checked, STATES.registering)).codeKept).toBe(false)
    })
    it("a code check refused for a rate limit keeps when it is checked again, until the check answers or the order moves on", () => {
      const due = reduce(STATES.failed, { type: "code-check-due", at: NOW + 30_000 })
      expect(due).toEqual({ ...STATES.failed, codeCheckAt: NOW + 30_000 })
      expect(reduce(due, { type: "code-checked" })).toMatchObject({ codeKept: true, codeCheckAt: null })
      expect(reduce(due, { type: "code-check-due", at: null }).codeCheckAt).toBeNull()
      expect(reduce(due, answered(due, STATES.failed)).codeCheckAt, "a read of the same failed order").toBe(NOW + 30_000)
      expect(reduce(due, answered(due, STATES.registering)).codeCheckAt, "another screen").toBeNull()
    })
    it("a code refused belongs to the failed screen: another tab's retry that moves the order on forgets it", () => {
      const refused = { ...STATES.failed, codeRefused: true }
      expect(reduce(refused, answered(refused, STATES.registering)).codeRefused).toBe(false)
    })
    it.each([["cancel-failed"], ["reorder-failed"], ["retry-failed"], ["move-failed"]])("%s of an action no longer at work changes nothing", (failed) => {
      expect(reduce(paying, { type: failed, note: WARN } as OrderEvent)).toBe(paying)
    })
    it("cancel-answered ends the cancel and leaves no note", () => {
      expect(reduce(reduce(paying, { type: "cancel-started" }), { type: "cancel-answered" })).toEqual(paying)
    })
    it("price-changed ends a new invoice's request with the new price", () => {
      const working = reduce(STATES["status:closed"], { type: "reorder-started" })
      expect(reduce(working, { type: "price-changed", price: 2500 })).toMatchObject({ busy: null, price: 2500 })
    })
    it("a screen change leaves the last screen's note, action and hold words behind", () => {
      const s = { ...paying, busy: "cancel" as const, note: WARN, hold: { until: NOW + 20_000, lead: "The invoice is still open. " } }
      expect(reduce(s, answered(s, STATES["status:closed"]))).toMatchObject({ busy: null, note: null, hold: { until: NOW + 20_000, lead: NO_LEAD } })
    })
  })

  describe("holds", () => {
    it("hold-started holds the actions, ending the one at work", () => {
      const working = reduce(STATES.failed, { type: "retry-started" })
      expect(reduce(working, { type: "hold-started", until: NOW + 2000, lead: "Nothing changed. " })).toEqual({ ...STATES.failed, hold: { until: NOW + 2000, lead: "Nothing changed. " } })
    })
    it("a shorter hold met meanwhile does not cut a longer one", () => {
      const held = reduce(STATES.failed, { type: "hold-started", until: NOW + 20_000, lead: NO_LEAD })
      expect(reduce(held, { type: "hold-started", until: NOW + 2000, lead: "Nothing changed. " }).hold).toEqual({ until: NOW + 20_000, lead: "Nothing changed. " })
    })
    it("hold-ended lets the actions go", () => {
      expect(reduce({ ...STATES.failed, hold: { until: NOW, lead: NO_LEAD } }, { type: "hold-ended" }).hold).toBeNull()
    })
  })

  it("an older answer never replaces a newer one, whichever arrives first", () => {
    const older = answered(STATES.registering, read(null, registration({ phase: "committed", commitTx: "0xc0" }), { now: NOW + 1000 }))
    const newer = { ...answered(STATES.registering, read(null, registration({ phase: "registering", commitTx: "0xc0", registerTx: "0xe9" }), { now: NOW + 2000 })), seq: older.seq + 1 }
    const inOrder = reduce(reduce(STATES.registering, older), newer)
    const reversed = reduce(reduce(STATES.registering, newer), older)
    expect(reversed).toEqual(inOrder)
    expect(inOrder.view!.phase).toBe("registering")
    expect(inOrder.now).toBe(NOW + 2000)
  })
})

describe("costOf", () => {
  it("is the invoice's amount for an order paid by its invoice alone", () => {
    expect(costOf(registration(), crypto())).toEqual({ cost: 1500, fromBalance: 0 })
  })
  it("adds what a balance paid to a difference invoice, which holds the rest only", () => {
    expect(costOf(registration({ price: 2500, fromBalance: 1000 }), crypto({ amount: 1500 }))).toEqual({ cost: 2500, fromBalance: 1000 })
  })
  it("is what the balance paid for an order without an invoice that a balance covered", () => {
    expect(costOf(registration({ price: 1500, fromBalance: 1500 }), null)).toEqual({ cost: 1500, fromBalance: 1500 })
  })
  it("is the cheaper name's price after a move, the balance paying no more of it than it costs", () => {
    expect(costOf(registration({ price: 500, fromBalance: 1500 }), null)).toEqual({ cost: 500, fromBalance: 500 })
    expect(costOf(registration({ price: 1000, fromBalance: 1000 }), crypto({ status: "paid", amount: 1000 })), "a difference order moved, whose coin paid half")
      .toEqual({ cost: 1000, fromBalance: 0 })
  })
  it("is null for a code order, which costs nothing", () => {
    expect(costOf(registration({ price: 0 }), null)).toBeNull()
  })
})

describe("finished", () => {
  const paidLate = (reg: Partial<RegistrationView>) => crypto({ status: "paid", paidInFull: true }, reg)
  it("follows money paid after the close until it is in the balance", () => {
    expect(finished(paidLate({}), registration())).toBe(false)
    expect(finished(paidLate({}), registration({ balance: { amount: 1500, held: false, heldUntil: null, refunded: 0 } }))).toBe(true)
  })
  it("follows a late credit while it is confirming or being made, and stops once only support can make it", () => {
    for (const waiting of ["confirming", "crediting"] as const) expect(finished(paidLate({}), registration({ latePayment: { waiting } })), waiting).toBe(false)
    expect(finished(paidLate({}), registration({ latePayment: { waiting: "support" } }))).toBe(true)
    expect(finished(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }), registration({ latePayment: { waiting: "support" } })), "a part payment").toBe(true)
  })
  it("stops at a whole late payment that BTCPay keeps expired once it is in the balance, and follows a part payment for the rest", () => {
    const credited = registration({ balance: { amount: 1500, held: false, heldUntil: null, refunded: 0 } })
    expect(finished(crypto(LATE_FULL, credited), credited)).toBe(true)
    expect(finished(crypto(LATE_FULL), registration()), "not credited yet").toBe(false)
    const part = crypto({ status: "expired", cryptoAmountPaid: "0.0001" }, credited)
    expect(finished(part, part.registration)).toBe(false)
  })
  it("stops at a registered name, and follows an open invoice and a taken or failed order", () => {
    expect(finished(null, registration({ phase: "registered" }))).toBe(true)
    expect(finished(crypto(), registration())).toBe(false)
    expect(finished(null, registration({ phase: "taken" }))).toBe(false)
  })
})

describe("closedBalance", () => {
  const BALANCE = { amount: 750, held: false, heldUntil: null, refunded: 0 }
  it("offers the balance that a confirmed part payment on an expired invoice became, so the page asks no whole price again", () => {
    expect(closedBalance(read(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }, { balance: BALANCE })))).toBe("offer")
  })
  it("offers the balance that money paid after the close became", () => {
    expect(closedBalance(read(crypto({ status: "paid", paidInFull: true }, { balance: BALANCE })))).toBe("offer")
    expect(closedBalance(read(crypto(LATE_FULL, { balance: BALANCE }))), "kept expired").toBe("offer")
  })
  it("leads a replaced invoice's balance to its new invoice, which can be cancelled for it", () => {
    const replaced = read(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }, { balance: BALANCE }), undefined, { record: record({ replacedBy: "/?order=inv-2" }) })
    expect(closedBalance(replaced)).toBe("replaced")
  })
  it("offers nothing before the credit, after it is spent, without the code, or for an invoice nothing reached", () => {
    expect(closedBalance(read(crypto({ status: "expired", cryptoAmountPaid: "0.0001" })))).toBeNull()
    expect(closedBalance(read(crypto({ status: "paid", paidInFull: true }, { balance: { ...BALANCE, amount: 0 } })))).toBeNull()
    expect(closedBalance(read(crypto({ status: "paid", paidInFull: true }, { balance: BALANCE }), undefined, { record: null }))).toBeNull()
    expect(closedBalance(read(crypto({ status: "expired" }, { balance: BALANCE })))).toBeNull()
  })
})

describe("spendCovers", () => {
  const expired = (sourceBalance: OrderState["sourceBalance"], change: Partial<OrderState> = {}) =>
    read(crypto({ status: "expired", amount: 500 }, { price: 1500, fromBalance: 1000 }), undefined, { record: record({ balanceSource: "reg-0" }), sourceBalance, ...change })
  const balance = (amount: number, held = false) => ({ amount, held, heldUntil: null, refunded: 0 })
  it("registers with the balance once it has grown to the price", () => {
    expect(spendCovers(expired(balance(1500)))).toBe(true)
    expect(spendCovers(expired(balance(4000)))).toBe(true)
  })
  it("gets a new invoice for the rest while the balance is short of the price, held, or not read", () => {
    expect(spendCovers(expired(balance(1000)))).toBe(false)
    expect(spendCovers(expired(balance(4000, true)))).toBe(false)
    expect(spendCovers(expired(null))).toBe(false)
  })
  it("takes a balance read for an order this browser learned its source of from find, which its record did not name", () => {
    expect(spendCovers(expired(balance(4000), { record: record() }))).toBe(true)
  })
  it("ends Get a new invoice's work when it finds the balance grown to the price, so the button can say so and be pressed again", () => {
    const pressed = reduce(expired(null), { type: "reorder-started" })
    const grown = reduce(pressed, { type: "source-read", balance: balance(1500) })
    expect([grown.busy, spendCovers(grown)]).toEqual([null, true])
  })
  const own = (amount: number, held = false) => read(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }, { balance: balance(amount, held) }))
  it("registers the same name with the order's own balance, which money on its closed invoice became, once that covers the price", () => {
    expect(spendCovers(own(1500))).toBe(true)
    expect(spendCovers(own(750))).toBe(false)
    expect(spendCovers(own(1500, true))).toBe(false)
  })
  it("says so once the order's own balance is read grown to the price", () => {
    const grown = reduce(reduce(own(750), { type: "reorder-started" }), { type: "source-read", balance: balance(1500) })
    expect([grown.busy, spendCovers(grown)]).toEqual([null, true])
  })
})

describe("newInvoiceBy", () => {
  it("spends again the balance that paid part of the order, as the record names it", () => {
    expect(newInvoiceBy(record({ balanceSource: "reg-0" }), crypto({ status: "expired" }, { fromBalance: 1000 }))).toBe("spend")
  })
  it("asks find which balance paid part of an order this browser adopted, never ordering the difference alone", () => {
    expect(newInvoiceBy(record(), crypto({ status: "expired", amount: 500 }, { fromBalance: 1000 }))).toBe("find")
  })
  it("spends the order's own balance, which money on its closed invoice became, for the rest of the same name", () => {
    const credited = { balance: { amount: 750, held: false, heldUntil: null, refunded: 0 } }
    expect(newInvoiceBy(record(), crypto({ status: "expired", cryptoAmountPaid: "0.0001" }, credited))).toBe("own")
    expect(newInvoiceBy(record({ balanceSource: "reg-0" }), crypto({ status: "expired", cryptoAmountPaid: "0.0001" }, { ...credited, fromBalance: 1000 })), "the balance that paid part first")
      .toBe("spend")
    expect(newInvoiceBy(record(), crypto({ status: "expired" }, { balance: { ...credited.balance, amount: 0 } })), "a balance spent or refunded").toBe("order")
  })
  it("orders again at the price an order paid by its invoice alone", () => {
    expect(newInvoiceBy(record(), crypto({ status: "expired" }))).toBe("order")
  })
})

describe("failedLead", () => {
  const coded = record({ method: "code", invoiceId: null, prepaidCode: "SN6-AAAA" })
  const failed = (invoice: InvoiceView | null, change: Partial<OrderState> = {}) =>
    read(invoice, registration({ phase: "failed" }), { record: invoice ? record() : coded, ...change })
  it("an invoice's payment is kept", () => {
    expect(failedLead(failed(crypto({ status: "paid", paidInFull: true })))).toBe("Your payment is kept. Trying again charges nothing.")
  })
  it("links the service refused send a browser without the code to enter it, as trying again cannot register them", () => {
    const refused = read(crypto({ status: "paid", paidInFull: true }), registration({ phase: "failed", linksRefused: true }), { record: null })
    expect(failedLead(refused)).toBe("The service refused its links. Enter its name code to register it without them, or another name.")
  })
  it("a refused code says it can no longer pay", () => {
    expect(failedLead(failed(null, { codeRefused: true }))).toBe("Your code can no longer be used for it, so trying again cannot register it.")
  })
  it("a code is said to be kept only once the service says so", () => {
    expect(failedLead(failed(null, { codeKept: true }))).toBe("Your code is kept. Trying again spends nothing more.")
    expect(failedLead(failed(null)), "the check has not answered, or failed").toBe("Trying again spends nothing more.")
  })
  it("a browser without the order's code is promised nothing of it, even once the service says it is unspent", () => {
    expect(failedLead(failed(null, { record: null, codeKept: true }))).toBe("Trying again spends nothing more.")
  })
})

describe("failedAlert", () => {
  const failed = (change: Partial<RegistrationView> = {}, state: Partial<OrderState> = {}) => read(null, registration({ phase: "failed", ...change }), state)
  it("names what happened in the service's own sentence for the buyer", () => {
    expect(failedAlert(failed({ error: "The name was not signed in time" })).title).toBe("The name was not signed in time")
  })
  it("says the name is not registered yet when the service gave no sentence", () => {
    expect(failedAlert(failed()).title).toBe("The name could not be registered yet")
  })
  it("offers Try again unless the order's links or its code were refused, which trying again cannot fix", () => {
    expect(failedAlert(failed()).retry).toBe(true)
    expect(failedAlert(failed({ linksRefused: true })).retry).toBe(false)
    expect(failedAlert(failed({}, { codeRefused: true })).retry).toBe(false)
  })
})

describe("a taken order's name", () => {
  const taken = read(null, registration({ phase: "taken", label: "alice" }))
  it("is taken as the search after it answered: reserved meanwhile, or not", () => {
    const start = initialState("reg-1", null)
    expect(reduce(start, answered(start, { ...taken, reserved: true })).reserved).toBe(true)
    expect(reduce(start, answered(start, taken)).reserved).toBe(false)
  })
})

describe("a stalled stage", () => {
  const seen = (view: RegistrationView, at = NOW, from = initialState("reg-1", null)) => reduce(from, answered(from, read(null, view, { now: at })))
  const committing = registration({ phase: "committing" })
  it("is timed from the first answer that shows its stage, whatever else changes in it", () => {
    const first = seen(committing)
    expect(first.since).toEqual({ stage: "reg-1 committing", at: NOW })
    expect(seen(registration({ phase: "committing", version: 2, commitTx: "0xc0" }), NOW + 5000, first).since, "a commit sent again").toEqual(first.since)
    expect(seen(registration({ ...committed, version: 3 }), NOW + 9000, first).since).toEqual({ stage: "reg-1 committed", at: NOW + 9000 })
  })
  it("counts a signed registration, which the service registers, as a stage of its own", () => {
    const waiting = seen(registration(committed))
    expect(seen(registration({ ...committed, label: "alice" }), NOW + 2000, waiting).since).toEqual({ stage: "reg-1 committed signed", at: NOW + 2000 })
  })
  it("of a transaction stalls once a mainnet commit or register would have been mined and confirmed, however slow", () => {
    expect(TX_STALL_MS).toBeGreaterThan(STALL_MARGIN_MS)
    expect(stalledAt(seen(committing))).toBe(NOW + TX_STALL_MS)
    expect(stalledAt(seen(registration({ ...committed, label: "alice" })))).toBe(NOW + TX_STALL_MS)
    expect(stalledAt(seen(registration({ ...committed, phase: "registering", label: "alice" })))).toBe(NOW + TX_STALL_MS)
  })
  it("of the wait and the reveal stalls past the wait's end, the reveal's tries and the margin", () => {
    const later = registration({ ...committed, revealAfter: NOW / 1000 + 30 })
    expect(stalledAt(seen(later))).toBe(NOW + 30_000 + REVEAL_ATTEMPTS * RETRY_MS + STALL_MARGIN_MS)
    // a wait already over when the stage was first seen is timed from then
    expect(stalledAt(seen(registration(committed)))).toBe(NOW + REVEAL_ATTEMPTS * RETRY_MS + STALL_MARGIN_MS)
  })
  it("is not said on any other page, nor once the service refused the reveal, which the page says instead", () => {
    for (const kind of ["registered", "taken", "failed", "links-refused", "not-on-device", "pay-crypto"] as const) {
      const s = STATES[kind]
      expect(stalledAt(reduce(s, answered(s, s))), kind).toBeNull()
    }
    const view = registration(committed)
    expect(stalledAt({ ...seen(view), reveal: { key: revealKey(view), sending: false, refusals: REVEAL_ATTEMPTS } })).toBeNull()
  })
})

describe("reveal helpers", () => {
  const view = registration(committed)
  const waiting = read(null, view)
  it("revealKey names the commit a reveal is signed for", () => {
    expect(revealKey(view)).toBe(`reg-1 ${COMMITMENT} 4 ${NOW / 1000 + 3600}`)
  })
  it("refusalsOf counts the refusals of the commit shown, and none outside the wait", () => {
    const refused = { ...waiting, reveal: { key: revealKey(view), sending: false, refusals: 2 } }
    expect(refusalsOf(refused)).toBe(2)
    expect(refusalsOf({ ...refused, view: registration({ ...committed, intentNonce: 5 }) })).toBe(0)
    expect(refusalsOf({ ...refused, view: registration({ ...committed, phase: "registering" }) })).toBe(0)
  })
  it("revealDue once the wait is over, for the browser with the name code", () => {
    expect(revealDue(waiting)).toBe(true)
    expect(revealDue({ ...waiting, now: NOW - 5000 })).toBe(false)
    expect(revealDue({ ...waiting, record: null })).toBe(false)
    // links the service refused cannot be signed again
    expect(revealDue({ ...waiting, record: record({ linksRefused: true }) })).toBe(false)
    expect(revealDue(read(null, registration({ ...committed, linksRefused: true }))), "refused at another browser's reveal").toBe(false)
    expect(revealDue(read(null, registration({ ...committed, label: "alice" })))).toBe(false)
    expect(revealDue(read(null, registration({ ...committed, phase: "registering" })))).toBe(false)
    // the sponsor's nonce the service could not read leaves nothing to sign with
    expect(revealDue(read(null, registration({ ...committed, intentNonce: null, unread: ["intentNonce"] })))).toBe(false)
  })
  it("unreadDelay reads a view with unread fields again after 5 s, 15 s, then every 30 s", () => {
    expect([0, 1, 2, 3, 10].map(unreadDelay)).toEqual([5000, 15000, 30000, 30000, 30000])
  })
  it("revealDue not while a reveal is on its way, nor once refused as often as the page tries", () => {
    const key = revealKey(view)
    expect(revealDue({ ...waiting, reveal: { key, sending: true, refusals: 0 } })).toBe(false)
    expect(revealDue({ ...waiting, reveal: { key, sending: false, refusals: REVEAL_ATTEMPTS } })).toBe(false)
    expect(revealDue({ ...waiting, reveal: { key, sending: false, refusals: REVEAL_ATTEMPTS - 1 } })).toBe(true)
  })
})

describe("wakeAt", () => {
  const paying = read(card(), undefined, { record: record({ method: "card" }), cardSubmittedAt: submittedAgo(1000) })
  it("wakes the page when a card's wait runs out", () => {
    expect(wakeAt(paying)).toBe(NOW - 1000 + CARD_SLOW_MS)
  })
  it("wakes the page when the commit's wait ends", () => {
    expect(wakeAt(read(null, registration({ ...committed, revealAfter: NOW / 1000 + 30 })))).toBe(NOW + 30_000)
  })
  it("takes the earlier of two moments", () => {
    expect(wakeAt({ ...paying, view: registration({ ...committed, revealAfter: NOW / 1000 + 30 }) })).toBe(NOW + 30_000)
  })
  it("sleeps when nothing waits on the clock", () => {
    expect(wakeAt(STATES["pay-crypto"])).toBeNull()
    expect(wakeAt(STATES.registered)).toBeNull()
    expect(wakeAt(SLOW)).toBeNull()
    expect(wakeAt(read(null, registration(committed)))).toBeNull()
    expect(wakeAt({ ...paying, record: null })).toBeNull()
    expect(wakeAt({ ...paying, invoice: card({ status: "expired" }) })).toBeNull()
  })
  it("a tick on the very millisecond of a card's wait turns the page to not confirmed, and nothing is left to wake for", () => {
    const woken = reduce(paying, { type: "tick", now: wakeAt(paying)! })
    expect(screenOf(paying)).toBe("confirming")
    expect(screenOf(woken)).toBe("status:card-unconfirmed")
    expect(wakeAt(woken)).toBeNull()
  })
  it("a tick one millisecond before a card's wait ends keeps the page waking for it", () => {
    const early = reduce(paying, { type: "tick", now: wakeAt(paying)! - 1 })
    expect(screenOf(early)).toBe("confirming")
    expect(wakeAt(early)).toBe(wakeAt(paying))
  })
  it("a tick on the very millisecond the commit's wait ends makes the reveal due, and nothing is left to wake for", () => {
    const waiting = read(null, registration({ ...committed, revealAfter: NOW / 1000 + 30 }))
    const woken = reduce(waiting, { type: "tick", now: wakeAt(waiting)! })
    expect(revealDue(waiting)).toBe(false)
    expect(revealDue(woken)).toBe(true)
    expect(wakeAt(woken)).toBeNull()
  })
})

describe("the terms of the same name again", () => {
  const TERMS = { version: "2026-11-01", url: "https://simplex.chat/" }
  const BAKERS = { for: "bakers and pastry chefs" }

  it("terms-asked ends a new invoice's or a move's work and asks for the name's terms, unticked", () => {
    for (const started of ["reorder-started", "move-started"] as const) {
      const s = reduce(STATES["status:closed"], { type: started })
      expect(reduce(s, { type: "terms-asked", label: "alice", terms: TERMS, community: BAKERS, changed: false }), started).toMatchObject({ busy: null, ask: { label: "alice", terms: TERMS, community: BAKERS, agreed: false, changed: false } })
    }
  })
  it("terms-agreed ticks the box and ends the notice that the terms changed", () => {
    const s = reduce(STATES["status:closed"], { type: "terms-asked", label: "alice", terms: TERMS, community: null, changed: true })
    const ticked = reduce(s, { type: "terms-agreed", agreed: true })
    expect(ticked.ask).toEqual({ label: "alice", terms: TERMS, community: null, agreed: true, changed: false })
    expect(reduce(ticked, { type: "terms-agreed", agreed: false }).ask).toEqual({ label: "alice", terms: TERMS, community: null, agreed: false, changed: false })
  })
  it("terms-agreed with nothing asked changes nothing", () => {
    expect(reduce(STATES["status:closed"], { type: "terms-agreed", agreed: true })).toBe(STATES["status:closed"])
  })
  it("the ask stays while the order is read again", () => {
    const s = reduce(STATES["status:closed"], { type: "terms-asked", label: "alice", terms: TERMS, community: null, changed: false })
    expect(reduce(s, answered(s, STATES["status:closed"])).ask).toEqual(s.ask)
  })
  it("an order moved to another name meanwhile drops the ask, ticked or not, so the next press asks for that name's terms", () => {
    const asked = reduce(STATES["status:closed"], { type: "terms-asked", label: "alice", terms: TERMS, community: null, changed: false })
    const ticked = reduce(asked, { type: "terms-agreed", agreed: true })
    const moved = { ...STATES["status:closed"], record: record({ label: "bob123" }) }
    expect(reduce(ticked, answered(ticked, moved)).ask).toBeNull()
    expect(reduce(ticked, { type: "record-changed", record: record({ label: "bob123" }), cardSubmittedAt: null }).ask).toBeNull()
    expect(reduce(ticked, { type: "record-changed", record: record(), cardSubmittedAt: null }).ask).toEqual(ticked.ask)
  })
})

describe("initialState", () => {
  it("starts with nothing read, holding as the tab does, and keeps a reveal carried over", () => {
    const reveal = { key: "reg-1 0x9c 4 1", sending: true, refusals: 1 }
    expect(initialState("inv-1", { until: NOW + 1000, lead: NO_LEAD }, reveal)).toEqual({
      reference: "inv-1", seq: 0, now: 0, invoice: null, view: null, record: null, cardSubmittedAt: null, cardFailed: false,
      reveal, busy: null, note: null, hold: { until: NOW + 1000, lead: NO_LEAD }, price: null, gone: false, codeRefused: false, codeKept: false, codeCheckAt: null, sourceBalance: null, ask: null,
      reserved: false, since: null,
    })
  })
})

describe("sameStep", () => {
  const refused = registration({ ...committed, linksRefused: true })
  it("finds nothing changed in a view another request wrote without moving the order on", () => {
    expect(sameStep(refused, { ...refused, version: refused.version + 1 })).toBe(true)
  })
  it("finds the order moved on when its phase, its name, its refused links or its moves differ", () => {
    expect(sameStep(refused, { ...refused, phase: "registered" })).toBe(false)
    expect(sameStep(refused, { ...refused, label: "alice" })).toBe(false)
    expect(sameStep(refused, { ...refused, linksRefused: false })).toBe(false)
    expect(sameStep(refused, { ...refused, moves: 1 })).toBe(false)
  })
})
