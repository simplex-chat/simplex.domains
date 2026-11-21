import { type Community, type FailReason, type InvoiceView, type Phase, type SearchAnswer, type Terms, termsFor } from "../api.ts"
import { dollars } from "../format.ts"
import { foldLabel, type LabelProblem, labelProblem } from "../names.ts"
import type { AppliedCode } from "../session.ts"
import type { OrderRecord } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

export type Opening = "retarget" | "plain"
export type SearchKind = `search:${Opening}`

export type Answer =
  | { kind: "rule"; label: string; problem: LabelProblem }
  | { kind: "uncovered"; label: string; minLength: number }
  | { kind: "found"; label: string; answer: SearchAnswer; mine: boolean; now: number }
  | { kind: "unchecked" }
  | { kind: "checking" }

type RegisterRefusal = { why: "taken" | "failed" | "unavailable" } | { why: "price"; price: number } | { why: "other"; url: string } | { why: "limit"; reference: string }

export interface SearchState {
  opening: Opening
  name: string
  typed: string
  searched: string | null
  seq: number
  searching: { label: string } | null
  answer: Answer | null
  bad: boolean
  retarget: OrderRecord | null
  hold: Hold | null
  paused: boolean
  ownOrder: string | null
  register: { busy: boolean; refusal: RegisterRefusal | null }
  agreed: boolean
  accepted: boolean
  termsChanged: boolean
}

export type SearchEvent =
  | { type: "opened"; opening: Opening; name: string; retarget: OrderRecord | null; hold: Hold | null }
  | { type: "typed"; text: string }
  // minLength: the least letters the tab's code covers, where only a code registers names
  | { type: "searched"; label: string; hold: Hold | null; minLength: number | null }
  | { type: "answered"; seq: number; label: string; answer: SearchAnswer; mine: boolean; now: number }
  | { type: "unanswered"; seq: number }
  | { type: "search-held"; seq: number; until: number }
  | { type: "hold-ended" }
  | { type: "own-order-seen"; label: string; url: string | null }
  | { type: "retarget-read"; record: OrderRecord }
  | { type: "register-started" }
  | { type: "register-refused"; refusal: RegisterRefusal }
  | { type: "register-held"; until: number }
  | { type: "agreed"; agreed: boolean }
  | { type: "accepted"; accepted: boolean }
  | { type: "terms-changed"; label: string; terms: Terms; community: Community | null }

const IDLE = { busy: false, refusal: null }
export const REGISTER_LEAD = "Nothing changed. "

export const initialSearch = (): SearchState => ({
  opening: "plain", name: "", typed: "", searched: null, seq: 0, searching: null, answer: null, bad: false,
  retarget: null, hold: null, paused: false, ownOrder: null, register: IDLE, agreed: false, accepted: false, termsChanged: false,
})

// An available name this browser has an order for, under its TLD, is checked again rather than offered while the order is read.
export function returnedTo(s: SearchState, opening: Opening, name: string, tld: string | undefined, orders: Pick<OrderRecord, "label" | "tld">[]): SearchState {
  if (s.opening !== opening || s.name !== name || s.answer?.kind !== "found") return initialSearch()
  const ordered = s.answer.answer.found.type === "available" && orders.some((o) => o.label === name && o.tld === tld)
  return { ...s, searching: null, register: IDLE, answer: ordered ? { kind: "checking" } : s.answer }
}

const unsearched = (s: SearchState) => foldLabel(s.typed) !== s.name

export const searchDue = (s: SearchState): boolean => !s.paused && s.name !== "" && s.name !== s.searched && !unsearched(s)

function opened(s: SearchState, e: Extract<SearchEvent, { type: "opened" }>): SearchState {
  const typed = e.name === s.name ? s.typed : e.name
  const next = { ...s, opening: e.opening, name: e.name, typed, register: { ...s.register, refusal: null }, retarget: e.retarget }
  const dropped = unsearched(next) ? { answer: null, searching: null, bad: false, seq: s.seq + 1 } : {}
  if (s.hold || e.hold === null) return { ...next, ...dropped }
  return { ...next, answer: null, searching: null, bad: false, seq: s.seq + 1, hold: e.hold, paused: true }
}

function searched(s: SearchState, e: Extract<SearchEvent, { type: "searched" }>): SearchState {
  if (s.paused || !e.label) return s
  const seq = s.seq + 1
  if (e.hold !== null) return { ...s, seq, answer: null, searching: null, bad: false, hold: { ...e.hold, until: Math.max(e.hold.until, s.hold?.until ?? 0) }, paused: true }
  // the field shows the name searched, as ".simplex" typed after it is already shown beside the field
  const started = { ...s, seq, name: e.label, searched: e.label, typed: e.label, register: IDLE }
  const problem = labelProblem(e.label)
  if (problem) return { ...started, searching: null, answer: { kind: "rule", label: e.label, problem }, bad: true }
  if (e.minLength !== null && e.label.length < e.minLength) return { ...started, searching: null, answer: { kind: "uncovered", label: e.label, minLength: e.minLength }, bad: true }
  return { ...started, searching: { label: e.label } }
}

const termsOf = ({ found, community }: SearchAnswer) => found.type === "available" && found.terms ? termsFor(found.terms, community) : null

