import { holdsPayment, type CodeState, type InvoiceView, type LateWait, LINK_KINDS, type Links, paidLate, type Phase, type RecordEdits, type RegistrationView, type SearchAnswer } from "../api.ts"
import { YEAR_S } from "../crypto/registration.ts"
import { dateOf, dollars, methodName } from "../format.ts"
import { type CodeRecord, type OrderRecord, orderUrl, type PendingCode } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

export interface RowSeen { view: RegistrationView; invoice: InvoiceView | null; answer?: SearchAnswer | null }
export type CodeCheck = CodeState | "unchecked"
export type Finding = "finding" | "none" | "unchecked"

export interface Stored { orders: OrderRecord[]; pending: PendingCode[]; codes: CodeRecord[]; canPersist: boolean }

export interface ListState extends Stored {
  hold: Hold | null
  now: number
  seen: Record<string, RowSeen>
  next: Record<string, RowSeen>
  unread: string[]
  checked: Record<string, CodeCheck>
  // when a code whose check met a rate limit is checked again, on the service's clock
  checkAgainAt: Record<string, number>
  finding: Record<string, Finding>
  asking: boolean
  shownCode: string | null
}

export type ListEvent =
  | ({ type: "stored"; hold: Hold | null } & Stored)
  | { type: "row-read"; id: string; view: RegistrationView; invoice: InvoiceView | null; now: number }
  | { type: "row-answered"; id: string; answer: SearchAnswer | null }
  | { type: "row-unread"; id: string }
  | { type: "code-toggled"; id: string }
  | { type: "code-read"; code: string; state: CodeCheck; checkAgainAt?: number }
  | { type: "find-started"; ownerCode: string }
  | { type: "find-ended"; ownerCode: string; outcome: "none" | "unchecked" }
  | { type: "find-held"; ownerCode: string; until: number }
  | { type: "hold-ended" }
  | { type: "forget-asked" }
  | { type: "forget-kept" }
  | { type: "forget-confirmed" }

const keep = <T>(map: Record<string, T>, keys: string[]): Record<string, T> => Object.fromEntries(keys.filter((k) => k in map).map((k) => [k, map[k]]))
const idsOf = (s: Stored) => s.orders.map((o) => o.registrationId)

export function initialList(stored: Stored, hold: Hold | null, seen: Record<string, RowSeen>, checked: Record<string, CodeCheck>, now: number): ListState {
  const known = stored.codes.map((c) => c.code).filter((c) => checked[c] !== "unchecked")
  const unreplaced = stored.orders.filter((o) => !o.replacedBy).map((o) => o.registrationId)
  return { ...stored, hold, now, seen: keep(seen, unreplaced), next: {}, unread: [], checked: keep(checked, known), checkAgainAt: {}, finding: {}, asking: false, shownCode: null }
}

// a row drawn stays as last seen until a whole new answer replaces it
export function rowShown(s: ListState, o: OrderRecord): boolean {
  const seen = s.seen[o.registrationId]
  return s.unread.includes(o.registrationId) || (seen !== undefined && (seen.view.phase !== "registered" || seen.answer !== undefined))
}

export function rowsDrawn(s: ListState, drawn: Set<string>): { rows: OrderRecord[]; done: boolean } {
  const rows: OrderRecord[] = []
  let blocked = false
  for (const o of nameRows(s)) {
    const before = rowShown(s, o) ? null : s.orders.find((p) => p.replacedBy === orderUrl(o) && drawn.has(p.registrationId))
    if (before) rows.push(before)
    else if (!rowShown(s, o)) blocked = true
    else if (!blocked || drawn.has(o.registrationId)) rows.push(o)
  }
  return { rows, done: !blocked }
}

export const unanswered = (s: ListState) => nameRows(s).filter((o) => !rowShown(s, o) || o.registrationId in s.next).map((o) => o.registrationId)

export const hasRecords = (s: Stored) => s.orders.length > 0 || s.pending.length > 0 || s.codes.length > 0

