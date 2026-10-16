// The names service's HTTP API, on the page's own origin.
import { MAX_LABEL_LENGTH } from "./names.ts"

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfter: number | null
  readonly body: Record<string, unknown>
  constructor(code: string, status: number, retryAfter: number | null, body: Record<string, unknown>) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
    this.body = body
  }
}

export type Phase = "unpaid" | "queued" | "committing" | "committed" | "registering" | "registered" | "taken" | "failed" | "code_issued"
export type Method = "card" | "btc" | "xmr"

export interface ChainInfo {
  resolver: string
  sponsor: string
  chainId: number
  tld: string
}

export type SearchAnswer =
  | ({ status: "available"; price: number; currency: string; years: number } & ChainInfo)
  | { status: "registered"; entities: Entity[]; records?: { contact: string; channel: string } | null; owner?: string; resolver?: string; recordsNonce?: number | null; expiresAt?: number; chainId?: number; tld: string }
  | { status: "reserved" }

export interface Entity {
  type: "address" | "channel"
  displayName: string
  image: string | null
  link: string
  deepLink: string
}

export interface RegistrationView extends ChainInfo {
  id: string
  phase: Phase
  labelHash: string
  label: string | null
  owner: string
  commitment: string
  sealed: string | null
  years: number
  // what the order is worth, in cents: what was paid, or the price of the name it moved to; it caps another move
  price: number
  commitTx: string | null
  registerTx: string | null
  revealAfter: number | null
  revealBefore: number | null
  intentNonce: number | null
  expiresAt: number | null
  error: string | null
}

export interface InvoiceView {
  invoiceId: string
  status: "open" | "paid" | "expired"
  amount: number
  currency: string
  expiresAt: string
  kind: "name"
  registration: RegistrationView
  amountPaid?: number
  cryptoAmountPaid?: string
  cryptoAmountDue?: string
  paidInFull?: boolean
  settledAt?: string
  clientSecret?: string
  address?: string
  cryptoAmount?: string
  cryptoCurrency?: Method
  requiredConfirmations?: number
}

export const holdsPayment = (inv: InvoiceView) => Boolean(inv.amountPaid) || Number(inv.cryptoAmountPaid ?? "0") > 0 || inv.paidInFull === true

// an invoice closed with nothing received, whose order a new invoice can take over
export const closedEmpty = (inv: InvoiceView | null) => inv?.status === "expired" && !holdsPayment(inv)

export interface OrderRequest {
  labelHash: string
  length: number
  owner: string
  commitment: string
  sealed: string | null
}

