import { describe, expect, it } from "vitest"
import type { InvoiceView, RegistrationView, SearchAnswer } from "../src/api.ts"
import { type Hold, NO_LEAD } from "../src/screens/hold.ts"
import {
  balanceRows, changesOf, CODE_CHIPS, holderOf, editable, editsLine, editsShort, hasLinks, linksAction, type EditEvent, type EditForm, type EditKind, type EditState, hasRecords, initialEdit,
  initialList, initialRestore, lapsed, lateLine, listedOrders, nameRows, ORDER_CHIP_WORDS, rowShown, rowsDrawn, unanswered, paidLine, type ListEvent, type ListState, NOT_SAVED, phaseChip, reduceEdit, reduceList, reduceRestore, REFUSALS,
  againLine, ranOut, registrableAgain, screenOfEdit, type Stored, waitsToSign,
} from "../src/screens/names.ts"
import type { CodeRecord, OrderRecord, PendingCode } from "../src/store.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
const APP = "0x0B306BF915C4d645ff596e518fAf3F9669b97016"
const CHAIN = { resolver: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318", sponsor: "0x0B306BF915C4d645ff596e518fAf3F9669b97016", chainId: 31337, tld: "simplex" }
const YEAR_S = 365 * 24 * 3600
const CONTACT = "https://smp8.simplex.im/a#Y8m3qT0vLw2Ab7cD9eF1gH3jK5mN7p"
const CHANNEL = "https://smp9.simplex.im/c#Rk27xN4pDe9Tz1Wb3Yc5Vd7Xf9Hg2J"

function registration(change: Partial<RegistrationView> = {}): RegistrationView {
  return {
    ...CHAIN, id: "reg-1", version: 1, phase: "unpaid", labelHash: "0x4f1b", label: null, owner: OWNER, commitment: "0x9c11", sealed: "sealed-box", years: 2,
    duration: 2 * YEAR_S, price: 1500, fromBalance: 0, balance: null, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, moves: 0, intentNonce: null, unread: [], expiresAt: null, error: null, linksRefused: false, latePayment: null,
    community: null, terms: "2026-10-23", ...change,
  }
}

const invoice = (change: Partial<InvoiceView> = {}, reg: Partial<RegistrationView> = {}): InvoiceView => ({
  invoiceId: "inv-1", status: "open", amount: 1500, currency: "usd", expiresAt: "2026-10-17T12:30:00Z", kind: "name", registration: registration(reg),
  address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", cryptoAmount: "0.00025", cryptoCurrency: "btc", cryptoAmountPaid: "0", cryptoAmountDue: "0.00025",
  paidInFull: false, requiredConfirmations: 1, ...change,
})

function record(change: Partial<OrderRecord> = {}): OrderRecord {
  return {
    registrationId: "reg-1", invoiceId: "inv-1", label: "alice", ownerCode: "SN-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", owner: OWNER, contact: "", channel: "",
    method: "btc", paid: 1500, years: 2, request: { duration: 2 * 365 * 86400, labelHash: "0x4f1b", length: 5, owner: OWNER, commitment: "0x9c11", sealed: "sealed-box" },
    tld: "simplex", createdAt: "2026-10-17T11:59:00Z", ...change,
  }
}

const code = (c: string): CodeRecord => ({ code: c, minLength: 6, years: 2, addedAt: "2026-10-17T11:00:00Z" })
const pending = (ownerCode: string): PendingCode => ({ ownerCode, label: "bob", tld: "simplex", createdAt: "2026-10-17T11:30:00Z" })

// the registrar's GRACE_PERIOD, as the search answer gives it
const GRACE_S = 90 * 86_400
const registered = (records: { contact: string; channel: string } | null = { contact: CONTACT, channel: "" }, change: Partial<Extract<SearchAnswer, { status: "registered" }>> = {}): SearchAnswer =>
  ({ status: "registered", entities: [], records, owner: OWNER, recordsNonce: 3, recordEdits: { left: 3, nextAt: null }, expiresAt: NOW / 1000 + 2 * YEAR_S, gracePeriod: GRACE_S, tld: "simplex", community: null, ...change })
const available: SearchAnswer = { status: "available", price: 1500, currency: "usd", years: 2, termStart: Date.UTC(2027, 0, 1) / 1000, community: null, terms: { version: "2026-10-23", url: "https://simplex.chat/" }, ...CHAIN }
const registeredView = (change: Partial<RegistrationView> = {}) => registration({ phase: "registered", label: "alice", registerTx: "0xe9", expiresAt: NOW / 1000 + 2 * YEAR_S, ...change })

const stored = (change: Partial<Stored> = {}): Stored => ({ orders: [], pending: [], codes: [], canPersist: true, ...change })
const WAIT = { until: NOW + 5000, lead: NO_LEAD }
const storedEvent = (change: Partial<Stored> = {}, hold: Hold | null = null): ListEvent => ({ type: "stored", ...stored(change), hold })
const list = (change: Partial<Stored> = {}, state: Partial<ListState> = {}): ListState => ({ ...initialList(stored(change), null, {}, {}, NOW), ...state })

describe("list helpers", () => {
  it("lapsed: a registered name past its expiry, or one the search finds available again, is over", () => {
    const view = registeredView()
    expect(lapsed({ view, answer: registered() }, NOW)).toBe(false)
    expect(lapsed({ view, answer: registered() }, NOW + 3 * YEAR_S * 1000)).toBe(true)
    expect(lapsed({ view, answer: available }, NOW)).toBe(true)
    expect(lapsed({ view: registration({ phase: "committed" }), answer: available }, NOW)).toBe(false)
  })
  it("registrableAgain: free now once the search finds it available", () => {
    expect(registrableAgain(NOW / 1000 - GRACE_S - 1, available, NOW)).toEqual({ when: "now" })
  })
  it("registrableAgain: within the grace period, from the moment it ends, while the chain still has it registered", () => {
    const expiresAt = NOW / 1000 - 1
    expect(registrableAgain(expiresAt, registered(), NOW)).toEqual({ when: "from", at: expiresAt + GRACE_S })
    expect(registrableAgain(expiresAt, registered(), (expiresAt + GRACE_S) * 1000 - 1)).toEqual({ when: "from", at: expiresAt + GRACE_S })
  })
  it("registrableAgain: taken once the grace period is over and the name is registered again, or with no expiry to count from", () => {
    const expiresAt = NOW / 1000 - GRACE_S
    expect(registrableAgain(expiresAt, registered(undefined, { owner: APP }), NOW)).toEqual({ when: "taken" })
    expect(registrableAgain(null, registered(undefined, { owner: APP }), NOW)).toEqual({ when: "taken" })
  })
  it("registrableAgain: counts the grace period the answer gives, and none from an answer without one", () => {
    const expiresAt = NOW / 1000 - 1
    expect(registrableAgain(expiresAt, registered(undefined, { gracePeriod: 3600 }), NOW)).toEqual({ when: "from", at: expiresAt + 3600 })
    expect(registrableAgain(expiresAt, registered(undefined, { gracePeriod: undefined }), NOW)).toEqual({ when: "taken" })
  })
  it("ranOut and againLine say when a name ran out and when it can be registered again, as the edit page and search show it", () => {
    const expiresAt = Date.parse("2028-11-16T12:00:00Z") / 1000
    expect(ranOut(expiresAt)).toBe("Its registration ran out on 16\u00a0November 2028.")
    expect(ranOut(null)).toBe("Its registration ran out.")
    expect(againLine(expiresAt, registered(), expiresAt * 1000 + 1000)).toBe("It can be registered again from 14\u00a0February 2029.")
    expect(againLine(expiresAt, available, expiresAt * 1000)).toBe("Search it to register it again.")
    expect(againLine(expiresAt, registered(undefined, { owner: APP }), (expiresAt + GRACE_S) * 1000)).toBe("It has been registered again since.")
  })
  it("waitsToSign: a commit whose wait is over and whose name is still hidden", () => {
    const view = registration({ phase: "committed", revealAfter: NOW / 1000 - 1 })
    expect(waitsToSign(view, NOW)).toBe(true)
    expect(waitsToSign(view, NOW - 2000)).toBe(false)
    expect(waitsToSign({ ...view, label: "alice" }, NOW)).toBe(false)
    expect(waitsToSign({ ...view, revealAfter: null }, NOW)).toBe(false)
  })
  it("phaseChip words each phase of an order as its page does", () => {
    const cases: [string, RegistrationView, InvoiceView | null, OrderRecord, [string, string]][] = [
      ["a commit waiting for this browser", registration({ phase: "committed", revealAfter: NOW / 1000 - 1 }), null, record(), ["Open to finish", "warn"]],
      ["an expired invoice", registration(), invoice({ status: "expired" }), record(), ["Invoice expired", "bad"]],
      ["an expired invoice money reached", registration(), invoice({ status: "expired", cryptoAmountPaid: "0.0001" }), record(), ["Invoice expired", "warn"]],
      ["a cancelled invoice that closed", registration(), invoice({ status: "expired" }), record({ cancelled: true }), ["Invoice cancelled", "bad"]],
      ["a payment after the invoice closed", registration(), invoice({ status: "paid" }), record(), ["Paid late", "warn"]],
      ["a whole payment after the close, credited, kept expired", registration(), invoice({ status: "expired", cryptoAmountPaid: "0.00025", paidInFull: true }), record(), ["Paid late", "warn"]],
      ["a whole payment after a cancel, credited", registration(), invoice({ status: "expired", cryptoAmountPaid: "0.00025", paidInFull: true }), record({ cancelled: true }), ["Paid late", "warn"]],
      ["a whole payment after the close, confirming", registration(), invoice({ status: "expired", cryptoAmountPaid: "0.00025", paidInFull: true }, { latePayment: { waiting: "confirming" } }), record(),
        ["Invoice expired", "warn"]],
      ["a payment in full", registration(), invoice({ paidInFull: true }), record(), ["Confirming payment", "warn"]],
      ["a card submitted", registration(), invoice({ cryptoCurrency: "card" }), record({ cardSubmittedAt: "2026-10-17T11:59:30Z" }), ["Confirming payment", "warn"]],
      ["part of a payment", registration(), invoice({ cryptoAmountPaid: "0.0001" }), record(), ["Waiting for the rest", "warn"]],
      ["nothing paid", registration(), invoice(), record(), ["Waiting for payment", "warn"]],
      ["a registration under way", registration({ phase: "registering" }), null, record(), ["Registering", "brand"]],
      ["a registered name", registeredView(), null, record(), ["Registered", "ok"]],
      ["a name taken first", registration({ phase: "taken" }), null, record(), ["Taken first", "warn"]],
      ["a failed registration", registration({ phase: "failed" }), null, record(), ["Not registered", "bad"]],
    ]
    for (const [what, view, inv, o, chip] of cases) {
      expect(phaseChip(view, inv, o, NOW), what).toEqual(chip)
      expect(ORDER_CHIP_WORDS, `${what}: the words its row keeps room for`).toContain(chip[0])
    }
  })
  it("CODE_CHIPS words every state a code can be in", () => {
    expect(Object.keys(CODE_CHIPS).sort()).toEqual(["expired", "reserved", "revoked", "unpaid", "unused", "used"])
  })
  it("linksAction adds a name's first links, and edits links it has", () => {
    expect(linksAction(hasLinks(record(), null))).toBe("Add links")
    expect(linksAction(hasLinks(record({ contact: CONTACT }), null))).toBe("Edit links")
    expect(linksAction(hasLinks(record(), registered({ contact: "", channel: CHANNEL })))).toBe("Edit links")
  })
  it("editable: a name in the app's wallet, or pointed at another resolver, is not edited here", () => {
    expect(editable(registered(), OWNER)).toBe(true)
    expect(editable(registered(), OWNER.toLowerCase())).toBe(true)
    expect(editable(registered(undefined, { owner: APP }), OWNER)).toBe(false)
    expect(editable(registered(null), OWNER)).toBe(false)
    expect(editable(registered(undefined, { owner: undefined }), OWNER)).toBe(true)
    expect(editable(available, OWNER)).toBe(true)
  })
  it("hasLinks: a name's records once read, else the links it was ordered with", () => {
    expect(hasLinks(record(), registered()), "a contact address on chain").toBe(true)
    expect(hasLinks(record({ contact: CONTACT }), registered({ contact: "", channel: "" })), "links removed since the order").toBe(false)
    expect(hasLinks(record(), registered(null)), "records another resolver holds").toBe(false)
    expect(hasLinks(record({ channel: CONTACT }), undefined), "not read yet, ordered with a link").toBe(true)
    expect(hasLinks(record(), null), "not read yet, ordered without links").toBe(false)
    expect(hasLinks(record({ contact: CONTACT }), available), "an answer of no name").toBe(true)
  })
  it("listedOrders leaves out a replaced invoice until its read says money reached it", () => {
    const replaced = record({ registrationId: "reg-old", replacedBy: "/?order=inv-2" })
    const s = list({ orders: [record(), replaced] })
    expect(listedOrders(s).map((o) => o.registrationId)).toEqual(["reg-1"])
    const late = reduceList(s, { type: "row-read", id: "reg-old", view: registration({ id: "reg-old" }), invoice: invoice({ status: "paid" }), now: NOW })
    expect(listedOrders(late).map((o) => o.registrationId)).toEqual(["reg-1", "reg-old"])
    const empty = reduceList(s, { type: "row-read", id: "reg-old", view: registration({ id: "reg-old" }), invoice: invoice({ status: "expired" }), now: NOW })
    expect(listedOrders(empty).map((o) => o.registrationId)).toEqual(["reg-1"])
  })
  it("listedOrders puts the order that replaced another in the replaced one's place", () => {
    const newer = record({ registrationId: "reg-2", invoiceId: "inv-2", createdAt: "2026-10-17T11:59:30Z" })
    const other = record({ registrationId: "reg-b", invoiceId: "inv-b", createdAt: "2026-10-17T11:59:10Z" })
    const replaced = record({ registrationId: "reg-1", replacedBy: "/?order=inv-2" })
    expect(listedOrders(list({ orders: [newer, other, replaced] })).map((o) => o.registrationId)).toEqual(["reg-b", "reg-2"])
    const newest = record({ registrationId: "reg-3", invoiceId: "inv-3", createdAt: "2026-10-17T11:59:50Z" })
    const chain = [newest, { ...newer, replacedBy: "/?order=inv-3" }, other, replaced]
    expect(listedOrders(list({ orders: chain })).map((o) => o.registrationId)).toEqual(["reg-b", "reg-3"])
    const late = reduceList(list({ orders: [newer, other, replaced] }), { type: "row-read", id: "reg-1", view: registration(), invoice: invoice({ status: "paid" }), now: NOW })
    expect(listedOrders(late).map((o) => o.registrationId)).toEqual(["reg-2", "reg-b", "reg-1"])
  })
  it("a listed order that becomes replaced leaves the list until a fresh read says money reached it", () => {
    const open = reduceList(list({ orders: [record()] }), { type: "row-read", id: "reg-1", view: registration(), invoice: invoice(), now: NOW })
    expect(listedOrders(open).map((o) => o.registrationId)).toEqual(["reg-1"])
    const replaced = reduceList(open, storedEvent({ orders: [record({ replacedBy: "/?order=inv-2" })] }))
    expect(replaced.seen).toEqual({})
    expect(listedOrders(replaced)).toEqual([])
    const late = reduceList(replaced, { type: "row-read", id: "reg-1", view: registration(), invoice: invoice({ status: "paid" }), now: NOW })
    expect(listedOrders(reduceList(late, storedEvent({ orders: late.orders }))).map((o) => o.registrationId)).toEqual(["reg-1"])
  })
  it("a read begun before another tab replaced the order lists it again only for money that reached it, whichever lands first", () => {
    const open = reduceList(list({ orders: [record()] }), { type: "row-read", id: "reg-1", view: registration(), invoice: invoice(), now: NOW })
    const replacedNow = storedEvent({ orders: [record({ replacedBy: "/?order=inv-2" })] })
    const staleRead = { type: "row-read", id: "reg-1", view: registration(), invoice: invoice(), now: NOW + 1000 } as const
    expect(listedOrders(reduceList(reduceList(open, replacedNow), staleRead))).toEqual([])
    expect(listedOrders(reduceList(reduceList(open, staleRead), replacedNow))).toEqual([])
    const paidRead = { ...staleRead, invoice: invoice({ status: "expired", cryptoAmountPaid: "0.0001" }) }
    expect(listedOrders(reduceList(reduceList(open, replacedNow), paidRead)).map((o) => o.registrationId)).toEqual(["reg-1"])
  })
  it("hasRecords: any order, pending code or code", () => {
    expect(hasRecords(list())).toBe(false)
    expect(hasRecords(list({ pending: [pending("SN-P")] }))).toBe(true)
    expect(hasRecords(list({ codes: [code("SN6-A")] }))).toBe(true)
    expect(hasRecords(list({ orders: [record({ replacedBy: "/?order=inv-2" })] }))).toBe(true)
  })
})

describe("balances", () => {
  const BALANCE = { amount: 10000, held: false, heldUntil: null, refunded: 0 }
  const orders = [record({ registrationId: "reg-taken" }), record({ registrationId: "reg-late", invoiceId: "inv-2" }), record({ registrationId: "reg-moved", invoiceId: "inv-3" }),
    record({ registrationId: "reg-plain", invoiceId: "inv-4" })]
  // a registered name's row is complete with its name's answer
  const read = (s: ListState, id: string, view: RegistrationView, inv: InvoiceView | null = null) => {
    const r = reduceList(s, { type: "row-read", id, view, invoice: inv, now: NOW })
    return view.phase === "registered" ? reduceList(r, { type: "row-answered", id, answer: registered() }) : r
  }
  const all = () => {
    let s = list({ orders })
    s = read(s, "reg-taken", registration({ id: "reg-taken", phase: "taken", balance: BALANCE }))
    s = read(s, "reg-late", registration({ id: "reg-late", balance: { ...BALANCE, amount: 2500, refunded: 7500 } }), invoice({ invoiceId: "inv-2", status: "paid" }))
    s = read(s, "reg-moved", registration({ id: "reg-moved", phase: "registered", balance: { ...BALANCE, amount: 5000, held: true, heldUntil: "2026-10-17T12:30:00Z" } }))
    return read(s, "reg-plain", registration({ id: "reg-plain", phase: "registered" }))
  }
  it("lists each order's balance with what made it, what support refunded, and the open invoice that holds it", () => {
    expect(balanceRows(all())).toEqual([
      { id: "reg-taken", amount: 10000, refunded: 0, held: false, heldUntil: null, from: "taken" },
      { id: "reg-late", amount: 2500, refunded: 7500, held: false, heldUntil: null, from: "late" },
      { id: "reg-moved", amount: 5000, refunded: 0, held: true, heldUntil: "2026-10-17T12:30:00Z", from: "rest" },
    ])
  })
  it("lists a balance support refunded whole, with nothing left, and no balance spent whole or not read yet", () => {
    let s = list({ orders })
    s = read(s, "reg-taken", registration({ id: "reg-taken", phase: "taken", balance: { ...BALANCE, amount: 0, refunded: 10000 } }))
    s = read(s, "reg-moved", registration({ id: "reg-moved", phase: "registered", balance: { ...BALANCE, amount: 0 } }))
    expect(balanceRows(s)).toEqual([{ id: "reg-taken", amount: 0, refunded: 10000, held: false, heldUntil: null, from: "taken" }])
  })
  it("lists a name registered by someone else first by its balance alone, and every other order as a name", () => {
    expect(nameRows(all()).map((o) => o.registrationId)).toEqual(["reg-late", "reg-moved", "reg-plain"])
    let spent = list({ orders })
    spent = read(spent, "reg-taken", registration({ id: "reg-taken", phase: "taken", balance: { ...BALANCE, amount: 0 } }))
    expect(nameRows(spent).map((o) => o.registrationId), "a taken order whose balance is spent stays a name").toContain("reg-taken")
  })
})

describe("holderOf", () => {
  const orders = [record({ registrationId: "expired", invoiceId: "inv-e", balanceSource: "src" }), record({ registrationId: "paid", invoiceId: "inv-p", balanceSource: "src" }),
    record({ registrationId: "open", invoiceId: "inv-o", balanceSource: "src" }), record({ registrationId: "other", invoiceId: "inv-x", balanceSource: "src2" })]
  const read = (s: ListState, id: string, status: InvoiceView["status"], phase: RegistrationView["phase"] = "unpaid") =>
    reduceList(s, { type: "row-read", id, view: registration({ id, phase }), invoice: invoice({ invoiceId: `inv-${id}`, status }), now: NOW })
  it("is the order whose invoice is open and holds the balance, never one that expired or was paid", () => {
    let s = read(read(list({ orders }), "expired", "expired"), "paid", "paid", "queued")
    expect(holderOf(s, "src"), "none open").toBeUndefined()
    s = read(read(s, "open", "open"), "other", "open")
    expect(holderOf(s, "src")?.registrationId).toBe("open")
  })
})

describe("paidLine", () => {
  it("names the invoice's amount and method", () => {
    expect(paidLine(record(), registration(), invoice())).toBe("$15 Bitcoin")
    expect(paidLine(record(), registration(), invoice({ cryptoCurrency: undefined }))).toBe("$15 Card")
  })
  it("adds what a balance paid beside a difference invoice", () => {
    expect(paidLine(record(), registration({ price: 2500, fromBalance: 1000 }), invoice())).toBe("$15 Bitcoin and $10 from your balance")
  })
  it("says a balance alone paid an order it covered, read or not", () => {
    expect(paidLine(record({ invoiceId: null, method: "balance" }), null, null)).toBe("Paid from your balance")
    expect(paidLine(record({ invoiceId: null, method: "code" }), registration({ fromBalance: 1500 }), null)).toBe("Paid from your balance")
  })
  it("words a code order as a free name, never as a payment, and a taken one's code as released", () => {
    expect(paidLine(record({ invoiceId: null, method: "code", paid: 0 }), registration({ price: 0 }), null)).toBe("Registered with a code")
    expect(paidLine(record({ invoiceId: null, method: "code", paid: 0 }), registration({ price: 0, phase: "taken" }), null))
      .toBe("Free name with a code; the code was released for another name")
  })
  it("names the record's worth and method before the order is read", () => {
    expect(paidLine(record({ method: "xmr", paid: 2500 }), null, null)).toBe("$25 Monero")
  })
})

describe("lateLine", () => {
  it("keeps a payment that arrived after its invoice closed as the order's balance", () => {
    expect(lateLine(invoice({ status: "paid", paidInFull: true }))).toBe("Paid after the invoice closed; kept as your balance")
  })
  it("says a whole payment that BTCPay keeps expired, or invalid after a cancel, was paid after the close once it is credited", () => {
    expect(lateLine(invoice({ status: "expired", cryptoAmountPaid: "0.00025", cryptoAmountDue: "0", paidInFull: true }))).toBe("Paid after the invoice closed; kept as your balance")
  })
  it("keeps part of a payment, and a payment that had not completed, held as the invoice closed", () => {
    expect(lateLine(invoice({ status: "expired", cryptoAmountPaid: "0.0001" }))).toBe("Part of the payment arrived; kept as your balance")
    expect(lateLine(invoice({ status: "expired", amountPaid: 1500, cryptoCurrency: "card" })))
      .toBe("A payment did not complete before the invoice closed; kept as your balance")
  })
  it("keeps it as the balance once it is confirmed or credited, while the credit waits on either", () => {
    const whole = { status: "expired", cryptoAmountPaid: "0.00025", cryptoAmountDue: "0", paidInFull: true } as const
    expect(lateLine(invoice(whole, { latePayment: { waiting: "confirming" } }))).toBe("A payment did not complete before the invoice closed; kept as your balance once confirmed")
    expect(lateLine(invoice(whole, { latePayment: { waiting: "crediting" } }))).toBe("A payment did not complete before the invoice closed; kept as your balance once credited")
    expect(lateLine(invoice({ status: "expired", cryptoAmountPaid: "0.0001" }, { latePayment: { waiting: "confirming" } })))
      .toBe("Part of the payment arrived; kept as your balance once confirmed")
  })
  it("sends to support money the service cannot credit by itself", () => {
    expect(lateLine(invoice({ status: "paid", paidInFull: true }, { latePayment: { waiting: "support" } }))).toBe("Paid after the invoice closed; write to support to have it credited")
    expect(lateLine(invoice({ status: "expired", cryptoAmountPaid: "0.0001" }, { latePayment: { waiting: "support" } })))
      .toBe("Part of the payment arrived; write to support to have it credited")
  })
  it("is null for an invoice that closed with nothing received, and for an open one", () => {
    expect(lateLine(invoice({ status: "expired" }))).toBeNull()
    expect(lateLine(invoice({ status: "open", cryptoAmountPaid: "0.0001" }))).toBeNull()
  })
})

describe("list", () => {
  const view = registration({ phase: "committing" })
  const one = list({ orders: [record()], codes: [code("SN6-A")], pending: [pending("SN-P")] })

  it("initialList starts from what the rows read last time, for the records still kept, and checks again a code that could not be", () => {
    const seen = { "reg-1": { view, invoice: null }, "reg-gone": { view, invoice: null } }
    const s = initialList(stored({ orders: [record()], codes: [code("SN6-A"), code("SN6-B")] }), null, seen, { "SN6-A": "used", "SN6-B": "unchecked", "SN6-gone": "unused" }, NOW)
    expect(s.seen).toEqual({ "reg-1": { view, invoice: null } })
    const replaced = initialList(stored({ orders: [record({ replacedBy: "/?order=inv-2" })] }), null, { "reg-1": { view, invoice: invoice() } }, {}, NOW)
    expect(replaced.seen).toEqual({})
    expect(listedOrders(replaced)).toEqual([])
    expect(s.checked).toEqual({ "SN6-A": "used" })
    expect(s).toMatchObject({ now: NOW, asking: false, hold: null, finding: {}, unread: [] })
    expect(initialList(stored({ pending: [pending("SN-P")] }), WAIT, {}, {}, NOW).hold).toEqual(WAIT)
  })
  it("stored takes the records another tab or this one wrote, and forgets what was read about records gone", () => {
    const read = reduceList(reduceList(one, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW }), { type: "code-read", code: "SN6-A", state: "unused" })
    const found = reduceList(read, { type: "find-ended", ownerCode: "SN-P", outcome: "none" })
    const next = reduceList(found, storedEvent({ codes: [code("SN6-B")], canPersist: false }, WAIT))
    expect(next).toMatchObject({ orders: [], pending: [], codes: [code("SN6-B")], canPersist: false, hold: WAIT, seen: {}, checked: {}, finding: {}, unread: [] })
  })
  it("stored with nothing left takes the forget question away", () => {
    const asking = reduceList(one, { type: "forget-asked" })
    expect(reduceList(asking, storedEvent()).asking).toBe(false)
    expect(reduceList(asking, storedEvent({ codes: [code("SN6-A")] })).asking).toBe(true)
  })
  it("row-read keeps the read, the time, and a registered name's records until they are read again", () => {
    const answer = registered()
    const first = reduceList(one, { type: "row-read", id: "reg-1", view: registeredView(), invoice: null, now: NOW + 1000 })
    const withAnswer = reduceList(first, { type: "row-answered", id: "reg-1", answer })
    expect(withAnswer.seen["reg-1"]).toEqual({ view: registeredView(), invoice: null, answer })
    const again = reduceList(withAnswer, { type: "row-read", id: "reg-1", view: registeredView(), invoice: null, now: NOW + 2000 })
    expect(again.seen["reg-1"].answer).toBe(answer)
    expect(again.now).toBe(NOW + 2000)
    const notRegistered = reduceList({ ...one, seen: { "reg-1": { view, invoice: null, answer } } }, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW })
    expect(notRegistered.seen["reg-1"].answer).toBeUndefined()
  })
  it("row-read clears the row's failed read", () => {
    const failed = reduceList(one, { type: "row-unread", id: "reg-1" })
    expect(failed.unread).toEqual(["reg-1"])
    expect(reduceList(failed, { type: "row-unread", id: "reg-1" }).unread).toEqual(["reg-1"])
    expect(reduceList(failed, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW }).unread).toEqual([])
  })
  it("an answer about a record no longer kept changes nothing", () => {
    expect(reduceList(one, { type: "row-read", id: "reg-gone", view, invoice: null, now: NOW })).toBe(one)
    expect(reduceList(one, { type: "row-answered", id: "reg-1", answer: null })).toBe(one)
    expect(reduceList(one, { type: "row-unread", id: "reg-gone" })).toBe(one)
    expect(reduceList(one, { type: "code-read", code: "SN6-gone", state: "used" })).toBe(one)
    expect(reduceList(one, { type: "find-started", ownerCode: "SN-gone" })).toBe(one)
    expect(reduceList(one, { type: "find-ended", ownerCode: "SN-gone", outcome: "none" })).toBe(one)
  })
  it("code-read keeps the code's state, or that it could not be checked", () => {
    expect(reduceList(one, { type: "code-read", code: "SN6-A", state: "reserved" }).checked).toEqual({ "SN6-A": "reserved" })
    expect(reduceList(one, { type: "code-read", code: "SN6-A", state: "unchecked" }).checked).toEqual({ "SN6-A": "unchecked" })
  })
  it("a code read refused for a rate limit keeps when it is checked again, until a read answers it or the code goes", () => {
    const limited = reduceList(one, { type: "code-read", code: "SN6-A", state: "unchecked", checkAgainAt: NOW + 30_000 })
    expect(limited).toMatchObject({ checked: { "SN6-A": "unchecked" }, checkAgainAt: { "SN6-A": NOW + 30_000 } })
    expect(reduceList(limited, { type: "code-read", code: "SN6-A", state: "unused" })).toMatchObject({ checked: { "SN6-A": "unused" }, checkAgainAt: {} })
    expect(reduceList(limited, { type: "stored", hold: null, ...stored({ orders: [record()] }) }).checkAgainAt).toEqual({})
    expect(reduceList(limited, { type: "forget-confirmed" }).checkAgainAt).toEqual({})
    expect(initialList(stored({ codes: [code("SN6-A")] }), null, {}, limited.checked, NOW).checkAgainAt, "a page opened again checks at once").toEqual({})
  })
  it("find-started marks the lookup at work; find-ended keeps what it found", () => {
    const finding = reduceList(one, { type: "find-started", ownerCode: "SN-P" })
    expect(finding.finding).toEqual({ "SN-P": "finding" })
    expect(reduceList(finding, { type: "find-ended", ownerCode: "SN-P", outcome: "none" }).finding).toEqual({ "SN-P": "none" })
    expect(reduceList(finding, { type: "find-ended", ownerCode: "SN-P", outcome: "unchecked" }).finding).toEqual({ "SN-P": "unchecked" })
  })
  it("find-held ends the lookup and holds every Find until hold-ended, a shorter wait never cutting a longer one", () => {
    const held = reduceList(reduceList(one, { type: "find-started", ownerCode: "SN-P" }), { type: "find-held", ownerCode: "SN-P", until: NOW + 5000 })
    expect(held).toMatchObject({ finding: {}, hold: WAIT })
    expect(reduceList(held, { type: "find-held", ownerCode: "SN-P", until: NOW + 1000 }).hold).toEqual(WAIT)
    expect(reduceList(held, { type: "hold-ended" }).hold).toBeNull()
  })
  it("forget-asked asks only while there is something to forget; forget-kept takes the question away", () => {
    const asking = reduceList(one, { type: "forget-asked" })
    expect(asking.asking).toBe(true)
    expect(reduceList(asking, { type: "forget-kept" }).asking).toBe(false)
    expect(reduceList(list(), { type: "forget-asked" }).asking).toBe(false)
  })
  it("forget-confirmed forgets every record and everything read about them", () => {
    const read = reduceList(reduceList(one, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW }), { type: "forget-asked" })
    expect(reduceList(read, { type: "forget-confirmed" })).toEqual({ ...list({}, { now: NOW }), canPersist: true })
  })
  it("the same events give the same list, whatever the rows' reads answer in between", () => {
    const events = [
      { type: "row-read", id: "reg-1", view, invoice: null, now: NOW },
      { type: "code-read", code: "SN6-A", state: "unused" },
      { type: "find-started", ownerCode: "SN-P" },
    ] as const
    const a = events.reduce(reduceList, one)
    const b = [events[2], events[0], events[1]].reduce(reduceList, one)
    expect(a).toEqual(b)
  })
})

