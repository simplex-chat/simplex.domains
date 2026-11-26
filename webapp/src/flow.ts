// The order flows, between the views and the crypto: build an order, reveal it, select a name for it, restore, edit links.
import * as api from "./api.ts"
import { heldPrice, SITE } from "./config.ts"
import { formatOwnerCode, parseNameCode } from "./crypto/code.ts"
import {
  acceptTermsDigest, CHANNEL_KEY, CONTACT_KEY, commitmentSecret, durationFor, labelHash, makeCommitment, namehash, registerIntentDigest, setTextDigest,
  type Registration,
} from "./crypto/registration.ts"
import { seal, unseal } from "./crypto/seal.ts"
import { checksumAddress, fromHex, hex, personalDigest, signDigest, walletFromEntropy, type Wallet } from "./crypto/wallet.ts"
import * as store from "./store.ts"

const EDIT_DEADLINE_SECONDS = 3600
const REVEAL_DEADLINE_SECONDS = 7 * 86400
const DISPUTE_DAYS: Record<store.OrderRecord["method"], number> = { card: 120, btc: 14, xmr: 14, code: 14 }

// signed timestamps and deadlines are judged by the service's clock
const now = api.serviceSeconds

export const newOwnerCode = () => formatOwnerCode(crypto.getRandomValues(new Uint8Array(16)))

const wallets = new Map<string, Wallet | null>()

export function walletOf(code: string): Wallet | null {
  if (!wallets.has(code)) {
    const parsed = parseNameCode(code)
    wallets.set(code, parsed?.kind === "owner" ? walletFromEntropy(parsed.entropy) : null)
  }
  return wallets.get(code)!
}

export const forgetWallets = () => wallets.clear()

function registrationOf(label: string, owner: Uint8Array, secret: Uint8Array, links: api.Links, duration: bigint): Registration {
  return {
    label, tld: SITE.tld, owner, duration, secret, resolver: fromHex(SITE.resolver),
    contactLink: links.contact || null, channelLink: links.channel || null,
  }
}

export interface Draft {
  label: string
  links: api.Links
  years: number
  ownerCode: string
  terms: string
  method: store.OrderRecord["method"]
}

export type Available = Extract<api.Found, { type: "available" }> & { community: api.Community | null }
export type Quote = Available & { terms: api.Terms }
export const orderable = (a: Available): a is Quote => a.terms !== null && a.years === SITE.paidYears && (a.community === null || a.community.years === SITE.communityYears)
export const availableOf = ({ found, community }: api.SearchAnswer): Available | null => found.type === "available" ? { ...found, community } : null

// The name's search answer as an order needs it, or null when it can no longer be ordered.
export async function quoteOf(label: string): Promise<Quote | null> {
  const available = availableOf(await api.searchName(hex(labelHash(label)), label.length))
  if (available === null) return null
  if (!orderable(available) || available.price !== heldPrice(label.length)) throw new api.ApiError("terms_unavailable", 503, null, {})
  return available
}

// An order of a record's name and links again, as a new order of its code: a new commitment for the term from now.
export const draftAgain = (record: store.OrderRecord, quote: Quote, terms: string, method: api.Method): Draft =>
  ({ label: record.label, links: { contact: record.contact, channel: record.channel }, years: api.termYears(quote.community, quote.years), ownerCode: record.ownerCode, terms, method })

export type BuiltOrder = { request: api.SignedOrder; owner: string }

export class Unsignable extends Error {}

const heldAcceptance = (a: api.Acceptance) => a.policy.toLowerCase() === SITE.namePolicy.toLowerCase() && api.heldTerms(a.termsHash, a.community) !== undefined
const agreedTo = (a: api.Acceptance, agreed: string | undefined) => a.termsHash === api.signedHash(agreed) && a.community === api.communityAgreed(agreed)

// The order and its owner's signature over it, which proves that the code's wallet placed it, with the signed registration
// and terms acceptance the service registers with after payment.
export async function orderRequest(draft: Draft): Promise<BuiltOrder> {
  const wallet = walletOf(draft.ownerCode)!
  const timestamp = now()
  const duration = durationFor(draft.years, SITE.termStart, timestamp)
  const r = registrationOf(draft.label, wallet.address, commitmentSecret(wallet.seed, draft.label), draft.links, duration)
  const commitment = makeCommitment(r)
  const sealed = await seal(wallet.seed, { label: draft.label, ...draft.links, method: draft.method })
  const owner = checksumAddress(wallet.address)
  const order = { labelHash: hex(labelHash(draft.label)), length: draft.label.length, duration: Number(duration), owner, commitment: hex(commitment), sealed, terms: draft.terms }
  const toSign = await api.signFor(order.labelHash, owner)
  const acceptance = { ...toSign.acceptance, community: api.communityAgreed(draft.terms), termsHash: api.signedHash(draft.terms) ?? "" }
  if (!heldAcceptance(toSign.acceptance) || !heldAcceptance(acceptance)) throw new Unsignable()
  const reveal = signedReveal(wallet, r, commitment, { ...toSign, acceptance }, draft.method)
  const message = `simplex.domains order ${order.labelHash} ${order.length} ${order.duration} ${order.commitment} ${await sha256Hex(sealed)} ${order.terms} ${timestamp}`
  return { request: { ...order, timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(message))), reveal }, owner }
}

