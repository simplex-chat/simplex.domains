// Whether the service sells names, or registers them only with prepaid codes until the full launch. The same build
// serves both: the service rewrites index.html's meta to say which.
export type Mode = "open" | "codes"

export const MODE_META = "simplex-names-mode"
// the service's refusal of a payment or a balance spend in codes-only mode
export const CODES_ONLY = "codes_only"

export const modeOf = (content: string | null | undefined): Mode => content?.trim() === "codes" ? "codes" : "open"
export const pageMode = (): Mode => modeOf(document.querySelector(`meta[name="${MODE_META}"]`)?.getAttribute("content"))
export const codesOnly = () => pageMode() === "codes"