describe("show code", () => {
  const two = stored({ orders: [record(), record({ registrationId: "reg-2" })] })
  const shown = (id: string) => reduceList(initialList(two, null, {}, {}, NOW), { type: "code-toggled", id })
  it("starts with no row expanded", () => {
    expect(initialList(two, null, {}, {}, NOW).shownCode).toBeNull()
  })
  it("expands one row at a time and collapses it when toggled again", () => {
    const one = shown("reg-1")
    expect(one.shownCode).toBe("reg-1")
    expect(reduceList(one, { type: "code-toggled", id: "reg-2" }).shownCode).toBe("reg-2")
    expect(reduceList(one, { type: "code-toggled", id: "reg-1" }).shownCode).toBeNull()
  })
  it("a row no longer stored is not expanded, and a toggle for an unknown row changes nothing", () => {
    expect(reduceList(shown("reg-2"), { type: "stored", ...two, orders: [record()], hold: null }).shownCode).toBeNull()
    expect(reduceList(shown("reg-2"), { type: "stored", ...two, hold: null }).shownCode).toBe("reg-2")
    expect(reduceList(shown("reg-1"), { type: "code-toggled", id: "reg-gone" }).shownCode).toBe("reg-1")
  })
  it("forgetting everything collapses the row", () => {
    expect(reduceList(shown("reg-1"), { type: "forget-confirmed" }).shownCode).toBeNull()
  })
})

