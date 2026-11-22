import { type FailReason, type InvoiceView, type Phase, type SearchAnswer } from "../api.ts"
import { parseNameCode } from "../crypto/code.ts"
import { foldLabel, type LabelProblem, labelProblem } from "../names.ts"
import type { AppliedCode } from "../session.ts"
import type { OrderRecord } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"

export type Opening = "order" | "plain"
export type SearchKind = `search:${Opening}`

export type Answer =
  | { kind: "rule"; label: string; problem: LabelProblem }
  | { kind: "uncovered"; label: string; minLength: number }
  | { kind: "found"; label: string; answer: SearchAnswer; mine: boolean; now: number }
  | { kind: "unchecked" }
  | { kind: "checking" }

export interface SearchState {
  opening: Opening
  name: string
  typed: string
  searched: string | null
  seq: number
  searching: { label: string } | null
  answer: Answer | null
  bad: boolean
  order: OrderRecord | null
  hold: Hold | null
  paused: boolean
  ownOrder: string | null
}

export type SearchEvent =
  | { type: "opened"; opening: Opening; name: string; order: OrderRecord | null; hold: Hold | null }
  | { type: "typed"; text: string }
  // minLength: the least letters the tab's or the order's code covers, where only a code registers names
  | { type: "searched"; label: string; hold: Hold | null; minLength: number | null }
  | { type: "answered"; seq: number; label: string; answer: SearchAnswer; mine: boolean; now: number }
  | { type: "unanswered"; seq: number }
  | { type: "search-held"; seq: number; until: number }
  | { type: "hold-ended" }
  | { type: "own-order-seen"; label: string; url: string | null }
  | { type: "order-read"; record: OrderRecord }

export const initialSearch = (): SearchState => ({
  opening: "plain", name: "", typed: "", searched: null, seq: 0, searching: null, answer: null, bad: false,
  order: null, hold: null, paused: false, ownOrder: null,
})

// An available name this browser has an order for, under its TLD, is checked again rather than offered while the order is read.
export function returnedTo(s: SearchState, opening: Opening, name: string, tld: string | undefined, orders: Pick<OrderRecord, "label" | "tld">[]): SearchState {
  if (s.opening !== opening || s.name !== name || s.answer?.kind !== "found") return initialSearch()
  const ordered = s.answer.answer.found.type === "available" && orders.some((o) => o.label === name && o.tld === tld)
  return { ...s, searching: null, answer: ordered ? { kind: "checking" } : s.answer }
}

const unsearched = (s: SearchState) => foldLabel(s.typed) !== s.name

export const searchDue = (s: SearchState): boolean => !s.paused && s.name !== "" && s.name !== s.searched && !unsearched(s)

function opened(s: SearchState, e: Extract<SearchEvent, { type: "opened" }>): SearchState {
  const typed = e.name === s.name ? s.typed : e.name
  const next = { ...s, opening: e.opening, name: e.name, typed, order: e.order }
  const dropped = unsearched(next) ? { answer: null, searching: null, bad: false, seq: s.seq + 1 } : {}
  if (s.hold || e.hold === null) return { ...next, ...dropped }
  return { ...next, answer: null, searching: null, bad: false, seq: s.seq + 1, hold: e.hold, paused: true }
}

function searched(s: SearchState, e: Extract<SearchEvent, { type: "searched" }>): SearchState {
  if (s.paused || !e.label) return s
  const seq = s.seq + 1
  if (e.hold !== null) return { ...s, seq, answer: null, searching: null, bad: false, hold: { ...e.hold, until: Math.max(e.hold.until, s.hold?.until ?? 0) }, paused: true }
  // the field shows the name searched, as ".simplex" typed after it is already shown beside the field
  const started = { ...s, seq, name: e.label, searched: e.label, typed: e.label }
  const problem = labelProblem(e.label)
  if (problem) return { ...started, searching: null, answer: { kind: "rule", label: e.label, problem }, bad: true }
  if (e.minLength !== null && e.label.length < e.minLength) return { ...started, searching: null, answer: { kind: "uncovered", label: e.label, minLength: e.minLength }, bad: true }
  return { ...started, searching: { label: e.label } }
}

function answered(s: SearchState, e: Extract<SearchEvent, { type: "answered" }>): SearchState {
  if (e.seq !== s.seq) return s
  const same = s.answer?.kind === "found" && s.answer.label === e.label
  return { ...s, searching: null, answer: { kind: "found", label: e.label, answer: e.answer, mine: e.mine, now: e.now }, ownOrder: same ? s.ownOrder : null }
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
    case "order-read": return s.order?.registrationId === e.record.registrationId ? { ...s, order: e.record } : s
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
// name selected for a code order is bounded by the order's own code.
export const searchLocked = (codesOnly: boolean, s: SearchState, code: AppliedCode | null) => codesOnly && s.opening === "plain" && code === null
export const coverOf = (codesOnly: boolean, s: SearchState, code: AppliedCode | null) => s.order ? codeCover(s.order)?.minLength ?? null
  : codesOnly && s.opening === "plain" ? code?.minLength ?? null : null

export function screenOf(s: SearchState): SearchKind {
  return `search:${s.opening}`
}

// minLength is null for an order restored without its code text
export interface CodeCover { minLength: number | null; years: number }

export function codeCover(record: OrderRecord): CodeCover | null {
  if (record.method !== "code") return null
  const code = record.prepaidCode ? parseNameCode(record.prepaidCode) : null
  return { minLength: code?.kind === "prepaid" ? code.minLength : null, years: record.years }
}