export function reduceList(s: ListState, e: ListEvent): ListState {
  const ordered = (id: string) => s.orders.some((o) => o.registrationId === id)
  const pendingFor = (ownerCode: string) => s.pending.some((p) => p.ownerCode === ownerCode)
  switch (e.type) {
    case "stored": {
      const { type: _, ...stored } = e
      const unreplaced = new Set(s.orders.filter((o) => !o.replacedBy).map((o) => o.registrationId))
      const ids = idsOf(stored).filter((id) => !(unreplaced.has(id) && stored.orders.find((o) => o.registrationId === id)?.replacedBy))
      return { ...s, ...stored, seen: keep(s.seen, ids), next: keep(s.next, ids), unread: s.unread.filter((id) => ids.includes(id)),
        checked: keep(s.checked, stored.codes.map((c) => c.code)), checkAgainAt: keep(s.checkAgainAt, stored.codes.map((c) => c.code)), finding: keep(s.finding, stored.pending.map((p) => p.ownerCode)), asking: s.asking && hasRecords(stored),
        shownCode: s.shownCode !== null && ids.includes(s.shownCode) ? s.shownCode : null }
    }
    case "row-read": {
      const o = s.orders.find((r) => r.registrationId === e.id)
      if (!o || (o.replacedBy && !moneyReached(e.invoice))) return s
      const last = s.seen[e.id]
      if (e.view.phase === "registered" && last?.view.phase !== "registered") return { ...s, now: e.now, next: { ...s.next, [e.id]: { view: e.view, invoice: e.invoice } } }
      const kept = last?.view.phase === "registered" ? { answer: last.answer } : {}
      return { ...s, now: e.now, seen: { ...s.seen, [e.id]: { view: e.view, invoice: e.invoice, ...kept } }, unread: s.unread.filter((id) => id !== e.id) }
    }
    case "row-answered": {
      const { [e.id]: read, ...next } = s.next
      const seen = read ?? s.seen[e.id]
      if (!seen) return s
      return { ...s, next, seen: { ...s.seen, [e.id]: { ...seen, answer: e.answer } }, unread: read ? s.unread.filter((id) => id !== e.id) : s.unread }
    }
    case "row-unread": return ordered(e.id) && !s.unread.includes(e.id) ? { ...s, unread: [...s.unread, e.id] } : s
    case "code-toggled": return { ...s, shownCode: s.shownCode === e.id ? null : ordered(e.id) ? e.id : s.shownCode }
    case "code-read": {
      if (!s.codes.some((c) => c.code === e.code)) return s
      const { [e.code]: _, ...checkAgainAt } = s.checkAgainAt
      return { ...s, checked: { ...s.checked, [e.code]: e.state }, checkAgainAt: e.checkAgainAt === undefined ? checkAgainAt : { ...checkAgainAt, [e.code]: e.checkAgainAt } }
    }
    case "find-started": return pendingFor(e.ownerCode) ? { ...s, finding: { ...s.finding, [e.ownerCode]: "finding" } } : s
    case "find-ended": return pendingFor(e.ownerCode) ? { ...s, finding: { ...s.finding, [e.ownerCode]: e.outcome } } : s
    case "find-held": {
      const { [e.ownerCode]: _, ...finding } = s.finding
      return { ...s, finding, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: NO_LEAD } }
    }
    case "hold-ended": return { ...s, hold: null }
    case "forget-asked": return hasRecords(s) ? { ...s, asking: true } : s
    case "forget-kept": return { ...s, asking: false }
    case "forget-confirmed": return { ...s, orders: [], pending: [], codes: [], seen: {}, unread: [], checked: {}, checkAgainAt: {}, finding: {}, asking: false, shownCode: null }
  }
}

export const moneyReached = (invoice: InvoiceView | null) => invoice !== null && (invoice.status === "paid" || holdsPayment(invoice))

