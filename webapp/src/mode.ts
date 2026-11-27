// Whether the service sells names, or registers them only with prepaid codes until the full launch.
import { SITE } from "./config.ts"

// the service's refusal of a payment in codes-only mode
export const CODES_ONLY = "codes_only"

export const codesOnly = () => SITE.codesOnly
