// This tab's checkout in progress, which ends with the tab.
import type { Balance, ChainInfo, Community, Method, SignedOrder, SpendRequest, Terms } from "./api.ts"
import type { CheckoutStep } from "./screens/routes.ts"

export interface AppliedCode {
  display: string
  minLength: number
  years: number
}

// an order's balance as last read: the order it belongs to, the cents left, whether an invoice holds them, and until when
// (null while money that reached that invoice is being confirmed)
export interface AppliedBalance {
  source: string
  amount: number
  held: boolean
  heldUntil: string | null
}

// a balance pays only while something is left of it
export const appliedBalance = (source: string, balance: Balance | null): AppliedBalance | null =>
  balance && balance.amount > 0 ? { source, amount: balance.amount, held: balance.held, heldUntil: balance.held ? balance.heldUntil : null } : null

// how the balance changed since the page took it: another amount left, or none
export type BalanceChange = "changed" | "gone"

export interface Checkout {
  label: string
  // the search answer's price, for its years, and when the paid years start
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
  // the balance that pays, under its order's name code, which owns the name too
  balance: AppliedBalance | null
  balanceChange?: BalanceChange
  ownerCode: string | null
  // the buyer ticked that they keep a copy of the name code, which the review waits for
  saved: boolean
  // the buyer ticked that they agree to the name terms, which the order waits for
  agreed: boolean
  termsChanged?: boolean
  // the history entry of the search the checkout started from
  searchAt: number
  // the step last opened, where Your names continues the checkout
  step: CheckoutStep
  unavailable?: Method
  // why the service refused the code this checkout carried
  codeError?: string
  // the order last sent and what it was made of, sent again exactly while that is unchanged, so a lost answer is safe to ask for again
  sent?: { of: string; request: SignedOrder; owner: string; spend?: SpendRequest }
}

const CHECKOUT = "simplex-names-checkout"
const ACTIVE_CODE = "simplex-names-code"
const ACTIVE_BALANCE = "simplex-names-balance"
const SCROLLED = "simplex-names-scrolled"
const memory = new Map<string, string>()
// keys whose last write did not reach sessionStorage, which then holds an older value
const unsaved = new Set<string>()

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

// a checkout without its name, chain, term or terms is a leftover, not one to continue; one kept without its step opens the review, which sends it on
export function checkout(): Checkout | null {
  const c = read<Checkout>(CHECKOUT)
  return c?.label && c.chain && c.terms && typeof c.termStart === "number" ? { ...c, step: c.step ?? "review", balance: c.balance ?? null } : null
}
export const setCheckout = (c: Checkout | null) => write(CHECKOUT, c)

// the prepaid code this tab pays with, chosen in Check your code or Your names, until it is taken off; a code and a
// balance take each other's place
export const activeCode = () => read<AppliedCode>(ACTIVE_CODE)
export function setActiveCode(code: AppliedCode | null): void {
  write(ACTIVE_CODE, code)
  if (code) write(ACTIVE_BALANCE, null)
}

// the balance this tab pays with, chosen in Your names or on its order's page, until it is taken off or spent
export const activeBalance = () => read<AppliedBalance>(ACTIVE_BALANCE)
export function setActiveBalance(balance: AppliedBalance | null): void {
  write(ACTIVE_BALANCE, balance)
  if (balance) write(ACTIVE_CODE, null)
}
// a balance read again or spent changes the tab's only if it is still the one the tab pays with
export function updateActiveBalance(source: string, balance: AppliedBalance | null): void {
  if (activeBalance()?.source === source) write(ACTIVE_BALANCE, balance)
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
