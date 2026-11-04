// What this browser keeps: its orders with their owner codes, and its prepaid codes.
// Storage can be missing or full; the page then keeps everything in memory and says so where it matters.

import type { Method } from "./api.ts"

export interface OrderRecord {
  registrationId: string
  invoiceId: string | null
  label: string
  ownerCode: string
  owner: string
  contact: string
  channel: string
  // a balance alone paid when it covered the price; a difference is paid by its invoice's method
  method: Method | "code" | "balance"
  paid: number
  years: number
  // the request, kept to ask for a new invoice for the same commitment
  request: { labelHash: string; length: number; duration: number; owner: string; commitment: string; sealed: string }
  terms?: string
  // when this browser submitted a card payment, kept until the invoice leaves open
  cardSubmittedAt?: string
  cancelled?: boolean
  tld: string
  // the prepaid code that paid, shown again if the name is taken first and the code is released
  prepaidCode?: string
  // the service's error for that code once it can no longer pay for a failed registration
  codeRefusal?: CodeRefusal
  // the link of the order that replaced this one with a new invoice; its old link leads there
  replacedBy?: string
  // the service refused the order's links at its reveal, which only a move to other links can fix
  linksRefused?: boolean
  // the order whose balance paid this one, which the service's views do not name
  balanceSource?: string
  createdAt: string
}

export type CodeRefusal = "code_used" | "code_invalid" | "code_expired"

export const invoiceUrl = (invoiceId: string) => `/?order=${invoiceId}`
export const orderUrl = (o: { invoiceId: string | null; registrationId: string }) =>
  o.invoiceId ? invoiceUrl(o.invoiceId) : `/?registration=${o.registrationId}`

export interface CodeRecord {
  code: string
  minLength: number
  years: number
  addedAt: string
}

// an owner code made at checkout, kept before its order is created so a lost answer loses nothing
export interface PendingCode {
  ownerCode: string
  label: string
  tld: string
  createdAt: string
}

// Each record has a key of its own, "simplex-names:<kind>:<id>", so tabs writing different records never overwrite each other.
const PREFIX = "simplex-names:"
type Kind = "order" | "code" | "pending" | "card"

// the records, once storage has failed; until then storage alone holds them
let memory: Map<string, string> | null = null

// Reading decides whether storage is there; a full storage still serves what it holds, and the first failed write moves to memory.
function storage(): Storage | null {
  if (memory) return null
  try {
    const s = window.localStorage
    void s.length
    return s
  } catch {
    memory = new Map()
    return null
  }
}

function stored(s: Storage): string[] {
  return Array.from({ length: s.length }, (_, i) => s.key(i)!).filter((k) => k.startsWith(PREFIX))
}

function keys(kind: Kind): string[] {
  const s = storage()
  return (s ? stored(s) : [...memory!.keys()]).filter((k) => k.startsWith(`${PREFIX}${kind}:`))
}

function read<T>(key: string): T | undefined {
  const s = storage()
  const text = s ? s.getItem(key) : memory!.get(key)
  try {
    return text ? (JSON.parse(text) as T) : undefined
  } catch {
    return undefined
  }
}

function all<T>(kind: Kind): T[] {
  return keys(kind).map((k) => read<T>(k)).filter((v): v is T => v !== undefined)
}

const get = <T>(kind: Kind, id: string) => read<T>(`${PREFIX}${kind}:${id}`)

// returns whether it reached storage, not only memory
function put(kind: Kind, id: string, value: unknown): boolean {
  const key = `${PREFIX}${kind}:${id}`
  const text = JSON.stringify(value)
  const s = storage()
  if (s) {
    try {
      s.setItem(key, text)
      return true
    } catch {
      // storage is full: this page goes on in memory, starting from what storage holds
      memory = new Map(stored(s).map((k) => [k, s.getItem(k)!]))
    }
  }
  memory!.set(key, text)
  return false
}

// A removal reaches storage even after this page moved to memory: removing frees space, and a record left would come back on reload.
function remove(kind: Kind, id: string): void {
  const key = `${PREFIX}${kind}:${id}`
  memory?.delete(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    // storage is blocked, so nothing of this page is in it
  }
}