function signedReveal(wallet: Wallet, r: Registration, commitment: Uint8Array, toSign: api.ToSignRead, method: store.OrderRecord["method"]): api.RevealBody {
  const deadline = now() + REVEAL_DEADLINE_SECONDS
  const digest = registerIntentDigest(BigInt(SITE.chainId), fromHex(SITE.sponsor), r, BigInt(DISPUTE_DAYS[method]), BigInt(toSign.intentNonce), BigInt(deadline))
  const a = toSign.acceptance
  const acceptance = {
    termsHash: a.termsHash, nonce: a.nonce,
    signature: hex(signDigest(wallet.privateKey, acceptTermsDigest(a.community, BigInt(SITE.chainId), fromHex(SITE.namePolicy), commitment, fromHex(a.termsHash), BigInt(a.nonce), BigInt(deadline)))),
  }
  return {
    label: r.label, secret: hex(r.secret), records: { contact: r.contactLink, channel: r.channelLink },
    nonce: toSign.intentNonce, deadline, signature: hex(signDigest(wallet.privateKey, digest)), acceptance,
  }
}

export const payeeOf = (inv: api.InvoiceView): Pick<store.OrderRecord, "address" | "addressProof"> => ({ address: inv.address, addressProof: inv.addressProof })

export function recordFor(draft: Draft, built: BuiltOrder, method: store.OrderRecord["method"], paid: number, ids: { registrationId: string; invoiceId: string | null }): store.OrderRecord {
  return {
    ...ids, label: draft.label, ownerCode: draft.ownerCode, owner: built.owner, ...draft.links, method, paid, years: draft.years,
    request: built.request, terms: draft.terms, tld: SITE.tld, createdAt: new Date(api.serviceNow()).toISOString(),
  }
}

export function revealFor(record: Pick<store.OrderRecord, "label" | "contact" | "channel" | "ownerCode" | "method" | "request">, view: api.RegistrationView, toSign: api.ToSignRead, agreed: string | undefined): api.RevealBody {
  if (view.duration !== record.request.duration || !heldAcceptance(toSign.acceptance) || !agreedTo(toSign.acceptance, agreed)) throw new Unsignable()
  const wallet = walletOf(record.ownerCode)!
  const r = registrationOf(record.label, wallet.address, commitmentSecret(wallet.seed, record.label), record, BigInt(record.request.duration))
  return signedReveal(wallet, r, makeCommitment(r), toSign, record.method)
}

export async function revealOrder(view: api.RegistrationView, record: store.OrderRecord, agreed: string | undefined): Promise<void> {
  const toSign = api.toSignOf(view)
  if (toSign?.type !== "read") throw new Error("the order's view has nothing read to sign")
  await api.reveal(view.id, revealFor(record, view, toSign, agreed))
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return hex(new Uint8Array(digest))
}

// A name selected for an order whose name was taken first, built on the same wallet so the same code owns it.
export async function selectName(record: store.OrderRecord, draft: Draft, built: BuiltOrder): Promise<api.RegistrationView> {
  const { label, links, terms } = draft
  const wallet = walletOf(record.ownerCode)!
  const timestamp = now()
  const { labelHash: lh, length, duration, commitment, sealed } = built.request
  const message = `simplex.domains name ${record.registrationId} ${lh} ${length} ${duration} ${commitment} ${await sha256Hex(sealed)} ${terms} ${timestamp}`
  const view = await api.selectName(record.registrationId, { labelHash: lh, length, duration, commitment, sealed, terms, timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(message))), reveal: built.request.reveal })
  store.saveOrder({ ...record, label, ...links, paid: view.price, request: built.request, terms })
  return view
}

type RestoreResult = { record: store.OrderRecord; view: api.RegistrationView }

