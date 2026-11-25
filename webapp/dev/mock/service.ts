// A stand-in for StoreService's names API, driving the real contracts on the local chain.
// A development fixture: memory only, no money, and not a specification of the real service.
import { createHash } from "node:crypto"
import {
  encodeFunctionData, getAddress, hashTypedData, isAddress, keccak256, namehash, recoverAddress, recoverMessageAddress, recoverTypedDataAddress, toHex,
  zeroHash, type Address, type Hex,
} from "viem"
import { communityAgreed, type FailReason, type Preview, signedHash, termsLink } from "../../src/api.ts"
import { codeHash, parseNameCode } from "../../src/crypto/code.ts"
import { CHANNEL_KEY, CONTACT_KEY, durationFor, YEAR_S } from "../../src/crypto/registration.ts"
import { CODES_ONLY } from "../../src/mode.ts"
import { labelProblem, LINK_MAX_BYTES, linkKind, type LinkKind, linkProblem, MAX_LABEL_LENGTH, MIN_LABEL_LENGTH } from "../../src/names.ts"
import {
  baseRegistrar, chainNow, contractsOwner, controller, deployment, holder, mined, moveChainTo, namePolicy, NotSent, ownerOf, read, registry, resolver, Reverted, send, sponsor,
} from "./chain.ts"
import { TERM_START_S, untilChainTime } from "../chain-time.ts"
import { registerNameTypedData } from "../register-name.ts"
import { savedTerms } from "../serve-terms.ts"
import { addressFor } from "./addresses.ts"
import { setClock } from "./clock.ts"
import { coreLink, deepLinkOf } from "./links.ts"
import { randomBytes, seedRandom } from "./random.ts"

const YEARS = 2
const COMMUNITY_YEARS = 2
// SimplexPriceOracle's attoUSD to the cent
const ATTO_PER_CENT = 10n ** 16n
// how far an order's free days may be from the service's own count: the page's clock is set from the service's Date header
const TERM_SLACK_S = 3600
// rates for the crypto amounts, in dollars
const RATES = { btc: 64000, xmr: 160 }
const CENTS_PER_DOLLAR = 100n
// a coin's atomic units: satoshi and piconero
const UNIT_DECIMALS = { btc: 8, xmr: 12 }
const INVOICE_MINUTES = 60

function wholeEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, not "${raw}"`)
  return Number(raw)
}

// how long a long poll holds before answering unchanged
const HOLD_MS = 20_000
const SIGNED_REQUEST_SECONDS = 600
const SIGNATURE_SECONDS = 7 * 86400
// find lists an owner's newest orders, at most this many
const FOUND_MAX = 50
// how long a register with no answer is followed on chain before it counts as failed: 12 × 5 s
const PENDING_CHECKS = 12
const PENDING_CHECK_MS = 5000
// a registered name's expiry is read a few times, inside a request the page waits 60 s for
const EXPIRY_READS = 3
const EXPIRY_READ_MS = 1000
const RESEND_MS = wholeEnv("MOCK_RESEND_MS", 5000)
const RESENDS = wholeEnv("MOCK_RESENDS", 12)
const SEALED_MAX = 11095
// the terms an order signs: the hash of the terms of the name's kind, after COMMUNITY_TERMS for a community name, or the
// version an older page signed, with /community/ and the community terms' hash after it for a community name
const SIGNED_TERMS = /^[A-Za-z0-9._/-]{1,112}$/
const COMMUNITY_TERMS = "community/"
const TERMS_FETCH_MS = 10_000
const TERMS_WAIT_S = 30
// the reverts of a relay or a register after which the page signs again, as the service judges them
const SIGN_AGAIN = ["InvalidNonce", "TermsNotAccepted", "TermsMismatch"]
// a community name's text in the service's ini: one line of up to this many characters
const COMMUNITY_TEXT_MAX = 200
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

export type Phase = "unpaid" | "queued" | "committing" | "committed" | "registering" | "registered" | "ended" | "taken" | "failed"
type Method = "card" | "btc" | "xmr"
type Coin = Exclude<Method, "card">
const isMethod = (v: unknown): v is Method => v === "card" || v === "btc" || v === "xmr"

interface Registration {
  id: string
  invoiceId: string | null
  labelHash: Hex
  length: number
  duration: number
  owner: Address
  commitment: Hex
  sealed: string
  years: number
  paid: number
  method: Method | "code"
  // the hash of the prepaid code that pays for it
  prepaidCode: string | null
  phase: Phase
  // counts every change to what the view shows; long polls hold on it, and every write is conditional on it
  version: number
  label: string | null
  secret: Hex | null
  records: RevealLinks | null
  intent: { nonce: bigint; deadline: bigint; signature: Hex } | null
  // the owner's signed acceptance of the terms of the name's kind, relayed before the register
  acceptance: { community: boolean; termsHash: Hex; nonce: bigint; signature: Hex } | null
  commitTx: Hex | null
  registerTx: Hex | null
  revealAfter: number | null
  revealBefore: number | null
  expiresAt: number | null
  error: FailReason | null
  createdAt: string
  failNext: boolean
  staleNext: boolean
  // what an exact resend of the order that made it must repeat: its fields, never its timestamp or signature
  orderHash: string
  // tries of a transaction that did not go out, since the last that did
  resends: number
  // the terms the order signed when it was made or its name last selected
  terms: string
  paidAt: number | null
  takenAt: number | null
  disputeDays: number
  disputeUntil: number | null
}

interface Invoice {
  id: string
  registrationId: string
  method: Method
  status: "open" | "paid" | "expired"
  amount: number
  expiresAt: string
  cryptoAmount: string | null
  amountPaid: number | null
  cryptoAmountPaid: string | null
  cryptoAmountDue: string | null
  paidInFull: boolean | null
  // all the money read on it is confirmed, which a settle makes so
  confirmed: boolean
  settledAt: string | null
  clientSecret: string | null
  // the confirmed money counted already, in coin units (cents for a card): the price when it settled in time, and each credit
  // to the order's balance since; and the cents credited
  lateUnits: bigint
  lateCents: number
  // what a credit of confirmed late money waits on, set by the tests: the service's next pass, or support
  lateWait: "crediting" | "support" | null
  closedBy: "expired" | "cancelled" | null
}

// An order's balance, in cents.
interface Balance {
  amount: number
  credited: number
  refunded: number
}

interface PrepaidCode {
  minLength: number
  years: number
  state: "unused" | "reserved" | "used" | "revoked" | "expired" | "unpaid"
  registrationId: string | null
}

const registrations = new Map<string, Registration>()
const invoices = new Map<string, Invoice>()
const codes = new Map<string, PrepaidCode>()
// by the order each belongs to
const balances = new Map<string, Balance>()
const waiters = new Map<string, Set<() => void>>()
// labels the control endpoint is registering to someone else, which a registration waits for
const taking = new Map<string, Promise<void>>()
// the next createInvoice answers with this error once, to show the checkout's refusals;
// find has a rate limit of its own
// until unsentUntil, no transaction goes out, as a chain that fails before the send; until unreadUntil, the view's own chain
// reads fail; each write to a registration waits writeDelayMs before its check, so a test can race two
// a fetch of a link in fetchDelays takes that many milliseconds;
// a late payment is credited at the lower of its invoice's rate and the coin's current rate in cents, when one is set;
// in codes mode, as the service's [names] codes_only, names are registered only with prepaid codes
const control: { mode: "open" | "codes"; downtime: boolean; chainDown: boolean; limitedUntil: number; invoiceError: string | null; findLimitedUntil: number; unsentUntil: number; unreadUntil: number; writeDelayMs: number; fetchDelays: Record<string, number>; rates: Record<Coin, bigint | null> } =
  { mode: "open", downtime: false, chainDown: false, limitedUntil: 0, invoiceError: null, findLimitedUntil: 0, unsentUntil: 0, unreadUntil: 0, writeDelayMs: 0, fetchDelays: {}, rates: { btc: null, xmr: null } }

const sendTx: typeof send = (...args) => Date.now() < control.unsentUntil ? Promise.reject(new NotSent()) : send(...args)

const mismatch: { price: number | null; policy: boolean; termsHash: boolean } = { price: null, policy: false, termsHash: false }
const OTHER_TERMS_HASH = keccak256(toHex("other terms"))

const INVOICE_ERRORS: Record<string, number> = { provider_unavailable: 503, rate_limited: 429, catalog_changed: 409, internal: 500 }
const RETRY_AFTER_SECONDS = wholeEnv("MOCK_RETRY_AFTER_SECONDS", 30)

export class HttpError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly retryAfter: number | null
  constructor(status: number, error: string, extra: Record<string, unknown> = {}, retryAfter: number | null = null) {
    super(error)
    this.status = status
    this.body = { type: error, ...extra }
    this.retryAfter = retryAfter
  }
}

const badRequest = (extra: Record<string, unknown> = {}) => new HttpError(400, "bad_request", extra)
const id = () => randomBytes(16).toString("base64url")
const nowSeconds = () => Math.floor(Date.now() / 1000)
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z")
const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The oracle prices by length only, so a label of as many letters "a" quotes every label of that length, and the label
// itself never reaches the node. A failed read throws.
async function priceOf(length: number, years: number): Promise<number> {
  const quote = await read<{ base: bigint }>(controller, "rentPriceUSD", ["a".repeat(length), BigInt(years * YEAR_S)])
  return Number(quote.base / ATTO_PER_CENT)
}

// --- long poll

function publish(...keys: (string | null)[]): void {
  for (const key of keys) {
    if (key === null) continue
    const set = waiters.get(key)
    waiters.delete(key)
    set?.forEach((wake) => wake())
  }
}

// the registration changed; an invoice changing alone only wakes its polls
function changed(reg: Registration): void {
  reg.version += 1
  wake(reg)
}

const wake = (reg: Registration) => publish(reg.id, reg.invoiceId)

// A write to a registration is a compare-and-set on the version its request read: one that lost a race changes nothing.
async function unchangedSince(reg: Registration, version: number): Promise<void> {
  if (control.writeDelayMs) await sleep(control.writeDelayMs)
  if (reg.version !== version) throw new HttpError(409, "registration_changed", { registration: await registrationView(reg) })
}

async function hold(key: string, unchanged: () => boolean): Promise<void> {
  if (!unchanged()) return
  await new Promise<void>((resolve) => {
    const set = waiters.get(key) ?? new Set()
    const wake = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { set.delete(wake); resolve() }, HOLD_MS)
    set.add(wake)
    waiters.set(key, set)
  })
}

// --- the chain, by hash: the service sends its own transactions, so it reads names from the contracts itself

type Lookup =
  | { type: "available" }
  | { type: "reserved" }
  | { type: "registered"; owner: Address; resolver: Address; expires: number; grace: number }

async function lookup(labelHash: Hex): Promise<Lookup> {
  if (control.chainDown) throw new HttpError(503, "provider_unavailable")
  try {
    const token = BigInt(labelHash)
    const [expires, grace, now, reason] = await Promise.all([
      read<bigint>(baseRegistrar, "nameExpires", [token]),
      read<bigint>(baseRegistrar, "GRACE_PERIOD"),
      chainNow(),
      read<number>(namePolicy, "reservedNames", [labelHash]),
    ])
    // a name in its grace period is still its holder's; a name never registered expires at 0
    if (expires > 0n && expires + grace >= BigInt(now)) {
      const node = nodeOf(labelHash)
      const [owner, nameResolver] = await Promise.all([read<Address>(registry, "owner", [node]), read<Address>(registry, "resolver", [node])])
      return { type: "registered", owner: getAddress(owner), resolver: getAddress(nameResolver), expires: Number(expires), grace: Number(grace) }
    }
    return reason === 0 ? { type: "available" } : { type: "reserved" }
  } catch {
    throw new HttpError(503, "provider_unavailable")
  }
}

// a paid, code or balance order holds its name from queued to registering, and failed until its month ended
const HOLDING: Phase[] = ["queued", "committing", "committed", "registering", "failed"]
function held(labelHash: Hex, except: Registration | null = null): boolean {
  return [...registrations.values()].some((r) => r !== except && r.labelHash === labelHash && HOLDING.includes(r.phase) && r.error !== "monthEnded")
}

// a text record may hold several links, joined as the app joins them
const LINK_SEPARATOR = ";"
const splitLinks = (text: string) => text.split(LINK_SEPARATOR).map((l) => l.trim()).filter(Boolean)
// a record set elsewhere may hold any number of links; a search answers the first few of each key
const MAX_ENTITIES_PER_KEY = 5

// --- link cards

// A link the chat core parses stands for a chat someone holds. A link's fragment says what profile the tests want behind
// it: a business, a bot, a profile with a picture, none as for a host the service does not fetch, or none read now, as
// for a fetch that failed or timed out.
const BUSINESS_TAG = "Biz"
const BOT_TAG = "Bot"
const PICTURE_TAG = "Pic"
const UNFETCHED_TAG = "Off"
const UNREAD_TAG = "Unr"
// a profile picture as the app sends one, a small image in a data URI
const PICTURE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#C76A3B"/><circle cx="32" cy="26" r="12" fill="#F6E3C8"/><path d="M12 60c2-14 10-20 20-20s18 6 20 20z" fill="#F6E3C8"/></svg>').toString("base64")}`