describe("restore", () => {
  const start = initialRestore(null)
  it("starts held when a wait met elsewhere in the tab is still on", () => {
    expect(initialRestore({ until: NOW + 5000, lead: NO_LEAD })).toEqual({ busy: false, refusal: null, hold: { until: NOW + 5000, lead: NO_LEAD } })
    expect(start).toEqual({ busy: false, refusal: null, hold: null })
  })
  it("find-started marks the lookup at work and clears the last refusal", () => {
    expect(reduceRestore({ ...start, refusal: "unasked" }, { type: "find-started" })).toEqual({ busy: true, refusal: null, hold: null })
  })
  it("refused ends the lookup with why", () => {
    expect(reduceRestore({ ...start, busy: true }, { type: "refused", why: "none" })).toEqual({ busy: false, refusal: "none", hold: null })
  })
  it("edited takes the refusal away, unless the tab is waiting", () => {
    expect(reduceRestore({ ...start, refusal: "none" }, { type: "edited" })).toEqual(start)
    const held = { ...start, hold: { until: NOW + 5000, lead: "Your code is fine. " } }
    expect(reduceRestore(held, { type: "edited" })).toBe(held)
  })
  it("held ends the lookup and holds it with its words; hold-ended lets it go", () => {
    const held = reduceRestore({ ...start, busy: true }, { type: "held", until: NOW + 5000, lead: "Your code is fine. " })
    expect(held).toEqual({ busy: false, refusal: null, hold: { until: NOW + 5000, lead: "Your code is fine. " } })
    expect(reduceRestore(held, { type: "hold-ended" })).toEqual(start)
  })
  it("REFUSALS: a refusal of the code itself waits for an edit; one of the service can be tried again", () => {
    expect(Object.entries(REFUSALS).filter(([, r]) => r.again).map(([k]) => k)).toEqual(["unasked"])
  })
})

