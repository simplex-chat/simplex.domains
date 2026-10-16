// The order flows, between the views and the crypto: build an order, reveal it, retarget it, take a code, restore, edit links.
import * as api from "./api.ts"
import { codeHash, formatOwnerCode, parseNameCode, takenOrderCode } from "./crypto/code.ts"
import {
  CHANNEL_KEY, CONTACT_KEY, commitmentSecret, durationFor, labelHash, makeCommitment, namehash, registerIntentDigest, setTextDigest,
  type Registration,
} from "./crypto/registration.ts"
import { seal, unseal } from "./crypto/seal.ts"
import { checksumAddress, fromHex, hex, personalDigest, signDigest, walletFromEntropy, type Wallet } from "./crypto/wallet.ts"
import * as store from "./store.ts"

// how long a signed link edit stays valid
const EDIT_DEADLINE_SECONDS = 3600

// signed timestamps and deadlines are judged by the service's clock
const now = () => Math.floor(api.serviceNow() / 1000)

export function newOwnerCode(): string {
  return formatOwnerCode(crypto.getRandomValues(new Uint8Array(16)))
}

export function walletOf(code: string): Wallet | null {
  const parsed = parseNameCode(code)
  return parsed?.kind === "owner" ? walletFromEntropy(parsed.entropy) : null
}

export interface Links {
  contact: string
  channel: string
}

function registrationOf(label: string, owner: Uint8Array, secret: Uint8Array, links: Links, chain: api.ChainInfo, years: number): Registration {
  return {
    label, tld: chain.tld, owner, duration: durationFor(years), secret, resolver: fromHex(chain.resolver),
    contactLinks: links.contact ? [links.contact] : [], channelLinks: links.channel ? [links.channel] : [],
  }
}

export interface Draft {
  label: string
  links: Links
  chain: api.ChainInfo
  years: number
  ownerCode: string | null
  // an order opened from the app: its wallet's address, and the secret this page keeps for it
  appOwner?: string
  appSecret?: string
}

export type BuiltOrder = { request: api.OrderRequest; owner: string; secret: string | null }

export async function orderRequest(draft: Draft): Promise<BuiltOrder> {
  if (draft.appOwner) {
    const secret = draft.appSecret!
    const r = registrationOf(draft.label, fromHex(draft.appOwner), fromHex(secret), draft.links, draft.chain, draft.years)
    return { request: { labelHash: hex(labelHash(draft.label)), length: draft.label.length, owner: draft.appOwner, commitment: hex(makeCommitment(r)), sealed: null }, owner: draft.appOwner, secret }
  }
  const wallet = walletOf(draft.ownerCode!)!
  const r = registrationOf(draft.label, wallet.address, commitmentSecret(wallet.seed, draft.label), draft.links, draft.chain, draft.years)
  const sealed = await seal(wallet.seed, { label: draft.label, ...draft.links })
  const owner = checksumAddress(wallet.address)
  return { request: { labelHash: hex(labelHash(draft.label)), length: draft.label.length, owner, commitment: hex(makeCommitment(r)), sealed }, owner, secret: null }
}

// An order can be answered with the commitment's existing order, paid another way or by code.
export function paidWith(res: api.CreatedOrder): { method: api.Method | "code"; paid: number } {
  return res.invoiceId ? { method: res.cryptoCurrency ?? "card", paid: res.amount } : { method: "code", paid: 0 }
}

export function recordFor(draft: Draft, built: BuiltOrder, method: api.Method | "code", paid: number, ids: { registrationId: string; invoiceId: string | null }): store.OrderRecord {
  return {
    ...ids, label: draft.label, ownerCode: draft.ownerCode, owner: built.owner, ...draft.links, method, paid, years: draft.years,
    secret: built.secret, request: built.request, tld: draft.chain.tld, createdAt: new Date(api.serviceNow()).toISOString(),
  }
}

// The owner signs the registration once the commit has aged; the deadline is when the commitment lapses anyway.
export async function revealOrder(view: api.RegistrationView, record: store.OrderRecord): Promise<void> {
  const wallet = walletOf(record.ownerCode!)!
  const r = registrationOf(record.label, wallet.address, commitmentSecret(wallet.seed, record.label), record, view, record.years)
  const digest = registerIntentDigest(BigInt(view.chainId), fromHex(view.sponsor), r, BigInt(view.intentNonce!), BigInt(view.revealBefore!))
  await api.reveal(view.id, {
    label: record.label, secret: hex(r.secret),
    records: { contact: r.contactLinks, channel: r.channelLinks },
    nonce: view.intentNonce!, deadline: view.revealBefore!, signature: hex(signDigest(wallet.privateKey, digest)),
  })
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return hex(new Uint8Array(digest))
}