function linkProfile(link: string): Preview | null {
  const kind = linkKind(link)
  if (kind === null || deepLinkOf(link) === null) return null
  const fragment = link.split("#")[1].slice(0, 6)
  if (fragment.startsWith(UNFETCHED_TAG)) return { kind, profile: { type: "unavailable" } }
  if (fragment.startsWith(UNREAD_TAG)) return { kind, profile: { type: "unread" } }
  const names = { displayName: kind === "contact" ? `Contact ${fragment}` : `Channel ${fragment}`, fullName: "", ...fragment.startsWith(PICTURE_TAG) ? { image: PICTURE } : {} }
  // a channel's count, the same for the same link
  if (kind === "channel") {
    const publicMemberCount = [...fragment].reduce((n, c) => n * 7 + c.charCodeAt(0), 0) % 5000
    return { kind, profile: { type: "ok", linkProfile: { kind: "channel", ...names, subscribers: publicMemberCount } } }
  }
  const chat = fragment.startsWith(BUSINESS_TAG) ? "business" : fragment.startsWith(BOT_TAG) ? "bot" : "contact"
  return { kind, profile: { type: "ok", linkProfile: { kind: chat, ...names } } }
}

// A profile that was read is kept this long, as the service caches it; one not read now is fetched again.
const PROFILE_CACHE_MS = 10 * 60_000
const readProfiles = new Map<string, { profile: Preview; until: number }>()

// The link's profile as a fetch gives it: a link not fetched answers at once, and a fetch takes the delay a test set for its link.
async function fetchedProfile(link: string): Promise<Preview | null> {
  const profile = linkProfile(link)
  if (profile === null || profile.profile.type === "unavailable") return profile
  const kept = readProfiles.get(link)
  if (kept && kept.until > Date.now()) return kept.profile
  const delay = control.fetchDelays[link]
  if (delay) await sleep(delay)
  if (profile.profile.type === "ok") {
    const now = Date.now()
    for (const [cached, { until }] of readProfiles) if (until <= now) readProfiles.delete(cached)
    readProfiles.set(link, { profile, until: now + PROFILE_CACHE_MS })
  }
  return profile
}

async function entity(link: string) {
  const preview = await fetchedProfile(link)
  return preview && { preview, link: coreLink(link)!, deepLink: deepLinkOf(link)! }
}

// the short links of the key's kind in its record that the chat core parses, in the record's order
const entitiesOf = async (kind: LinkKind, text: string) =>
  (await Promise.all(splitLinks(text).filter((link) => linkProblem(kind, link) === null && deepLinkOf(link) !== null).slice(0, MAX_ENTITIES_PER_KEY).map(entity))).filter((e) => e !== null)

// --- search

export async function search(hash: string, lengthText: string | null): Promise<Record<string, unknown>> {
  if (control.limitedUntil > Date.now()) throw new HttpError(429, "rate_limited", {}, Math.ceil((control.limitedUntil - Date.now()) / 1000))
  if (!isHash(hash)) throw badRequest()
  const length = Number(lengthText)
  if (!Number.isInteger(length) || length < MIN_LABEL_LENGTH || length > MAX_LABEL_LENGTH) throw new HttpError(400, "invalid_name")
  const { listed, terms } = await nameTerms(hash).catch(unavailable)
  return { found: await answerFor(hash, length, terms, listed), ...listed ? { community: communityEntry(hash) } : {} }
}

async function answerFor(hash: Hex, length: number, terms: Terms | null, listed: boolean): Promise<Record<string, unknown>> {
  const found = await lookup(hash)
  if (found.type === "reserved") return { type: "reserved" }
  if (found.type === "available") {
    if (held(hash)) return { type: "taken" }
    const years = listed ? COMMUNITY_YEARS : YEARS
    const price = await priceOf(length, years).catch(unavailable)
    const readable = terms && await termsText(terms).catch(() => null) !== null ? terms : null
    return { type: "available", price: mismatch.price ?? price, years, ...readable ? { terms: readable } : {} }
  }
  const registered = { type: "registered", owner: found.owner, resolver: found.resolver, expiresAt: found.expires, gracePeriod: found.grace }
  // Records are read only from the store's own resolver: calling whatever contract a name points at would let anyone
  // make the service run arbitrary code. A name pointed elsewhere is shown with its owner and no links.
  if (found.resolver !== getAddress(deployment.resolver)) return { ...registered, entities: [], records: { type: "other" } }
  const node = nodeOf(hash)
  let contact: string, channel: string, nonce: bigint
  try {
    [contact, channel, nonce] = await Promise.all([
      read<string>(resolver, "text", [node, CONTACT_KEY]),
      read<string>(resolver, "text", [node, CHANNEL_KEY]),
      read<bigint>(resolver, "nonces", [found.owner]),
    ])
  } catch {
    // a failed read is not "no links": the page says the name could not be checked
    throw new HttpError(503, "provider_unavailable")
  }
  const entities = [...await entitiesOf("contact", contact), ...await entitiesOf("channel", channel)]
  const { left, nextAt } = editsLeft(hash)
  const edits = { left, ...nextAt === null ? {} : { nextAt: iso(nextAt) } }
  return { ...registered, entities, records: { type: "own", contact, channel, nonce: Number(nonce), edits } }
}

function nodeOf(labelHash: Hex): Hex {
  return keccak256(`${namehash(deployment.tld)}${labelHash.slice(2)}` as Hex)
}

// --- terms and community names

// The service's [community] words keyed by label hash, which the service reads at startup; /control/community changes them
// as a restart with a new ini would. The e2e spec's community names are bakers and bakehouse, which dev/deploy.ts lists, and
// the service's contract run words bakers otherwise. Which names are community names is the name policy's list on chain; the
// words only say what a listed name is for. The terms of each kind are the policy's links, whose texts the service fetches.
const communities = new Map<Hex, string>([[keccak256(toHex("bakers")), "bakers and pastry chefs"]])

const communityEntry = (labelHash: Hex) => ({ ...communities.has(labelHash) ? { for: communities.get(labelHash) } : {}, years: COMMUNITY_YEARS })
// a community name's order pays for these years, whatever years its code gives
const orderYears = (o: { terms: string }, years: number) => communityAgreed(o.terms) ? COMMUNITY_YEARS : years

interface Terms { hash: Hex; link: string }
const termsOf = (link: string): Terms | null => link === "" ? null : { hash: keccak256(toHex(link)), link }
const termsFor = (listed: boolean, terms: Terms) => `${listed ? COMMUNITY_TERMS : ""}${terms.hash.slice(2)}`
const policyLinks = () => Promise.all([read<string>(namePolicy, "generalTermsLink"), read<string>(namePolicy, "communityTermsLink")])

async function nameTerms(labelHash: Hex): Promise<{ listed: boolean; terms: Terms | null }> {
  const [listed, [generalLink, communityLink]] = await Promise.all([read<boolean>(namePolicy, "communityNames", [labelHash]), policyLinks()])
  return { listed, terms: termsOf(listed ? communityLink : generalLink) }
}

async function termsText(terms: Terms): Promise<string | null> {
  const digest = termsLink(terms.link, deployment.chainId)?.digest
  if (!digest) return null
  const fetched = await fetch(terms.link.slice(0, terms.link.indexOf("#")), { redirect: "manual", signal: AbortSignal.timeout(TERMS_FETCH_MS) }).catch(() => null)
  const bytes = fetched?.status === 200 ? Buffer.from(await fetched.arrayBuffer()) : null
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== digest) throw new HttpError(503, "terms_unavailable", {}, TERMS_WAIT_S)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new HttpError(503, "terms_unavailable", {}, TERMS_WAIT_S)
  }
}

// the entry of the community terms an order signed, which the view shows without reading the chain
const signedCommunity = (reg: Registration) => communityAgreed(reg.terms) ? communityEntry(reg.labelHash) : null

