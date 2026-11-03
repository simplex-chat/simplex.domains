import { type Community, type Terms, termsFor } from "../api.ts"

export interface TermsAsk {
  label: string
  terms: Terms
  community: Community | null
  agreed: boolean
  accepted: boolean
  changed: boolean
}

export const askFor = (label: string, terms: Terms, community: Community | null, changed: boolean): TermsAsk => ({ label, terms, community, agreed: false, accepted: false, changed })

// the general terms' box ticked, or a community name's own tick in its place
export const ticked = (a: { agreed: boolean; accepted?: boolean; community: Community | null }) => a.community ? a.accepted === true : a.agreed

export function termsToSign(label: string, current: string, signed: string | null | undefined, ask: TermsAsk | null): string | null {
  if (signed === current) return current
  return ask?.label === label && ticked(ask) && termsFor(ask.terms, ask.community) === current ? current : null
}
