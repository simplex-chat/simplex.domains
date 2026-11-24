import type { Acceptance, FailReason, Payment, Phase, PhaseView, RegistrationView, ToSign } from "../src/api.ts"

export type ViewBase = Omit<RegistrationView, "phase" | "payment">

export interface ShortView extends Partial<Omit<RegistrationView, "phase">> {
  phase?: Phase
  revealAfter?: number
  revealBefore?: number
  intentNonce?: number | null
  acceptance?: Acceptance | null
  unread?: boolean
  lapsed?: boolean
  expiresAt?: number
  reason?: FailReason
  closedBy?: ClosedBy
}

type ClosedBy = Extract<PhaseView, { type: "closed" }>["closedBy"]

export function viewOf(base: ViewBase, change: ShortView): RegistrationView {
  const { phase = "unpaid", revealAfter = 0, revealBefore = 0, intentNonce = null, acceptance = null, unread = false, lapsed = false, expiresAt = 0, reason = "registryRefused", closedBy = "expired", ...rest } = change
  const view = { ...base, ...rest }
  const payment: Payment = { type: "invoice", method: "btc" }
  const toSign: ToSign = unread || intentNonce === null || acceptance === null ? { type: "unread" } : { type: "read", intentNonce, acceptance }
  const phaseView: PhaseView = phase === "committed" ? { type: phase, revealAfter, revealBefore, signature: view.label !== null ? { type: "signed" } : lapsed ? { type: "lapsed" } : { type: "awaiting", toSign } }
    : phase === "registered" ? { type: phase, expiresAt } : phase === "failed" ? { type: phase, reason } : phase === "closed" ? { type: phase, closedBy } : { type: phase }
  return { payment, ...view, phase: phaseView }
}