describe("edit", () => {
  const opened = initialEdit("reg-1", record({ invoiceId: null, method: "code" }))
  const answered = (s: EditState, answer: SearchAnswer, view = registeredView(), change: Partial<Extract<EditEvent, { type: "answered" }>> = {}): EditState =>
    reduceEdit(s, { type: "answered", view, answer, record: s.record!, now: NOW, hold: null, ...change })
  const form = (s: EditState): EditForm => s.form!
  const editing = answered(opened, registered())

  const STATES: Record<EditKind, EditState> = {
    "edit-no-code": initialEdit("reg-1", null),
    "edit-unreadable": reduceEdit(opened, { type: "read-failed" }),
    "edit-expired": answered(opened, available),
    "edit-in-app": answered(opened, registered(undefined, { owner: APP })),
    "edit-elsewhere": answered(opened, registered(null)),
    "edit-not-registered": answered(opened, { status: "reserved", community: null }, registration({ phase: "committed" })),
    edit: editing,
  }

  describe("screenOfEdit", () => {
    const cases: [string, EditState, EditKind][] = [
      ["a name whose code is not in this browser", STATES["edit-no-code"], "edit-no-code"],
      ["an order with no record at all", initialEdit("reg-1", null), "edit-no-code"],
      ["a name not read yet", opened, "edit-unreadable"],
      ["a name whose read failed", STATES["edit-unreadable"], "edit-unreadable"],
      ["a name past its expiry", answered(opened, registered(), registeredView({ expiresAt: NOW / 1000 - 1 })), "edit-expired"],
      ["a name registered again by someone else", STATES["edit-expired"], "edit-expired"],
      ["a name moved to the app's wallet", STATES["edit-in-app"], "edit-in-app"],
      ["a name pointed at another resolver", STATES["edit-elsewhere"], "edit-elsewhere"],
      ["a name still being registered", STATES["edit-not-registered"], "edit-not-registered"],
      ["a registered name without a records nonce", answered(opened, registered(undefined, { recordsNonce: null })), "edit-not-registered"],
      ["a registered name with its links", STATES.edit, "edit"],
    ]
    it.each(cases)("%s", (_, state, kind) => {
      expect(screenOfEdit(state)).toBe(kind)
    })
  })

  describe("reduceEdit", () => {
    it("answered opens the form with the chain's links and nonce, held when the tab is waiting", () => {
      expect(form(editing)).toEqual({
        current: { contact: CONTACT, channel: "" }, values: { contact: CONTACT, channel: "" }, nonce: 3, changes: {},
        saving: false, unanswered: false, settled: false, result: null, hold: null, edits: { left: 3, nextAt: null },
      })
      expect(form(answered(opened, registered(undefined, { recordEdits: undefined }))).edits, "a service that counts no edits").toBeNull()
      expect(form(answered(opened, registered(), undefined, { hold: { until: NOW + 5000, lead: NO_LEAD } })).hold).toEqual({ until: NOW + 5000, lead: NO_LEAD })
      expect(STATES["edit-in-app"].form).toBeNull()
    })
    it("answered again keeps the form as it is typed", () => {
      const typed = reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL })
      expect(form(answered(typed, registered(undefined, { recordsNonce: 9 }))).values.channel).toBe(CHANNEL)
    })
    it("opened changes nothing", () => {
      expect(reduceEdit(STATES["edit-no-code"], { type: "opened" })).toBe(STATES["edit-no-code"])
    })
    it("read-started marks a read under way; read-failed ends it and counts the failure, answered ends it", () => {
      const reading = reduceEdit(STATES["edit-unreadable"], { type: "read-started" })
      expect(reading).toMatchObject({ reading: true, failures: 1 })
      expect(reduceEdit(reading, { type: "read-failed" })).toMatchObject({ reading: false, failures: 2 })
      expect(answered(reading, registered()).reading).toBe(false)
    })
    it("field-changed keeps the value, takes away an answer it no longer stands for and lets Save go again", () => {
      const saved = { ...editing, form: { ...form(editing), result: "saved" as const, settled: true } }
      const typed = reduceEdit(saved, { type: "field-changed", kind: "channel", value: CHANNEL })
      expect(form(typed)).toMatchObject({ values: { contact: CONTACT, channel: CHANNEL }, result: null, settled: false })
      const moved = { ...editing, form: { ...form(editing), values: { contact: "", channel: "" }, result: "moved" as const } }
      expect(form(reduceEdit(moved, { type: "field-changed", kind: "contact", value: CONTACT }))).toMatchObject({ values: { contact: CONTACT, channel: "" }, result: "moved" })
    })
    it("field-changed to the value it had changes nothing", () => {
      expect(reduceEdit(editing, { type: "field-changed", kind: "contact", value: CONTACT })).toBe(editing)
    })
    it("field-changed while a save is on its way, unanswered or held keeps only the value", () => {
      for (const block of [{ saving: true }, { unanswered: true }, { hold: { until: NOW + 5000, lead: NO_LEAD } }]) {
        const s = { ...editing, form: { ...form(editing), ...block, result: "sending" as const } }
        expect(form(reduceEdit(s, { type: "field-changed", kind: "channel", value: CHANNEL }))).toEqual({ ...s.form, values: { contact: CONTACT, channel: CHANNEL } })
      }
    })
    it("save-started with nothing changed says so; with changes it sends them", () => {
      expect(form(reduceEdit(editing, { type: "save-started" }))).toMatchObject({ saving: false, result: "nothing" })
      const typed = reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL })
      expect(form(reduceEdit(typed, { type: "save-started" }))).toMatchObject({ saving: true, result: "sending", changes: { channel: CHANNEL } })
    })
    it("save-done takes every changed link as on chain, spending a nonce per link and one edit for the Save", () => {
      const both = reduceEdit(reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "contact", value: "" }), { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      expect(form(reduceEdit(both, { type: "save-done", at: NOW / 1000 }))).toMatchObject({
        saving: false, result: "saved", settled: true, nonce: 5, current: { contact: "", channel: CHANNEL }, edits: { left: 2, nextAt: NOW / 1000 + YEAR_S },
      })
      const one = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      expect(form(reduceEdit(one, { type: "save-done", at: NOW / 1000 }))).toMatchObject({ nonce: 4, current: { contact: CONTACT, channel: CHANNEL }, edits: { left: 2, nextAt: NOW / 1000 + YEAR_S } })
    })
    it("save-done keeps when the oldest counted edit returns, and counts nothing for a service that counts none", () => {
      const counted = answered(opened, registered(undefined, { recordEdits: { left: 2, nextAt: NOW / 1000 + 100 } }))
      const sending = reduceEdit(reduceEdit(counted, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      expect(form(reduceEdit(sending, { type: "save-done", at: NOW / 1000 })).edits).toEqual({ left: 1, nextAt: NOW / 1000 + 100 })
      const uncounted = answered(opened, registered(undefined, { recordEdits: null }))
      const sent = reduceEdit(reduceEdit(reduceEdit(uncounted, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" }), { type: "save-done", at: NOW / 1000 })
      expect(form(sent).edits).toBeNull()
    })
    it("save-done leaves Save on for a field typed while the Save was on its way", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const typedMeanwhile = reduceEdit(sending, { type: "field-changed", kind: "contact", value: "" })
      expect(form(reduceEdit(typedMeanwhile, { type: "save-done", at: NOW / 1000 }))).toMatchObject({ result: "saved", settled: false, current: { contact: CONTACT, channel: CHANNEL } })
    })
    it("save-limited takes the edits as used up until the service's time, with no notice, as no link reached the chain", () => {
      const both = reduceEdit(reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "contact", value: "" }), { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const nextAt = NOW / 1000 + 1000
      expect(form(reduceEdit(both, { type: "save-limited", nextAt }))).toMatchObject({ saving: false, result: null, nonce: 3, current: { contact: CONTACT, channel: "" }, edits: { left: 0, nextAt } })
    })
    it("save-unanswered keeps Save off until the page is reloaded, spending an edit only when the service took it", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      expect(form(reduceEdit(sending, { type: "save-unanswered", counted: false, at: NOW / 1000 }))).toMatchObject({ saving: false, unanswered: true, result: "unanswered", edits: { left: 3, nextAt: null } })
      expect(form(reduceEdit(sending, { type: "save-unanswered", counted: true, at: NOW / 1000 })).edits).toEqual({ left: 2, nextAt: NOW / 1000 + YEAR_S })
    })
    it("save-held holds Save, saying the links were not saved; hold-ended lets it go", () => {
      const both = reduceEdit(reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "contact", value: "" }), { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const held = reduceEdit(both, { type: "save-held", until: NOW + 5000 })
      expect(form(held)).toMatchObject({ saving: false, result: null, nonce: 3, hold: { until: NOW + 5000, lead: `${NOT_SAVED} ` } })
      expect(form(reduceEdit(held, { type: "hold-ended" })).hold).toBeNull()
    })
    it("save-refused after the nonce moved takes the chain's nonce and links", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const moved = reduceEdit(sending, { type: "save-refused", moved: { nonce: 7, records: { contact: "", channel: CHANNEL } } })
      expect(form(moved)).toMatchObject({ saving: false, result: "moved", nonce: 7, current: { contact: "", channel: CHANNEL } })
      expect(form(reduceEdit(sending, { type: "save-refused", moved: { nonce: 7, records: null } }))).toMatchObject({ nonce: 7, current: { contact: CONTACT, channel: "" } })
      expect(form(reduceEdit(sending, { type: "save-refused", moved: null }))).toMatchObject({ saving: false, result: "refused", nonce: 3 })
    })
    it("save-refused takes the edits left as the service read them again, else keeps its own", () => {
      const sending = reduceEdit(reduceEdit(editing, { type: "field-changed", kind: "channel", value: CHANNEL }), { type: "save-started" })
      const edits = { left: 1, nextAt: NOW / 1000 + 50 }
      expect(form(reduceEdit(sending, { type: "save-refused", moved: null, edits })).edits).toEqual(edits)
      expect(form(reduceEdit(sending, { type: "save-refused", moved: { nonce: 7, records: null }, edits })).edits).toEqual(edits)
      expect(form(reduceEdit(sending, { type: "save-refused", moved: null })).edits).toEqual({ left: 3, nextAt: null })
    })
    it("form events reach no form on a page that has none", () => {
      const s = STATES["edit-in-app"]
      for (const event of [{ type: "save-started" }, { type: "field-changed", kind: "contact", value: "x" }, { type: "hold-ended" }] as EditEvent[]) expect(reduceEdit(s, event)).toBe(s)
    })
  })

  describe("form helpers", () => {
    const f = (change: Partial<EditForm>): EditForm => ({ ...form(editing), ...change })
    it("changesOf lists the links that differ from the chain's", () => {
      expect(changesOf(f({}))).toEqual({})
      expect(changesOf(f({ values: { contact: "", channel: CHANNEL } }))).toEqual({ contact: "", channel: CHANNEL })
    })
    it("editsLine says the Saves left this year, whatever the Save changes, and when they return", () => {
      expect(editsLine(f({}))).toBe("3 edits left this year.")
      expect(editsLine(f({ edits: { left: 1, nextAt: NOW / 1000 } }))).toBe("1 edit left this year.")
      expect(editsLine(f({ edits: { left: 1, nextAt: NOW / 1000 }, values: { contact: "", channel: CHANNEL } }))).toBe("1 edit left this year.")
      expect(editsLine(f({ edits: { left: 1, nextAt: NOW / 1000 }, values: { contact: CONTACT, channel: CHANNEL } }))).toBe("1 edit left this year.")
      expect(editsLine(f({ edits: { left: 0, nextAt: Date.UTC(2027, 9, 29, 23, 59) / 1000 }, values: { contact: "", channel: "" } }))).toBe("You can edit links again on 29\u00a0October 2027.")
      expect(editsLine(f({ edits: null }))).toBe("")
    })
    it("editsShort turns Save off only when no edit is left, as one covers both links", () => {
      expect(editsShort(f({}))).toBe(false)
      expect(editsShort(f({ values: { contact: "", channel: CHANNEL } }))).toBe(false)
      expect(editsShort(f({ edits: { left: 1, nextAt: 1 }, values: { contact: "", channel: CHANNEL } }))).toBe(false)
      expect(editsShort(f({ edits: { left: 1, nextAt: 1 }, values: { contact: CONTACT, channel: CHANNEL } }))).toBe(false)
      expect(editsShort(f({ edits: { left: 0, nextAt: 1 } })), "none left, even with nothing changed").toBe(true)
      expect(editsShort(f({ edits: null, values: { contact: "", channel: CHANNEL } }))).toBe(false)
    })
  })
})

