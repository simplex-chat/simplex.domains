// The names service's HTTP API, on the page's own origin.
import { sha256 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
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

// a spend refused because the balance is not as the page read it: the balance now, or null when the order has none
export class BalanceChanged extends ApiError {
  readonly balance: Balance | null
  constructor(e: ApiError, balance: Balance | null) {
    super(e.code, e.status, e.retryAfter, e.body)
    this.balance = balance
  }
}

export class TermsChanged extends ApiError {
  readonly terms: Terms
  readonly community: Community | null
  constructor(e: ApiError, terms: Terms, community: Community | null) {
    super(e.code, e.status, e.retryAfter, e.body)
    this.terms = terms
    this.community = community
  }
}

// a link edit refused because the name's yearly edits are used up, until nextAt in unix seconds
export class EditLimited extends ApiError {
  readonly nextAt: number
  constructor(e: ApiError, nextAt: number) {
    super(e.code, e.status, e.retryAfter, e.body)
    this.nextAt = nextAt
  }
}

// How long to wait before asking again: what a rate limit asks for, or the usual pause. Null for a refusal that asking
// again cannot change, such as a request this device's clock signed outside the service's window.
export function retryDelay(e: unknown, usual: number): number | null {
  if (!(e instanceof ApiError)) return usual
  if (e.retryAfter) return e.retryAfter * 1000
  if (e.code === "rate_limited") return usual
  return e.status >= 400 && e.status < 500 ? null : usual
}

export type Phase = "unpaid" | "queued" | "committing" | "committed" | "registering" | "registered" | "taken" | "failed"
export type Method = "card" | "btc" | "xmr"

export interface ChainInfo {
  resolver: string
  sponsor: string
  chainId: number
  tld: string
}

export const LINK_KINDS = ["contact", "channel"] as const
export interface Links {
  contact: string
  channel: string
}

export interface Terms {
  hash: string
  link: string
}

// A community name: what it is for, null when the service has no words for it, and the years it is registered for. In a
// search answer, a name on the chain's list; in an order's view, an order that signed the community terms.
export interface Community {
  for: string | null
  years: number
}

const COMMUNITY_TERMS = "community/"
const COMMUNITY_AGREED = /^(?:[A-Za-z0-9._-]+\/)?community\//

export const termsFor = (terms: Terms, community: Community | null) => `${community ? COMMUNITY_TERMS : ""}${terms.hash.slice(2)}`
export const currentTerms = (a: { terms: Terms; community: Community | null }) => termsFor(a.terms, a.community)
// a community name is registered for its own years, whatever years its code or order pays for
export const termYears = (community: Community | null, years: number) => community?.years ?? years
export const communityAgreed = (terms: string | null | undefined) => COMMUNITY_AGREED.test(terms ?? "")

export function signedHash(terms: string | null | undefined): string | null {
  const hash = terms?.startsWith(COMMUNITY_TERMS) ? terms.slice(COMMUNITY_TERMS.length) : terms
  return hash && /^[0-9a-f]{64}$/.test(hash) ? `0x${hash}` : null
}

const LOCAL_CHAIN_ID = 31337
const MAX_PORT = 65535
const TERMS_LINK = /^(?:https:\/\/git\.simplex\.chat\/simplex-chat\/simplex-chat\/raw\/commit\/([0-9a-f]{40})|http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4}))\/([A-Za-z0-9_./-]+)#sha256=([0-9a-f]{64})$/

export function termsLink(link: string, chainId: number): { commit: string | null; digest: string } | null {
  const [, commit, port, path, digest] = TERMS_LINK.exec(link) ?? []
  if (path === undefined || !path.endsWith(".md") || path === ".md" || path.split("/").some((s) => s === "" || s === "." || s === "..")) return null
  if (commit === undefined && (chainId !== LOCAL_CHAIN_ID || Number(port) > MAX_PORT)) return null
  return { commit: commit ?? null, digest }
}

export const readerUrl = (link: string) => link.slice(0, link.indexOf("#")).replace("/raw/commit/", "/src/commit/")