export function listedOrders(s: ListState): OrderRecord[] {
  const shown = (o: OrderRecord) => !o.replacedBy || (s.seen[o.registrationId] !== undefined && moneyReached(s.seen[o.registrationId].invoice))
  const index = new Map(s.orders.map((o, i) => [o.registrationId, i]))
  const byUrl = new Map(s.orders.map((o) => [orderUrl(o), o]))
  const predecessor = new Map<string, OrderRecord>()
  for (const o of s.orders) {
    const next = !shown(o) && o.replacedBy ? byUrl.get(o.replacedBy) : undefined
    if (next && !predecessor.has(next.registrationId)) predecessor.set(next.registrationId, o)
  }
  const slotOf = (o: OrderRecord, passed = new Set<string>()): number => {
    const before = predecessor.get(o.registrationId)
    if (!before || passed.has(before.registrationId)) return index.get(o.registrationId)!
    passed.add(o.registrationId)
    return slotOf(before, passed)
  }
  return s.orders.filter(shown).map((o) => ({ o, slot: slotOf(o), at: index.get(o.registrationId)! }))
    .sort((a, b) => a.slot - b.slot || a.at - b.at).map(({ o }) => o)
}

// An order's balance as Your names lists it: what is left, what support refunded from it, until when an open invoice
// holds it, and what made it: its name registered by someone else first, money after its invoice closed, or the rest
// after a move to a cheaper name.
export interface BalanceRow { id: string; amount: number; refunded: number; held: boolean; heldUntil: string | null; from: "taken" | "late" | "rest" }

export function balanceRows(s: ListState): BalanceRow[] {
  return listedOrders(s).flatMap((o) => {
    const view = s.seen[o.registrationId]?.view
    const b = view?.balance
    if (!b || (b.amount === 0 && b.refunded === 0)) return []
    const from = view.phase === "taken" ? "taken" : view.phase === "unpaid" ? "late" : "rest"
    return [{ id: o.registrationId, amount: b.amount, refunded: b.refunded, held: b.held, heldUntil: b.held ? b.heldUntil : null, from }]
  })
}

// The order of this browser whose invoice, as last read, is open and holds the balance of order `source`: never one
// that expired, was cancelled or was paid since; undefined when this browser holds none such.
export const holderOf = (s: ListState, source: string) => s.orders.find((o) => {
  const seen = s.seen[o.registrationId]
  return o.balanceSource === source && seen?.invoice?.status === "open" && seen.view.phase === "unpaid"
})

// the orders listed as names: a name registered by someone else first is listed by its balance alone
export function nameRows(s: ListState): OrderRecord[] {
  const kept = new Set(balanceRows(s).filter((b) => b.from === "taken").map((b) => b.id))
  return listedOrders(s).filter((o) => !kept.has(o.registrationId))
}

// A registered name past its expiry: there are no renewals, so the page takes it as over, though the chain keeps it its
// holder's through the grace period, and whether or not someone has registered it again since.
export const lapsed = ({ view, answer }: Pick<RowSeen, "view" | "answer">, now: number) =>
  view.phase === "registered" && ((view.expiresAt !== null && view.expiresAt < now / 1000) || answer?.status === "available")

export const waitsToSign = (view: RegistrationView, now: number) =>
  view.phase === "committed" && view.label === null && view.revealAfter !== null && now / 1000 >= view.revealAfter

const PHASE_CHIPS: Record<Phase, [string, string]> = {
  unpaid: ["Waiting for payment", "warn"],
  queued: ["Registering", "brand"], committing: ["Registering", "brand"], committed: ["Registering", "brand"], registering: ["Registering", "brand"],
  registered: ["Registered", "ok"], taken: ["Taken first", "warn"], failed: ["Not registered", "bad"],
}

const CHIPS = {
  sign: "Open to finish", cancelled: "Invoice cancelled", expired: "Invoice expired", late: "Paid late", confirming: "Confirming payment", rest: "Waiting for the rest",
} as const
export const ROW_CHIPS = { unchecked: "Not checked", lapsed: "Expired" } as const
export const ORDER_CHIP_WORDS = [...new Set([...Object.values(ROW_CHIPS), ...Object.values(PHASE_CHIPS).map(([words]) => words), ...Object.values(CHIPS)])]