// The order's name and links, and the payment it asked for once that is sealed too, unsealed with the code, after checking
// that they rebuild the order's commitment.
async function openOrder(wallet: Wallet, view: api.RegistrationView): Promise<Pick<store.OrderRecord, "label" | "contact" | "channel" | "request" | "terms"> & Partial<Pick<store.OrderRecord, "method">>> {
  const opened = await unseal(wallet.seed, view.sealed)
  if (!opened) throw new Error("the code does not open this order")
  const r = registrationOf(opened.label, wallet.address, commitmentSecret(wallet.seed, opened.label), opened, BigInt(view.duration))
  if (hex(makeCommitment(r)) !== view.commitment) throw new Error("the order's commitment does not match the code")
  const request = { labelHash: hex(labelHash(opened.label)), length: opened.label.length, duration: view.duration, owner: checksumAddress(wallet.address), commitment: view.commitment, sealed: view.sealed }
  return { label: opened.label, contact: opened.contact, channel: opened.channel, request, terms: api.signedTermsOf(view.terms), ...opened.method ? { method: opened.method } : {} }
}

// A name selected for the order elsewhere (another browser, or a selection whose answer was lost) is read back from the
// service.
export async function syncRecord(record: store.OrderRecord, view: api.RegistrationView): Promise<store.OrderRecord | null> {
  if (view.commitment === record.request.commitment) return record
  try {
    const synced = { ...record, ...await openOrder(walletOf(record.ownerCode)!, view), paid: view.price }
    store.saveOrder(synced)
    return synced
  } catch {
    return null
  }
}

type Found = api.FoundOrder

// The code's orders, newest first, asked with a signature of the code's key. A fresh page has not yet heard the
// service's clock; a refusal that sets it is signed once more.
async function findOrders(wallet: Wallet): Promise<Found[]> {
  const owner = checksumAddress(wallet.address)
  const ask = () => {
    const timestamp = now()
    const signature = hex(signDigest(wallet.privateKey, personalDigest(`simplex.domains find ${owner.toLowerCase()} ${timestamp}`)))
    return api.findRegistrations(owner, timestamp, signature)
  }
  const clock = api.clockVersion()
  try {
    return (await ask()).registrations
  } catch (e) {
    if (e instanceof api.ApiError && e.code === "bad_request" && api.clockVersion() !== clock) return (await ask()).registrations
    throw e
  }
}

export interface CodeOrder { code: string; name: string; order: Found }

// The order a name code restores, as chooseOrder picks it among the orders find lists whose sealed name opens with the
// code and hashes to the order's label hash, with its name; "none" when find lists no order, "other" when it lists only
// orders of another code.
export async function codeOrderOf(text: string): Promise<CodeOrder | "none" | "other"> {
  const parsed = parseNameCode(text)
  if (parsed?.kind !== "owner") throw new Error("not an owner code")
  const wallet = walletFromEntropy(parsed.entropy)
  const listed = await findOrders(wallet)
  if (listed.length === 0) return "none"
  const opened = await Promise.all(listed.map(async (found) => ({ found, sealed: await unseal(wallet.seed, found.sealed) })))
  const open = opened.filter(({ found, sealed }) => sealed !== null && hex(labelHash(sealed.label)) === found.labelHash)
  if (open.length === 0) return "other"
  const order = chooseOrder(open.map(({ found }) => found))
  return { code: formatOwnerCode(parsed.entropy), name: open.find(({ found }) => found === order)!.sealed!.label, order }
}

export const addOrder = async ({ code, order }: CodeOrder) => (await reopen(walletOf(code)!, code, order)).record

// one paid into a registration is the order; otherwise the newest
const chooseOrder = (found: Found[]) => found.find((r) => r.phase !== "unpaid" && r.phase !== "closed") ?? found[0]

// The owner code alone finds its orders and reopens the newest, checking that the code really owns it; null when find
// lists no order.
export async function restore(text: string): Promise<RestoreResult | null> {
  const parsed = parseNameCode(text)
  if (parsed?.kind !== "owner") throw new Error("not an owner code")
  const code = formatOwnerCode(parsed.entropy)
  const wallet = walletFromEntropy(parsed.entropy)
  const found = await findOrders(wallet)
  return found.length === 0 ? null : reopen(wallet, code, chooseOrder(found))
}

// The order of this code for a name that a new order met, which find lists: one on its way, else the newest unpaid one.
export async function ownOrderFor(ownerCode: string, nameHash: string): Promise<store.OrderRecord | null> {
  const wallet = walletOf(ownerCode)!
  const found = (await findOrders(wallet)).filter((r) => r.labelHash === nameHash)
  const chosen = found.find((r) => !["unpaid", "closed", "ended", "taken"].includes(r.phase)) ?? found.find((r) => r.phase === "unpaid")
  return chosen ? (await reopen(wallet, ownerCode, chosen)).record : null
}