const keccakOf = (text: string) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`

// the link edits a name has left in any 365 days, and when the next one returns: null while none is counted
export interface RecordEdits {
  left: number
  nextAt: number | null
}

export type SearchAnswer =
  | ({ status: "available"; price: number; currency: string; years: number; termStart: number; community: Community | null; terms: Terms | null } & ChainInfo)
  | { status: "registered"; entities: Entity[]; records?: Links | null; owner?: string; resolver?: string; recordsNonce?: number | null; recordEdits?: RecordEdits | null; expiresAt?: number; gracePeriod?: number; chainId?: number; tld: string; community: Community | null }
  | { status: "reserved"; community: Community | null }

export type ChatKind = "contact" | "channel" | "business" | "bot"
// whether the service read the link's data: not now (unread), or never, for a host it does not fetch (unavailable)
const PROFILE_STATES = ["ok", "unread", "unavailable"] as const
// the profile a link opens, as the app's connection alert shows it; only a channel counts subscribers
export interface Profile {
  type: "address" | "channel"
  kind: ChatKind
  displayName: string
  fullName: string
  image: string | null
  subscribers: number | null
  profile: typeof PROFILE_STATES[number]
}
// the chat core's own form of the link, null for a link the core cannot parse, which is opened as it is
export interface Entity extends Profile {
  link: string
  deepLink: string | null
}

// An order's balance, in cents: what is left to spend, whether an invoice of another order holds it and until when (null
// once money reached that invoice, which holds it until its payment settles), and what support has refunded from it
export interface Balance {
  amount: number
  held: boolean
  heldUntil: string | null
  refunded: number
}

export interface RegistrationView extends ChainInfo {
  id: string
  // counts the service's changes to the registration, which a long poll holds on
  version: number
  phase: Phase
  labelHash: string
  label: string | null
  owner: string
  commitment: string
  sealed: string
  years: number
  // the term in seconds the commitment holds: the paid years and the free days until the term starts
  duration: number
  // what the order is worth, in cents: what was paid, or the price of the name it moved to; it caps another move
  price: number
  // the cents another order's balance paid when this order was made
  fromBalance: number
  balance: Balance | null
  // what money paid after the invoice closed waits on before it is all in the balance: being confirmed, being credited, or support
  latePayment: { waiting: LateWait } | null
  // how often the order moved to another name or other links, which the service bounds
  moves: number
  commitTx: string | null
  registerTx: string | null
  revealAfter: number | null
  revealBefore: number | null
  intentNonce: number | null
  // what the owner signs with the reveal to accept the terms of the name's kind on chain, while a committed order waits for
  // its reveal, the policy being the signature's verifying contract; null otherwise
  acceptance: { kind: "general" | "community"; policy: string; termsHash: string; nonce: number } | null
  // the fields left null because the service's chain read failed; reading the view again may fill them
  unread: string[]
  expiresAt: number | null
  error: string | null
  // a reveal was refused for its links, which the commitment holds: only another name or other links can register it
  linksRefused: boolean
  community: Community | null
  terms: string | null
}

const LATE_WAITS = ["confirming", "crediting", "support"] as const
export type LateWait = typeof LATE_WAITS[number]

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

// All of a closed invoice's amount arrived after it closed and is credited, or waits on support alone. BTCPay keeps such an
// invoice expired (invalid after a cancel) and says paidInFull; a provider that settles it late reads paid.
export function paidLate(inv: InvoiceView): boolean {
  const waiting = inv.registration.latePayment?.waiting
  return (inv.status === "paid" || (inv.status === "expired" && inv.paidInFull === true)) && (waiting === undefined || waiting === "support")
}

// an invoice closed with nothing received, whose order a new invoice can take over
export const closedEmpty = (inv: InvoiceView | null) => inv?.status === "expired" && !holdsPayment(inv)

interface OrderRequest {
  labelHash: string
  length: number
  duration: number
  owner: string
  commitment: string
  sealed: string
  terms: string
}
// an order as sent, signed by its owner at a time the service checks
export type SignedOrder = OrderRequest & { timestamp: number; signature: string }

// A request is given up after this long, so a hung one never blocks the page for good. Long polls hold as long as
// the service decides; a link edit answers once it is mined, which a fee bump can stretch to minutes.
const REQUEST_TIMEOUT_MS = 60_000
const EDIT_TIMEOUT_MS = 10 * 60_000
// a wait asked for longer than this is taken as this long, as the badge web client does
const MAX_RETRY_AFTER_S = 300
const TOO_MANY_REQUESTS = 429
// the one refusal under 429 that is the service's own, not a rate limit
const EDIT_LIMIT = "edit_limit"
// a proxy's answer when the service is down or slow: the request may never have reached the service
const GATEWAY_FAILURES = [502, 503, 504]
// a rate limit that names no wait is waited out for this long
export const LIMITED_WAIT_S = 30
// The service's times are read against its clock, which each answer's Date header gives to the second; a device off by less than this is taken as right.
const CLOCK_SLACK_MS = 2000
let clockOffsetMs = 0
// counts changes of the offset, so a request signed before one can be signed again
let clockChanges = 0
export const serviceNow = () => Date.now() + clockOffsetMs
export const serviceSeconds = () => Math.floor(serviceNow() / 1000)
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
    const code = res.status === TOO_MANY_REQUESTS ? (json.error === EDIT_LIMIT ? EDIT_LIMIT : "rate_limited")
      : typeof json.error === "string" ? json.error
      : GATEWAY_FAILURES.includes(res.status) ? "network" : "internal"
    throw new ApiError(code, res.status, retry, json)
  }
  return json as T
}

// An answer the page cannot draw, or holding what cannot be (a negative price, an unknown state), is no answer, as a body cut off is.
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
// BTCPay reports an overpaid invoice's due below zero, which the page reads as nothing left to pay
const isDue = (v: unknown) => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)
const optional = (v: unknown, test: (v: unknown) => boolean) => v === undefined || test(v)
const nullable = (v: unknown, test: (v: unknown) => boolean) => v === null || test(v)
// an image the page holds itself, as the service sends it: the page's CSP loads images from nowhere else
const isImage = (v: unknown) => v === null || (typeof v === "string" && v.startsWith("data:image/"))
const CHAT_KINDS: ChatKind[] = ["contact", "channel", "business", "bot"]
// a channel's record holds a channel; an address's, any other kind of chat
const isPreview = (e: unknown) => isObject(e) && (e.type === "address" || e.type === "channel") && CHAT_KINDS.includes(e.kind as ChatKind)
  && (e.type === "channel") === (e.kind === "channel") && isText(e.displayName)
  && isText(e.fullName) && isImage(e.image) && nullable(e.subscribers, isAmount) && PROFILE_STATES.includes(e.profile as Profile["profile"])
const isEntity = (e: unknown) => isPreview(e) && isText((e as Record<string, unknown>).link) && nullable((e as Record<string, unknown>).deepLink, isText)
const isChain = (a: Record<string, unknown>) => isText(a.resolver) && isText(a.sponsor) && typeof a.chainId === "number" && isText(a.tld)
const PHASES: Phase[] = ["unpaid", "queued", "committing", "committed", "registering", "registered", "taken", "failed"]
const isBalance = (v: unknown) => isObject(v) && isAmount(v.amount) && typeof v.held === "boolean" && nullable(v.heldUntil, isText) && isAmount(v.refunded)
const isSignedTerms = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._/-]{1,112}$/.test(v)
const isHash = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v)
const isTerms = (v: unknown, chainId: number) => isObject(v) && isHash(v.hash) && typeof v.link === "string" && termsLink(v.link, chainId) !== null && keccakOf(v.link) === v.hash
const isCommunity = (v: unknown) => v === null || (isObject(v) && nullable(v.for, (f) => typeof f === "string" && f !== "") && isCount(v.years))
const isAcceptance = (v: unknown) => isObject(v) && (v.kind === "general" || v.kind === "community") && isText(v.policy) && isHash(v.termsHash) && Number.isInteger(v.nonce) && (v.nonce as number) >= 0
const isRegistration = (v: unknown) => isObject(v) && isChain(v) && isText(v.id) && Number.isInteger(v.version) && PHASES.includes(v.phase as Phase) && isText(v.labelHash)
  && nullable(v.label, isText) && isText(v.owner) && isText(v.commitment) && isText(v.sealed) && isCount(v.years) && isCount(v.duration) && isAmount(v.price) && Number.isInteger(v.moves)
  && isAmount(v.fromBalance) && nullable(v.balance, isBalance) && nullable(v.latePayment, (l) => isObject(l) && LATE_WAITS.includes(l.waiting as LateWait))
  && nullable(v.commitTx, isText) && nullable(v.registerTx, isText) && nullable(v.revealAfter, isAmount) && nullable(v.revealBefore, isAmount)
  && nullable(v.intentNonce, isAmount) && nullable(v.acceptance, isAcceptance) && Array.isArray(v.unread) && v.unread.every(isText) && nullable(v.expiresAt, isAmount) && nullable(v.error, isText)
  && typeof v.linksRefused === "boolean" && isCommunity(v.community) && nullable(v.terms, isSignedTerms)
const isInvoice = (v: unknown) => isObject(v) && isText(v.invoiceId) && ["open", "paid", "expired"].includes(v.status as string) && isAmount(v.amount)
  && isText(v.currency) && isText(v.expiresAt) && isRegistration(v.registration) && optional(v.amountPaid, isAmount)
  && optional(v.cryptoAmountPaid, isDecimal) && optional(v.cryptoAmountDue, isDue) && optional(v.cryptoAmount, isDecimal)
  && optional(v.paidInFull, (x) => typeof x === "boolean") && optional(v.address, isText)
  && optional(v.cryptoCurrency, (x) => ["card", "btc", "xmr"].includes(x as string)) && optional(v.requiredConfirmations, (x) => Number.isInteger(x) && (x as number) >= 0)
const clampDue = (inv: InvoiceView): InvoiceView => inv.cryptoAmountDue?.startsWith("-") ? { ...inv, cryptoAmountDue: "0" } : inv
const checkedInvoice = (answer: Promise<unknown>) => checked<InvoiceView>(answer, isInvoice).then(clampDue)
const isRecords = (v: unknown) => isObject(v) && isText(v.contact) && isText(v.channel)
// none left only while an edit is counted, which returns at nextAt
const isRecordEdits = (v: unknown) => isObject(v) && Number.isInteger(v.left) && (v.left as number) >= 0 && nullable(v.nextAt, isAmount) && (v.left !== 0 || v.nextAt !== null)

export const searchName = (labelHash: string, length: number) => checked<SearchAnswer>(call("GET", `/api/name/${labelHash}?length=${length}`), (a) => isCommunity(a.community) && (
  a.status === "reserved"
  || (a.status === "available" && isAmount(a.price) && isCount(a.years) && isAmount(a.termStart) && isText(a.currency) && isChain(a) && nullable(a.terms, (t) => isTerms(t, a.chainId as number)))
  || (a.status === "registered" && isText(a.tld) && Array.isArray(a.entities) && a.entities.every(isEntity) && optional(a.owner, isText)
    && optional(a.resolver, isText) && optional(a.records, (r) => nullable(r, isRecords)) && optional(a.recordsNonce, (n) => nullable(n, isAmount)) && optional(a.recordEdits, (r) => nullable(r, isRecordEdits))
    && optional(a.expiresAt, isAmount) && optional(a.gracePeriod, isAmount) && optional(a.chainId, isAmount))))
export const previewLink = (link: string) => checked<Profile>(call("POST", "/api/link/preview", { link }), isPreview)

// The terms' text, which the service fetches by their link, only when it is the file the link names: the page shows the very
// text whose acceptance the owner signs.
export async function termsText(terms: Terms, chainId: number, signal?: AbortSignal): Promise<string> {
  const read = await call<Record<string, unknown>>("GET", `/api/terms/${terms.hash}`, undefined, signal)
  const digest = termsLink(terms.link, chainId)?.digest
  if (read.link !== terms.link || keccakOf(terms.link) !== terms.hash || typeof read.text !== "string" || bytesToHex(sha256(utf8ToBytes(read.text))) !== digest) throw noAnswer()
  return read.text
}
const CODE_STATES = ["unused", "used", "reserved", "expired", "unpaid", "revoked"] as const
export type CodeState = typeof CODE_STATES[number]
interface CodeAnswer { minLength: number; years: number; state: CodeState }
export async function checkCode(code: string, signal?: AbortSignal): Promise<CodeAnswer> {
  const answer: unknown = await call("POST", "/api/code/check", { code }, signal)
  const drawable = isObject(answer) && isCount(answer.minLength) && (answer.minLength as number) <= MAX_LABEL_LENGTH && isCount(answer.years)
    && CODE_STATES.includes(answer.state as CodeState)
  if (!drawable) throw noAnswer()
  return answer as unknown as CodeAnswer
}

const signingTerms = (sent: Promise<unknown>, chainId: number) => sent.catch((e: unknown) => {
  if (!(e instanceof ApiError && e.code === "terms_changed")) throw e
  if (!isTerms(e.body.terms, chainId) || !isCommunity(e.body.community)) throw noAnswer()
  throw new TermsChanged(e, e.body.terms as Terms, e.body.community as Community | null)
})

export const createOrder = (order: SignedOrder, method: Method, price: number, chainId: number) =>
  checkedInvoice(signingTerms(call("POST", "/api/invoice", { kind: "name", ...order, method, price }), chainId))
export const registerWithCode = (order: SignedOrder, code: string, chainId: number) =>
  checked<{ registrationId: string }>(signingTerms(call("POST", "/api/name/register", { ...order, code }), chainId), (a) => isText(a.registrationId))
export const cancelInvoice = (invoiceId: string) => checkedInvoice(call("POST", `/api/invoice/${encodeURIComponent(invoiceId)}/cancel`))

// what a long poll on an invoice has seen: its status, its registration's version, and the payment marks, the paid amount
// and paidInFull, as Monero can report a full payment with no amount yet
interface SeenInvoice { status: string; version: number; paid: string; full: boolean }
export const seenOf = (inv: InvoiceView): SeenInvoice => ({ status: inv.status, version: inv.registration.version, paid: inv.cryptoAmountPaid ?? "", full: inv.paidInFull === true })

export function readInvoice(invoiceId: string, seen?: SeenInvoice, signal?: AbortSignal): Promise<InvoiceView> {
  const query = seen ? `?wait=${seen.status}&seenVersion=${seen.version}&seenPaid=${encodeURIComponent(seen.paid)}&seenFull=${seen.full ? "1" : "0"}` : ""
  return checkedInvoice(call("GET", `/api/invoice/${encodeURIComponent(invoiceId)}${query}`, undefined, signal, seen ? null : REQUEST_TIMEOUT_MS))
}

export function readRegistration(registrationId: string, seenVersion?: number, signal?: AbortSignal): Promise<RegistrationView> {
  const held = seenVersion !== undefined
  return checked<RegistrationView>(call("GET", `/api/registration/${encodeURIComponent(registrationId)}${held ? `?seenVersion=${seenVersion}` : ""}`, undefined, signal, held ? null : REQUEST_TIMEOUT_MS), isRegistration)
}

export const changedView = (e: ApiError): RegistrationView | null => isRegistration(e.body.registration) ? e.body.registration as RegistrationView : null

export const reveal = (registrationId: string, body: { label: string; secret: string; records: { contact: string[]; channel: string[] }; nonce: number; deadline: number; signature: string;
  acceptance?: { termsHash: string; nonce: number; signature: string } }) =>
  call<Record<string, never>>("POST", `/api/registration/${encodeURIComponent(registrationId)}/reveal`, body)
export const retarget = (registrationId: string, body: Omit<SignedOrder, "owner">, chainId: number) =>
  checked<RegistrationView>(signingTerms(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/name`, body), chainId), isRegistration)