describe("a row shown", () => {
  const order = record({ registrationId: "reg-1" })
  const registering = registration({ phase: "registering", label: "alice" })
  const readAs = (s: ListState, view: RegistrationView) => reduceList(s, { type: "row-read", id: "reg-1", view, invoice: null, now: NOW })
  const answered = (s: ListState) => reduceList(s, { type: "row-answered", id: "reg-1", answer: registered() })
  it("keeps its last state while a read that finds it registered waits for its name's answer, which then replaces it", () => {
    const seen = { ...initialList(stored({ orders: [order] }), null, { "reg-1": { view: registering, invoice: null } }, {}, NOW) }
    expect(rowShown(seen, order)).toBe(true)
    const read = readAs(seen, registeredView())
    expect(rowShown(read, order)).toBe(true)
    expect(read.seen["reg-1"].view.phase, "still drawn as last seen").toBe("registering")
    const done = answered(read)
    expect(done.seen["reg-1"]).toEqual({ view: registeredView(), invoice: null, answer: registered() })
    expect(rowShown(done, order)).toBe(true)
  })
  it("of a name never seen, registered, waits for its name's answer", () => {
    const read = readAs(list({ orders: [order] }), registeredView())
    expect(rowShown(read, order)).toBe(false)
    expect(rowShown(answered(read), order)).toBe(true)
  })
  it("marked not read stays shown when a late read finds it registered, until its name's answer", () => {
    const unread = reduceList(list({ orders: [order] }), { type: "row-unread", id: "reg-1" })
    expect(rowShown(unread, order)).toBe(true)
    const read = readAs(unread, registeredView())
    expect(rowShown(read, order)).toBe(true)
    expect(answered(read).unread).toEqual([])
  })
  it("of an order in progress is shown with its read alone", () => {
    expect(rowShown(readAs(list({ orders: [order] }), registering), order)).toBe(true)
  })
})