export function phaseChip(view: RegistrationView, invoice: InvoiceView | null, o: OrderRecord, now: number): [string, string] {
  if (waitsToSign(view, now)) return [CHIPS.sign, "warn"]
  if (view.phase !== "unpaid") return PHASE_CHIPS[view.phase]
  if (invoice && paidLate(invoice)) return [CHIPS.late, "warn"]
  if (invoice?.status === "expired") return o.cancelled && !holdsPayment(invoice) ? [CHIPS.cancelled, "bad"] : [CHIPS.expired, holdsPayment(invoice) ? "warn" : "bad"]
  if (invoice?.paidInFull || o.cardSubmittedAt) return [CHIPS.confirming, "warn"]
  if (invoice?.amountPaid || Number(invoice?.cryptoAmountPaid ?? "0") > 0) return [CHIPS.rest, "warn"]
  return PHASE_CHIPS.unpaid
}

// What paid the order: its invoice, with what another order's balance paid besides, a balance alone, or a free name's code. Before
// the order is read, its record's method and worth.
export function paidLine(o: OrderRecord, view: RegistrationView | null, invoice: InvoiceView | null): string {
  const fromBalance = view?.fromBalance ?? 0
  if (invoice) {
    const paid = `${dollars(invoice.amount)} ${methodName(invoice.cryptoCurrency ?? "card")}`
    return fromBalance ? `${paid} and ${dollars(fromBalance)} from your balance` : paid
  }
  if (fromBalance || o.method === "balance") return "Paid from your balance"
  // a code carries no money: it registers a free name, and a name taken first gives it back
  if (o.method === "code") return view?.phase === "taken" ? "Free name with a code; the code was released for another name" : "Registered with a code"
  return `${dollars(o.paid)} ${methodName(o.method)}`
}

const LATE_KEPT: Record<LateWait | "credited", string> = {
  credited: "kept as your balance", confirming: "kept as your balance once confirmed", crediting: "kept as your balance once credited", support: "write to support to have it credited",
}

// Money that reached an unpaid order's invoice once it had closed, or that it held as it closed, which is kept as the
// order's balance; null when the invoice took none.
export function lateLine(invoice: InvoiceView): string | null {
  const kept = LATE_KEPT[invoice.registration.latePayment?.waiting ?? "credited"]
  if (paidLate(invoice)) return `Paid after the invoice closed; ${kept}`
  if (invoice.status !== "expired") return null
  const part = Number(invoice.cryptoAmountPaid ?? "0") > 0 && !invoice.paidInFull
  const arrived = part ? "Part of the payment arrived" : holdsPayment(invoice) ? "A payment did not complete before the invoice closed" : null
  return arrived && `${arrived}; ${kept}`
}

export const CODE_CHIPS: Record<CodeState, [string, string]> = {
  unused: ["Unused", "ok"], used: ["Used", "bad"], reserved: ["In use", "brand"],
  expired: ["Expired", "bad"], unpaid: ["Not paid yet", "warn"], revoked: ["Not valid", "bad"],
}

export function editable(answer: SearchAnswer, owner: string): boolean {
  if (answer.status !== "registered" || answer.owner === undefined) return true
  return answer.owner.toLowerCase() === owner.toLowerCase() && answer.records !== null
}

// what opens Edit links for a name: adding its first links, or editing them
export const linksAction = (has: boolean) => has ? "Edit links" : "Add links"

// whether a name opens any chat, by its records once read, else by the links it was ordered with
export const hasLinks = (o: OrderRecord, answer: SearchAnswer | null | undefined): boolean =>
  answer?.status === "registered" && answer.records !== undefined ? Boolean(answer.records?.contact || answer.records?.channel) || answer.entities.length > 0
    : Boolean(o.contact || o.channel)

type RefusalKind = "none" | "unasked" | "other"
export interface Refusal { title: string; text: string; again: boolean }
// why a name code found no order to add; only the service's not answering can change by asking again
export const REFUSALS: Record<RefusalKind, Refusal> = {
  none: { title: "No order was found for this code", text: "The service has no order registered to its wallet.", again: false },
  unasked: { title: "The service could not be asked now", text: "Your code is fine to try again in a moment.", again: true },
  other: { title: "This code does not open the order", text: "The order found for it was made with another code.", again: false },
}

