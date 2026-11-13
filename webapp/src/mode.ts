// Whether the service sells names, or registers them only with prepaid codes until the full launch. The same build
// serves both: the service rewrites index.html's meta to say which.
export type Mode = "open" | "codes"

export const MODE_META = "simplex-names-mode"
// the service's refusal of a payment or a balance spend in codes-only mode
export const CODES_ONLY = "codes_only"

export const modeOf = (content: string | null | undefined): Mode => content?.trim() === "codes" ? "codes" : "open"
// the mode in a shell's text, as the service writes it, or null for a page that is not the shell, as a portal's
export function modeIn(html: string): Mode | null {
  const content = new RegExp(`<meta name="${MODE_META}" content="([^"]*)">`).exec(html)?.[1]
  return content === undefined ? null : modeOf(content)
}
export const pageMode = (): Mode => modeOf(document.querySelector(`meta[name="${MODE_META}"]`)?.getAttribute("content"))
export const codesOnly = () => pageMode() === "codes"