// an order or a selection signs the terms of the name's kind the service has now, which it takes no order without
async function checkTerms(o: Pick<OrderBody, "labelHash" | "terms">): Promise<void> {
  const { listed, terms } = await nameTerms(o.labelHash).catch((): never => { throw new HttpError(503, "name_check_unavailable") })
  if (!terms || await termsText(terms) === null) throw new HttpError(503, "terms_unavailable")
  if (o.terms !== termsFor(listed, terms)) throw new HttpError(409, "terms_changed", { terms, community: listed ? communityEntry(o.labelHash) : null })
}

// --- views

// a failed chain read is the provider's, not the request's
const unavailable = (): never => { throw new HttpError(503, "provider_unavailable") }

// What the owner signs to accept the terms of the name's kind.
async function acceptanceOf(reg: Pick<Registration, "labelHash" | "owner">): Promise<{ community: boolean; policy: Address; termsHash: Hex; nonce: number }> {
  const { listed, terms } = await nameTerms(reg.labelHash)
  // before the policy has these terms there are none to accept: the view reads unread, and a reveal waits
  if (!terms) throw new Error("the name policy has not set these terms yet")
  return {
    community: listed, policy: mismatch.policy ? deployment.sponsor : deployment.namePolicy, termsHash: mismatch.termsHash ? OTHER_TERMS_HASH : terms.hash,
    nonce: Number(await read<bigint>(namePolicy, "nonces", [reg.owner])),
  }
}

// the chain reads the owner signs with, unread when either fails: the view still answers
async function toSignOf(reg: Pick<Registration, "labelHash" | "owner">): Promise<Record<string, unknown>> {
  try {
    if (Date.now() < control.unreadUntil) throw new Error("the chain is not answering")
    const intentNonce = Number(await read<bigint>(sponsor, "nonces", [reg.owner]))
    return { type: "read", intentNonce, acceptance: await acceptanceOf(reg) }
  } catch {
    return { type: "unread" }
  }
}

export async function signFor(hash: string, owner: string | null): Promise<Record<string, unknown>> {
  if (!isHash(hash) || owner === null || !isAddress(owner, { strict: true }) || getAddress(owner) !== owner) throw badRequest()
  const toSign = await toSignOf({ labelHash: hash, owner })
  if (toSign.type !== "read") throw new HttpError(503, "name_check_unavailable")
  return toSign
}

function monthAfter(seconds: number): number {
  const d = new Date(seconds * 1000)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + 1)
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()))
  return Math.floor(d.getTime() / 1000)
}

const closedOf = (reg: Registration) => reg.invoiceId === null ? null : invoices.get(reg.invoiceId)!.closedBy

async function phaseView(reg: Registration): Promise<Record<string, unknown>> {
  const closedBy = closedOf(reg)
  switch (reg.phase) {
    case "unpaid": return closedBy ? { type: "closed", closedBy } : { type: "unpaid" }
    case "committed": return { type: "committed", revealAfter: reg.revealAfter, revealBefore: reg.revealBefore,
      signature: reg.label !== null ? { type: "signed" } : lapsed(reg) ? { type: "lapsed" } : { type: "awaiting", toSign: await toSignOf(reg) } }
    case "registered": return { type: "registered", expiresAt: reg.expiresAt, ...reg.disputeUntil === null ? {} : { disputeUntil: reg.disputeUntil } }
    case "failed": return { type: "failed", reason: reg.error, ...reg.error !== "monthEnded" && reg.paidAt !== null ? { heldUntil: iso(monthAfter(reg.paidAt)) } : {} }
    default: return { type: reg.phase }
  }
}

function paymentOf(reg: Registration): Record<string, unknown> {
  if (reg.method === "code") return { type: "code" }
  return { type: "invoice", method: reg.method }
}

async function registrationView(reg: Registration): Promise<Record<string, unknown>> {
  return {
    id: reg.id, version: reg.version, phase: await phaseView(reg), labelHash: reg.labelHash, label: reg.paidAt === null ? null : reg.label, owner: reg.owner, commitment: reg.commitment, sealed: reg.sealed,
    years: reg.years, duration: reg.duration, price: reg.paid, payment: paymentOf(reg), balance: balanceView(reg.id), latePayment: latePayment(reg), commitTx: reg.commitTx, registerTx: reg.registerTx,
    disputeDays: reg.disputeDays, community: signedCommunity(reg), terms: { communityName: communityAgreed(reg.terms), termsHash: signedHash(reg.terms) },
  }
}

// --- balances

// An open invoice past its expiry with nothing received: its order is closed by whatever meets it next.
const overdue = (inv: Invoice) => inv.status === "open" && inv.amountPaid === null && Date.parse(inv.expiresAt) <= Date.now()

function balanceView(registrationId: string): Record<string, unknown> | null {
  const b = balances.get(registrationId)
  if (!b) return null
  return { amount: b.amount, refunded: b.refunded }
}

// What money on a closed unpaid order waits on before it is all in the order's balance: money received and not confirmed,
// or a credit the tests hold back; null once all is credited, or when none came.
function latePayment(reg: Registration): "confirming" | "crediting" | "support" | null {
  const inv = reg.invoiceId === null ? null : invoices.get(reg.invoiceId)!
  if (reg.phase !== "unpaid" || inv === null || inv.status === "open" || inv.amountPaid === null) return null
  if (inv.lateWait !== null) return inv.lateWait
  return inv.confirmed ? null : "confirming"
}

function credit(registrationId: string, cents: number): void {
  const b = balances.get(registrationId) ?? { amount: 0, credited: 0, refunded: 0 }
  b.amount += cents
  b.credited += cents
  balances.set(registrationId, b)
}

function close(inv: Invoice, by: "expired" | "cancelled" = "expired"): void {
  inv.status = "expired"
  inv.closedBy = by
  const reg = registrations.get(inv.registrationId)!
  clearReveal(reg)
  wake(reg)
}

const unitsOf = (decimal: string, decimals: number) => {
  const [whole, fraction = ""] = decimal.split(".")
  return BigInt(whole + fraction.padEnd(decimals, "0"))
}
const decimalOf = (units: bigint, decimals: number) => {
  const digits = units.toString().padStart(decimals + 1, "0")
  const fraction = digits.slice(-decimals).replace(/0+$/, "")
  return fraction ? `${digits.slice(0, -decimals)}.${fraction}` : digits.slice(0, -decimals)
}

// Money confirmed on an invoice after its order closed, or past its amount, is credited to that order's balance, each figure
// once, at the lower of the invoice's rate (its amount over its crypto) and the current rate, rounded down to the cent.
function creditLate(inv: Invoice): void {
  const coin = inv.method === "card" ? null : inv.method
  const confirmed = coin === null ? BigInt(inv.amountPaid!) : unitsOf(inv.cryptoAmountPaid!, UNIT_DECIMALS[coin])
  const due = confirmed - inv.lateUnits
  if (due <= 0n) return
  let cents = due
  if (coin !== null) {
    const [amount, units, scale] = [BigInt(inv.amount), unitsOf(inv.cryptoAmount!, UNIT_DECIMALS[coin]), 10n ** BigInt(UNIT_DECIMALS[coin])]
    const current = control.rates[coin]
    const [perUnit, per] = current !== null && current * units < amount * scale ? [current, scale] : [amount, units]
    cents = due * perUnit / per
  }
  inv.lateUnits = confirmed
  inv.lateCents += Number(cents)
  credit(inv.registrationId, Number(cents))
  changed(registrations.get(inv.registrationId)!)
}

async function invoiceView(inv: Invoice): Promise<Record<string, unknown>> {
  const view: Record<string, unknown> = {
    invoiceId: inv.id, status: inv.status, amount: inv.amount, currency: "usd", expiresAt: inv.expiresAt, kind: "name",
    registration: await registrationView(registrations.get(inv.registrationId)!),
  }
  for (const k of ["amountPaid", "cryptoAmountPaid", "cryptoAmountDue", "paidInFull", "settledAt"] as const) if (inv[k] !== null) view[k] = inv[k]
  if (inv.method === "card") view.clientSecret = inv.clientSecret
  else Object.assign(view, { address: addressFor(inv.method, inv.id), cryptoAmount: inv.cryptoAmount, cryptoCurrency: inv.method, requiredConfirmations: 1 })
  return view
}

// --- orders

interface OrderBody {
  labelHash: Hex
  length: number
  duration: number
  owner: Address
  commitment: Hex
  sealed: string
  terms: string
}

function orderBody(body: Record<string, unknown>): OrderBody {
  const { owner } = body
  if (typeof owner !== "string" || !isAddress(owner, { strict: true }) || getAddress(owner) !== owner) throw badRequest()
  return { ...orderFields(body), owner }
}

// an order's fields but its owner
function orderFields(body: Record<string, unknown>): Omit<OrderBody, "owner"> {
  const { labelHash, length, duration, commitment, sealed, terms } = body
  if (!isHash(labelHash) || !isHash(commitment) || !Number.isInteger(duration)) throw badRequest()
  if (typeof sealed !== "string" || sealed.length > SEALED_MAX) throw badRequest()
  if (typeof terms !== "string" || !SIGNED_TERMS.test(terms)) throw badRequest()
  if (typeof length !== "number" || !Number.isInteger(length) || length < MIN_LABEL_LENGTH || length > MAX_LABEL_LENGTH) throw new HttpError(400, "invalid_name")
  return { labelHash, length, duration: duration as number, commitment, sealed, terms }
}

const objectOf = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest()
  return v as Record<string, unknown>
}

function signedTermsOf(v: unknown): string {
  const { communityName, termsHash } = objectOf(v)
  if (typeof communityName !== "boolean" || !isHash(termsHash)) throw badRequest()
  return `${communityName ? COMMUNITY_TERMS : ""}${termsHash.slice(2)}`
}

function flatSigned(v: unknown): Record<string, unknown> {
  const { fields, timestamp, signature } = objectOf(v)
  const sent = objectOf(fields)
  return { ...sent, terms: signedTermsOf(sent.terms), timestamp, signature }
}

const flatOrder = (v: unknown): Record<string, unknown> => ({ ...flatSigned(v), owner: objectOf(v).owner })

// the paid years and the free days until the term starts, as the page counts them by the service's clock
function checkDuration(duration: number, years: number): void {
  const free = duration - years * YEAR_S
  if (free < 0 || Math.abs(free - Math.max(0, TERM_START_S - nowSeconds())) > TERM_SLACK_S) throw badRequest()
}

// an order's own chain reads fail with their own tag, which the page tells from a payment method being unavailable
const chainPrice = (length: number, years: number) => priceOf(length, years).catch((): never => { throw new HttpError(503, "name_check_unavailable") })

async function nameFree(labelHash: Hex, except: Registration | null = null): Promise<void> {
  let found: Lookup
  try {
    found = await lookup(labelHash)
  } catch {
    throw new HttpError(503, "name_check_unavailable")
  }
  if (found.type !== "available" || held(labelHash, except)) throw new HttpError(409, "name_taken")
}

