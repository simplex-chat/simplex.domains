import { describe, expect, it } from "vitest"
import { bitcoinPayee, devReceiving, moneroPayee } from "../dev/mock/addresses.ts"
import type { Acceptance, Community, InvoiceView, RegistrationView } from "../src/api.ts"
import { heldPrice, LOCAL } from "../src/config.ts"
import { NO_LEAD } from "../src/screens/hold.ts"
import {
  CARD_SLOW_MS, closedBalance, type ClosedCase, closedCase, costOf, failedAlert, failedLead, finished, initialState, type Note, type OrderEvent, type OrderKind,
  type OrderState, reduce, refusalsOf, RETRY_MS, retryRefusal, REVEAL_ATTEMPTS, revealDue, revealKey, screenOf, STALL_MARGIN_MS, stalledAt, TX_STALL_MS, unreadDelay, wakeAt,
  askAgainDue, paymentChecked, retryDue, supportCase,
} from "../src/screens/order.ts"
import { askFor } from "../src/screens/terms.ts"
import type { CodeRefusal, OrderRecord } from "../src/store.ts"
import { type ShortView as Short, viewOf } from "./registration-view.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const COMMITMENT = "0x9c1185a5c5e9fc54612808977ee8f548b2258d31b6c0a94e1ab9e1e8c4d6a0f1"
const USED: Note = { tone: "warn", icon: "key", title: "Your code was used for another name", text: "A code registers one name only." }
const WARN: Note = { tone: "warn", icon: "alert", title: null, text: "The invoice could not be cancelled now. Try again in a moment." }

const registration = (change: Short = {}): RegistrationView => viewOf({
  id: "reg-1", version: 1, labelHash: "0x4f1b", label: null, owner: OWNER, commitment: COMMITMENT, sealed: "sealed-box", years: 2, duration: 2 * 365 * 86400,
  price: 1500, balance: null, commitTx: null, registerTx: null, latePayment: null, community: null, terms: { communityName: false, termsHash: SIGNED },
}, change)

const crypto = (change: Partial<InvoiceView> = {}, reg: Short = {}): InvoiceView => ({
  invoiceId: "inv-1", status: "open", amount: 1500, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", registration: registration(reg),
  address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", cryptoAmount: "0.00025", cryptoCurrency: "btc", cryptoAmountPaid: "0", cryptoAmountDue: "0.00025",
  paidInFull: false, requiredConfirmations: 1, ...change,
})

const card = (change: Partial<InvoiceView> = {}, reg: Short = {}): InvoiceView => ({
  invoiceId: "inv-1", status: "open", amount: 1500, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", registration: registration(reg),
  clientSecret: "pi_1_secret_2", cryptoCurrency: "card", amountPaid: 0, ...change,
})

function record(change: Partial<OrderRecord> = {}): OrderRecord {
  return {
    registrationId: "reg-1", invoiceId: "inv-1", label: "alice", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: OWNER, contact: "", channel: "",
    method: "btc", paid: 1500, years: 2, request: { labelHash: "0x4f1b", length: 5, duration: 2 * 365 * 86400, owner: OWNER, commitment: COMMITMENT, sealed: "sealed-box" },
    terms: SIGNED.slice(2), tld: "simplex", createdAt: "2026-10-17T11:59:00Z", ...change,
  }
}

function read(invoice: InvoiceView | null, view: RegistrationView = invoice!.registration, change: Partial<OrderState> = {}): OrderState {
  return { ...initialState("inv-1", null), seq: 1, now: NOW, invoice, view, record: record(), ...change }
}

const answered = (s: OrderState, next: OrderState): Extract<OrderEvent, { type: "answered" }> =>
  ({ type: "answered", seq: s.seq + 1, now: next.now, invoice: next.invoice, view: next.view!, record: next.record, cardSubmittedAt: next.cardSubmittedAt, nameStatus: next.nameStatus, downtime: next.downtime })

