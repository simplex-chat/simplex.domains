import { type Balance, type Community, holdsPayment, type InvoiceView, paidLate, type RegistrationView, type SearchAnswer, signedHash, type Terms } from "../api.ts"
import type { IconName } from "../icons.ts"
import type { CodeRefusal, OrderRecord } from "../store.ts"
import { type Hold, NO_LEAD } from "./hold.ts"
import { askFor, type TermsAsk, ticked } from "./terms.ts"

// a card payment Stripe has not confirmed after this long gets the "not confirmed" page
export const CARD_SLOW_MS = 10 * 60 * 1000
// the contract's maxCommitmentAge (dev/deploy.ts): a paid order not revealed within it lapses and has to commit again
export const REVEAL_HOURS = 24
// refusals of the signed registration after which the page stops signing and says so
export const REVEAL_ATTEMPTS = 3
export const RETRY_MS = 3000
export const STALL_MARGIN_MS = 60_000
// a mainnet commit or register: a slow inclusion, then the service's 3 confirmations
export const TX_STALL_MS = 180_000
// A view whose chain reads failed is read again after these pauses, the last repeated while they fail: a held poll would
// wait for a change that a failed read never makes.
const UNREAD_PACING_MS = [5_000, 15_000, 30_000]
export const unreadDelay = (reads: number) => UNREAD_PACING_MS[Math.min(reads, UNREAD_PACING_MS.length - 1)]

export type OrderKind = "pay-crypto" | "pay-card" | "confirming" | "registering" | "links-refused" | "registered" | "taken" | "failed" | "not-on-device"
  | "status:closed" | "status:card-unconfirmed" | "status:paid-by-invoice" | "status:unreadable" | "status:unknown-link" | "status:price-changed"

export type ClosedCase = "paid-late" | "cancelled" | "received" | "expired"

type Action = "card" | "cancel" | "reorder" | "retry" | "move"

export interface Note { tone: "warn" | "danger"; icon: IconName; title: string | null; text: string; link?: { text: string; href: string; after: string } }

interface Reveal { key: string; sending: boolean; refusals: number }

export interface OrderState {
  reference: string
  seq: number
  now: number
  invoice: InvoiceView | null
  view: RegistrationView | null
  record: OrderRecord | null
  cardSubmittedAt: string | null
  cardFailed: boolean
  reveal: Reveal | null
  busy: Action | null
  note: Note | null
  hold: Hold | null
  price: number | null
  gone: boolean
  codeRefused: boolean
  // the service said the order's code is unspent, which the failed page waits for before saying so
  codeKept: boolean
  // when the code, whose check met a rate limit, is checked again, on the service's clock
  codeCheckAt: number | null
  // the balance that paid part of the order, as its own order reads now, which a new invoice spends again
  sourceBalance: Balance | null
  ask: TermsAsk | null
  // a taken or failed order's name, as one search answered it
  nameStatus: SearchAnswer["status"] | null
  // the search of the changed terms' ask answered the name as registered or reserved, for the commit of this key
  unavailable: { key: string; status: SearchAnswer["status"] } | null
  // when this page first saw the stage, or the buyer ticked changed terms in it, on the service's clock
  since: { stage: string; at: number } | null
}

export type OrderEvent =
  | { type: "answered"; seq: number; now: number; invoice: InvoiceView | null; view: RegistrationView; record: OrderRecord | null; cardSubmittedAt: string | null; nameStatus: SearchAnswer["status"] | null }
  | { type: "record-changed"; record: OrderRecord | null; cardSubmittedAt: string | null }
  | { type: "read-failed" }
  | { type: "not-found" }
  | { type: "tick"; now: number }
  | { type: "card-started" }
  | { type: "card-submitted"; at: string }
  | { type: "card-failed" }
  | { type: "card-refused"; note: Note | null }
  | { type: "reveal-sent"; key: string }
  | { type: "reveal-refused"; key: string }
  | { type: "reveal-failed"; key: string }
  | { type: "reveal-retried" }
  | { type: "cancel-started" }
  | { type: "cancel-answered" }
  | { type: "cancel-failed"; note: Note }
  | { type: "reorder-started" }
  | { type: "reorder-failed"; note: Note }
  | { type: "price-changed"; price: number }
  | { type: "move-started" }
  | { type: "move-failed"; note: Note | null }
  | { type: "retry-started" }
  | { type: "retry-failed"; note: Note; codeRefused: boolean }
  | { type: "code-checked" }
  | { type: "code-check-due"; at: number | null }
  | { type: "source-read"; balance: Balance | null }
  | { type: "terms-asked"; label: string; terms: Terms; community: Community | null; changed: boolean }
  | { type: "terms-agreed"; agreed: boolean; now: number }
  | { type: "terms-accepted"; accepted: boolean; now: number }
  | { type: "name-unavailable"; key: string; status: SearchAnswer["status"] }
  | { type: "hold-started"; until: number; lead: string }
  | { type: "hold-ended" }