// Another name for a taken order, registered to the same wallet, so the same code owns it.
// The order takes the new name's price, as the service answers it, which caps any later move.
export async function retargetOrder(record: store.OrderRecord, label: string, links: Links, chain: api.ChainInfo): Promise<api.RegistrationView> {
  const draft: Draft = { label, links, chain, years: record.years, ownerCode: record.ownerCode }
  const built = await orderRequest(draft)
  const wallet = walletOf(record.ownerCode!)!
  const timestamp = now()
  const { labelHash: lh, length, commitment, sealed } = built.request
  const message = `simplex.domains name ${record.registrationId} ${lh} ${length} ${commitment} ${await sha256Hex(sealed!)} ${timestamp}`
  const view = await api.retarget(record.registrationId, { ...built.request, timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(message))) })
  store.saveOrder({ ...record, label, ...links, paid: view.price, request: built.request })
  return view
}

// A code for a taken order, derived from the owner code, so the code alone recovers it; only its hash is sent.
export async function takeCodeFor(record: store.OrderRecord, view: api.RegistrationView): Promise<string> {
  const wallet = walletOf(record.ownerCode!)!
  const code = takenOrderCode(wallet.seed, view.id, record.label.length)
  const hash = codeHash(code.canonical)
  const timestamp = now()
  const signature = hex(signDigest(wallet.privateKey, personalDigest(`simplex.domains code ${view.id} ${hash} ${timestamp}`)))
  await api.takeCode(view.id, { codeHash: hash, timestamp, signature })
  store.updateOrder(record.registrationId, { takenCode: code.display })
  store.addCode({ code: code.display, minLength: code.minLength, years: 2, addedAt: new Date().toISOString() })
  return code.display
}

export function takenCodeOf(record: store.OrderRecord, registrationId: string): string {
  const wallet = walletOf(record.ownerCode!)!
  return takenOrderCode(wallet.seed, registrationId, record.label.length).display
}

export type RestoreResult = { record: store.OrderRecord; view: api.RegistrationView }

// The order's name and links, unsealed with the code, after checking that they rebuild the order's commitment.
async function openOrder(wallet: Wallet, view: api.RegistrationView): Promise<Pick<store.OrderRecord, "label" | "contact" | "channel" | "request">> {
  const opened = view.sealed ? await unseal(wallet.seed, view.sealed) : null
  if (!opened) throw new Error("the code does not open this order")
  const r = registrationOf(opened.label, wallet.address, commitmentSecret(wallet.seed, opened.label), opened, view, view.years)
  if (hex(makeCommitment(r)) !== view.commitment) throw new Error("the order's commitment does not match the code")
  const request = { labelHash: view.labelHash, length: opened.label.length, owner: checksumAddress(wallet.address), commitment: view.commitment, sealed: view.sealed }
  return { label: opened.label, contact: opened.contact, channel: opened.channel, request }
}

// An order moved to another name elsewhere (another browser, or a retarget whose answer was lost) is read back from the service.
export async function syncRecord(record: store.OrderRecord, view: api.RegistrationView): Promise<store.OrderRecord | null> {
  if (view.commitment === record.request.commitment) return record
  if (!record.ownerCode) return null
  try {
    const synced = { ...record, ...await openOrder(walletOf(record.ownerCode)!, view), paid: view.price }
    store.saveOrder(synced)
    return synced
  } catch {
    return null
  }
}

export const orderUrl = (o: { invoiceId: string | null; registrationId: string }) =>
  o.invoiceId ? `/?order=${o.invoiceId}` : `/?registration=${o.registrationId}`

type Found = Awaited<ReturnType<typeof api.findRegistrations>>["registrations"][number]

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

// one paid into a registration is the order; otherwise the newest
const chooseOrder = (found: Found[]) => found.find((r) => r.phase !== "unpaid") ?? found[0]