export interface RestoreState { busy: boolean; refusal: RefusalKind | null; hold: Hold | null }
export type RestoreEvent = { type: "edited" } | { type: "refused"; why: RefusalKind } | { type: "find-started" } | ({ type: "held" } & Hold) | { type: "hold-ended" }

export const initialRestore = (hold: Hold | null): RestoreState => ({ busy: false, refusal: null, hold })

export function reduceRestore(s: RestoreState, e: RestoreEvent): RestoreState {
  switch (e.type) {
    case "edited": return s.hold ? s : { ...s, refusal: null }
    case "refused": return { ...s, busy: false, refusal: e.why }
    case "find-started": return { ...s, busy: true, refusal: null }
    case "held": return { ...s, busy: false, refusal: null, hold: { until: e.until, lead: e.lead } }
    case "hold-ended": return { ...s, hold: null }
  }
}

export const EDIT_RETRY_MS = 5000
export type EditKind = "edit" | "edit-unreadable" | "edit-no-code" | "edit-expired" | "edit-in-app" | "edit-elsewhere" | "edit-not-registered"
interface EditRead { view: RegistrationView; answer: SearchAnswer; now: number }
type EditResult = "sending" | "nothing" | "saved" | "unanswered" | "moved" | "refused"

export interface EditForm {
  current: Links
  values: Links
  nonce: number
  changes: Partial<Links>
  saving: boolean
  unanswered: boolean
  settled: boolean
  result: EditResult | null
  hold: Hold | null
  // null from a service that counts no edits
  edits: RecordEdits | null
}

export interface EditState {
  registrationId: string
  record: OrderRecord | null
  read: EditRead | null
  form: EditForm | null
  failures: number
  reading: boolean
}

export type EditEvent =
  | { type: "opened" }
  | { type: "answered"; view: RegistrationView; answer: SearchAnswer; record: OrderRecord; now: number; hold: Hold | null }
  | { type: "read-failed" }
  | { type: "read-started" }
  | { type: "field-changed"; kind: keyof Links; value: string }
  | { type: "save-started" }
  | { type: "save-done"; at: number }
  // counted: the service took the edit, which goes on without an answer
  | { type: "save-unanswered"; counted: boolean; at: number }
  | { type: "save-held"; until: number }
  | { type: "save-limited"; nextAt: number }
  | { type: "save-refused"; moved: { nonce: number; records: Links | null } | null; edits?: RecordEdits | null }
  | { type: "hold-ended" }

export const initialEdit = (registrationId: string, record: OrderRecord | null): EditState => ({ registrationId, record, read: null, form: null, failures: 0, reading: false })

export const changesOf = (f: EditForm): Partial<Links> => Object.fromEntries(LINK_KINDS.filter((k) => f.values[k] !== f.current[k]).map((k) => [k, f.values[k]]))

type Again = { when: "now" } | { when: "from"; at: number } | { when: "taken" }
// an expired name stays its holder's for the registrar's grace period, which the search answer gives, before anyone can register it again
export function registrableAgain(expiresAt: number | null, answer: SearchAnswer, now: number): Again {
  if (answer.status === "available") return { when: "now" }
  const grace = answer.status === "registered" ? answer.gracePeriod : undefined
  if (expiresAt !== null && grace !== undefined && now / 1000 < expiresAt + grace) return { when: "from", at: expiresAt + grace }
  return { when: "taken" }
}

export const ranOut = (expiresAt: number | null) => `Its registration ran out${expiresAt ? ` on ${dateOf(expiresAt)}` : ""}.`

export function againLine(expiresAt: number | null, answer: SearchAnswer, now: number): string {
  const again = registrableAgain(expiresAt, answer, now)
  if (again.when === "now") return "Search it to register it again."
  return again.when === "from" ? `It can be registered again from ${dateOf(again.at)}.` : "It has been registered again since."
}

// Each Save is one edit of the name's yearly count, whatever it changes, and returns 365 days after it was made, so the
// oldest counted edit, or this one when none was counted, is the next to return. At is the service's time in seconds.
const spent = (edits: RecordEdits | null, at: number): RecordEdits | null =>
  edits && { left: Math.max(0, edits.left - 1), nextAt: edits.nextAt ?? at + YEAR_S }