// A write tells whether storage still takes records: a full one is readable but keeps nothing new.
export function canPersist(): boolean {
  const s = storage()
  if (!s) return false
  // outside the records' prefix, so other tabs do not take the probe for a change to a record
  const probe = "simplex-names-probe"
  try {
    s.setItem(probe, "1")
    s.removeItem(probe)
    return true
  } catch {
    memory = new Map(stored(s).map((k) => [k, s.getItem(k)!]))
    return false
  }
}

// the storage key of an order, to tell another tab's change to it from any other change
export const orderKey = (registrationId: string) => `${PREFIX}order:${registrationId}`
export const cardKey = (invoiceId: string) => `${PREFIX}card:${invoiceId}`

export function orders(): OrderRecord[] {
  return all<OrderRecord>("order").sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function orderByRegistration(registrationId: string): OrderRecord | undefined {
  return get<OrderRecord>("order", registrationId)
}

export function orderByInvoice(invoiceId: string): OrderRecord | undefined {
  return all<OrderRecord>("order").find((o) => o.invoiceId === invoiceId)
}

export function saveOrder(order: OrderRecord): boolean {
  const saved = put("order", order.registrationId, order)
  // The pending code is the stored copy of the owner code until the order holding it is stored too; an order kept
  // only in memory replaces it in memory alone.
  if (saved) remove("pending", order.ownerCode)
  else memory?.delete(`${PREFIX}pending:${order.ownerCode}`)
  return saved
}

export function updateOrder(registrationId: string, change: Partial<OrderRecord>): void {
  const order = orderByRegistration(registrationId)
  if (order) saveOrder({ ...order, ...change })
}

export function pendingCodes(): PendingCode[] {
  return all<PendingCode>("pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// written once per code, so redrawing the code page changes nothing other tabs follow
export function addPending(pending: PendingCode): void {
  if (!get<PendingCode>("pending", pending.ownerCode)) put("pending", pending.ownerCode, pending)
}

export function dropPending(ownerCode: string): void {
  remove("pending", ownerCode)
}

// a card payment submitted for an invoice, kept even without the order's record, so no reload or tab offers the card form while Stripe confirms
export const markCardSubmitted = (invoiceId: string, at: string) => void put("card", invoiceId, at)
export const cardSubmittedAt = (invoiceId: string) => get<string>("card", invoiceId)
export const clearCardSubmitted = (invoiceId: string) => remove("card", invoiceId)

export function codes(): CodeRecord[] {
  return all<CodeRecord>("code").sort((a, b) => a.addedAt.localeCompare(b.addedAt))
}

export function addCode(code: CodeRecord): void {
  put("code", code.code, code)
}

// outside the records' prefix, so no tab takes its writes for a record's change
const SEEN = "simplex-names-seen"
export const seen = <T>(): Record<string, T> => read<Record<string, T>>(SEEN) ?? {}
export function setSeen(rows: object): void {
  const text = JSON.stringify(rows)
  const s = storage()
  if (!s) return void memory!.set(SEEN, text)
  try {
    s.setItem(SEEN, text)
  } catch {
    // a full storage keeps the rows last written
  }
}

// Storage is cleared even when this page has moved to memory, so nothing forgotten comes back on reload.
export function forgetEverything(): void {
  memory?.clear()
  try {
    const s = window.localStorage
    for (const key of [...stored(s), SEEN]) s.removeItem(key)
  } catch {
    // nothing stored to clear
  }
}

// index.html reads the theme kept here before the first paint
const THEME_KEY = "theme"
type Theme = "light" | "dark"
// a choice storage refused, which lasts this page only
let pageTheme: Theme | null = null

export function setTheme(t: Theme): void {
  pageTheme = t
  try {
    window.localStorage.setItem(THEME_KEY, t)
  } catch {
    // the choice lasts this page only
  }
}

// the theme a reader chose, here or in another tab, or null while the page follows the system's
export function chosenTheme(): Theme | null {
  try {
    const kept = window.localStorage.getItem(THEME_KEY)
    if (kept === "light" || kept === "dark") return kept
  } catch {
    // storage refused: only this page's choice counts
  }
  return pageTheme
}