const submittedAgo = (ms: number) => new Date(NOW - ms).toISOString()
// the community terms an order signed, others on chain, a community entry, the view's acceptance of some terms, and the
// buyer's ask of them
const SIGNED = `0x${"c7".repeat(32)}`
const CHANGED = LOCAL.communityTerms[1].hash
const communityEntry = (text?: string): Community => ({ ...text === undefined ? {} : { for: text }, years: 2 })
const termsOf = (hash: string) => ({ hash, link: `https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/${"83".repeat(20)}/docs/terms.md#sha256=${"02".repeat(32)}` })
const acceptanceFor = (termsHash: string, community = true): Acceptance => ({ community, policy: "0x3", termsHash, nonce: 0 })
const committed: Short = { phase: "committed", commitTx: "0xc0", revealAfter: NOW / 1000 - 1, revealBefore: NOW / 1000 + 3600, intentNonce: 4, acceptance: acceptanceFor(SIGNED, false) }
const reask = (hash = CHANGED) => askFor(record().label, termsOf(hash), communityEntry(), true)

const SLOW = read(card(), undefined, { record: record({ method: "card" }), cardSubmittedAt: submittedAgo(CARD_SLOW_MS + 1000) })
const LAPSED = read(null, registration({ ...committed, revealBefore: NOW / 1000 - 1, lapsed: true }))