export const editsShort = (f: EditForm) => f.edits !== null && f.edits.left === 0

const editCount = (n: number) => n === 1 ? "1 edit" : `${n} edits`

export function editsLine(f: EditForm): string {
  if (!f.edits) return ""
  const { left, nextAt } = f.edits
  return left === 0 ? `You can edit links again on ${dateOf(nextAt!)}.` : `${editCount(left)} left this year.`
}

// a Save is one transaction, so a Save that fails changed no link
export const NOT_SAVED = "The links were not saved."

const owns = (answer: SearchAnswer, owner: string) => answer.status === "registered" && answer.owner !== undefined && answer.owner.toLowerCase() === owner.toLowerCase()

export function screenOfEdit(s: EditState): EditKind {
  if (!s.record) return "edit-no-code"
  if (!s.read) return "edit-unreadable"
  const { view, answer, now } = s.read
  if (lapsed({ view, answer }, now)) return "edit-expired"
  if (answer.status === "registered" && answer.owner !== undefined && !owns(answer, s.record.owner)) return "edit-in-app"
  if (answer.status === "registered" && owns(answer, s.record.owner) && answer.records === null) return "edit-elsewhere"
  if (view.phase !== "registered" || answer.status !== "registered" || !answer.records || answer.recordsNonce == null) return "edit-not-registered"
  return "edit"
}

function formOf(answer: SearchAnswer, hold: Hold | null): EditForm | null {
  if (answer.status !== "registered" || !answer.records || answer.recordsNonce == null) return null
  return { current: { ...answer.records }, values: { ...answer.records }, nonce: answer.recordsNonce, changes: {},
    saving: false, unanswered: false, settled: false, result: null, hold, edits: answer.recordEdits ?? null }
}

function applyToForm(f: EditForm, e: EditEvent): EditForm {
  switch (e.type) {
    case "field-changed": {
      if (f.values[e.kind] === e.value) return f
      const values = { ...f.values, [e.kind]: e.value }
      if (f.saving || f.unanswered || f.hold) return { ...f, values }
      return { ...f, values, settled: false, result: e.value === f.current[e.kind] ? f.result : null }
    }
    case "save-started": {
      const changes = changesOf(f)
      if (Object.keys(changes).length === 0) return { ...f, result: "nothing" }
      return { ...f, changes, saving: true, result: "sending" }
    }
    case "save-done": {
      const saved = { ...f, nonce: f.nonce + Object.keys(f.changes).length, current: { ...f.current, ...f.changes }, edits: spent(f.edits, e.at) }
      return { ...saved, saving: false, result: "saved", settled: Object.keys(changesOf(saved)).length === 0 }
    }
    case "save-unanswered": return { ...f, saving: false, unanswered: true, result: "unanswered", edits: e.counted ? spent(f.edits, e.at) : f.edits }
    case "save-held": return { ...f, saving: false, result: null, hold: { until: e.until, lead: `${NOT_SAVED} ` } }
    // the edits line says when they return
    case "save-limited": return { ...f, saving: false, result: null, edits: { left: 0, nextAt: e.nextAt } }
    case "save-refused": {
      const edits = e.edits ?? f.edits
      if (!e.moved) return { ...f, saving: false, result: "refused", edits }
      return { ...f, saving: false, result: "moved", nonce: e.moved.nonce, current: e.moved.records ? { ...e.moved.records } : f.current, edits }
    }
    case "hold-ended": return { ...f, hold: null }
    default: return f
  }
}

export function reduceEdit(s: EditState, e: EditEvent): EditState {
  switch (e.type) {
    case "answered": {
      const next = { ...s, record: e.record, read: { view: e.view, answer: e.answer, now: e.now }, reading: false }
      return { ...next, form: s.form ?? (screenOfEdit(next) === "edit" ? formOf(e.answer, e.hold) : null) }
    }
    case "opened": return s
    case "read-failed": return { ...s, failures: s.failures + 1, reading: false }
    case "read-started": return { ...s, reading: true }
    default: {
      if (!s.form) return s
      const form = applyToForm(s.form, e)
      return form === s.form ? s : { ...s, form }
    }
  }
}