// another name paid from an order's balance: the balance the page read, and a method for the difference when it does not cover the price
export type SpendRequest = Omit<SignedOrder, "owner"> & { price: number; balance: number; method?: Method }

// The new order, without an invoice when the balance covered it, or with the invoice for the difference.
export async function spend(registrationId: string, body: SpendRequest, chainId: number): Promise<{ registrationId: string } | InvoiceView> {
  const sent = signingTerms(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/spend`, body), chainId).catch((e: unknown) => {
    if (!(e instanceof ApiError && e.code === "balance_changed")) throw e
    if (!nullable(e.body.balance, isBalance)) throw noAnswer()
    throw new BalanceChanged(e, e.body.balance as Balance | null)
  })
  const made = await checked<{ registrationId: string } | InvoiceView>(sent, (a) => isInvoice(a) || (isText(a.registrationId) && a.invoiceId === undefined))
  return "invoiceId" in made ? clampDue(made) : made
}
export const retry = (registrationId: string) => checked<RegistrationView>(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/retry`), isRegistration)
const isFound = (r: unknown) => isObject(r) && isText(r.registrationId) && nullable(r.invoiceId, isText) && PHASES.includes(r.phase as Phase) && isText(r.createdAt)
  && isText(r.labelHash) && isText(r.sealed) && nullable(r.balanceSource, isText) && nullable(r.heldBy, isText)
// `balanceSource`: the order whose balance paid this one; `heldBy`: the order whose invoice holds this one's balance
export interface FoundOrder {
  registrationId: string; invoiceId: string | null; phase: Phase; createdAt: string; labelHash: string; sealed: string; balanceSource: string | null; heldBy: string | null
}
export const findRegistrations = (owner: string, timestamp: number, signature: string) =>
  checked<{ registrations: FoundOrder[] }>(
    call("POST", "/api/registration/find", { owner, timestamp, signature }), (a) => Array.isArray(a.registrations) && a.registrations.every(isFound))
export interface SignedEdit { key: string; value: string; nonce: number; deadline: number; signature: string }
export const editRecords = (body: { labelHash: string; edits: SignedEdit[] }) => {
  const sent = call("POST", "/api/name/records", body, undefined, EDIT_TIMEOUT_MS).catch((e: unknown) => {
    if (!(e instanceof ApiError && e.code === EDIT_LIMIT)) throw e
    if (!isAmount(e.body.nextAt)) throw noAnswer()
    throw new EditLimited(e, e.body.nextAt as number)
  })
  return checked<{ tx: string | null }>(sent, (a) => nullable(a.tx, isText))
}