// Orders and selections check state, await the chain, then write: run one at a time so two at once cannot both pass.
let orderTurn: Promise<unknown> = Promise.resolve()

export function oneOrderAtATime<T>(f: () => Promise<T>): Promise<T> {
  const run = orderTurn.then(f)
  orderTurn = run.catch(() => undefined)
  return run
}

// An order's own fields, tagged by its kind, as an exact resend repeats them.
const orderHashOf = (kind: "invoice" | "register", o: OrderBody, extra: unknown[]) =>
  createHash("sha256").update(JSON.stringify([kind, o.labelHash, o.length, o.duration, o.owner, o.commitment, o.sealed, o.terms, ...extra])).digest("hex")

// The owner signs every order, so nobody can place one in another wallet's name; its age is checked only for a new order.
async function checkOrderSigner(o: OrderBody, body: Record<string, unknown>): Promise<void> {
  if (!Number.isInteger(body.timestamp)) throw badRequest()
  const message = `simplex.domains order ${o.labelHash} ${o.length} ${o.duration} ${o.commitment} ${sha256Hex(o.sealed)} ${o.terms} ${body.timestamp}`
  if (await recoverMessageAddress({ message, signature: checkSignature(body.signature) }) !== o.owner) throw badRequest()
}

const freshTimestamp = (timestamp: unknown) => { if (Math.abs(nowSeconds() - (timestamp as number)) > SIGNED_REQUEST_SECONDS) throw badRequest() }

function live(reg: Registration): boolean {
  if (reg.phase === "unpaid") return reg.invoiceId !== null && invoices.get(reg.invoiceId)!.status === "open"
  return reg.phase !== "taken" && reg.phase !== "registered" && reg.phase !== "ended"
}

// The answer to an exact resend, or nothing; an overdue order of the same wallet and name with nothing received is closed
// by this one first, and any other live order of the commitment, or of the wallet and name, refuses it without saying
// anything of itself.
function existingOrder(o: OrderBody, orderHash: string | null, except: Registration | null = null): Registration | null {
  const resent = orderHash === null ? undefined : [...registrations.values()].find((r) => r.orderHash === orderHash)
  if (resent) return resent
  const meets = (r: Registration) => r !== except && (r.commitment === o.commitment || (r.owner === o.owner && r.labelHash === o.labelHash))
  for (const r of registrations.values()) if (meets(r) && r.invoiceId) expireIfDue(invoices.get(r.invoiceId)!)
  if ([...registrations.values()].some((r) => meets(r) && live(r))) throw new HttpError(409, "order_exists")
  return null
}

// the refusal a test asked the next order to meet, once
async function injectedRefusal(length: number): Promise<void> {
  const injected = control.invoiceError
  if (!injected) return
  control.invoiceError = null
  const extra = injected === "catalog_changed" ? { price: await chainPrice(length, YEARS) } : {}
  throw new HttpError(INVOICE_ERRORS[injected], injected, extra, injected === "rate_limited" ? RETRY_AFTER_SECONDS : null)
}

// in codes mode nothing is paid: no invoice for a name
function refuseWhenCodesOnly(): void {
  if (control.mode === "codes") throw new HttpError(403, CODES_ONLY)
}

const refuseInDowntime = () => { if (control.downtime) throw new HttpError(503, "downtime") }

export async function createInvoice(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (body.kind !== "name") throw badRequest()
  refuseWhenCodesOnly()
  refuseInDowntime()
  const sent = flatOrder(body.order)
  const order = orderBody(sent)
  const method = body.method
  if (!isMethod(method)) throw badRequest()
  if (!Number.isInteger(body.price)) throw badRequest()
  await injectedRefusal(order.length)
  await checkOrderSigner(order, sent)
  const orderHash = orderHashOf("invoice", order, [method, body.price])
  const resent = existingOrder(order, orderHash)
  if (resent) return invoiceView(invoices.get(resent.invoiceId!)!)
  freshTimestamp(sent.timestamp)
  checkDuration(order.duration, YEARS)
  await checkTerms(order)
  await nameFree(order.labelHash)
  const price = await chainPrice(order.length, YEARS)
  if (body.price !== price) throw new HttpError(409, "catalog_changed", { price })
  const rv = await orderReveal({ ...order, disputeDays: DISPUTE_DAYS[method] }, body.reveal)
  const reg = newRegistration(order, { years: YEARS, paid: price, method, prepaidCode: null, phase: "unpaid", orderHash }, rv)
  return invoiceView(openInvoice(reg, method, price))
}

function openInvoice(reg: Registration, method: Method, amount: number): Invoice {
  const inv: Invoice = {
    id: id(), registrationId: reg.id, method, status: "open", amount,
    expiresAt: iso(nowSeconds() + INVOICE_MINUTES * 60),
    cryptoAmount: method === "card" ? null : (amount / 100 / RATES[method]).toFixed(method === "btc" ? 5 : 3),
    amountPaid: null, cryptoAmountPaid: null, cryptoAmountDue: null, paidInFull: null, confirmed: false, settledAt: null,
    clientSecret: method === "card" ? `pi_mock_secret_${randomBytes(12).toString("hex")}` : null, lateUnits: 0n, lateCents: 0, lateWait: null, closedBy: null,
  }
  reg.invoiceId = inv.id
  invoices.set(inv.id, inv)
  return inv
}

type NewRegistration = Pick<Registration, "years" | "paid" | "method" | "prepaidCode" | "phase" | "orderHash">

const DISPUTE_DAYS: Record<Method | "code", number> = { card: 120, btc: 14, xmr: 14, code: 14 }

function newRegistration(order: OrderBody, extra: NewRegistration, rv: Reveal): Registration {
  const reg: Registration = {
    id: id(), invoiceId: null, ...order, ...extra, ...rv, commitTx: null, registerTx: null,
    revealAfter: null, revealBefore: null, expiresAt: null, error: null, createdAt: iso(nowSeconds()), failNext: false, staleNext: false, resends: 0, version: 1,
    paidAt: extra.phase === "queued" ? nowSeconds() : null, takenAt: null, disputeDays: DISPUTE_DAYS[extra.method], disputeUntil: null,
  }
  registrations.set(reg.id, reg)
  return reg
}

export async function readInvoice(invoiceId: string, wait: string | null, seenVersion: number | null, seenPaid: string | null, seenFull: boolean): Promise<Record<string, unknown>> {
  const inv = invoices.get(invoiceId)
  if (!inv) throw new HttpError(404, "not_found")
  expireIfDue(inv)
  const reg = registrations.get(inv.registrationId)!
  if (wait !== null) {
    await hold(inv.id, () => inv.status === wait && (seenVersion === null || reg.version === seenVersion) && (seenPaid === null || ((inv.cryptoAmountPaid ?? "") === seenPaid && (inv.paidInFull === true) === seenFull)))
    expireIfDue(inv)
  }
  return invoiceView(inv)
}

export async function readRegistration(registrationId: string, seenVersion: number | null): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  if (seenVersion !== null) await hold(reg.id, () => reg.version === seenVersion)
  return registrationView(reg)
}

// An open invoice past its rate window with no money received expires when it is next looked at; a funded one stays
// open until it settles.
function expireIfDue(inv: Invoice): void {
  if (overdue(inv)) close(inv)
}

export async function cancelInvoice(invoiceId: string): Promise<Record<string, unknown>> {
  const inv = invoices.get(invoiceId)
  if (!inv) throw new HttpError(404, "not_found")
  expireIfDue(inv)
  if (inv.status !== "open") throw new HttpError(409, "not_open")
  if (inv.amountPaid) throw new HttpError(409, "funded")
  close(inv, "cancelled")
  return invoiceView(inv)
}

// --- prepaid codes

function prepaidOf(text: string): { hash: string; row: PrepaidCode | undefined } {
  const code = parseNameCode(text)
  if (code?.kind !== "prepaid") throw new HttpError(400, "code_invalid")
  const hash = codeHash(code.canonical)
  return { hash, row: codes.get(hash) }
}

export function checkCode(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.code !== "string") throw badRequest()
  const { row } = prepaidOf(body.code)
  if (!row) throw new HttpError(400, "code_invalid")
  return { minLength: row.minLength, years: row.years, state: stateOf(row) }
}

const stateOf = (row: PrepaidCode) => row.registrationId !== null && row.state === "expired" ? "reserved" : row.state

const CODE_ERRORS: Partial<Record<PrepaidCode["state"], string>> = { used: "code_used", reserved: "code_reserved", expired: "code_expired", unpaid: "payment_pending", revoked: "code_invalid" }

export async function registerWithCode(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof body.code !== "string") throw badRequest()
  refuseInDowntime()
  const sent = flatOrder(body.order)
  const order = orderBody(sent)
  const { hash, row } = prepaidOf(body.code)
  if (!row) throw new HttpError(400, "code_invalid")
  await checkOrderSigner(order, sent)
  const orderHash = orderHashOf("register", order, [hash])
  const resent = existingOrder(order, orderHash)
  if (resent) return { registrationId: resent.id }
  freshTimestamp(sent.timestamp)
  checkDuration(order.duration, orderYears(order, row.years))
  await checkTerms(order)
  await nameFree(order.labelHash)
  const error = CODE_ERRORS[stateOf(row)]
  if (error) throw new HttpError(error === "code_invalid" ? 400 : 409, error)
  if (order.length < row.minLength) throw new HttpError(409, "code_not_covering")
  const rv = await orderReveal({ ...order, disputeDays: DISPUTE_DAYS.code }, body.reveal)
  const reg = newRegistration(order, { years: row.years, paid: 0, method: "code", prepaidCode: hash, phase: "queued", orderHash }, rv)
  row.state = "reserved"
  row.registrationId = reg.id
  void advance(reg)
  return { registrationId: reg.id }
}

// the controller's minimum registration is 2 years, and codes cover names of 6 to 63 letters
const CODE_YEARS = { min: 2, max: 10 }
const CODE_STATES: PrepaidCode["state"][] = ["unused", "reserved", "used", "revoked", "expired", "unpaid"]

// A code's state set from outside, as an order elsewhere taking it, or letting it go
export function setCodeState(code: unknown, state: unknown): Record<string, unknown> {
  const parsed = typeof code === "string" ? parseNameCode(code) : null
  const row = parsed?.kind === "prepaid" ? codes.get(codeHash(parsed.canonical)) : undefined
  if (!row || !CODE_STATES.includes(state as PrepaidCode["state"])) throw badRequest()
  row.state = state as PrepaidCode["state"]
  if (row.state === "unused") row.registrationId = null
  return { ok: true }
}