describe("rows drawn and unanswered", () => {
  const [a, b, c] = ["reg-a", "reg-b", "reg-c"].map((registrationId, i) => record({ registrationId, createdAt: `2026-10-17T11:0${5 - i}:00Z` }))
  const progress = registration({ phase: "committed" })
  const seenAll = { "reg-a": { view: progress, invoice: null }, "reg-b": { view: progress, invoice: null }, "reg-c": { view: progress, invoice: null } }
  it("draws rows in order up to the first not in, and every row drawn before, wherever it now stands", () => {
    const s = initialList(stored({ orders: [a, b, c] }), null, seenAll, {}, NOW)
    expect(rowsDrawn(s, new Set()).rows.map((o) => o.registrationId)).toEqual(["reg-a", "reg-b", "reg-c"])
    // a newer order of a's name takes a's place, its read not in yet
    const successor = record({ registrationId: "reg-new", createdAt: "2026-10-17T11:06:00Z" })
    const replaced = initialList(stored({ orders: [successor, b, c] }), null, seenAll, {}, NOW)
    const { rows, done } = rowsDrawn(replaced, new Set(["reg-a", "reg-b", "reg-c"]))
    expect(rows.map((o) => o.registrationId)).toEqual(["reg-b", "reg-c"])
    expect(done).toBe(false)
  })
  it("keeps a drawn order's row in its place while the newer order that replaced it is read, then draws the newer one there", () => {
    const older = record({ registrationId: "reg-a", invoiceId: "inv-a", replacedBy: "/?order=inv-new", createdAt: "2026-10-17T11:05:00Z" })
    const newer = record({ registrationId: "reg-new", invoiceId: "inv-new", createdAt: "2026-10-17T11:07:00Z" })
    const s = initialList(stored({ orders: [newer, older, b] }), null, { "reg-b": { view: progress, invoice: null } }, {}, NOW)
    const drawn = new Set(["reg-a", "reg-b"])
    expect(rowsDrawn(s, drawn)).toEqual({ rows: [older, b], done: true })
    const read = reduceList(s, { type: "row-read", id: "reg-new", view: progress, invoice: null, now: NOW })
    expect(rowsDrawn(read, drawn).rows.map((o) => o.registrationId)).toEqual(["reg-new", "reg-b"])
  })
  it("names the rows whose read, or whose registered name's answer, is still out", () => {
    const s = initialList(stored({ orders: [a, b, c] }), null, { "reg-a": { view: registration({ phase: "registering" }), invoice: null } }, {}, NOW)
    const readA = reduceList(s, { type: "row-read", id: "reg-a", view: registeredView(), invoice: null, now: NOW })
    const readB = reduceList(readA, { type: "row-read", id: "reg-b", view: progress, invoice: null, now: NOW })
    expect(unanswered(readB)).toEqual(["reg-a", "reg-c"])
  })
})