export async function orderOfCodes(id: string): Promise<store.OrderRecord | null> {
  for (const code of new Set(store.orders().map((o) => o.ownerCode))) {
    const wallet = walletOf(code)
    if (!wallet) continue
    const found = (await findOrders(wallet)).find((r) => r.invoiceId === id || r.registrationId === id)
    if (!found) continue
    const { record } = await reopen(wallet, code, found)
    if (found.phase === "closed") await newerOrder(record)
    return store.orderByRegistration(record.registrationId) ?? record
  }
  return null
}

// orders this tab found nothing newer for; find has its own rate limit, so each is asked once
const nothingNewer = new Set<string>()

// An order this browser holds may have a newer invoice that another browser made; the code finds it, and the old
// record then leads there. Null when there is none; a failure to ask throws, so the caller can ask again.
export async function newerOrder(record: store.OrderRecord): Promise<store.OrderRecord | null> {
  const wallet = walletOf(record.ownerCode)
  if (!wallet || nothingNewer.has(record.registrationId)) return null
  const none = () => {
    nothingNewer.add(record.registrationId)
    return null
  }
  const found = await findOrders(wallet)
  // Orders listed before this one are newer; one the service has forgotten is not listed, so then only orders made after
  // it count, by the service's clock. Never the one this record replaced, which would lead straight back here.
  const at = found.findIndex((r) => r.registrationId === record.registrationId)
  const self = store.orderUrl(record)
  const newer = (at >= 0 ? found.slice(0, at) : found.filter((r) => Date.parse(r.createdAt) > Date.parse(record.createdAt)))
    .filter((r) => store.orderByRegistration(r.registrationId)?.replacedBy !== self)
  if (newer.length === 0) return none()
  const { record: next } = await reopen(wallet, record.ownerCode, chooseOrder(newer))
  store.updateOrder(record.registrationId, { replacedBy: store.orderUrl(next) })
  return next
}

const signerOf = (wallet: Wallet): api.OrderSigner => (id, action) => {
  const timestamp = now()
  return { timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(`simplex.domains order ${id} ${action} ${timestamp}`))) }
}
export const orderSigner = (ownerCode: string): api.OrderSigner => signerOf(walletOf(ownerCode)!)

async function reopen(wallet: Wallet, code: string, chosen: Found): Promise<RestoreResult> {
  const owner = checksumAddress(wallet.address)
  const sign = signerOf(wallet)
  const invoice = chosen.invoiceId ? await api.readInvoice(chosen.invoiceId, sign) : null
  const view = invoice?.registration ?? await api.readRegistration(chosen.registrationId, sign)
  const opened = await openOrder(wallet, view)
  // what only this browser knew about the order (a card in confirmation, a cancel, the prepaid code that paid) is kept
  const known = store.orderByRegistration(view.id)
  const record: store.OrderRecord = {
    ...known, registrationId: view.id, invoiceId: chosen.invoiceId, ownerCode: code, owner, ...opened,
    method: known?.method ?? opened.method ?? (view.payment.type === "invoice" ? view.payment.method : view.payment.type), paid: view.price, years: view.years,
    tld: SITE.tld, createdAt: chosen.createdAt,
  }
  store.saveOrder(record)
  return { record, view }
}

export const KEYS = { contact: CONTACT_KEY, channel: CHANNEL_KEY } as const

// One signed SetText per changed key, in one request the service relays as one transaction. The resolver takes an
// owner's intents only in nonce order, so the second is signed with the nonce the first spends.
export async function saveLinks(record: store.OrderRecord, nonce: number, changes: Partial<api.Links>): Promise<string | null> {
  const wallet = walletOf(record.ownerCode)!
  const node = namehash(SITE.tld, record.label)
  const deadline = now() + EDIT_DEADLINE_SECONDS
  const edits = api.LINK_KINDS.filter((kind) => changes[kind] !== undefined).map((kind, i) => {
    const value = changes[kind]!
    const digest = setTextDigest(BigInt(SITE.chainId), fromHex(SITE.resolver), node, KEYS[kind], value, BigInt(nonce + i), BigInt(deadline))
    return { key: kind, value, nonce: nonce + i, deadline, signature: hex(signDigest(wallet.privateKey, digest)) }
  })
  const { tx } = await api.editRecords({ labelHash: hex(labelHash(record.label)), edits })
  return tx
}