export function issueCode(minLength: number, years: number, state: PrepaidCode["state"]): string {
  if (!Number.isInteger(years) || years < CODE_YEARS.min || years > CODE_YEARS.max) throw badRequest()
  if (!Number.isInteger(minLength) || minLength < MIN_LABEL_LENGTH || minLength > MAX_LABEL_LENGTH || !CODE_STATES.includes(state)) throw badRequest()
  const lengthText = String(minLength)
  for (;;) {
    // a random body with a valid check character: draw until the parser accepts one
    const payload = [...randomBytes(19)].map((b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b % 32]).join("")
    for (const c of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") {
      const code = parseNameCode(`SN${lengthText}${payload}${c}`)
      if (code?.kind === "prepaid") {
        codes.set(codeHash(code.canonical), { minLength, years, state, registrationId: null })
        return code.display
      }
    }
  }
}

// --- the worker: commit, wait, register

const busy = new Set<string>()

async function advance(reg: Registration): Promise<void> {
  if (busy.has(reg.id)) return
  busy.add(reg.id)
  try {
    // a commit that did not go out stays committing while it is tried again
    if (reg.phase === "queued" || reg.phase === "committing") await commit(reg)
    if (reg.phase === "committed" && reg.intent) await register(reg)
    reg.resends = 0
  } catch (e) {
    console.error(`${new Date().toISOString()} ${reg.id} ${reg.phase}, try ${reg.resends}: ${e instanceof Error ? e.message : e}`)
    if (e instanceof NotSent && reg.resends < RESENDS) {
      reg.resends += 1
      setTimeout(() => void advance(reg), RESEND_MS)
    } else fail(reg, "registryRefused")
  } finally {
    busy.delete(reg.id)
  }
}

const lapsed = (reg: Registration) => reg.phase === "committed" && !reg.intent && reg.revealBefore !== null && nowSeconds() > reg.revealBefore

function fail(reg: Registration, error: FailReason): void {
  // a failed registration keeps its prepaid code reserved
  reg.phase = "failed"
  reg.error = error
  changed(reg)
}

async function commit(reg: Registration): Promise<void> {
  reg.phase = "committing"
  changed(reg)
  if (reg.failNext) {
    reg.failNext = false
    return fail(reg, "registryRefused")
  }
  for (;;) {
    try {
      // kept once its receipt is in: the order's page reads a commit hash as a commit on chain
      reg.commitTx = await sendTx(controller, "commit", [reg.commitment])
      reg.resends = 0
    } catch (e) {
      // an earlier commit of the same commitment is still live
      if (!(e instanceof Reverted && e.revert === "UnexpiredCommitmentExists")) throw e
    }
    const at = Number(await read<bigint>(controller, "commitments", [reg.commitment]))
    // a commit the wall clock calls lapsed can still be live on chain for a few blocks; reusing it would lapse at once
    if (at + deployment.maxCommitmentAge > nowSeconds()) break
    console.error(`${new Date().toISOString()} ${reg.id} commit at ${at}, now ${nowSeconds()}`)
    await sleep(1000)
  }
  const committedAt = Number(await read<bigint>(controller, "commitments", [reg.commitment]))
  reg.revealAfter = committedAt + deployment.minCommitmentAge
  reg.revealBefore = committedAt + deployment.maxCommitmentAge
  if (reg.intent && reg.intent.deadline < BigInt(reg.revealAfter)) clearReveal(reg)
  reg.phase = "committed"
  changed(reg)
}

function clearReveal(reg: Registration): void {
  reg.label = null
  reg.secret = null
  reg.records = null
  reg.intent = null
  reg.acceptance = null
}

function registrationTuple(reg: Pick<Registration, "label" | "secret" | "records" | "owner" | "duration">) {
  const node = namehash(`${reg.label}.${deployment.tld}`)
  const records: [string, string | null][] = [[CONTACT_KEY, reg.records!.contact], [CHANNEL_KEY, reg.records!.channel]]
  const data = records.filter((record): record is [string, string] => record[1] !== null)
    .map(([key, link]) => encodeFunctionData({ abi: resolver.abi, functionName: "setText", args: [node, key, link] }))
  return {
    label: reg.label!, owner: reg.owner, duration: BigInt(reg.duration), secret: reg.secret!, resolver: deployment.resolver, data, reverseRecord: 0, referrer: zeroHash,
  }
}

async function register(reg: Registration): Promise<void> {
  await untilChainTime(reg.revealAfter!, chainNow)
  await taking.get(reg.label!)
  if (reg.failNext) {
    reg.failNext = false
    return fail(reg, "registryRefused")
  }
  if (reg.staleNext) {
    reg.staleNext = false
    clearReveal(reg)
    return changed(reg)
  }
  const { nonce, deadline, signature } = reg.intent!
  const { acceptance } = reg
  // the acceptance is relayed first unless already on chain; its revert is judged as the register's, unless the policy holds
  // that acceptance, which another sent first
  const accepted = () => read<Hex>(namePolicy, "acceptedTerms", [reg.commitment, reg.owner])
  const relay = acceptance !== null && await accepted() !== acceptance.termsHash
  // registering only once the transaction goes out: until then the name is not on its way to the owner
  const sending = (hash: Hex) => {
    reg.phase = "registering"
    reg.registerTx = hash
    changed(reg)
  }
  try {
    if (relay) {
      const withSig = acceptance.community ? "commitUnderCommunityTermsWithSig" : "commitUnderGeneralTermsWithSig"
      await sendTx(namePolicy, withSig, [reg.commitment, acceptance.termsHash, reg.owner, acceptance.nonce, deadline, acceptance.signature]).catch(async (e) => {
        if (!(e instanceof Reverted) || await accepted() !== acceptance.termsHash) throw e
      })
    }
    reg.registerTx = await sendTx(sponsor, "registerWithCredit", [registrationTuple(reg), BigInt(reg.disputeDays), nonce, deadline, signature], sending)
  } catch (e) {
    if (e instanceof NotSent) throw e
    // a register with no answer may still be mined, so the order waits for the chain; a relay with no answer fails the order
    if (!(e instanceof Reverted)) return reg.phase === "registering" ? awaitRegistration(reg) : fail(reg, "registryRefused")
    if ((await ownerOf(reg.labelHash).catch(() => null)) === reg.owner) return registered(reg)
    // another registration by the same owner spent this nonce first, or the terms changed: the owner signs again
    if (SIGN_AGAIN.includes(e.revert ?? "")) {
      clearReveal(reg)
      reg.phase = "committed"
      return changed(reg)
    }
    const available = await read<boolean>(controller, "available", [reg.label])
    if (!available) {
      reg.phase = "taken"
      reg.takenAt = nowSeconds()
      // a paid order keeps what it is worth as its balance; a code order keeps its code reserved
      if (!reg.prepaidCode) credit(reg.id, reg.paid)
      return changed(reg)
    }
    return fail(reg, "registryRefused")
  }
  // the transaction went through; the owner is checked as the chain answers it, and a read that fails leaves it at that
  const holder = await ownerOf(reg.labelHash).catch(() => reg.owner)
  if (holder !== reg.owner) return fail(reg, "registryRefused")
  await registered(reg)
}

// A register whose sending got no answer: the chain is asked for a while whether the name came to its owner.
async function awaitRegistration(reg: Registration): Promise<void> {
  for (let i = 0; i < PENDING_CHECKS; i++) {
    await new Promise((resolve) => setTimeout(resolve, PENDING_CHECK_MS))
    if ((await ownerOf(reg.labelHash).catch(() => null)) === reg.owner) return registered(reg)
  }
  fail(reg, "registryRefused")
}

// a few tries, as one failed read is the provider's moment, not the registration's
async function registered(reg: Registration): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      reg.expiresAt = Number(await read<bigint>(baseRegistrar, "nameExpires", [BigInt(reg.labelHash)]))
      const disputeUntil = await read<bigint>(baseRegistrar, "disputeUntil", [BigInt(reg.labelHash)])
      reg.disputeUntil = disputeUntil === 0n ? null : Number(disputeUntil)
      break
    } catch (e) {
      if (i + 1 >= EXPIRY_READS) throw e
      await new Promise((resolve) => setTimeout(resolve, EXPIRY_READ_MS))
    }
  }
  reg.phase = "registered"
  reg.error = null
  if (reg.prepaidCode) {
    const row = codes.get(reg.prepaidCode)
    if (row) row.state = "used"
  }
  changed(reg)
}

// --- the reveal

function checkSignature(signature: unknown): Hex {
  if (typeof signature !== "string" || !/^0x[0-9a-f]{130}$/.test(signature)) throw badRequest()
  const s = BigInt("0x" + signature.slice(66, 130))
  const v = parseInt(signature.slice(130), 16)
  // the sponsor's and resolver's SignatureChecker take only a low s and v 27 or 28
  if (s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) throw badRequest()
  return signature as Hex
}

interface RevealLinks { contact: string | null; channel: string | null }

// one link per key or none, each text; whether they are links the service takes is checked last
function linksOf(records: unknown): RevealLinks {
  if (typeof records !== "object" || records === null) throw badRequest()
  const linkOf = (link: unknown) => {
    if (link !== undefined && link !== null && typeof link !== "string") throw badRequest()
    return typeof link === "string" ? link : null
  }
  const { contact, channel } = records as Record<string, unknown>
  return { contact: linkOf(contact), channel: linkOf(channel) }
}

const refusedLink = (records: RevealLinks): LinkKind | null =>
  (["contact", "channel"] as const).find((kind) => { const link = records[kind]; return link !== null && (linkProblem(kind, link) !== null || deepLinkOf(link) === null) }) ?? null

type Ordered = Pick<Registration, "labelHash" | "length" | "duration" | "owner" | "commitment" | "disputeDays">
type Reveal = { label: string; secret: Hex; records: RevealLinks; intent: NonNullable<Registration["intent"]>; acceptance: NonNullable<Registration["acceptance"]> }

