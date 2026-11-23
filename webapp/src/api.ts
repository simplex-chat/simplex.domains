// The names service's HTTP API, on the page's own origin.
import { sha256 } from "@noble/hashes/sha2"
import { keccak_256 } from "@noble/hashes/sha3"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
import { MAX_LABEL_LENGTH } from "./names.ts"

const REFUSALS = [
  "bad_request", "invalid_name", "invalid_link", "not_found", "method_not_allowed", "internal", "rate_limited", "provider_unavailable", "terms_unavailable",
  "name_check_unavailable", "code_invalid", "code_used", "code_reserved", "code_expired", "code_not_covering", "payment_pending", "codes_only", "order_exists",
  "name_taken", "catalog_changed", "terms_changed", "registration_changed", "not_open", "funded",
  "stale_nonce", "record_reverted", "edit_pending", "edit_limit",
] as const
type Refusal = typeof REFUSALS[number]
export type ErrorCode = Refusal | "network"

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly retryAfter: number | null
  readonly body: Record<string, unknown>
  constructor(code: ErrorCode, status: number, retryAfter: number | null, body: Record<string, unknown>) {
    super(code)
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
    this.body = body
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

export type Phase = "unpaid" | "closed" | "queued" | "committing" | "committed" | "registering" | "registered" | "ended" | "taken" | "failed"
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

// A community name: what it is for, absent when the service has no words for it, and the years it is registered for. In a
// search answer, a name on the chain's list; in an order's view, an order that signed the community terms.
export interface Community {
  for?: string
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
const TERMS_LINK = /^(?:https:\/\/(?:git\.simplex\.chat\/simplex-chat\/simplex-chat\/raw\/commit|raw\.githubusercontent\.com\/simplex-chat\/simplex-chat)\/([0-9a-f]{40})|http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4}))\/([A-Za-z0-9_./-]+)#sha256=([0-9a-f]{64})$/
const FORGEJO_RAW = "https://git.simplex.chat/simplex-chat/simplex-chat/raw/commit/"
const FORGEJO_PAGE = "https://git.simplex.chat/simplex-chat/simplex-chat/src/commit/"
const GITHUB_RAW = "https://raw.githubusercontent.com/simplex-chat/simplex-chat/"
const GITHUB_PAGE = "https://github.com/simplex-chat/simplex-chat/blob/"

export function termsLink(link: string, chainId: number): { commit: string | null; digest: string } | null {
  const [, commit, port, path, digest] = TERMS_LINK.exec(link) ?? []
  if (path === undefined || !path.endsWith(".md") || path === ".md" || path.split("/").some((s) => s === "" || s === "." || s === "..")) return null
  if (commit === undefined && (chainId !== LOCAL_CHAIN_ID || Number(port) > MAX_PORT)) return null
  return { commit: commit ?? null, digest }
}

export function readerUrl(link: string): string {
  const file = link.slice(0, link.indexOf("#"))
  if (file.startsWith(FORGEJO_RAW)) return FORGEJO_PAGE + file.slice(FORGEJO_RAW.length)
  if (file.startsWith(GITHUB_RAW)) return GITHUB_PAGE + file.slice(GITHUB_RAW.length)
  return file
}

