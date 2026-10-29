import { type Community, type Terms, termsFor } from "../api.ts"

export interface TermsAsk {
  label: string
  terms: Terms
  community: Community | null
  agreed: boolean
  changed: boolean
}

export const askFor = (label: string, terms: Terms, community: Community | null, changed: boolean): TermsAsk => ({ label, terms, community, agreed: false, changed })

export function termsToSign(label: string, current: string, signed: string | null | undefined, ask: TermsAsk | null): string | null {
  if (signed === current) return current
  return ask?.label === label && ask.agreed && termsFor(ask.terms, ask.community) === current ? current : null
}