export function initialState(reference: string, hold: Hold | null, reveal: Reveal | null = null): OrderState {
  return { reference, seq: 0, now: 0, invoice: null, view: null, record: null, cardSubmittedAt: null, cardFailed: false, reveal, busy: null, note: null, hold, price: null, gone: false, codeRefused: false, codeKept: false, codeCheckAt: null, sourceBalance: null, ask: null, nameStatus: null, unavailable: null, since: null }
}

const stageOf = (view: RegistrationView) => `${view.id} ${view.phase}${view.phase === "committed" && view.label !== null ? " signed" : ""}`
const sinceOf = (since: OrderState["since"], view: RegistrationView, now: number) => since?.stage === stageOf(view) ? since : { stage: stageOf(view), at: now }

const start = (s: OrderState, action: Action): OrderState => ({ ...s, busy: action, note: null })
const askKept = (ask: TermsAsk | null, label: string | null) => ask && label !== null && label !== ask.label ? null : ask
const end = (s: OrderState, action: Action, change: Partial<OrderState>): OrderState => s.busy === action ? { ...s, busy: null, ...change } : s

function apply(s: OrderState, e: OrderEvent): OrderState {
  switch (e.type) {
    case "answered":
      if (e.seq <= s.seq) return s
      // a reveal the view shows as stored is no longer sending, so one the service clears is signed again under the same key
      return { ...s, seq: e.seq, now: e.now, invoice: e.invoice, view: e.view, record: e.record, cardSubmittedAt: e.cardSubmittedAt, ask: askKept(s.ask, e.record?.label ?? e.view.label),
        nameStatus: e.nameStatus, since: sinceOf(s.since, e.view, e.now), reveal: e.view.label !== null && s.reveal ? { ...s.reveal, sending: false } : s.reveal }
    case "record-changed": return { ...s, record: e.record, cardSubmittedAt: e.cardSubmittedAt, ask: askKept(s.ask, e.record?.label ?? null) }
    case "read-failed": return s
    case "not-found": return { ...s, gone: true }
    case "tick": return { ...s, now: e.now }
    case "card-submitted": return { ...s, cardSubmittedAt: e.at }
    case "card-failed": return { ...s, cardFailed: true }
    case "card-started": return start(s, "card")
    case "card-refused": return end(s, "card", { note: e.note })
    // at a reveal, the ask is kept only for the changed terms whose acceptance the reveal includes
    case "reveal-sent": return { ...s, ask: termsAskedAgain(s) ? s.ask : null, reveal: { key: e.key, sending: true, refusals: s.reveal?.key === e.key ? s.reveal.refusals : 0 } }
    case "reveal-refused": return s.reveal?.key === e.key ? { ...s, reveal: { ...s.reveal, sending: false, refusals: s.reveal.refusals + 1 } } : s
    case "reveal-failed": return s.reveal?.key === e.key ? { ...s, reveal: { ...s.reveal, sending: false } } : s
    case "reveal-retried": return s.reveal ? { ...s, reveal: { ...s.reveal, refusals: 0 } } : s
    case "cancel-started": return start(s, "cancel")
    case "cancel-answered": return end(s, "cancel", {})
    case "cancel-failed": return end(s, "cancel", { note: e.note })
    case "reorder-started": return start(s, "reorder")
    case "reorder-failed": return end(s, "reorder", { note: e.note })
    case "price-changed": return end(s, "reorder", { price: e.price })
    case "move-started": return start(s, "move")
    case "move-failed": return end(s, "move", { note: e.note })
    case "retry-started": return start(s, "retry")
    case "retry-failed": return end(s, "retry", { note: e.note, codeRefused: e.codeRefused })
    case "code-checked": return { ...s, codeKept: true, codeCheckAt: null }
    case "code-check-due": return { ...s, codeCheckAt: e.at }
    case "source-read": return s.busy === "reorder" ? end(s, "reorder", { sourceBalance: e.balance }) : { ...s, sourceBalance: e.balance }
    case "terms-asked": return { ...s, busy: null, ask: askFor(e.label, e.terms, e.community, e.changed) }
    // agreeing to changed terms times the stall from then
    case "terms-agreed": return s.ask ? { ...s, ask: { ...s.ask, agreed: e.agreed, changed: false }, since: termsAskedAgain(s) && s.since ? { ...s.since, at: e.now } : s.since } : s
    case "terms-accepted": return s.ask ? { ...s, ask: { ...s.ask, accepted: e.accepted, changed: false }, since: termsAskedAgain(s) && s.since ? { ...s.since, at: e.now } : s.since } : s
    case "name-unavailable": return { ...s, unavailable: { key: e.key, status: e.status } }
    case "hold-started": return { ...s, busy: null, note: null, hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: e.lead } }
    case "hold-ended": return { ...s, hold: null }
  }
}