// A request is given up after this long, so a hung one never blocks the page for good. Long polls hold as long as
// the service decides; a link edit answers once it is mined, which a fee bump can stretch to minutes.
const REQUEST_TIMEOUT_MS = 60_000
const EDIT_TIMEOUT_MS = 10 * 60_000
// a wait asked for longer than this is taken as this long, as the badge web client does
const MAX_RETRY_AFTER_S = 300
const TOO_MANY_REQUESTS = 429
// a proxy's answer when the service is down or slow: the request may never have reached the service
const GATEWAY_FAILURES = [502, 503, 504]
// a rate limit that names no wait is waited out for this long
export const LIMITED_WAIT_S = 30
// The service's times (reveal windows, invoice expiry, signed timestamps) are read against its clock, which each answer's
// Date header gives to the second; a device off by less than this is taken as right.
const CLOCK_SLACK_MS = 2000
let clockOffsetMs = 0
// counts changes of the offset, so a request signed before one can be signed again
let clockChanges = 0
export const serviceNow = () => Date.now() + clockOffsetMs
export const clockVersion = () => clockChanges

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
  // one controller for the caller's signal and the time limit, without AbortSignal.any, which older browsers lack
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal?.addEventListener("abort", onAbort)
  if (signal?.aborted) stop.abort()
  const timer = timeoutMs === null ? undefined : setTimeout(onAbort, timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(path, {
        method, signal: stop.signal,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      if (signal?.aborted) throw e
      throw new ApiError("network", 0, null, {})
    }
    const date = Date.parse(res.headers.get("date") ?? "")
    if (Number.isFinite(date)) {
      const offset = Math.abs(date - Date.now()) > CLOCK_SLACK_MS ? date - Date.now() : 0
      if (offset !== clockOffsetMs) clockChanges++
      clockOffsetMs = offset
    }
    // a body cut off on its way is no answer, even after a 200
    const json = await res.json().catch(() => null)
    if (json === null && res.ok) throw new ApiError("network", 0, null, {})
    return answer<T>(res, json ?? {})
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

// Retry-After is seconds or an HTTP date
function retryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = /^\d+$/.test(header.trim()) ? Number(header) : Math.ceil((Date.parse(header) - serviceNow()) / 1000)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : null
}

function answer<T>(res: Response, json: Record<string, unknown>): T {
  if (!res.ok) {
    const retry = retryAfter(res.headers.get("retry-after"))
    // a rate limit or a gateway failure a proxy answers carries no error code of the service's
    const code = res.status === TOO_MANY_REQUESTS ? "rate_limited"
      : typeof json.error === "string" ? json.error
      : GATEWAY_FAILURES.includes(res.status) ? "network" : "internal"
    throw new ApiError(code, res.status, retry, json)
  }
  return json as T
}

// An answer the page cannot draw, or that holds what cannot be so (a negative price, an unknown state), is no
// answer, as a body cut off is.
const noAnswer = () => new ApiError("network", 0, null, {})
async function checked<T>(answer: Promise<unknown>, drawable: (a: Record<string, unknown>) => boolean): Promise<T> {
  const a = await answer
  if (!isObject(a) || !drawable(a)) throw noAnswer()
  return a as T
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isText = (v: unknown) => typeof v === "string"
const isAmount = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 1
const isDecimal = (v: unknown) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v)
const optional = (v: unknown, test: (v: unknown) => boolean) => v === undefined || test(v)
const nullable = (v: unknown, test: (v: unknown) => boolean) => v === null || test(v)
// an image the page shows itself, never a link a click could follow
const isImage = (v: unknown) => v === null || (typeof v === "string" && /^(data:image\/|https:\/\/)/.test(v))
const isPreview = (e: unknown) => isObject(e) && (e.type === "address" || e.type === "channel") && isText(e.displayName) && isImage(e.image)
const isEntity = (e: unknown) => isPreview(e) && isText((e as Record<string, unknown>).link) && isText((e as Record<string, unknown>).deepLink)
const isChain = (a: Record<string, unknown>) => isText(a.resolver) && isText(a.sponsor) && typeof a.chainId === "number" && isText(a.tld)
const PHASES: Phase[] = ["unpaid", "queued", "committing", "committed", "registering", "registered", "taken", "failed", "code_issued"]
const isRegistration = (v: unknown) => isObject(v) && isChain(v) && isText(v.id) && PHASES.includes(v.phase as Phase) && isText(v.labelHash)
  && nullable(v.label, isText) && isText(v.owner) && isText(v.commitment) && nullable(v.sealed, isText) && isCount(v.years) && isAmount(v.price)
  && nullable(v.commitTx, isText) && nullable(v.registerTx, isText) && nullable(v.revealAfter, isAmount) && nullable(v.revealBefore, isAmount)
  && nullable(v.intentNonce, isAmount) && nullable(v.expiresAt, isAmount) && nullable(v.error, isText)
const isInvoice = (v: unknown) => isObject(v) && isText(v.invoiceId) && ["open", "paid", "expired"].includes(v.status as string) && isAmount(v.amount)
  && isText(v.currency) && isText(v.expiresAt) && isRegistration(v.registration) && optional(v.amountPaid, isAmount)
  && optional(v.cryptoAmountPaid, isDecimal) && optional(v.cryptoAmountDue, isDecimal) && optional(v.cryptoAmount, isDecimal)
  && optional(v.paidInFull, (x) => typeof x === "boolean") && optional(v.address, isText)
  && optional(v.cryptoCurrency, (x) => ["card", "btc", "xmr"].includes(x as string)) && optional(v.requiredConfirmations, (x) => Number.isInteger(x) && (x as number) >= 0)
const isRecords = (v: unknown) => isObject(v) && isText(v.contact) && isText(v.channel)

export const searchName = (labelHash: string, length: number) => checked<SearchAnswer>(call("GET", `/api/name/${labelHash}?length=${length}`), (a) =>
  a.status === "reserved"
  || (a.status === "available" && isAmount(a.price) && isCount(a.years) && isText(a.currency) && isChain(a))
  || (a.status === "registered" && isText(a.tld) && Array.isArray(a.entities) && a.entities.every(isEntity) && optional(a.owner, isText)
    && optional(a.resolver, isText) && optional(a.records, (r) => nullable(r, isRecords)) && optional(a.recordsNonce, (n) => nullable(n, isAmount))
    && optional(a.expiresAt, isAmount) && optional(a.chainId, isAmount)))
export const previewLink = (link: string) =>
  checked<{ type: "address" | "channel"; displayName: string; image: string | null }>(call("POST", "/api/link/preview", { link }), isPreview)
const CODE_STATES = ["unused", "used", "reserved", "expired", "unpaid", "revoked"] as const
export type CodeState = typeof CODE_STATES[number]
export interface CodeAnswer { minLength: number; years: number; state: CodeState }
export async function checkCode(code: string): Promise<CodeAnswer> {
  const answer: unknown = await call("POST", "/api/code/check", { code })
  const drawable = isObject(answer) && isCount(answer.minLength) && (answer.minLength as number) <= MAX_LABEL_LENGTH && isCount(answer.years)
    && CODE_STATES.includes(answer.state as CodeState)
  if (!drawable) throw noAnswer()
  return answer as unknown as CodeAnswer
}

export type CreatedOrder = InvoiceView | { invoiceId: null; kind: "name"; registration: RegistrationView }
export const createOrder = (order: OrderRequest, method: Method, price: number) =>
  checked<CreatedOrder>(call("POST", "/api/invoice", { kind: "name", ...order, method, price }), (a) => a.invoiceId === null ? isRegistration(a.registration) : isInvoice(a))
export const registerWithCode = (order: OrderRequest, code: string) =>
  checked<{ registrationId: string; invoiceId?: string }>(call("POST", "/api/name/register", { ...order, code }), (a) => isText(a.registrationId) && optional(a.invoiceId, isText))
export const cancelInvoice = (invoiceId: string) => checked<InvoiceView>(call("POST", `/api/invoice/${encodeURIComponent(invoiceId)}/cancel`), isInvoice)

// the seen payment marks are the paid amount and paidInFull: Monero can report a full payment with no amount yet
export function readInvoice(invoiceId: string, seen?: { status: string; phase: string; paid: string; full: boolean }, signal?: AbortSignal): Promise<InvoiceView> {
  const query = seen ? `?wait=${seen.status}&seenPhase=${seen.phase}&seenPaid=${encodeURIComponent(seen.paid)}&seenFull=${seen.full ? "1" : "0"}` : ""
  return checked<InvoiceView>(call("GET", `/api/invoice/${encodeURIComponent(invoiceId)}${query}`, undefined, signal, seen ? null : REQUEST_TIMEOUT_MS), isInvoice)
}

export function readRegistration(registrationId: string, seenPhase?: string, signal?: AbortSignal): Promise<RegistrationView> {
  return checked<RegistrationView>(call("GET", `/api/registration/${encodeURIComponent(registrationId)}${seenPhase ? `?seenPhase=${seenPhase}` : ""}`, undefined, signal, seenPhase ? null : REQUEST_TIMEOUT_MS), isRegistration)
}

export const reveal = (registrationId: string, body: { label: string; secret: string; records: { contact: string[]; channel: string[] }; nonce: number; deadline: number; signature: string }) =>
  call<Record<string, never>>("POST", `/api/registration/${encodeURIComponent(registrationId)}/reveal`, body)
export const retarget = (registrationId: string, body: OrderRequest & { timestamp: number; signature: string }) =>
  checked<RegistrationView>(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/name`, body), isRegistration)
export const takeCode = (registrationId: string, body: { codeHash: string; timestamp: number; signature: string }) =>
  call<Record<string, never>>("POST", `/api/registration/${encodeURIComponent(registrationId)}/code`, body)
export const retry = (registrationId: string) => checked<RegistrationView>(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/retry`), isRegistration)
const isFound = (r: unknown) => isObject(r) && isText(r.registrationId) && nullable(r.invoiceId, isText) && PHASES.includes(r.phase as Phase) && isText(r.createdAt)
export const findRegistrations = (owner: string, timestamp: number, signature: string) =>
  checked<{ registrations: { registrationId: string; invoiceId: string | null; phase: Phase; createdAt: string }[] }>(
    call("POST", "/api/registration/find", { owner, timestamp, signature }), (a) => Array.isArray(a.registrations) && a.registrations.every(isFound))
export const editRecord = (body: { labelHash: string; key?: string; value?: string; clear?: boolean; nonce: number; deadline: number; signature: string }) =>
  checked<{ tx: string | null }>(call("POST", "/api/name/records", body, undefined, EDIT_TIMEOUT_MS), (a) => nullable(a.tx, isText))
