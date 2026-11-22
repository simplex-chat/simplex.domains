import type { Community, Method, Terms } from "../api.ts"
import type { LinkKind } from "../names.ts"
import type { AppliedCode, Checkout } from "../session.ts"
import { type Hold, NO_LEAD } from "./hold.ts"
import type { CheckoutStep } from "./routes.ts"

export const FALLBACK_METHOD: Record<Method, Method> = { card: "btc", btc: "xmr", xmr: "btc" }

export type Refusal = "price-changed" | "too-many" | "failed" | "taken" | "unavailable" | "codes-only" | `link-${LinkKind}`
export type CheckoutKind = CheckoutStep | `status:${Refusal}`

export interface WaitingOrder { registrationId: string; invoiceId: string }
interface OpenOrder { invoiceId: string; confirming: boolean }

export interface CheckoutState {
  step: CheckoutStep
  checkout: Checkout
  // the service registers names only with prepaid codes, so a code pays for every order
  codesOnly: boolean
  sending: boolean
  busy: boolean
  waiting: WaitingOrder | null
  openOrder: OpenOrder | null
  hold: Hold | null
  refusal: Refusal | null
  // the community terms' text read for their step, by their hash; null when it cannot be shown
  communityText: { hash: string; text: string | null } | null
}

export type CheckoutEvent =
  | { type: "opened"; step: CheckoutStep; checkout: Checkout; sending: boolean; waiting: WaitingOrder | null; hold: Hold | null }
  | { type: "link-set"; kind: LinkKind; link: string }
  | { type: "saved"; saved: boolean }
  | { type: "agreed"; agreed: boolean }
  | { type: "accepted"; accepted: boolean }
  | { type: "community-read"; hash: string; text: string | null }
  | { type: "method-chosen"; method: Method }
  | { type: "code-opened" }
  // the code the review's field holds that covers the name, or null for anything else typed there
  | { type: "code-heard"; code: AppliedCode | null }
  | { type: "code-removed" }
  | { type: "waiting-settled" }
  | { type: "open-order-seen"; order: OpenOrder | null }
  | { type: "send-started" }
  | { type: "order-refused"; reason: "code"; error: string }
  | { type: "order-refused"; reason: "method" | "failed" | "taken" | "unavailable" | "codes-only" | `link-${LinkKind}` }
  | { type: "price-changed"; price: number }
  | { type: "terms-changed"; terms: Terms; community: Community | null }
  | { type: "hold-started"; until: number }
  | { type: "hold-ended" }

export function initialState(checkout: Checkout, step: CheckoutStep, codesOnly: boolean): CheckoutState {
  return { step, checkout, codesOnly, sending: false, busy: false, waiting: null, openOrder: null, hold: null, refusal: null, communityText: null }
}

export function changeOf({ checkout, codesOnly }: CheckoutState, e: CheckoutEvent): Partial<Checkout> | null {
  switch (e.type) {
    case "link-set": return e.kind === "contact" ? { contact: e.link } : { channel: e.link }
    case "saved": return { saved: e.saved }
    case "agreed": return { agreed: e.agreed, termsChanged: undefined }
    case "accepted": return { accepted: e.accepted }
    case "method-chosen": return e.method === checkout.method || e.method === checkout.unavailable ? null : { method: e.method }
    case "code-opened": return codeEntry(checkout, codesOnly) === "link" ? { codeHere: true, codeError: undefined } : null
    // the field stays open once it took a code, as it is open in codes-only mode only while no code pays
    case "code-heard": return codeEntry(checkout, codesOnly) === "field" && JSON.stringify(e.code) !== JSON.stringify(checkout.code) ? { code: e.code, codeError: undefined, codeHere: true } : null
    case "code-removed": return checkout.codeHere ? { code: null, codeHere: undefined } : null
    case "order-refused":
      if (e.reason === "code") return { code: null, codeError: e.error, codeHere: undefined }
      return e.reason === "method" ? { unavailable: checkout.method, method: FALLBACK_METHOD[checkout.method] } : null
    case "price-changed": return { price: e.price }
    case "terms-changed": return { terms: e.terms, community: e.community, agreed: false, accepted: false, termsChanged: true }
    default: return null
  }
}

const unsent = (s: CheckoutState, change: Partial<CheckoutState>): CheckoutState => ({ ...s, sending: false, busy: false, ...change })

export function reduce(s: CheckoutState, e: CheckoutEvent): CheckoutState {
  const change = changeOf(s, e)
  const checkout = change ? { ...s.checkout, ...change } : s.checkout
  switch (e.type) {
    case "opened": return { ...s, step: e.step, checkout: e.checkout, sending: e.sending, busy: false, waiting: e.waiting, hold: e.hold, refusal: null }
    case "link-set":
    case "saved":
    case "agreed":
    case "accepted":
    case "method-chosen":
    case "code-opened":
    case "code-heard":
    case "code-removed": return change ? { ...s, checkout } : s
    case "community-read": return { ...s, communityText: { hash: e.hash, text: e.text } }
    case "waiting-settled": return { ...s, waiting: null }
    case "open-order-seen": return { ...s, openOrder: e.order }
    case "send-started": return { ...s, sending: true, busy: true }
    case "order-refused": return unsent(s, { checkout, refusal: e.reason === "method" || e.reason === "code" ? null : e.reason })
    case "price-changed": return unsent(s, { checkout, refusal: "price-changed" })
    case "terms-changed": return unsent(s, { checkout })
    case "hold-started": return unsent(s, { hold: { until: Math.max(e.until, s.hold?.until ?? 0), lead: NO_LEAD }, refusal: "too-many" })
    case "hold-ended": return { ...s, hold: null }
  }
}

export const METHODS: Method[] = ["card", "btc", "xmr"]

// The review's code field, once opened, or the link that opens it, offered where the order is paid: not where the tab's
// code pays it, which the header takes off, nor for a name selected for a taken order. In codes-only mode nothing else
// pays, so the field is open whenever no code pays.
export function codeEntry(c: Checkout, codesOnly: boolean): "field" | "link" | null {
  if (c.order) return null
  if (c.codeHere || (codesOnly && c.code === null)) return "field"
  return c.code ? null : "link"
}

// the open code field takes the payment choices' place, and the order waits for a code there that covers the name
export const awaitsCode = (c: Checkout, codesOnly: boolean) => codeEntry(c, codesOnly) === "field" && c.code === null

// the review opens once the name code is saved and a community name's terms are accepted on their own step, which only a
// community name has
export function stepFor(c: Checkout, asked: CheckoutStep): CheckoutStep {
  if ((asked === "community" || asked === "review") && !(c.ownerCode && c.saved)) return "code"
  if (asked === "community" && !c.community) return "review"
  return asked === "review" && c.community && !c.accepted ? "community" : asked
}

export function screenOf(s: CheckoutState): CheckoutKind {
  return s.refusal ? `status:${s.refusal}` : s.step
}