const RETRY_CODE_NOTES: Record<CodeRefusal | "code_reserved", [string, string]> = {
  code_used: ["Your code was used for another name", "A code registers one name only."],
  code_reserved: ["Your code is held by another registration; try again later", ""],
  code_invalid: ["This code is not valid", "The service no longer accepts it."],
  code_expired: ["This code has expired", "An expired code cannot register a name."],
}

// The service's refusal of a retry for the order's code, with the error to keep when no later retry gets past it.
export function retryRefusal(error: string): { note: Note; kept: CodeRefusal | null } | null {
  if (!Object.hasOwn(RETRY_CODE_NOTES, error)) return null
  const known = error as keyof typeof RETRY_CODE_NOTES
  const [title, text] = RETRY_CODE_NOTES[known]
  return { note: { tone: "warn", icon: "key", title, text }, kept: known === "code_reserved" ? null : known }
}

// A refusal this browser kept shows with the failed page itself, so a reload never offers Try again first.
function keptRefusal(s: OrderState): OrderState {
  const kept = s.record?.codeRefusal
  const refusal = kept ? retryRefusal(kept) : null
  return refusal?.kept && !s.codeRefused && s.busy === null && screenOf(s) === "failed" ? { ...s, note: refusal.note, codeRefused: true } : s
}

export function reduce(state: OrderState, event: OrderEvent): OrderState {
  const next = apply(state, event)
  if (next === state || screenOf(next) === screenOf(state)) return keptRefusal(next)
  return keptRefusal({ ...next, busy: null, note: null, codeRefused: false, codeKept: false, codeCheckAt: null, hold: next.hold && { ...next.hold, lead: NO_LEAD } })
}

// The code is said to be kept only once the service says so; a browser that restored the order has not got its code.
export const failedLead = ({ view, invoice, codeRefused, codeKept, record }: OrderState) => view?.linksRefused ? "The service refused its links. Enter its name code to register it without them, or another name."
  : invoice ? "Your payment is kept. Trying again charges nothing."
  : codeRefused ? "Your code can no longer be used for it, so trying again cannot register it."
  : record?.prepaidCode && codeKept ? "Your code is kept. Trying again spends nothing more." : "Trying again spends nothing more."

const NOT_REGISTERED_YET = "The name could not be registered yet"

export const failedAlert = ({ view, codeRefused }: OrderState) => ({ title: view!.error ?? NOT_REGISTERED_YET, retry: !view!.linksRefused && !codeRefused })

export const sameStep = (a: RegistrationView, b: RegistrationView) => a.phase === b.phase && a.label === b.label && a.linksRefused === b.linksRefused && a.moves === b.moves

