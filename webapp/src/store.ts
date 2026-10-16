// What this browser keeps: its orders with their owner codes, and its prepaid codes.
// Storage can be missing or full; the page then keeps everything in memory and says so where it matters.

import type { Method } from "./api.ts"

export interface OrderRecord {
  registrationId: string
  invoiceId: string | null
  label: string
  // the owner code; null for an order opened from the app, whose wallet is the app's
  ownerCode: string | null
  owner: string
  contact: string
  channel: string
  method: Method | "code"
  paid: number
  years: number
  // an order opened from the app has no code to derive its secret from
  secret: string | null
  // the request, kept to ask for a new invoice for the same commitment
  request: { labelHash: string; length: number; owner: string; commitment: string; sealed: string | null }
  // when this browser submitted a card payment, kept until the invoice leaves open
  cardSubmittedAt?: string
  cancelled?: boolean
  takenCode?: string
  tld: string
  // the prepaid code that paid, shown again if the name is taken first and the code is released
  prepaidCode?: string
  // the link of the order that replaced this one with a new invoice; its old link leads there
  replacedBy?: string
  createdAt: string
}

export interface CodeRecord {
  code: string
  minLength: number
  years: number
  addedAt: string
}

// an owner code shown at checkout, kept before its order is created so a lost answer loses nothing
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

// A removal reaches storage even after this page moved to memory: removing frees space, so it works on a full storage,
// and a record left there would come back on reload.
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

// whether a storage event from another tab changed one of this store's records
export const isRecordKey = (key: string | null) => key === null || key.startsWith(PREFIX)

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
  if (order.ownerCode) {
    if (saved) remove("pending", order.ownerCode)
    else memory?.delete(`${PREFIX}pending:${order.ownerCode}`)
  }
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

// a card payment submitted for an invoice, kept even for an order this browser has no record of, so a reload or
// another tab does not offer the card form again while Stripe confirms
export const markCardSubmitted = (invoiceId: string) => void put("card", invoiceId, new Date().toISOString())
export const cardSubmitted = (invoiceId: string) => get<string>("card", invoiceId) !== undefined
export const clearCardSubmitted = (invoiceId: string) => remove("card", invoiceId)

export function codes(): CodeRecord[] {
  return all<CodeRecord>("code").sort((a, b) => a.addedAt.localeCompare(b.addedAt))
}

export function addCode(code: CodeRecord): void {
  put("code", code.code, code)
}

// Storage is cleared even when this page has moved to memory, so nothing forgotten comes back on reload.
export function forgetEverything(): void {
  memory?.clear()
  try {
    const s = window.localStorage
    for (const key of stored(s)) s.removeItem(key)
  } catch {
    // nothing stored to clear
  }
}

export function setTheme(t: "light" | "dark"): void {
  try {
    window.localStorage.setItem("theme", t)
  } catch {
    // the choice lasts this page only
  }
}
