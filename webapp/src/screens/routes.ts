export type View = "search" | "checkout" | "order" | "names" | "edit" | "trademarks" | "code"
export type CheckoutStep = "links" | "code" | "review"

export const EDIT_PATH = /^\/edit\/([\w-]+)$/
const CHECKOUT_PATH = /^\/checkout(?:\/(links|code))?$/

export function viewOf(query: URLSearchParams, path: string): View {
  if (query.get("order") || query.get("registration")) return "order"
  if (CHECKOUT_PATH.test(path)) return "checkout"
  if (path === "/names") return "names"
  if (path === "/trademarks") return "trademarks"
  if (path === "/code") return "code"
  if (EDIT_PATH.test(path)) return "edit"
  return "search"
}

export const checkoutStepOf = (path: string): CheckoutStep => (CHECKOUT_PATH.exec(path)?.[1] as CheckoutStep | undefined) ?? "review"
export const checkoutUrl = (step: CheckoutStep) => step === "review" ? "/#/checkout" : `/#/checkout/${step}`
export const CODE_URL = "/#/code"
export const editUrl = (registrationId: string) => `/#/edit/${registrationId}`
// Check your code opened from an order's page, which goes on to the order a name code finds rather than to Your names
export const CODE_FROM_ORDER_URL = `${CODE_URL}?from=order`
export const fromOrder = (hashQuery: URLSearchParams) => hashQuery.get("from") === "order"
