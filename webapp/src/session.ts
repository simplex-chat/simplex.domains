// This tab's checkout in progress, which ends with the tab.
import type { ChainInfo, Community, Method, SignedOrder, Terms } from "./api.ts"
import type { CheckoutStep } from "./screens/routes.ts"

export interface AppliedCode {
  display: string
  minLength: number
  years: number
}

export interface Checkout {
  label: string
  // the search answer's price, for its years or a community name's own, and when the paid years start
  price: number
  years: number
  termStart: number
  chain: ChainInfo
  terms: Terms
  community: Community | null
  contact: string
  channel: string
  method: Method
  code: AppliedCode | null
  // the code field opened on Check your order, whose code pays in place of the tab's, until it is removed
  codeHere?: boolean
  ownerCode: string | null
  // the buyer ticked that they keep a copy of the name code, which the review waits for
  saved: boolean
  // the buyer ticked that they agree to the general terms, which the order waits for
  agreed: boolean
  // the buyer ticked, on its own step, that they accept a community name's community terms, which the review waits for
  accepted?: boolean
  termsChanged?: boolean
  // the history entry of the search the checkout started from
  searchAt: number
  // the step last opened, where Your names continues the checkout
  step: CheckoutStep
  unavailable?: Method
  // why the service refused the code this checkout carried
  codeError?: string
  // the order last sent and what it was made of, sent again exactly while that is unchanged, so a lost answer is safe to ask for again
  sent?: { of: string; request: SignedOrder; owner: string }
  order?: { registrationId: string; method: Method | "code" }
}

const CHECKOUT = "simplex-names-checkout"
const ACTIVE_CODE = "simplex-names-code"
const SCROLLED = "simplex-names-scrolled"
const memory = new Map<string, string>()
// keys whose last write did not reach sessionStorage, which then holds an older value
const unsaved = new Set<string>()

// whether everything this tab holds is in sessionStorage, so a reload of the page keeps it
export const allKept = () => unsaved.size === 0

function read<T>(key: string): T | null {
  let text: string | null
  try {
    text = unsaved.has(key) ? memory.get(key) ?? null : window.sessionStorage.getItem(key)
  } catch {
    text = memory.get(key) ?? null
  }
  try {
    return text ? (JSON.parse(text) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  const text = JSON.stringify(value)
  memory.set(key, text)
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, text)
    unsaved.delete(key)
  } catch {
    unsaved.add(key)
  }
}

// Each entry is written on its own so a page restored from the browser's cache, holding older places, keeps the others.
export const scrolled = (): Record<number, number> => read<Record<number, number>>(SCROLLED) ?? {}
export const setScrolled = (at: number, y: number) => write(SCROLLED, { ...scrolled(), [at]: y })

// a checkout without its name, chain, term or terms, or with the terms version an older page kept, is a leftover, not one to
// continue; one kept without its step opens the review, which sends it on
export function checkout(): Checkout | null {
  const c = read<Checkout>(CHECKOUT)
  return c?.label && c.chain && typeof c.terms?.hash === "string" && typeof c.termStart === "number" ? { ...c, step: c.step ?? "review" } : null
}
export const setCheckout = (c: Checkout | null) => write(CHECKOUT, c)

// the prepaid code this tab pays with, chosen in Check your code or Your names, until it is taken off
export const activeCode = () => read<AppliedCode>(ACTIVE_CODE)
export function setActiveCode(code: AppliedCode | null): void {
  write(ACTIVE_CODE, code)
}
// a code an order took, or the service refused, stops paying only if it is still the one the tab pays with
export function dropActiveCode(display: string): void {
  if (activeCode()?.display === display) setActiveCode(null)
}

// a page changes only its own name's checkout; once the order took it, a stale page writes nothing
export function updateCheckout(label: string, change: Partial<Checkout>): boolean {
  const c = checkout()
  if (c?.label !== label) return false
  write(CHECKOUT, { ...c, ...change })
  return true
}
// The checkout whose order is on its way keeps Pay off and its links, method and code locked, so no press or Back sends or changes another.
const sending = new Set<string>()
const keyOf = (c: Checkout) => `${c.label} ${c.ownerCode}`
export const isSending = (c: Checkout) => sending.has(keyOf(c))
export const startSending = (c: Checkout) => sending.add(keyOf(c))
export const stopSending = (c: Checkout) => sending.delete(keyOf(c))
export const anySending = () => sending.size > 0