export const coinOf = (invoice: InvoiceView) => invoice.cryptoCurrency === "btc" || invoice.cryptoCurrency === "xmr" ? invoice.cryptoCurrency : null

// How a closed invoice's order gets a new one: a new spend of the balance that paid part of it, once find names that
// balance where this browser's record does not; a spend of its own balance, which money on the invoice became; or a new
// order at its price.
export function newInvoiceBy(record: OrderRecord, invoice: InvoiceView): "spend" | "find" | "own" | "order" {
  if (record.balanceSource) return "spend"
  if (invoice.registration.fromBalance > 0) return "find"
  return invoice.registration.balance?.amount ? "own" : "order"
}

// A new invoice spends the balance that paid part of the order, read only for such an order, or the order's own; once that
// covers the price, the spend registers the name with nothing to pay, which its button says.
export function spendCovers({ view, invoice, record, sourceBalance }: OrderState): boolean {
  const paying = record && invoice && newInvoiceBy(record, invoice) === "own" ? sourceBalance ?? view?.balance ?? null : sourceBalance
  return view !== null && paying !== null && !paying.held && paying.amount >= view.price
}

// What the order's name costs, which a move to a cheaper name lowers, and what another order's balance paid of it, the
// rest of that payment kept as this order's balance after such a move; null for a code, which costs nothing.
export function costOf(view: RegistrationView, invoice: InvoiceView | null): { cost: number; fromBalance: number } | null {
  if (!invoice && view.fromBalance === 0) return null
  // an order its invoice paid part of names the balance's part only while it is short of the price a move lowered
  return { cost: view.price, fromBalance: invoice && view.fromBalance >= view.price ? 0 : Math.min(view.fromBalance, view.price) }
}

// The service refused the order's links at its reveal, as the view says or as this browser saw: trying again would commit
// the same links, so only another name or other links can register it.
export const linksRefused = ({ view, record }: OrderState) => view?.linksRefused === true || record?.linksRefused === true

export function screenOf(s: OrderState): OrderKind {
  if (s.gone) return "status:unknown-link"
  if (s.price !== null) return "status:price-changed"
  const { invoice, view, record } = s
  if (!view) return "status:unreadable"
  if (closedCase(s)) return "status:closed"
  if (invoice && view.phase === "unpaid") return paymentKind(s, invoice)
  if (view.phase === "unpaid") return "status:paid-by-invoice"
  if (view.phase === "registered") return "registered"
  if (view.phase === "taken") return "taken"
  if (view.phase === "failed") return record && linksRefused(s) ? "links-refused" : "failed"
  if (view.phase !== "registering" && view.label === null && !record) return "not-on-device"
  if (view.phase === "committed" && view.label === null && linksRefused(s)) return "links-refused"
  return "registering"
}

// Money that reached a closed invoice, once credited to its order's balance, is offered as a taken order's balance is:
// another name from it, or a refund. An invoice another replaced still leads there, saying its new one can be cancelled.
export function closedBalance(s: OrderState): "offer" | "replaced" | null {
  const closed = closedCase(s)
  if ((closed !== "paid-late" && closed !== "received") || !s.record || !s.view?.balance?.amount) return null
  return s.record.replacedBy ? "replaced" : "offer"
}

// An expired invoice is still followed: a payment can arrive after it closed, and then nothing must be ordered again.
// A taken or failed order is followed too, since another tab or browser can move or retry it. Money paid after the close
// is followed until it is all in the order's balance, or until the service says only support can credit it.
export function finished(invoice: InvoiceView | null, view: RegistrationView): boolean {
  if (view.phase === "registered") return true
  if (view.phase !== "unpaid" || !invoice || invoice.status === "open") return false
  if (view.latePayment) return view.latePayment.waiting === "support"
  return paidLate(invoice) && view.balance !== null
}

// An unpaid order's invoice that takes no more payment.
export function closedCase({ invoice, view, record }: OrderState): ClosedCase | null {
  if (!invoice || view?.phase !== "unpaid") return null
  if (invoice.status === "open") return null
  if (paidLate(invoice)) return "paid-late"
  if (record?.cancelled && !holdsPayment(invoice)) return "cancelled"
  return holdsPayment(invoice) ? "received" : "expired"
}

