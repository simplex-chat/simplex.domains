// Whether the service sells names, or registers them only with prepaid codes until the full launch. The same build
// serves both: the page reads the service's mode from GET /api/config before it draws (src/config.ts).
export type Mode = "open" | "codes"

// the service's refusal of a payment or a balance spend in codes-only mode
export const CODES_ONLY = "codes_only"

export const modeOf = (value: unknown): Mode => value === "codes" ? "codes" : "open"

let mode: Mode = "open"
export const setPageMode = (served: Mode) => { mode = served }
export const pageMode = (): Mode => mode
export const codesOnly = () => mode === "codes"