// A reveal includes the owner's signature of the acceptance its view returns, of the terms of the name's kind on chain now.
async function checkAcceptance(reg: Ordered, accepted: unknown, deadline: number, unread: () => never): Promise<Reveal["acceptance"]> {
  const asked = await acceptanceOf(reg).catch(unread)
  if (typeof accepted !== "object" || accepted === null) throw badRequest()
  const { termsHash, nonce, signature: signed } = accepted as Record<string, unknown>
  if (termsHash !== asked.termsHash || nonce !== asked.nonce) throw badRequest()
  const signature = checkSignature(signed)
  const primaryType = asked.community ? "AcceptCommunityTerms" : "AcceptGeneralTerms"
  const acceptor = await recoverTypedDataAddress({
    domain: { name: "SimplexNamePolicy", version: "1", chainId: deployment.chainId, verifyingContract: deployment.namePolicy },
    types: { [primaryType]: [{ name: "commitment", type: "bytes32" }, { name: "termsHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType,
    message: { commitment: reg.commitment, termsHash: asked.termsHash, nonce: BigInt(asked.nonce), deadline: BigInt(deadline) },
    signature,
  })
  if (acceptor !== reg.owner) throw badRequest()
  return { community: asked.community, termsHash: asked.termsHash, nonce: BigInt(asked.nonce), signature }
}

async function checkReveal(o: Ordered, body: Record<string, unknown>, earliest: number, unread: () => never): Promise<Reveal> {
  const signature = checkSignature(body.signature)
  const { label, secret, nonce, deadline } = body
  if (typeof label !== "string" || labelProblem(label) !== null) throw badRequest()
  if (keccak256(toHex(label)) !== o.labelHash || label.length !== o.length) throw badRequest()
  if (!isHash(secret) || typeof nonce !== "number" || typeof deadline !== "number" || !Number.isInteger(nonce) || !Number.isInteger(deadline)) throw badRequest()
  const records = linksOf(body.records)
  const tuple = registrationTuple({ ...o, label, secret, records })
  if ((await read<Hex>(controller, "makeCommitment", [tuple]).catch(unread)) !== o.commitment) throw badRequest()
  if (deadline < earliest || deadline > nowSeconds() + SIGNATURE_SECONDS + SIGNED_REQUEST_SECONDS) throw badRequest()
  const signer = await recoverTypedDataAddress({
    ...registerNameTypedData(deployment.chainId, deployment.sponsor),
    message: { label, owner: o.owner, duration: tuple.duration, resolver: deployment.resolver, data: tuple.data, disputeDays: BigInt(o.disputeDays), nonce: BigInt(nonce), deadline: BigInt(deadline) },
    signature,
  })
  if (signer !== o.owner) throw badRequest()
  if (BigInt(nonce) !== (await read<bigint>(sponsor, "nonces", [o.owner]).catch(unread))) throw badRequest()
  const acceptance = await checkAcceptance(o, body.acceptance, deadline, unread)
  return { label, secret, records, intent: { nonce: BigInt(nonce), deadline: BigInt(deadline), signature }, acceptance }
}

async function orderReveal(o: Ordered, body: unknown): Promise<Reveal> {
  const rv = await checkReveal(o, objectOf(body), nowSeconds(), (): never => { throw new HttpError(503, "name_check_unavailable") })
  const kind = refusedLink(rv.records)
  if (kind) throw new HttpError(400, "invalid_link", { kind })
  return rv
}

export async function reveal(registrationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  const signature = checkSignature(body.signature)
  if (reg.label !== null) {
    if (reg.label === body.label && reg.intent?.signature === signature) return {}
    throw badRequest()
  }
  const unread = reg.phase === "failed" && reg.error === "unread"
  if (!unread && (reg.phase !== "committed" || lapsed(reg))) throw badRequest()
  const version = reg.version
  const rv = await checkReveal(reg, body, nowSeconds(), unavailable)
  await unchangedSince(reg, version)
  Object.assign(reg, rv, unread ? { phase: "queued", error: null, commitTx: null, registerTx: null, revealAfter: null, revealBefore: null } : {})
  changed(reg)
  void advance(reg)
  return {}
}

// --- signed requests from the owner code's key

async function checkSigner(owner: Address, message: string, timestamp: unknown, signature: unknown): Promise<void> {
  if (!Number.isInteger(timestamp)) throw badRequest()
  const signer = await recoverMessageAddress({ message, signature: checkSignature(signature) })
  if (signer !== owner) throw badRequest()
}

async function checkSigned(owner: Address, message: string, timestamp: unknown, signature: unknown): Promise<void> {
  await checkSigner(owner, message, timestamp, signature)
  freshTimestamp(timestamp)
}

const sha256Hex = (text: string) => "0x" + createHash("sha256").update(text, "ascii").digest("hex")

export async function selectName(registrationId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  refuseInDowntime()
  const sent = flatSigned(body)
  const order = orderBody({ ...sent, owner: reg.owner })
  const revealBody = objectOf(body.reveal)
  await checkSigner(reg.owner, `simplex.domains name ${reg.id} ${order.labelHash} ${order.length} ${order.duration} ${order.commitment} ${sha256Hex(order.sealed)} ${order.terms} ${sent.timestamp}`, sent.timestamp, sent.signature)
  const current = reg.labelHash === order.labelHash && reg.length === order.length && reg.duration === order.duration && reg.commitment === order.commitment && reg.sealed === order.sealed
    && reg.terms === order.terms
  // a repeat is answered however old its signature, as the service answers it before the age
  if (current) return registrationView(reg)
  // only an order taken first, with a new order's checks in a new order's sequence: a code order whose code is checked
  // again, or a paid order while its balance keeps its price
  if (reg.phase !== "taken") throw badRequest()
  const version = reg.version
  existingOrder(order, null, reg)
  freshTimestamp(sent.timestamp)
  checkDuration(order.duration, orderYears(order, reg.years))
  await checkTerms(order)
  await nameFree(order.labelHash, reg)
  const paid = reg.method !== "code"
  const price = paid ? await chainPrice(order.length, orderYears(order, reg.years)) : 0
  if (price !== reg.paid) throw new HttpError(409, "catalog_changed", { price })
  const rv = await orderReveal({ ...order, disputeDays: reg.disputeDays }, revealBody)
  const row = reg.prepaidCode ? codes.get(reg.prepaidCode) : undefined
  if (row) codeReservable(row, reg, order.length)
  if (paid && (balances.get(reg.id)?.amount ?? 0) < reg.paid) throw badRequest()
  await unchangedSince(reg, version)
  if (row?.state === "unused") Object.assign(row, { state: "reserved", registrationId: reg.id })
  if (paid) balances.get(reg.id)!.amount -= reg.paid
  Object.assign(reg, {
    labelHash: order.labelHash, length: order.length, duration: order.duration, commitment: order.commitment, sealed: order.sealed, terms: order.terms,
    phase: "queued", commitTx: null, registerTx: null, revealAfter: null, revealBefore: null, error: null, paidAt: nowSeconds(), ...rv,
  })
  changed(reg)
  const view = await registrationView(reg)
  void advance(reg)
  return view
}

// A code order's code is accepted at a selection while this order holds it, past its expiry until a calendar month after
// the take, or while it is unused, and as long as it covers the name; a revoked code never is.
function codeReservable(row: PrepaidCode, reg: Registration, length: number): void {
  const held = row.registrationId === reg.id && (row.state === "reserved" || (row.state === "expired" && reg.takenAt !== null && nowSeconds() < monthAfter(reg.takenAt)))
  const error = row.state === "revoked" ? "code_invalid" : held || row.state === "unused" ? undefined : CODE_ERRORS[row.state]
  if (error) throw new HttpError(error === "code_invalid" ? 400 : 409, error)
  if (length < row.minLength) throw new HttpError(409, "code_not_covering")
}

export async function retry(registrationId: string): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  // only a commitment that lapsed unsigned is committed again
  if (!lapsed(reg)) throw badRequest()
  await unchangedSince(reg, reg.version)
  reg.phase = "queued"
  reg.commitTx = null
  reg.registerTx = null
  reg.resends = 0
  changed(reg)
  const view = await registrationView(reg)
  void advance(reg)
  return view
}

export function findLimited(): void {
  if (control.findLimitedUntil > Date.now()) throw new HttpError(429, "rate_limited", {}, Math.ceil((control.findLimitedUntil - Date.now()) / 1000))
}

export async function find(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const owner = body.owner
  if (typeof owner !== "string" || !isAddress(owner)) throw badRequest()
  const address = getAddress(owner)
  await checkSigned(address, `simplex.domains find ${address.toLowerCase()} ${body.timestamp}`, body.timestamp, body.signature)
  const all = [...registrations.values()].filter((r) => r.owner === address).reverse()
  // a balance never expires, so an older order holding one is listed after the newest
  const found = [...all.slice(0, FOUND_MAX), ...all.slice(FOUND_MAX).filter((r) => (balances.get(r.id)?.amount ?? 0) > 0)]
  return { registrations: found.map((r) => ({ registrationId: r.id, invoiceId: r.invoiceId, phase: r.phase === "unpaid" && closedOf(r) ? "closed" : r.phase, createdAt: r.createdAt, labelHash: r.labelHash, sealed: r.sealed })) }
}

export async function previewLink(body: Record<string, unknown>): Promise<Preview> {
  if (typeof body.link !== "string" || linkProfile(body.link) === null || new TextEncoder().encode(body.link).length > LINK_MAX_BYTES) throw new HttpError(400, "invalid_link", { kind: null })
  return (await fetchedProfile(body.link))!
}

// --- the records relay

// The service's record_edits_per_year, its default and its bounds; /control/edits sets it as a restart with a new ini would.
const RECORD_EDITS_PER_YEAR = 3
const RECORD_EDITS_MIN = 1
const RECORD_EDITS_MAX = 100
let editsPerYear = RECORD_EDITS_PER_YEAR

// When each of a name's edits went out, by label hash. Each counts however it ends on chain, mined, reverted or expired,
// as the service counts every relayed edit; one refused or never sent is never counted.
const nameEdits = new Map<Hex, number[]>()

// the edits a name has left in any 365 days, and when the next returns: when the oldest counted one, or a later one
// while a lowered limit is overrun, is 365 days old
function editsLeft(labelHash: Hex): { left: number; nextAt: number | null } {
  const since = nowSeconds() - YEAR_S
  const times = (nameEdits.get(labelHash) ?? []).filter((at) => at > since).sort((a, b) => a - b)
  const returning = times[Math.max(0, times.length - editsPerYear)]
  return { left: Math.max(0, editsPerYear - times.length), nextAt: returning === undefined ? null : returning + YEAR_S }
}

// Each sent request, by its signed edits: a repeat is answered from it rather than checked anew. A refused request is
// never sent, so it is not kept, and its repeat is checked again.
interface SentEdit { hash: Hex; outcome: Record<string, unknown> | HttpError | null; reverted: () => Promise<Record<string, unknown> | HttpError> }
const sentEdits = new Map<string, SentEdit>()

async function revertedOutcome(node: Hex, owner: Address, edits: SignedEdit[]): Promise<Record<string, unknown> | HttpError> {
  let nonce: bigint, values: string[]
  try {
    [nonce, ...values] = await Promise.all([read<bigint>(resolver, "nonces", [owner]), ...edits.map((e) => read<string>(resolver, "text", [node, recordKey(e.key)]))]) as [bigint, ...string[]]
  } catch {
    throw new HttpError(504, "edit_pending")
  }
  const held = nonce > BigInt(edits[edits.length - 1].nonce) && edits.every((e, i) => values[i] === e.value)
  return held ? { tx: null } : new HttpError(409, "record_reverted")
}

async function repeatedEdit(sent: SentEdit): Promise<Record<string, unknown>> {
  if (sent.outcome instanceof HttpError) throw sent.outcome
  if (sent.outcome) return sent.outcome
  // one that got no answer goes on: the repeat waits for it again
  let ok: boolean
  try {
    ok = await mined(sent.hash)
  } catch {
    throw new HttpError(504, "edit_pending")
  }
  sent.outcome = ok ? { tx: sent.hash } : await sent.reverted()
  return repeatedEdit(sent)
}

// A Save's edits: one link of each kind at most, so two
const MAX_EDITS = 2

// One signed edit of a request: a SetText of a kind's record.
interface SignedEdit { key: "contact" | "channel"; value: string; nonce: number; deadline: number; signature: Hex }
const recordKey = (kind: SignedEdit["key"]) => kind === "contact" ? CONTACT_KEY : CHANNEL_KEY

// every edit's format and key, then every link, then every signature, as the service checks them
function signedEdits(edits: unknown): SignedEdit[] {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_EDITS) throw badRequest()
  const parsed = edits.map((e: unknown) => {
    if (typeof e !== "object" || e === null) throw badRequest()
    const { key, value, nonce, deadline, signature } = e as Record<string, unknown>
    if (typeof nonce !== "number" || typeof deadline !== "number" || !Number.isInteger(nonce) || !Number.isInteger(deadline)) throw badRequest()
    if ((key !== "contact" && key !== "channel") || typeof value !== "string") throw badRequest()
    return { key: key as SignedEdit["key"], value, nonce, deadline, signature }
  })
  const keys = parsed.map((e) => e.key)
  if (new Set(keys).size !== keys.length) throw badRequest()
  if (parsed.some((e, i) => i > 0 && e.nonce !== parsed[i - 1].nonce + 1)) throw badRequest()
  for (const { key, value } of parsed) {
    if (value !== "" && (linkProblem(key, value) !== null || deepLinkOf(value) === null)) throw new HttpError(400, "invalid_link", { kind: null })
  }
  return parsed.map((e) => ({ ...e, signature: checkSignature(e.signature) }))
}

const SET_TEXT_TYPES = { SetText: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }, { name: "value", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }

function editDigest(node: Hex, { key, value, nonce, deadline }: SignedEdit): Hex {
  const domain = { name: "SimplexResolver", version: "1", chainId: deployment.chainId, verifyingContract: deployment.resolver }
  return hashTypedData({ domain, primaryType: "SetText", types: SET_TEXT_TYPES, message: { node, key: recordKey(key), value, nonce: BigInt(nonce), deadline: BigInt(deadline) } })
}

const editCall = (node: Hex, { key, value, nonce, deadline, signature }: SignedEdit): [string, unknown[]] =>
  ["setTextWithSig", [node, recordKey(key), value, BigInt(nonce), BigInt(deadline), signature]]

// A request's one transaction: an edit alone as its own call, two as the resolver's multicall, which reverts both when
// either fails.
function sendEdits(node: Hex, edits: SignedEdit[], goingOut: (hash: Hex) => void): Promise<Hex> {
  if (edits.length === 1) return sendTx(resolver, ...editCall(node, edits[0]), goingOut)
  const calls = edits.map((e) => {
    const [functionName, args] = editCall(node, e)
    return encodeFunctionData({ abi: resolver.abi, functionName, args })
  })
  return sendTx(resolver, "multicall", [calls], goingOut)
}

export async function editRecords(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { labelHash } = body
  if (!isHash(labelHash)) throw badRequest()
  const edits = signedEdits(body.edits)
  const node = nodeOf(labelHash)
  const signers = await Promise.all(edits.map((e) => recoverAddress({ hash: editDigest(node, e), signature: e.signature })))
  if (signers.some((a) => a !== signers[0])) throw badRequest()
  const editKey = JSON.stringify([labelHash, edits])
  const earlier = sentEdits.get(editKey)
  if (earlier) return repeatedEdit(earlier)
  // as the service, after the signatures and before any chain read
  const { left, nextAt } = editsLeft(labelHash)
  if (left === 0) throw new HttpError(409, "edit_limit", { nextAt: iso(nextAt ?? nowSeconds()) })
  if (Math.min(...edits.map((e) => e.deadline)) < nowSeconds()) throw badRequest()
  // a failed chain read is the provider's, not the request's
  let owner: Address, nameResolver: Address, current: bigint
  try {
    // getAddress takes a chain id second, so it is not handed map's index
    [owner, nameResolver] = (await Promise.all([read<Address>(registry, "owner", [node]), read<Address>(registry, "resolver", [node])])).map((a) => getAddress(a))
    current = await read<bigint>(resolver, "nonces", [owner])
  } catch {
    throw new HttpError(503, "provider_unavailable")
  }
  if (signers[0] !== owner) throw badRequest()
  // the relay writes only the store's resolver, which a name pointed elsewhere no longer reads
  if (nameResolver !== getAddress(deployment.resolver)) throw badRequest()
  if (BigInt(edits[0].nonce) !== current) throw new HttpError(409, "stale_nonce")
  // kept from the moment it goes out, and counted once whatever it changes
  const edit: { sent: SentEdit | null } = { sent: null }
  const goingOut = (hash: Hex) => {
    nameEdits.set(labelHash, [...nameEdits.get(labelHash) ?? [], nowSeconds()])
    edit.sent = { hash, outcome: null, reverted: () => revertedOutcome(node, owner, edits) }
    sentEdits.set(editKey, edit.sent)
  }
  try {
    const tx = await sendEdits(node, edits, goingOut)
    if (edit.sent) edit.sent.outcome = { tx }
    return { tx }
  } catch (e) {
    if (e instanceof NotSent) throw new HttpError(503, "provider_unavailable")
    // a dry run that reverts sends nothing; a transaction that reverts is the edit's answer
    if (e instanceof Reverted) {
      if (!edit.sent) throw new HttpError(409, "record_reverted")
      edit.sent.outcome = await edit.sent.reverted()
      return repeatedEdit(edit.sent)
    }
    // no answer from the chain is not a refusal: the edit may still be mined, which the page says
    throw new HttpError(504, "edit_pending")
  }
}

// --- controls for tests and screenshots

// What a settle confirms in all, in coin units (cents for a card): the invoice's amount, or the coin a test names.
function settledUnits(inv: Invoice, paid: unknown): bigint {
  const decimals = inv.method === "card" ? null : UNIT_DECIMALS[inv.method]
  if (paid === undefined) return decimals === null ? BigInt(inv.amount) : unitsOf(inv.cryptoAmount!, decimals)
  const [, fraction = ""] = typeof paid === "string" ? paid.split(".") : []
  if (decimals === null || typeof paid !== "string" || !/^\d+(\.\d+)?$/.test(paid) || fraction.length > decimals) throw badRequest()
  return unitsOf(paid, decimals)
}

// As BTCPay settles: an open invoice paid in full, or past its amount, registers its name and credits what is past it, and
// one whose name another paid order holds is taken, its price credited; a closed one stays closed, its money credited to
// the order's balance.
function settle(inv: Invoice, reg: Registration, paid: bigint): void {
  const decimals = inv.method === "card" ? null : UNIT_DECIMALS[inv.method]
  const whole = decimals === null ? BigInt(inv.amount) : unitsOf(inv.cryptoAmount!, decimals)
  const open = inv.status === "open"
  // less than the amount on an open invoice is a part payment, which /control/partial makes
  if (open && paid < whole) throw badRequest()
  Object.assign(inv, { amountPaid: Number(paid * BigInt(inv.amount) / whole), paidInFull: paid >= whole, confirmed: true })
  if (decimals !== null) Object.assign(inv, { cryptoAmountPaid: decimalOf(paid, decimals), cryptoAmountDue: decimalOf(paid >= whole ? 0n : whole - paid, decimals) })
  if (open && reg.phase === "unpaid") {
    Object.assign(inv, { status: "paid", settledAt: iso(nowSeconds()), lateUnits: whole })
    const taken = held(reg.labelHash, reg)
    reg.phase = taken ? "taken" : "queued"
    reg.paidAt = nowSeconds()
    if (taken) reg.takenAt = nowSeconds()
    if (taken) credit(reg.id, reg.paid)
    changed(reg)
    if (!taken) void advance(reg)
  }
  if (inv.lateWait === null) creditLate(inv)
}

export function controlInvoice(action: string, invoiceId: string, body: Record<string, unknown>): Record<string, unknown> {
  const inv = invoices.get(invoiceId)
  if (!inv) throw new HttpError(404, "not_found")
  expireIfDue(inv)
  const reg = registrations.get(inv.registrationId)!
  if (action === "settle") {
    settle(inv, reg, settledUnits(inv, body.paid))
  } else if (action === "partial") {
    const half = (Number(inv.cryptoAmount) / 2).toFixed(5)
    Object.assign(inv, { amountPaid: Math.floor(inv.amount / 2), paidInFull: false, confirmed: false, cryptoAmountPaid: half, cryptoAmountDue: (Number(inv.cryptoAmount) - Number(half)).toFixed(5) })
  } else if (action === "confirming") {
    Object.assign(inv, { amountPaid: inv.amount, paidInFull: true, confirmed: false })
    if (inv.method !== "card") Object.assign(inv, { cryptoAmountPaid: inv.cryptoAmount, cryptoAmountDue: "0" })
  } else if (action === "expire") {
    close(inv)
  } else if (action === "overdue") {
    inv.expiresAt = iso(nowSeconds())
  } else throw badRequest()
  wake(reg)
  return { ok: true, status: inv.status }
}

// A balance grown by money from elsewhere, as a later credit to the order (a late payment) grows it.
export function controlCredit(registrationId: string, cents: unknown): Record<string, unknown> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  if (!Number.isInteger(cents) || (cents as number) <= 0) throw badRequest()
  credit(reg.id, cents as number)
  wake(reg)
  return { ok: true, balance: balanceView(reg.id) }
}