function answered(s: SearchState, e: Extract<SearchEvent, { type: "answered" }>): SearchState {
  if (e.seq !== s.seq) return s
  const before = s.answer?.kind === "found" && s.answer.label === e.label ? s.answer : null
  const same = before !== null
  const agreed = same && s.agreed && termsOf(before.answer) === termsOf(e.answer)
  const accepted = same && s.accepted && termsOf(before.answer) === termsOf(e.answer)
  return { ...s, searching: null, answer: { kind: "found", label: e.label, answer: e.answer, mine: e.mine, now: e.now }, ownOrder: same ? s.ownOrder : null, agreed, accepted, termsChanged: same && s.termsChanged }
}

function termsChanged(s: SearchState, e: Extract<SearchEvent, { type: "terms-changed" }>): SearchState {
  const found = s.answer?.kind === "found" && s.answer.label === e.label ? s.answer.answer.found : null
  if (s.answer?.kind !== "found" || found?.type !== "available") return s
  const answer = { ...s.answer, answer: { found: { ...found, terms: e.terms }, community: e.community } }
  return { ...s, answer, agreed: false, accepted: false, termsChanged: true, register: IDLE }
}

export function reduce(s: SearchState, e: SearchEvent): SearchState {
  switch (e.type) {
    case "opened": return opened(s, e)
    case "typed": return { ...s, typed: e.text, bad: false }
    case "searched": return searched(s, e)
    case "answered": return answered(s, e)
    case "unanswered": return e.seq === s.seq ? { ...s, searching: null, answer: { kind: "unchecked" } } : s
    case "search-held": return e.seq === s.seq ? { ...s, searching: null, answer: null, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: NO_LEAD }, paused: true } : s
    case "hold-ended": return { ...s, hold: null, paused: false, answer: s.paused && foldLabel(s.typed) ? { kind: "checking" } : s.answer }
    case "own-order-seen": return s.answer?.kind === "found" && s.answer.label === e.label ? { ...s, ownOrder: e.url } : s
    case "retarget-read":
      if (s.retarget?.registrationId !== e.record.registrationId) return s
      return { ...s, retarget: e.record, register: IDLE }
    case "register-started": return { ...s, register: { busy: true, refusal: null } }
    case "register-refused": return { ...s, register: { busy: false, refusal: e.refusal } }
    case "register-held": return { ...s, register: IDLE, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: REGISTER_LEAD } }
    case "agreed": return { ...s, agreed: e.agreed, termsChanged: e.agreed ? false : s.termsChanged }
    case "accepted": return { ...s, accepted: e.accepted }
    case "terms-changed": return termsChanged(s, e)
  }
}

// an order as the service reads it: its registration's phase, its failure's reason, and its invoice's status when it has one
export interface OrderRead { phase: Phase; failure: FailReason | null; invoice: InvoiceView["status"] | null }
export interface OwnOrders { open: OrderRecord | null; closed: OrderRecord | null }

const ENDED: Phase[] = ["closed", "registered", "taken"]
const ended = (r: OrderRead) => ENDED.includes(r.phase) || r.failure === "monthEnded"

// This browser's orders for a name, newest first: the first that can still register it, and the newest that closed
// unpaid, cancelled or expired. A cancelled order is closed without a read; one that cannot be read is neither.
export async function ownOrders(orders: OrderRecord[], read: (o: OrderRecord) => Promise<OrderRead | null>): Promise<OwnOrders> {
  let closed: OrderRecord | null = null
  for (const o of orders) {
    if (o.cancelled) {
      closed ??= o
      continue
    }
    const r = await read(o)
    if (r === null) continue
    if (r.phase === "unpaid" ? r.invoice === "open" : !ended(r)) return { open: o, closed }
    if ((r.phase === "unpaid" || r.phase === "closed") && r.invoice !== null) closed ??= o
  }
  return { open: null, closed }
}

// A new order keeps the code of the name's closed order, which the buyer saved for it.
export const orderCode = (closed: string | null): { ownerCode: string | null; saved: boolean } => ({ ownerCode: closed, saved: closed !== null })

// In codes-only mode a plain search opens only with the tab's prepaid code, and only for the names that code covers; a
// paid order is moved only to another name of its price.
export const searchLocked = (codesOnly: boolean, s: SearchState, code: AppliedCode | null) => codesOnly && s.opening === "plain" && code === null
export const coverOf = (codesOnly: boolean, s: SearchState, code: AppliedCode | null) => codesOnly && s.opening === "plain" ? code?.minLength ?? null : null

export function screenOf(s: SearchState): SearchKind {
  return `search:${s.opening}`
}

export const moveBar = (record: OrderRecord, price: number): "dearer" | "cheaper" | null => price > record.paid ? "dearer" : price < record.paid ? "cheaper" : null

export function moveHint(record: OrderRecord, price: number): string {
  const paid = dollars(record.paid)
  if (price > record.paid) return `This name costs more than the ${paid} you paid.`
  return price < record.paid ? `This name costs less than the ${paid} you paid.` : "Covered by your payment"
}

export const keptWords = (record: OrderRecord) => `You paid ${dollars(record.paid)}: choose another name at that price.`