const keccakOf = (text: string) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`

// the link edits a name has left in any 365 days, and when the next one returns: null while none is counted
export interface RecordEdits {
  left: number
  nextAt: number | null
}

export type ResolverRecords = ({ type: "own"; nonce: number; edits: RecordEdits } & Links) | { type: "other" }
export type Found =
  | { type: "available"; price: number; years: number; terms: Terms | null }
  | { type: "taken" }
  | { type: "reserved" }
  | { type: "registered"; owner: string; resolver: string; expiresAt: number; gracePeriod: number; entities: Entity[]; records: ResolverRecords }
export interface SearchAnswer { found: Found; community: Community | null }

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
// the link as the chat core writes it, and its simplex:/ form, which the app opens
export interface Entity extends Profile {
  link: string
  deepLink: string
}

interface LinkProfile { kind: ChatKind; displayName: string; fullName: string; image?: string; subscribers?: number }
export interface Preview { kind: typeof LINK_KINDS[number]; profile: { type: "ok"; linkProfile: LinkProfile } | { type: "unread" | "unavailable" } }
type LinkEntity = { preview: Preview; link: string; deepLink: string }

function profileOf({ kind, profile: read }: Preview): Profile {
  const type = kind === "channel" ? "channel" : "address"
  if (read.type !== "ok") return { type, kind, displayName: "", fullName: "", image: null, subscribers: null, profile: read.type }
  const { kind: chat, displayName, fullName, image, subscribers } = read.linkProfile
  return { type, kind: chat, displayName, fullName, image: image ?? null, subscribers: subscribers ?? null, profile: "ok" }
}
const entityOf = (e: LinkEntity): Entity => ({ ...profileOf(e.preview), link: e.link, deepLink: e.deepLink })

// An order's balance, in cents: what is left, and what support has refunded from it
export interface Balance {
  amount: number
  refunded: number
}

// How the order was paid: by an invoice or by a code
export type Payment =
  | { type: "invoice"; method: Method }
  | { type: "code" }

// what the owner signs with the reveal to accept the terms of the name's kind on chain, the policy being the signature's verifying contract
export interface Acceptance { community: boolean; policy: string; termsHash: string; nonce: number }

// the chain reads the owner signs with, unread when the service could not read them; reading the view again may read them
export type ToSign = { type: "unread" } | { type: "read"; intentNonce: number; acceptance: Acceptance }

export type Signing = { type: "awaiting"; toSign: ToSign } | { type: "signed" } | { type: "lapsed" }

export type PhaseView =
  | { type: "unpaid" }
  | { type: "closed"; closedBy: "expired" | "cancelled" | "reversed" }
  | { type: "queued" }
  | { type: "committing" }
  | { type: "committed"; revealAfter: number; revealBefore: number; signature: Signing }
  | { type: "registering" }
  | { type: "registered"; expiresAt: number; disputeUntil?: number }
  | { type: "ended" }
  | { type: "taken" }
  | { type: "failed"; reason: FailReason; heldUntil?: string }

export interface AgreedTerms { communityName: boolean; termsHash: string }

export interface RegistrationView {
  id: string
  // counts the service's changes to the registration, which a long poll holds on
  version: number
  phase: PhaseView
  labelHash: string
  label: string | null
  owner: string
  commitment: string
  sealed: string
  years: number
  // the term in seconds the commitment holds: the paid years and the free days until the term starts
  duration: number
  // what the order is worth, in cents: what was paid, and the price of a name selected for it after a take
  price: number
  payment: Payment
  balance: Balance | null
  // what money paid after the invoice closed waits on before it is all in the balance: being confirmed, being credited, or support
  latePayment: LateWait | null
  commitTx: string | null
  registerTx: string | null
  disputeDays: number
  community: Community | null
  terms: AgreedTerms
}

export const FAIL_REASONS = ["registryRefused", "signatureRefused", "monthEnded", "unread"] as const
export type FailReason = (typeof FAIL_REASONS)[number]

export const committedOf = (view: RegistrationView) => view.phase.type === "committed" ? view.phase : null
export const toSignOf = (view: RegistrationView): ToSign | null => {
  const committed = committedOf(view)
  return committed?.signature.type === "awaiting" ? committed.signature.toSign : null
}
export const lapsedOf = (view: RegistrationView) => committedOf(view)?.signature.type === "lapsed"
export const expiresAtOf = (view: RegistrationView) => view.phase.type === "registered" ? view.phase.expiresAt : null
export const disputeUntilOf = (view: RegistrationView) => view.phase.type === "registered" ? view.phase.disputeUntil ?? null : null
export const signedTermsOf = (terms: AgreedTerms) => `${terms.communityName ? COMMUNITY_TERMS : ""}${terms.termsHash.slice(2)}`

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

export const reversedOrder = ({ phase }: RegistrationView) => phase.type === "closed" && phase.closedBy === "reversed"

export const takenByOrder = ({ phase, commitTx }: RegistrationView) => phase.type === "taken" && commitTx === null

export const paymentKept = ({ balance, price }: RegistrationView) => balance !== null && balance.amount >= price

export const selectable = (view: RegistrationView) => view.phase.type === "taken" && (view.payment.type === "code" || paymentKept(view))

export const holdsPayment = (inv: InvoiceView) => Boolean(inv.amountPaid) || Number(inv.cryptoAmountPaid ?? "0") > 0 || inv.paidInFull === true

// All of a closed invoice's amount arrived after it closed and is credited, or waits on support alone. BTCPay keeps such an
// invoice expired (invalid after a cancel) and says paidInFull; a provider that settles it late reads paid.
export function paidLate(inv: InvoiceView): boolean {
  const waiting = inv.registration.latePayment
  return (inv.status === "paid" || (inv.status === "expired" && inv.paidInFull === true)) && (waiting === null || waiting === "support")
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
export interface RevealBody {
  label: string
  secret: string
  records: { contact: string | null; channel: string | null }
  nonce: number
  deadline: number
  signature: string
  acceptance: { termsHash: string; nonce: number; signature: string }
}
// an order as sent, signed by its owner at a time the service checks
export type SignedOrder = OrderRequest & { timestamp: number; signature: string; reveal: RevealBody }

interface OrderFields { labelHash: string; length: number; duration: number; commitment: string; sealed: string; terms: AgreedTerms }
interface SignedFields { fields: OrderFields; timestamp: number; signature: string }

const agreedTerms = (terms: string): AgreedTerms => ({ communityName: terms.startsWith(COMMUNITY_TERMS), termsHash: signedHash(terms)! })
export const signedFields = (o: Omit<SignedOrder, "owner" | "reveal">): SignedFields => ({
  fields: { labelHash: o.labelHash, length: o.length, duration: o.duration, commitment: o.commitment, sealed: o.sealed, terms: agreedTerms(o.terms) },
  timestamp: o.timestamp, signature: o.signature,
})
export const orderOf = (o: SignedOrder): SignedFields & { owner: string } => ({ owner: o.owner, ...signedFields(o) })

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
// The service's times are read against its clock, which each answer's Date header gives to the second; a device off by less than this is taken as right.
const CLOCK_SLACK_MS = 2000
let clockOffsetMs = 0
// counts changes of the offset, so a request signed before one can be signed again
let clockChanges = 0
export const serviceNow = () => Date.now() + clockOffsetMs
export const serviceSeconds = () => Math.floor(serviceNow() / 1000)
export const clockVersion = () => clockChanges
// requests that change something, on their way: a page loaded again meanwhile would never hear their answers
let changing = 0
export const changeOnItsWay = () => changing > 0

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
  // one controller for the caller's signal and the time limit, without AbortSignal.any, which older browsers lack
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal?.addEventListener("abort", onAbort)
  if (signal?.aborted) stop.abort()
  const timer = timeoutMs === null ? undefined : setTimeout(onAbort, timeoutMs)
  const changes = method !== "GET"
  if (changes) changing++
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
    if (changes) changing--
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
      : REFUSALS.includes(json.type as Refusal) ? json.type as Refusal
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
const isImage = (v: unknown) => typeof v === "string" && (v === "" || v.startsWith("data:image/"))
const CHAT_KINDS: ChatKind[] = ["contact", "channel", "business", "bot"]
const isLinkProfile = (p: unknown) => isObject(p) && CHAT_KINDS.includes(p.kind as ChatKind) && isText(p.displayName) && isText(p.fullName) && optional(p.image, isImage)
  && optional(p.subscribers, isAmount)
const isPreview = (p: unknown) => isObject(p) && LINK_KINDS.includes(p.kind as Preview["kind"]) && isObject(p.profile)
  && (p.profile.type === "ok" ? isLinkProfile(p.profile.linkProfile) : PROFILE_STATES.includes(p.profile.type as Profile["profile"]))
const isEntity = (e: unknown) => isObject(e) && isPreview(e.preview) && isText(e.link) && isText(e.deepLink)
const PHASES: Phase[] = ["unpaid", "closed", "queued", "committing", "committed", "registering", "registered", "ended", "taken", "failed"]
const METHODS: Method[] = ["card", "btc", "xmr"]
const isBalance = (v: unknown) => isObject(v) && isAmount(v.amount) && isAmount(v.refunded)
const isPayment = (v: unknown) => isObject(v) && ((v.type === "invoice" && METHODS.includes(v.method as Method)) || v.type === "code")
const isHash = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v)
const isAgreedTerms = (v: unknown) => isObject(v) && typeof v.communityName === "boolean" && isHash(v.termsHash)
const isTerms = (v: unknown, chainId: number) => isObject(v) && isHash(v.hash) && typeof v.link === "string" && termsLink(v.link, chainId) !== null && keccakOf(v.link) === v.hash
const isCommunity = (v: unknown) => v === null || (isObject(v) && optional(v.for, (f) => typeof f === "string" && f !== "") && isCount(v.years))
const isAcceptance = (v: unknown) => isObject(v) && typeof v.community === "boolean" && isText(v.policy) && isHash(v.termsHash) && Number.isInteger(v.nonce) && (v.nonce as number) >= 0
const MIN_DISPUTE_DAYS = 14
const MAX_DISPUTE_DAYS = 120
export const DISPUTE_DAYS: Record<Method | "code", number> = { card: 120, btc: 14, xmr: 14, code: 14 }
const isDisputeDays = (v: unknown) => Number.isInteger(v) && (v as number) >= MIN_DISPUTE_DAYS && (v as number) <= MAX_DISPUTE_DAYS
const isToSign = (v: unknown) => isObject(v) && (v.type === "unread" || (v.type === "read" && isAmount(v.intentNonce) && isAcceptance(v.acceptance)))
const isSigning = (v: unknown) => isObject(v) && ((v.type === "awaiting" && isToSign(v.toSign)) || v.type === "signed" || v.type === "lapsed")
const isPhase = (v: unknown) => isObject(v) && PHASES.includes(v.type as Phase) && (v.type !== "closed" || v.closedBy === "expired" || v.closedBy === "cancelled" || v.closedBy === "reversed")
  && (v.type !== "committed" || (isAmount(v.revealAfter) && isAmount(v.revealBefore) && isSigning(v.signature)))
  && (v.type !== "registered" || (isAmount(v.expiresAt) && optional(v.disputeUntil, isAmount))) && (v.type !== "failed" || (FAIL_REASONS.includes(v.reason as FailReason) && optional(v.heldUntil, isTime)))
const isRegistration = (v: unknown) => isObject(v) && isText(v.id) && Number.isInteger(v.version) && isPhase(v.phase) && isText(v.labelHash)
  && nullable(v.label, isText) && isText(v.owner) && isText(v.commitment) && isText(v.sealed) && isCount(v.years) && isCount(v.duration) && isAmount(v.price)
  && isPayment(v.payment) && nullable(v.balance, isBalance) && nullable(v.latePayment, (l) => LATE_WAITS.includes(l as LateWait))
  && nullable(v.commitTx, isText) && nullable(v.registerTx, isText) && isDisputeDays(v.disputeDays) && isCommunity(v.community) && isAgreedTerms(v.terms)
const isInvoice = (v: unknown) => isObject(v) && isText(v.invoiceId) && ["open", "paid", "expired"].includes(v.status as string) && isAmount(v.amount)
  && isText(v.currency) && isText(v.expiresAt) && isRegistration(v.registration) && optional(v.amountPaid, isAmount)
  && optional(v.cryptoAmountPaid, isDecimal) && optional(v.cryptoAmountDue, isDue) && optional(v.cryptoAmount, isDecimal)
  && optional(v.paidInFull, (x) => typeof x === "boolean") && optional(v.address, isText)
  && optional(v.cryptoCurrency, (x) => ["card", "btc", "xmr"].includes(x as string)) && optional(v.requiredConfirmations, (x) => Number.isInteger(x) && (x as number) >= 0)
const clampDue = (inv: InvoiceView): InvoiceView => inv.cryptoAmountDue?.startsWith("-") ? { ...inv, cryptoAmountDue: "0" } : inv
const checkedInvoice = (answer: Promise<unknown>) => checked<InvoiceView>(answer, isInvoice).then(clampDue)
const isTime = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v))
// none left only while an edit is counted, which returns at nextAt
const isRecordEdits = (v: unknown) => isObject(v) && Number.isInteger(v.left) && (v.left as number) >= 0 && optional(v.nextAt, isTime) && (v.left !== 0 || v.nextAt !== undefined)
const isResolverRecords = (v: unknown) => isObject(v) && (v.type === "other" || (v.type === "own" && isText(v.contact) && isText(v.channel) && isAmount(v.nonce) && isRecordEdits(v.edits)))
const isNameFound = (v: unknown, chainId: number) => isObject(v) && (v.type === "reserved" || v.type === "taken"
  || (v.type === "available" && isAmount(v.price) && isCount(v.years) && optional(v.terms, (t) => isTerms(t, chainId)))
  || (v.type === "registered" && isText(v.owner) && isText(v.resolver) && isAmount(v.expiresAt) && isAmount(v.gracePeriod) && Array.isArray(v.entities) && v.entities.every(isEntity)
    && isResolverRecords(v.records)))

type WireRecords = ({ type: "own"; nonce: number; edits: { left: number; nextAt?: string } } & Links) | { type: "other" }
type WireFound = Extract<Found, { type: "registering" | "reserved" }> | { type: "available"; price: number; years: number; terms?: Terms }
  | (Omit<Extract<Found, { type: "registered" }>, "entities" | "records"> & { entities: LinkEntity[]; records: WireRecords })

function foundOf(f: WireFound): Found {
  switch (f.type) {
    case "available": return { type: "available", price: f.price, years: f.years, terms: f.terms ?? null }
    case "registered": {
      const records: ResolverRecords = f.records.type === "own"
        ? { ...f.records, edits: { left: f.records.edits.left, nextAt: f.records.edits.nextAt === undefined ? null : Date.parse(f.records.edits.nextAt) / 1000 } }
        : f.records
      return { ...f, entities: f.entities.map(entityOf), records }
    }
    default: return f
  }
}

export const searchName = (labelHash: string, length: number, chainId: number) =>
  checked<{ found: WireFound; community?: Community }>(call("GET", `/api/name/${labelHash}?length=${length}`), (a) => optional(a.community, isCommunity) && isNameFound(a.found, chainId))
    .then((a): SearchAnswer => ({ found: foundOf(a.found), community: a.community ?? null }))
export const previewLink = (link: string) => checked<Preview>(call("POST", "/api/link/preview", { link }), isPreview).then(profileOf)

// The terms' text, which the service fetches by their link, only when it is the file the link names: the page shows the very
// text whose acceptance the owner signs.
export async function termsText(terms: Terms, chainId: number, signal?: AbortSignal): Promise<string> {
  const read = await call<Record<string, unknown>>("GET", `/api/terms/${terms.hash}`, undefined, signal)
  const digest = termsLink(terms.link, chainId)?.digest
  if (read.link !== terms.link || keccakOf(terms.link) !== terms.hash || typeof read.text !== "string" || bytesToHex(sha256(utf8ToBytes(read.text))) !== digest) throw noAnswer()
  return read.text
}

export async function currentTermsOf(hash: string, chainId: number): Promise<Terms> {
  const read = await call<Record<string, unknown>>("GET", `/api/terms/${hash}`)
  const terms = { hash, link: read.link }
  if (!isTerms(terms, chainId)) throw noAnswer()
  return terms as Terms
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
  checkedInvoice(signingTerms(call("POST", "/api/invoice", { kind: "name", order: orderOf(order), method, price, reveal: order.reveal }), chainId))
export const registerWithCode = (order: SignedOrder, code: string, chainId: number) =>
  checked<{ registrationId: string }>(signingTerms(call("POST", "/api/name/register", { order: orderOf(order), code, reveal: order.reveal }), chainId), (a) => isText(a.registrationId))

export type ToSignRead = Extract<ToSign, { type: "read" }>
export const signFor = (labelHash: string, owner: string) =>
  checked<ToSignRead>(call("GET", `/api/name/${labelHash}/sign?owner=${owner}`), (a) => a.type === "read" && isToSign(a))
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

export const reveal = (registrationId: string, body: RevealBody) =>
  call<Record<string, never>>("POST", `/api/registration/${encodeURIComponent(registrationId)}/reveal`, body)
export const selectName = (registrationId: string, body: Omit<SignedOrder, "owner">, chainId: number) =>
  checked<RegistrationView>(signingTerms(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/name`, { ...signedFields(body), reveal: body.reveal }), chainId), isRegistration)