// A credit of late money held back as the service's would wait, or let go: what is confirmed then is credited.
export function controlLate(invoiceId: string, waiting: unknown): Record<string, unknown> {
  const inv = invoices.get(invoiceId)
  if (!inv) throw new HttpError(404, "not_found")
  if (waiting !== null && waiting !== "crediting" && waiting !== "support") throw badRequest()
  inv.lateWait = waiting
  const reg = registrations.get(inv.registrationId)!
  if (waiting === null && inv.confirmed && reg.phase === "unpaid") creditLate(inv)
  wake(reg)
  return { ok: true }
}

export function controlRegistration(action: string, registrationId: string): Record<string, unknown> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  if (action === "fail") reg.failNext = true
  else if (action === "stale") reg.staleNext = true
  else if (action === "unread" && reg.phase === "committed" && reg.intent === null) fail(reg, "unread")
  else if (action === "lapse" && reg.phase === "committed") {
    reg.revealBefore = nowSeconds() - 1
    changed(reg)
  } else throw badRequest()
  return { ok: true }
}

export async function controlUnregister(registrationId: string): Promise<Record<string, unknown>> {
  const reg = registrations.get(registrationId)
  if (!reg) throw new HttpError(404, "not_found")
  if (reg.phase !== "registered" || reg.disputeUntil === null) throw badRequest()
  await send(controller, "unregister", [reg.label, BigInt(reg.disputeUntil)], undefined, contractsOwner)
  reg.phase = "ended"
  reg.expiresAt = null
  reg.disputeUntil = null
  changed(reg)
  return { ok: true }
}