function paymentKind(s: OrderState, invoice: InvoiceView): OrderKind {
  if (coinOf(invoice)) return invoice.paidInFull ? "confirming" : "pay-crypto"
  if (!s.cardSubmittedAt && !invoice.amountPaid) return s.cardFailed ? "status:card-unconfirmed" : "pay-card"
  const slow = s.record !== null && s.cardSubmittedAt !== null && s.now >= Date.parse(s.cardSubmittedAt) + CARD_SLOW_MS
  return slow ? "status:card-unconfirmed" : "confirming"
}

export const revealKey = (view: RegistrationView) => `${view.id} ${view.commitment} ${view.intentNonce} ${view.revealBefore}${view.acceptance ? ` ${view.acceptance.policy} ${view.acceptance.termsHash} ${view.acceptance.nonce}` : ""}`

// The terms of the name's kind on chain are not the ones the order signed, so the buyer agrees to them again before the reveal.
const termsChanged = ({ view }: OrderState) => !!view?.acceptance && view.acceptance.termsHash !== signedHash(view.terms)

// The buyer is asked for the changed terms, ticked or not.
export const termsAskedAgain = (s: OrderState) => termsChanged(s) && s.ask?.terms.hash === s.view!.acceptance!.termsHash

// The reveal waits until the buyer ticks the changed terms.
export const termsToAgree = (s: OrderState) => termsChanged(s) && !(termsAskedAgain(s) && ticked(s.ask!))

// The changed terms are asked for once the order is committed and they are not asked for yet.
export const askAgainDue = (s: OrderState) => !!s.record && !linksRefused(s) && termsChanged(s) && !termsAskedAgain(s) && !nameUnavailable(s)

// The commit an answer about its name belongs to, whatever nonces and terms its reveal signs.
export const commitKey = (view: RegistrationView) => `${view.id} ${view.commitment} ${view.revealBefore}`

// The changed terms cannot be asked for a name the search answered as registered or reserved while this commitment waits.
export const nameUnavailable = (s: OrderState) => s.view && s.unavailable?.key === commitKey(s.view) ? s.unavailable : null

export function refusalsOf({ view, reveal }: OrderState): number {
  return view?.phase === "committed" && reveal?.key === revealKey(view) ? reveal.refusals : 0
}

export function revealDue(s: OrderState): boolean {
  const { view, record, reveal } = s
  if (view?.phase !== "committed" || view.label !== null || view.intentNonce === null || !record || linksRefused(s)) return false
  if (view.unread.includes("acceptance") || termsToAgree(s)) return false
  if ((view.revealAfter ?? 0) * 1000 > s.now) return false
  return !(reveal?.key === revealKey(view) && reveal.sending) && refusalsOf(s) < REVEAL_ATTEMPTS
}

export function stalledAt(s: OrderState): number | null {
  const { view, since } = s
  if (!view || !since || screenOf(s) !== "registering" || refusalsOf(s) >= REVEAL_ATTEMPTS || (termsAskedAgain(s) && !ticked(s.ask!)) || nameUnavailable(s)) return null
  if (view.phase !== "committed" || view.label !== null) return since.at + TX_STALL_MS
  return Math.max(since.at, (view.revealAfter ?? 0) * 1000) + REVEAL_ATTEMPTS * RETRY_MS + STALL_MARGIN_MS
}

// A moment counts as reached at its own millisecond, so a tick landing on it changes the page.
export function wakeAt(s: OrderState): number | null {
  const { invoice, view, record, cardSubmittedAt, now } = s
  const moments = [
    invoice?.status === "open" && !coinOf(invoice) && record && cardSubmittedAt ? Date.parse(cardSubmittedAt) + CARD_SLOW_MS : null,
    view?.phase === "committed" && view.revealAfter !== null ? view.revealAfter * 1000 : null,
  ].filter((at): at is number => at !== null && at > now)
  return moments.length ? Math.min(...moments) : null
}