export const retry = (registrationId: string) => checked<RegistrationView>(call("POST", `/api/registration/${encodeURIComponent(registrationId)}/retry`), isRegistration)
const isFound = (r: unknown) => isObject(r) && isText(r.registrationId) && nullable(r.invoiceId, isText) && PHASES.includes(r.phase as Phase) && isText(r.createdAt)
  && isText(r.labelHash) && isText(r.sealed)
export interface FoundOrder {
  registrationId: string; invoiceId: string | null; phase: Phase; createdAt: string; labelHash: string; sealed: string
}
export const findRegistrations = (owner: string, timestamp: number, signature: string) =>
  checked<{ registrations: FoundOrder[] }>(
    call("POST", "/api/registration/find", { owner, timestamp, signature }), (a) => Array.isArray(a.registrations) && a.registrations.every(isFound))
export interface SignedEdit { key: typeof LINK_KINDS[number]; value: string; nonce: number; deadline: number; signature: string }
export const editRecords = (body: { labelHash: string; edits: SignedEdit[] }) => {
  const sent = call("POST", "/api/name/records", body, undefined, EDIT_TIMEOUT_MS).catch((e: unknown) => {
    if (!(e instanceof ApiError && e.code === "edit_limit")) throw e
    if (!isTime(e.body.nextAt)) throw noAnswer()
    throw new EditLimited(e, Date.parse(e.body.nextAt as string) / 1000)
  })
  return checked<{ tx: string | null }>(sent, (a) => nullable(a.tx, isText))
}