// The owner code alone finds its orders and reopens the newest, checking that the code really owns it.
export async function restore(text: string): Promise<RestoreResult> {
  const parsed = parseNameCode(text)
  if (parsed?.kind !== "owner") throw new Error("not an owner code")
  const code = formatOwnerCode(parsed.entropy)
  const wallet = walletFromEntropy(parsed.entropy)
  return reopen(wallet, code, chooseOrder(await findOrders(wallet)))
}

// orders this tab found nothing newer for; find has its own rate limit, so each is asked once
const nothingNewer = new Set<string>()

// An order this browser holds may have a newer invoice that another browser made; the code finds it, and the old
// record then leads there. Null when there is none; a failure to ask throws, so the caller can ask again.
export async function newerOrder(record: store.OrderRecord): Promise<store.OrderRecord | null> {
  const wallet = record.ownerCode ? walletOf(record.ownerCode) : null
  if (!wallet || nothingNewer.has(record.registrationId)) return null
  const none = () => {
    nothingNewer.add(record.registrationId)
    return null
  }
  let found: Found[]
  try {
    found = await findOrders(wallet)
  } catch (e) {
    // the code has no orders left at all
    if (e instanceof api.ApiError && e.code === "not_found") return none()
    throw e
  }
  // Orders listed before this one are newer; one the service has forgotten is not listed, so then only orders made after
  // it count, by the service's clock. Never the one this record replaced, which would lead straight back here.
  const at = found.findIndex((r) => r.registrationId === record.registrationId)
  const self = orderUrl(record)
  const newer = (at >= 0 ? found.slice(0, at) : found.filter((r) => Date.parse(r.createdAt) > Date.parse(record.createdAt)))
    .filter((r) => store.orderByRegistration(r.registrationId)?.replacedBy !== self)
  if (newer.length === 0) return none()
  const { record: next } = await reopen(wallet, record.ownerCode!, chooseOrder(newer))
  store.updateOrder(record.registrationId, { replacedBy: orderUrl(next) })
  return next
}

// When the service made one of the code's orders; the page learns an order it adopts only from its invoice, which
// does not say. Null when the service does not list it.
export async function createdAtOf(record: store.OrderRecord, registrationId: string): Promise<string | null> {
  const wallet = record.ownerCode ? walletOf(record.ownerCode) : null
  if (!wallet) return null
  return (await findOrders(wallet)).find((r) => r.registrationId === registrationId)?.createdAt ?? null
}

async function reopen(wallet: Wallet, code: string, chosen: Found): Promise<RestoreResult> {
  const owner = checksumAddress(wallet.address)
  const invoice = chosen.invoiceId ? await api.readInvoice(chosen.invoiceId) : null
  const view = invoice?.registration ?? await api.readRegistration(chosen.registrationId)
  const opened = await openOrder(wallet, view)
  // what only this browser knew about the order (a card in confirmation, a cancel, a taken code) is kept
  const known = store.orderByRegistration(view.id)
  const record: store.OrderRecord = {
    ...known, registrationId: view.id, invoiceId: chosen.invoiceId, ownerCode: code, owner, ...opened,
    method: invoice ? invoice.cryptoCurrency ?? "card" : "code", paid: view.price, years: view.years, secret: null,
    tld: view.tld, createdAt: chosen.createdAt,
  }
  store.saveOrder(record)
  return { record, view }
}

export const KEYS = { contact: CONTACT_KEY, channel: CHANNEL_KEY } as const

// One signed SetText per changed key, sent one at a time: each needs the nonce the previous one spent.
export async function saveLinks(record: store.OrderRecord, chain: { chainId: number; resolver: string; tld: string }, nonce: number, changes: Partial<Links>, saved: (kind: keyof Links) => void): Promise<string[]> {
  const wallet = walletOf(record.ownerCode!)!
  const node = namehash(chain.tld, record.label)
  const lh = hex(labelHash(record.label))
  const txs: string[] = []
  let next = nonce
  for (const kind of ["contact", "channel"] as const) {
    const value = changes[kind]
    if (value === undefined) continue
    const deadline = now() + EDIT_DEADLINE_SECONDS
    const digest = setTextDigest(BigInt(chain.chainId), fromHex(chain.resolver), node, KEYS[kind], value, BigInt(next), BigInt(deadline))
    const { tx } = await api.editRecord({ labelHash: lh, key: KEYS[kind], value, nonce: next, deadline, signature: hex(signDigest(wallet.privateKey, digest)) })
    if (tx) txs.push(tx)
    saved(kind)
    next += 1
  }
  return txs
}