// A refund support records, by the order's invoice id or registration id, of the whole balance: the cents given, else all of it.
export function controlRefund(reference: string, cents: unknown): Record<string, unknown> {
  const reg = registrations.get(reference) ?? registrations.get(invoices.get(reference)?.registrationId ?? "")
  if (!reg) throw new HttpError(404, "not_found")
  if (cents !== undefined && (!Number.isInteger(cents) || (cents as number) <= 0)) throw badRequest()
  const b = balances.get(reg.id)
  if (!b || b.amount === 0) throw new HttpError(409, "no_balance")
  const refund = (cents ?? b.amount) as number
  if (refund !== b.amount) throw new HttpError(409, "balance_changed", { balance: balanceView(reg.id) })
  b.amount = 0
  b.refunded += refund
  return { registrationId: reg.id, cents: refund }
}

// The coins' current rates in whole dollars, for late payments; null goes back to the invoice's own rate.
export function controlRate(body: Record<string, unknown>): Record<string, unknown> {
  for (const coin of ["btc", "xmr"] as const) {
    const rate = body[coin]
    if (rate === undefined) continue
    if (rate !== null && !(Number.isInteger(rate) && (rate as number) > 0)) throw badRequest()
    control.rates[coin] = rate === null ? null : BigInt(rate as number) * CENTS_PER_DOLLAR
  }
  return { ok: true }
}

// Registers the label to the test holder before a registration waiting on it, as a rival registrar would.
export function controlTake(label: unknown): Record<string, unknown> {
  if (typeof label !== "string" || labelProblem(label) !== null) throw badRequest()
  const done = (async () => {
    const tuple = { label, owner: holder.address, duration: durationFor(YEARS, TERM_START_S, nowSeconds()), secret: toHex(randomBytes(32)), resolver: deployment.resolver, data: [] as Hex[], reverseRecord: 0, referrer: zeroHash }
    const commitment = await read<Hex>(controller, "makeCommitment", [tuple])
    // committed under the terms of the name's kind, as the policy needs
    const { listed, terms } = await nameTerms(keccak256(toHex(label)))
    await send(namePolicy, listed ? "commitUnderCommunityTerms" : "commitUnderGeneralTerms", [commitment, terms?.hash ?? zeroHash], undefined, holder)
    await untilChainTime(Number(await read<bigint>(controller, "commitments", [commitment])) + deployment.minCommitmentAge, chainNow)
    const turn = holderTurn.then(() => registerForHolder(tuple))
    holderTurn = turn.catch(() => undefined)
    await turn
  })()
  taking.set(label, done.catch((e) => console.error(`control/take ${label} failed:`, e)))
  return { ok: true }
}

// the holder registers one name at a time: each signature needs the nonce the last one spent
let holderTurn: Promise<unknown> = Promise.resolve()

async function registerForHolder(tuple: { label: string; owner: Address; duration: bigint; secret: Hex; resolver: Address; data: Hex[]; reverseRecord: number; referrer: Hex }): Promise<void> {
  const nonce = await read<bigint>(sponsor, "nonces", [holder.address])
  const deadline = BigInt(nowSeconds() + 3600)
  const disputeDays = BigInt(DISPUTE_DAYS.card)
  const signature = await holder.signTypedData({ ...registerNameTypedData(deployment.chainId, deployment.sponsor), message: { ...tuple, disputeDays, nonce, deadline } })
  await send(sponsor, "registerWithCredit", [tuple, disputeDays, nonce, deadline, signature])
}

export function controlSearch(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.chainDown === "boolean") control.chainDown = body.chainDown
  if (typeof body.limitSeconds === "number") control.limitedUntil = Date.now() + body.limitSeconds * 1000
  if (body.invoiceError === null || (typeof body.invoiceError === "string" && body.invoiceError in INVOICE_ERRORS)) control.invoiceError = body.invoiceError
  if (typeof body.findLimitSeconds === "number") control.findLimitedUntil = Date.now() + body.findLimitSeconds * 1000
  if (typeof body.unsentSeconds === "number") control.unsentUntil = Date.now() + body.unsentSeconds * 1000
  if (typeof body.unreadSeconds === "number") control.unreadUntil = Date.now() + body.unreadSeconds * 1000
  if (typeof body.writeDelayMs === "number") control.writeDelayMs = body.writeDelayMs
  const delays = body.fetchDelays
  if (typeof delays === "object" && delays !== null && Object.values(delays).every((ms) => Number.isInteger(ms) && ms >= 0)) control.fetchDelays = delays as Record<string, number>
  return { ok: true }
}

export function controlMismatch(body: Record<string, unknown>): Record<string, unknown> {
  const { price = null, policy = false, termsHash = false } = body
  if ((price !== null && !(Number.isInteger(price) && (price as number) >= 0)) || typeof policy !== "boolean" || typeof termsHash !== "boolean") throw badRequest()
  Object.assign(mismatch, { price, policy, termsHash })
  return { ...mismatch }
}

// The service's mode as a restart with codes_only on or off sets it.
export function controlMode(body: Record<string, unknown>): Record<string, unknown> {
  if (body.mode !== "open" && body.mode !== "codes") throw badRequest()
  control.mode = body.mode
  return { mode: control.mode }
}

export const modeNow = () => ({ mode: control.mode })

export function controlDowntime(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.on !== "boolean") throw badRequest()
  control.downtime = body.on
  return { downtime: control.downtime }
}

export const siteConfig = () => ({
  stripePublishableKey: null,
  names: { codesOnly: control.mode === "codes", chainId: deployment.chainId, resolver: deployment.resolver, sponsor: deployment.sponsor, tld: deployment.tld, termStart: TERM_START_S, downtime: control.downtime },
})

export async function controlClock(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { now } = body
  if (!Number.isInteger(now)) throw badRequest()
  if (await chainNow() > (now as number)) throw new HttpError(409, "chain_ahead")
  await moveChainTo(now as number)
  setClock((now as number) * 1000)
  return { now }
}

export function controlSeed(body: Record<string, unknown>): Record<string, unknown> {
  const { seed } = body
  if (seed !== null && typeof seed !== "string") throw badRequest()
  seedRandom(seed)
  return { seed }
}

// The service's record_edits_per_year as a restart with a new ini sets it, and a name's counted edits: count of them, all
// made at `at` in unix seconds (now when not given), in place of those it has.
export function controlEdits(body: Record<string, unknown>): Record<string, unknown> {
  const { limit, label, count, at } = body
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || (limit as number) < RECORD_EDITS_MIN || (limit as number) > RECORD_EDITS_MAX) throw badRequest()
    editsPerYear = limit as number
  }
  if (label === undefined) return { limit: editsPerYear }
  if (typeof label !== "string" || labelProblem(label) !== null) throw new HttpError(400, "invalid_name")
  if (!Number.isInteger(count) || (count as number) < 0 || (at !== undefined && !Number.isInteger(at))) throw badRequest()
  const hash = keccak256(toHex(label))
  const made = (at as number | undefined) ?? nowSeconds()
  nameEdits.set(hash, Array.from({ length: count as number }, () => made))
  return { limit: editsPerYear, recordEdits: editsLeft(hash) }
}

// A name put on the chain's community list with what it is for in the ini, or taken off both with null, as the owner's
// listing and an edit of the ini and a restart would. A registered name cannot be listed.
export async function controlCommunity(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { label, for: text } = body
  if (typeof label !== "string" || labelProblem(label) !== null) throw new HttpError(400, "invalid_name")
  if (text !== null && (typeof text !== "string" || text.length === 0 || text.length > COMMUNITY_TEXT_MAX || /\p{Cc}/u.test(text))) throw badRequest()
  const hash = keccak256(toHex(label))
  await send(namePolicy, text === null ? "removeCommunityNames" : "addCommunityNames", [[label]], undefined, contractsOwner)
  if (text === null) communities.delete(hash)
  else communities.set(hash, text)
  return { community: (await nameTerms(hash)).listed ? communityEntry(hash) : null }
}

// The terms of a kind on chain changed by the owner: to the link of this text, which this machine serves, to this link as it
// is, or back to the deployed link with a null text.
async function setTerms(setter: string, deployed: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { text, link } = body
  if (link !== undefined ? typeof link !== "string" || link === "" : text !== null && (typeof text !== "string" || text === "")) throw badRequest()
  const next = typeof link === "string" ? link : typeof text === "string" ? savedTerms(text) : deployed
  await send(namePolicy, setter, [next], undefined, contractsOwner)
  return { link: next, hash: keccak256(toHex(next)) }
}

export const controlGeneralTerms = (body: Record<string, unknown>) => setTerms("setGeneralTerms", deployment.generalTermsLink, body)
export const controlCommunityTerms = (body: Record<string, unknown>) => setTerms("setCommunityTerms", deployment.communityTermsLink, body)

// The text of either current terms by their hash, with their link, as the service fetches it.
export async function currentTerms(hash: string): Promise<Record<string, unknown>> {
  if (!isHash(hash)) throw badRequest()
  const terms = (await policyLinks().catch(unavailable)).map(termsOf).find((t) => t?.hash === hash)
  const text = terms ? await termsText(terms) : null
  if (!terms || text === null) throw new HttpError(404, "not_found")
  return { link: terms.link, text }
}

export function dump(): unknown {
  return {
    registrations: [...registrations.values()].map((r) => ({ ...r, intent: r.intent && { ...r.intent, nonce: String(r.intent.nonce), deadline: String(r.intent.deadline) } })),
    invoices: [...invoices.values()], balances: Object.fromEntries(balances),
  }
}