const STATES: Record<OrderKind, OrderState> = {
  "pay-crypto": read(crypto()),
  "pay-card": read(card(), undefined, { record: record({ method: "card" }) }),
  confirming: read(crypto({ paidInFull: true, cryptoAmountPaid: "0.00025" })),
  registering: read(null, registration({ phase: "committing" })),
  registered: read(null, registration({ phase: "registered", label: "alice", registerTx: "0xe9", expiresAt: NOW / 1000 + 63072000 })),
  ended: read(null, registration({ phase: "ended", label: "alice", registerTx: "0xe9" })),
  taken: read(crypto({ status: "paid", paidInFull: true }, { phase: "taken" })),
  failed: read(crypto({ status: "paid", paidInFull: true }, { phase: "failed", reason: "registryRefused" })),
  "status:no-code": read(null, registration({ phase: "committing" }), { record: null }),
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
    ["a registration ended in its dispute period", STATES.ended, "ended"],
    ["a registration ended, seen without the name code", read(null, registration({ phase: "ended", label: "alice" }), { record: null }), "ended"],
    ["a name taken first", STATES.taken, "taken"],
    ["a failed registration", STATES.failed, "failed"],
    ["a commit in a browser without the name code", STATES["status:no-code"], "status:no-code"],
    ["an order's link in a browser without its name code, which reads nothing", reduce(initialState("inv-1", null), { type: "no-code" }), "status:no-code"],
    ["an order's link answered once another tab added its name code", reduce(reduce(initialState("inv-1", null), { type: "no-code" }), answered(initialState("inv-1", null), STATES.registered)), "registered"],
    ["an order's link answered after it was not found", reduce(reduce(initialState("inv-1", null), { type: "not-found" }), answered(initialState("inv-1", null), STATES.registered)), "registered"],
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
    ["a whole payment after the close that only support can credit", "paid-late", read(crypto(LATE_FULL, { latePayment: "support" }))],
    ["a whole payment after the close, still confirming", "received", read(crypto(LATE_FULL, { latePayment: "confirming" }))],
    ["a whole payment after the close, confirmed and not yet credited", "received", read(crypto(LATE_FULL, { latePayment: "crediting" }))],
    ["a cancelled invoice that closed with nothing received", "cancelled", read(crypto({ status: "expired" }), undefined, { record: record({ cancelled: true }) })],
    ["an expired invoice that money reached", "received", read(crypto({ status: "expired", cryptoAmountPaid: "0.0001", cryptoAmountDue: "0.00015" }))],
    ["a cancelled invoice that money reached", "received", read(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }), undefined, { record: record({ cancelled: true }) })],
    ["an expired card invoice with nothing paid", "expired", read(card({ status: "expired" }))],
    ["an expired invoice with nothing received", "expired", read(crypto({ status: "expired" }))],
    ["an order whose payment was reversed", "reversed", read(card({ status: "paid", amountPaid: 1500 }, { phase: "closed", closedBy: "reversed" }))],
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
    it("reveal-sent keeps an ask of the changed community terms it signs, and drops another", () => {
      const asking = read(null, registration({ ...committed, acceptance: acceptanceFor(CHANGED) }))
      const ask = reask()
      expect(reduce({ ...asking, ask }, { type: "reveal-sent", key: "k" }).ask).toEqual(ask)
      expect(reduce({ ...read(null, registration(committed)), ask }, { type: "reveal-sent", key: "k" }).ask).toBeNull()
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
    const cases: [OrderEvent["type"], OrderEvent["type"], OrderState, OrderState["busy"]][] = [
      ["cancel-started", "cancel-failed", { ...paying, note: WARN }, "cancel"],
      ["reorder-started", "reorder-failed", { ...STATES["status:closed"], note: WARN }, "reorder"],
      ["retry-started", "retry-ended", { ...LAPSED, note: WARN }, "retry"],
      ["continue-started", "continue-failed", { ...STATES.failed, note: WARN }, "continue"],
    ]
    it.each(cases)("%s marks the action at work and clears the note; %s ends it with its note", (started, failed, s, busy) => {
      const working = reduce(s, { type: started } as OrderEvent)
      expect(working).toEqual({ ...s, busy, note: null })
      expect(reduce(working, { type: failed, note: WARN } as OrderEvent)).toEqual({ ...s, busy: null, note: WARN })
    })
    it("retry-started holds the lapsed order's /retry until an answer shows the order moved on", () => {
      const working = reduce(LAPSED, { type: "retry-started" })
      expect(reduce(working, answered(working, { ...LAPSED, now: NOW + 1000 })).busy).toBe("retry")
      expect(reduce(working, answered(working, read(null, registration({ phase: "queued" }), { now: NOW + 1000 }))).busy).toBeNull()
    })
    it("a refusal kept with the order shows with the failed page from its first answer, its Try again off", () => {
      const kept = record({ codeRefusal: "code_used" })
      const opened = reduce(initialState("inv-1", null), answered(initialState("inv-1", null), { ...STATES.failed, record: kept }))
      expect(opened).toMatchObject({ note: USED, codeRefused: true })
      expect(reduce(STATES.failed, { type: "record-changed", record: kept, cardSubmittedAt: null })).toMatchObject({ note: USED, codeRefused: true })
    })
    it("a kept refusal belongs to the failed page and waits out a Continue at work", () => {
      const kept = record({ codeRefusal: "code_used" })
      expect(reduce(STATES.registering, { type: "record-changed", record: kept, cardSubmittedAt: null })).toMatchObject({ codeRefused: false, note: null })
      const working = reduce(STATES.failed, { type: "continue-started" })
      expect(reduce(working, { type: "record-changed", record: kept, cardSubmittedAt: null })).toMatchObject({ busy: "continue", codeRefused: false })
      const refused = reduce(STATES.failed, { type: "record-changed", record: kept, cardSubmittedAt: null })
      expect(reduce(refused, { type: "tick", now: NOW + 1000 })).toMatchObject({ codeRefused: true, note: USED })
    })
    it("retryRefusal: each code error of a retry that a page kept has its note, saying why", () => {
      expect(retryRefusal("code_used")).toEqual({ note: USED, kept: "code_used" })
      expect(retryRefusal("code_invalid")).toEqual({ note: { ...USED, title: "This code is not valid", text: "The service no longer accepts it." }, kept: "code_invalid" })
      expect(retryRefusal("code_expired")).toEqual({ note: { ...USED, title: "This code has expired", text: "An expired code cannot register a name." }, kept: "code_expired" })
      for (const other of ["network", "bad_request", "code_reserved", "constructor", "toString"]) expect(retryRefusal(other), other).toBeNull()
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
    it.each([["cancel-failed"], ["reorder-failed"], ["retry-ended"], ["continue-failed"]])("%s of an action no longer at work changes nothing", (failed) => {
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
    expect(inOrder.view!.phase.type).toBe("registering")
    expect(inOrder.now).toBe(NOW + 2000)
  })
})

describe("paymentChecked", () => {
  const held = heldPrice(record().label.length)
  const btc = bitcoinPayee(devReceiving, LOCAL.bitcoinHrp, 0)
  const xmr = moneroPayee(0, 1)
  const coin = (change: Partial<InvoiceView> = {}) => crypto({ amount: held, ...btc, ...change })
  const asXmr = { cryptoCurrency: "xmr", ...xmr } as const
  const priced = (change: Partial<InvoiceView> = {}) => card({ amount: held, ...change })
  const cardRecord = { record: record({ method: "card" }) }

  it("is an invoice of the payment its order asked for, at the price the page holds, in dollars, to an address proven from the page's keys", () => {
    expect(paymentChecked(read(coin()))).toBe(true)
    expect(paymentChecked(read(coin(asXmr), undefined, { record: record({ method: "xmr" }) }))).toBe(true)
    expect(paymentChecked(read(priced(), undefined, cardRecord))).toBe(true)
  })

  it("is not an invoice of another payment than the order asked for", () => {
    expect(paymentChecked(read(coin(asXmr)))).toBe(false)
    expect(paymentChecked(read(priced()))).toBe(false)
    expect(paymentChecked(read(coin(), undefined, cardRecord))).toBe(false)
    expect(paymentChecked(read(coin({ clientSecret: "pi_1_secret_2" })))).toBe(false)
  })

  it("is not an invoice of another amount or currency", () => {
    for (const amount of [held - 100, held + 100, 1500]) {
      expect(paymentChecked(read(coin({ amount }))), String(amount)).toBe(false)
      expect(paymentChecked(read(priced({ amount }), undefined, cardRecord)), `card ${amount}`).toBe(false)
    }
    expect(paymentChecked(read(coin({ currency: "eur" })))).toBe(false)
    expect(paymentChecked(read(priced({ currency: "USD" }), undefined, cardRecord))).toBe(false)
  })

  it("is not an invoice whose address its proof does not derive from the page's keys, or that has no proof", () => {
    expect(paymentChecked(read(coin({ address: moneroPayee(0, 2).address, cryptoCurrency: "xmr", addressProof: xmr.addressProof }), undefined, { record: record({ method: "xmr" }) }))).toBe(false)
    expect(paymentChecked(read(coin({ address: bitcoinPayee(devReceiving, LOCAL.bitcoinHrp, 1).address })))).toBe(false)
    expect(paymentChecked(read(coin({ addressProof: undefined })))).toBe(false)
    expect(paymentChecked(read(coin({ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" })))).toBe(false)
  })

  it("is not an invoice whose address differs from the one the order's record keeps for it", () => {
    const other = bitcoinPayee(devReceiving, LOCAL.bitcoinHrp, 1)
    expect(paymentChecked(read(coin(), undefined, { record: record({ payee: btc }) }))).toBe(true)
    expect(paymentChecked(read(coin(other), undefined, { record: record({ payee: btc }) }))).toBe(false)
    expect(paymentChecked(read(coin(other), undefined, { record: record({ payee: btc, invoiceId: "inv-0" }) })), "another invoice's address").toBe(true)
  })

  it("is not a card invoice whose PaymentIntent the card page found other than the invoice, which the reducer keeps for the page", () => {
    const mismatched = reduce(read(priced(), undefined, cardRecord), { type: "card-mismatched" })
    expect(mismatched.cardMismatched).toBe(true)
    expect(paymentChecked(mismatched)).toBe(false)
  })

  it("is not an invoice whose order the page holds no record of, as its name and payment are then the service's alone", () => {
    expect(paymentChecked(read(coin(), undefined, { record: null }))).toBe(false)
    expect(paymentChecked(read(priced(), undefined, { record: null }))).toBe(false)
  })
})

describe("costOf", () => {
  it("is the invoice's amount for an order paid by its invoice", () => {
    expect(costOf(registration(), crypto())).toBe(1500)
  })
  it("is null for a code order, which costs nothing", () => {
    expect(costOf(registration({ price: 0 }), null)).toBeNull()
  })
})

describe("finished", () => {
  const paidLate = (reg: Short) => crypto({ status: "paid", paidInFull: true }, reg)
  it("follows money paid after the close until it is in the balance", () => {
    expect(finished(paidLate({}), registration())).toBe(false)
    expect(finished(paidLate({}), registration({ balance: { amount: 1500, refunded: 0 } }))).toBe(true)
  })
  it("follows a late credit while it is confirming or being made, and stops once only support can make it", () => {
    for (const waiting of ["confirming", "crediting"] as const) expect(finished(paidLate({}), registration({ latePayment: waiting })), waiting).toBe(false)
    expect(finished(paidLate({}), registration({ latePayment: "support" }))).toBe(true)
    expect(finished(crypto({ status: "expired", cryptoAmountPaid: "0.0001" }), registration({ latePayment: "support" })), "a part payment").toBe(true)
  })
  it("stops at a whole late payment that BTCPay keeps expired once it is in the balance, and follows a part payment for the rest", () => {
    const credited: Short = { balance: { amount: 1500, refunded: 0 } }
    expect(finished(crypto(LATE_FULL, credited), registration(credited))).toBe(true)
    expect(finished(crypto(LATE_FULL), registration()), "not credited yet").toBe(false)
    const part = crypto({ status: "expired", cryptoAmountPaid: "0.0001" }, credited)
    expect(finished(part, part.registration)).toBe(false)
  })
  it("stops at an order whose payment was reversed, which nothing changes after", () => {
    const reversed: Short = { phase: "closed", closedBy: "reversed" }
    expect(finished(card({ status: "paid", amountPaid: 1500 }, reversed), registration(reversed))).toBe(true)
  })
  it("stops at a registered name or an ended registration, and follows an open invoice and a taken or failed order", () => {
    expect(finished(null, registration({ phase: "registered" }))).toBe(true)
    expect(finished(null, registration({ phase: "ended" }))).toBe(true)
    expect(finished(crypto(), registration())).toBe(false)
    expect(finished(null, registration({ phase: "taken" }))).toBe(false)
  })
})

describe("closedBalance", () => {
  const BALANCE = { amount: 750, refunded: 0 }
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

describe("failedLead", () => {
  const coded = record({ method: "code", invoiceId: null, prepaidCode: "SN6-AAAA" })
  const failed = (invoice: InvoiceView | null, change: Partial<OrderState> = {}) =>
    read(invoice, registration({ phase: "failed" }), { record: invoice ? record() : coded, ...change })
  it("an invoice's payment is kept, for support", () => {
    expect(failedLead(failed(crypto({ status: "paid", paidInFull: true })))).toBe("Your payment is kept. Write to support.")
  })
  it("a refused code says it can no longer pay", () => {
    expect(failedLead(failed(null, { codeRefused: true }))).toBe("Your code can no longer be used for it. Write to support.")
  })
  it("a code is said to be kept only once the service says so", () => {
    expect(failedLead(failed(null, { codeKept: true }))).toBe("Your code is kept. Write to support.")
    expect(failedLead(failed(null)), "the check has not answered, or failed").toBe("Write to support.")
  })
  it("a browser without the order's code is promised nothing of it, even once the service says it is unspent", () => {
    expect(failedLead(failed(null, { record: null, codeKept: true }))).toBe("Write to support.")
  })
})

describe("failedAlert", () => {
  const failed = (change: Short = {}, state: Partial<OrderState> = {}) => read(null, registration({ phase: "failed", ...change }), state)
  it("words the service's reason for the buyer", () => {
    expect(failedAlert(failed({ reason: "registryRefused" }))).toBe("The name could not be registered")
    expect(failedAlert(failed({ reason: "signatureRefused" }))).toBe("The name could not be registered")
    expect(failedAlert(failed({ reason: "monthEnded" }))).toBe("The name was not registered within a month")
    expect(failedAlert(failed({ reason: "unread" }))).toBe("The order was not opened for 3 days")
  })
  it("names the failures whose text sends the buyer to support", () => {
    expect(supportCase(failed({ reason: "signatureRefused" }))).toBe("signatureRefused")
    expect(supportCase(failed({ reason: "monthEnded" }))).toBe("monthEnded")
    expect(supportCase(failed({ reason: "unread" }))).toBe("unread")
    expect(supportCase(failed({ reason: "registryRefused" }))).toBeNull()
  })
})

describe("retryDue", () => {
  it("asks for a new commitment of an order whose commitment lapsed unsigned, from the browser with the name code", () => {
    expect(retryDue(LAPSED)).toBe(true)
    expect(retryDue({ ...LAPSED, record: null }), "no name code here").toBe(false)
    expect(retryDue({ ...LAPSED, nameStatus: "taken" }), "a search answering the name the order holds as taken").toBe(true)
    expect(retryDue({ ...LAPSED, busy: "retry" }), "one on its way").toBe(false)
    expect(retryDue({ ...LAPSED, hold: { until: NOW + 1000, lead: NO_LEAD } }), "a rate limit").toBe(false)
    expect(retryDue(read(null, registration(committed))), "still in its window").toBe(false)
  })
})

describe("a taken order's name", () => {
  const taken = read(null, registration({ phase: "taken", label: "alice" }))
  it("is taken as the search after it answered: reserved meanwhile, or not", () => {
    const start = initialState("reg-1", null)
    expect(reduce(start, answered(start, { ...taken, nameStatus: "reserved" })).nameStatus).toBe("reserved")
    expect(reduce(start, answered(start, taken)).nameStatus).toBeNull()
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
    for (const kind of ["registered", "taken", "failed", "status:no-code", "pay-crypto"] as const) {
      const s = STATES[kind]
      expect(stalledAt(reduce(s, answered(s, s))), kind).toBeNull()
    }
    const view = registration(committed)
    expect(stalledAt({ ...seen(view), reveal: { key: revealKey(view), sending: false, refusals: REVEAL_ATTEMPTS } })).toBeNull()
  })
  it("of a reveal waits while the service is in its downtime, which signs nothing, and of a transaction does not", () => {
    expect(stalledAt({ ...seen(registration(committed)), downtime: true })).toBeNull()
    expect(stalledAt({ ...seen(committing), downtime: true })).toBe(NOW + TX_STALL_MS)
  })
  it("waits while changed community terms are asked for, and is timed from the last tick", () => {
    const asking = registration({ ...committed, acceptance: acceptanceFor(CHANGED) })
    const ask = reask()
    expect(stalledAt({ ...seen(asking), ask }), "the changed community terms asked for").toBeNull()
    const agreed = reduce({ ...seen(asking), ask }, { type: "terms-agreed", agreed: true, now: NOW + 30_000 })
    expect(stalledAt(agreed), "the community terms not accepted yet").toBeNull()
    const ticked = reduce(agreed, { type: "terms-accepted", accepted: true, now: NOW + 60_000 })
    expect(stalledAt(ticked), "timed from the last tick").toBe(NOW + 60_000 + REVEAL_ATTEMPTS * RETRY_MS + STALL_MARGIN_MS)
    expect(stalledAt(seen(asking)), "changed terms that could not be asked for").not.toBeNull()
  })
})

describe("reveal helpers", () => {
  const view = registration(committed)
  const waiting = read(null, view)
  it("revealKey names the commit a reveal is signed for", () => {
    expect(revealKey(view)).toBe(`reg-1 ${COMMITMENT} 4 ${NOW / 1000 + 3600} 0x3 ${SIGNED} 0`)
    expect(revealKey(registration({ ...committed, acceptance: acceptanceFor(CHANGED) })), "and the acceptance it signs").toBe(`reg-1 ${COMMITMENT} 4 ${NOW / 1000 + 3600} 0x3 ${CHANGED} 0`)
  })
  it("a stored reveal ends its sending, so one the service clears is signed again under the same key", () => {
    const sent = reduce(waiting, { type: "reveal-sent", key: revealKey(view) })
    const stored = reduce(sent, answered(sent, read(null, registration({ ...committed, label: "alice" }))))
    expect(stored.reveal).toEqual({ key: revealKey(view), sending: false, refusals: 0 })
    expect(revealDue(reduce(stored, answered(stored, read(null, view))))).toBe(true)
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
    expect(revealDue(read(null, registration({ ...committed, label: "alice" })))).toBe(false)
    expect(revealDue(read(null, registration({ ...committed, phase: "registering" })))).toBe(false)
    // the chain reads the service could not make leave nothing to sign with
    expect(revealDue(read(null, registration({ ...committed, unread: true })))).toBe(false)
  })
  it("revealDue and askAgainDue for a community name: the reveal waits for changed terms to be ticked, which are asked for once, only with the name code", () => {
    const listedView: Short = { ...committed, community: communityEntry(), terms: { communityName: true, termsHash: SIGNED } }
    const listed = (termsHash: string, change: Partial<OrderState> = {}) => read(null, registration({ ...listedView, acceptance: acceptanceFor(termsHash) }), change)
    expect([revealDue(listed(SIGNED)), askAgainDue(listed(SIGNED))]).toEqual([true, false])
    expect([revealDue(listed(CHANGED)), askAgainDue(listed(CHANGED))], "terms changed on chain since the order").toEqual([false, true])
    const ask = reask()
    expect([revealDue(listed(CHANGED, { ask })), askAgainDue(listed(CHANGED, { ask }))], "asked, not ticked").toEqual([false, false])
    expect(askAgainDue(listed(CHANGED, { record: null })), "no name code in this browser").toBe(false)
    expect(askAgainDue(listed(CHANGED, { nameStatus: "taken" })), "a search answering the name the order holds as taken").toBe(true)
    expect(revealDue(listed(CHANGED, { ask: { ...ask, agreed: true } })), "the general terms' box alone").toBe(false)
    expect(revealDue(listed(CHANGED, { ask: { ...ask, accepted: true } })), "ticked").toBe(true)
    expect(revealDue(listed(CHANGED, { ask: { ...reask(SIGNED), accepted: true } })), "ticked other terms").toBe(false)
    expect(revealDue(read(null, registration({ ...listedView, unread: true }))), "an acceptance the service could not read").toBe(false)
  })
  it("revealDue and askAgainDue for a plain name: the reveal waits for changed general terms to be ticked", () => {
    const PLAIN = `0x${"21".repeat(32)}`
    const CHANGED_PLAIN = LOCAL.generalTerms[1].hash
    const plain = (termsHash: string, change: Partial<OrderState> = {}) =>
      read(null, registration({ ...committed, acceptance: acceptanceFor(termsHash, false), terms: { communityName: false, termsHash: PLAIN } }), { record: record({ terms: PLAIN.slice(2) }), ...change })
    expect([revealDue(plain(PLAIN)), askAgainDue(plain(PLAIN))]).toEqual([true, false])
    expect([revealDue(plain(CHANGED_PLAIN)), askAgainDue(plain(CHANGED_PLAIN))], "terms changed on chain since the order").toEqual([false, true])
    const ask = { ...askFor(record().label, termsOf(CHANGED_PLAIN), null, true), agreed: true }
    expect(revealDue(plain(CHANGED_PLAIN, { ask })), "ticked").toBe(true)
  })
  it("takes the terms the order signed from this browser's record, whatever terms the view names, and asks only for terms the page holds", () => {
    const claimed = (termsHash: string, change: Partial<OrderState> = {}) =>
      read(null, registration({ ...committed, acceptance: acceptanceFor(termsHash), terms: { communityName: true, termsHash } }), change)
    expect([revealDue(claimed(CHANGED)), askAgainDue(claimed(CHANGED))], "a view naming the changed terms as the order's").toEqual([false, true])
    expect([revealDue(claimed(CHANGED, { record: null })), askAgainDue(claimed(CHANGED, { record: null }))], "no name code in this browser").toEqual([false, false])
    const unheld = `0x${"d8".repeat(32)}`
    expect([revealDue(claimed(unheld)), askAgainDue(claimed(unheld))], "terms the page does not hold, which its own check refuses").toEqual([true, false])
  })
  it("unreadDelay reads a view with unread fields again after 5 s, 15 s, then every 30 s", () => {
    expect([0, 1, 2, 3, 10].map(unreadDelay)).toEqual([5000, 15000, 30000, 30000, 30000])
  })
  it("revealDue not in the service's downtime, and once the page read the downtime's end", () => {
    const down = reduce(waiting, answered(waiting, { ...waiting, downtime: true }))
    expect([down.downtime, revealDue(down)]).toEqual([true, false])
    expect(revealDue(reduce(down, answered(down, { ...down, downtime: false })))).toBe(true)
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
  const TERMS = termsOf(`0x${"f6".repeat(32)}`)
  const BAKERS = communityEntry("bakers and pastry chefs")

  it("terms-asked ends a new invoice's or a Continue's work and asks for the name's terms, unticked", () => {
    for (const started of ["reorder-started", "continue-started"] as const) {
      const s = reduce(STATES["status:closed"], { type: started })
      expect(reduce(s, { type: "terms-asked", label: "alice", terms: TERMS, community: BAKERS, changed: false }), started).toMatchObject({ busy: null, ask: { label: "alice", terms: TERMS, community: BAKERS, agreed: false, changed: false } })
    }
  })
  it("terms-agreed ticks the box and ends the notice that the terms changed", () => {
    const s = reduce(STATES["status:closed"], { type: "terms-asked", label: "alice", terms: TERMS, community: null, changed: true })
    const ticked = reduce(s, { type: "terms-agreed", agreed: true, now: NOW })
    expect(ticked.ask).toEqual({ label: "alice", terms: TERMS, community: null, agreed: true, accepted: false, changed: false })
    expect(reduce(ticked, { type: "terms-agreed", agreed: false, now: NOW }).ask).toEqual({ label: "alice", terms: TERMS, community: null, agreed: false, accepted: false, changed: false })
  })
  it("terms-accepted ticks a community name's own box and ends the notice that the terms changed", () => {
    const s = reduce(STATES["status:closed"], { type: "terms-asked", label: "alice", terms: TERMS, community: BAKERS, changed: true })
    const ticked = reduce(s, { type: "terms-accepted", accepted: true, now: NOW })
    expect(ticked.ask).toEqual({ label: "alice", terms: TERMS, community: BAKERS, agreed: false, accepted: true, changed: false })
    expect(reduce(ticked, { type: "terms-accepted", accepted: false, now: NOW }).ask).toMatchObject({ accepted: false })
    expect(reduce(STATES["status:closed"], { type: "terms-accepted", accepted: true, now: NOW }), "nothing asked").toBe(STATES["status:closed"])
  })
  it("terms-agreed with nothing asked changes nothing", () => {
    expect(reduce(STATES["status:closed"], { type: "terms-agreed", agreed: true, now: NOW })).toBe(STATES["status:closed"])
  })
  it("the ask stays while the order is read again", () => {
    const s = reduce(STATES["status:closed"], { type: "terms-asked", label: "alice", terms: TERMS, community: null, changed: false })
    expect(reduce(s, answered(s, STATES["status:closed"])).ask).toEqual(s.ask)
  })
  it("an order read with another name meanwhile drops the ask, ticked or not, so the next press asks for that name's terms", () => {
    const asked = reduce(STATES["status:closed"], { type: "terms-asked", label: "alice", terms: TERMS, community: null, changed: false })
    const ticked = reduce(asked, { type: "terms-agreed", agreed: true, now: NOW })
    const renamed = { ...STATES["status:closed"], record: record({ label: "bob123" }) }
    expect(reduce(ticked, answered(ticked, renamed)).ask).toBeNull()
    expect(reduce(ticked, { type: "record-changed", record: record({ label: "bob123" }), cardSubmittedAt: null }).ask).toBeNull()
    expect(reduce(ticked, { type: "record-changed", record: record(), cardSubmittedAt: null }).ask).toEqual(ticked.ask)
  })
})

describe("initialState", () => {
  it("starts with nothing read, holding as the tab does, and keeps a reveal carried over", () => {
    const reveal = { key: "reg-1 0x9c 4 1", sending: true, refusals: 1 }
    expect(initialState("inv-1", { until: NOW + 1000, lead: NO_LEAD }, reveal)).toEqual({
      reference: "inv-1", seq: 0, now: 0, invoice: null, view: null, record: null, cardSubmittedAt: null, cardFailed: false, cardMismatched: false,
      reveal, busy: null, note: null, hold: { until: NOW + 1000, lead: NO_LEAD }, price: null, gone: false, noCode: false, codeRefused: false, codeKept: false, codeCheckAt: null, ask: null,
      nameStatus: null, since: null, downtime: false,
    })
  })
})
