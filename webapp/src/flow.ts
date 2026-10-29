// The order flows, between the views and the crypto: build an order, reveal it, retarget it, spend a balance, restore, edit links.
import * as api from "./api.ts"
import { formatOwnerCode, parseNameCode } from "./crypto/code.ts"
import {
  CHANNEL_KEY, CONTACT_KEY, commitmentSecret, durationFor, labelHash, makeCommitment, namehash, registerIntentDigest, setTextDigest,
  type Registration,
} from "./crypto/registration.ts"
import { seal, unseal } from "./crypto/seal.ts"
import { checksumAddress, fromHex, hex, personalDigest, signDigest, walletFromEntropy, type Wallet } from "./crypto/wallet.ts"
import * as store from "./store.ts"

const EDIT_DEADLINE_SECONDS = 3600

// signed timestamps and deadlines are judged by the service's clock
const now = api.serviceSeconds

export const newOwnerCode = () => formatOwnerCode(crypto.getRandomValues(new Uint8Array(16)))

export function walletOf(code: string): Wallet | null {
  const parsed = parseNameCode(code)
  return parsed?.kind === "owner" ? walletFromEntropy(parsed.entropy) : null
}

function registrationOf(label: string, owner: Uint8Array, secret: Uint8Array, links: api.Links, chain: api.ChainInfo, duration: bigint): Registration {
  return {
    label, tld: chain.tld, owner, duration, secret, resolver: fromHex(chain.resolver),
    contactLinks: links.contact ? [links.contact] : [], channelLinks: links.channel ? [links.channel] : [],
  }
}

export interface Draft {
  label: string
  links: api.Links
  chain: api.ChainInfo
  years: number
  termStart: number
  ownerCode: string
  terms: string
}

export type Quote = Extract<api.SearchAnswer, { status: "available" }>
export const chainOf = (q: api.ChainInfo): api.ChainInfo => ({ resolver: q.resolver, sponsor: q.sponsor, chainId: q.chainId, tld: q.tld })

// The name's search answer as an order needs it, or null when it can no longer be ordered.
export async function quoteOf(label: string): Promise<Quote | null> {
  const answer = await api.searchName(hex(labelHash(label)), label.length)
  return answer.status === "available" ? answer : null
}

// An order of a record's name and links again, as a new order of its code: a new commitment for the term from now.
export const draftAgain = (record: store.OrderRecord, quote: Quote, terms: string): Draft =>
  ({ label: record.label, links: { contact: record.contact, channel: record.channel }, chain: chainOf(quote), years: record.years, termStart: quote.termStart, ownerCode: record.ownerCode, terms })

export type BuiltOrder = { request: api.SignedOrder; owner: string }

// The order and its owner's signature over it, which proves that the code's wallet placed it.
export async function orderRequest(draft: Draft): Promise<BuiltOrder> {
  const wallet = walletOf(draft.ownerCode)!
  const timestamp = now()
  const duration = durationFor(draft.years, draft.termStart, timestamp)
  const r = registrationOf(draft.label, wallet.address, commitmentSecret(wallet.seed, draft.label), draft.links, draft.chain, duration)
  const sealed = await seal(wallet.seed, { label: draft.label, ...draft.links })
  const owner = checksumAddress(wallet.address)
  const order = { labelHash: hex(labelHash(draft.label)), length: draft.label.length, duration: Number(duration), owner, commitment: hex(makeCommitment(r)), sealed, terms: draft.terms }
  const message = `simplex.domains order ${order.labelHash} ${order.length} ${order.duration} ${order.commitment} ${await sha256Hex(sealed)} ${order.terms} ${timestamp}`
  return { request: { ...order, timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(message))) }, owner }
}

// what the order is worth, which for an invoice of a difference is more than the invoice
export const paidWith = (res: api.InvoiceView): { method: api.Method; paid: number } => ({ method: res.cryptoCurrency ?? "card", paid: res.registration.price })

export function recordFor(draft: Draft, built: BuiltOrder, method: store.OrderRecord["method"], paid: number, ids: { registrationId: string; invoiceId: string | null }): store.OrderRecord {
  return {
    ...ids, label: draft.label, ownerCode: draft.ownerCode, owner: built.owner, ...draft.links, method, paid, years: draft.years,
    request: built.request, terms: draft.terms, tld: draft.chain.tld, createdAt: new Date(api.serviceNow()).toISOString(),
  }
}

// The owner signs the registration once the commit has aged; the deadline is when the commitment lapses anyway.
export async function revealOrder(view: api.RegistrationView, record: store.OrderRecord): Promise<void> {
  const wallet = walletOf(record.ownerCode)!
  const r = registrationOf(record.label, wallet.address, commitmentSecret(wallet.seed, record.label), record, view, BigInt(view.duration))
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

// Another name, or other links, for a failed order or one whose links were refused, on the same wallet so the same code
// owns it, at the new name's price, which caps any later move.
export async function retargetOrder(record: store.OrderRecord, label: string, links: api.Links, quote: Quote, terms: string): Promise<api.RegistrationView> {
  const draft: Draft = { label, links, chain: chainOf(quote), years: record.years, termStart: quote.termStart, ownerCode: record.ownerCode, terms }
  const built = await orderRequest(draft)
  const wallet = walletOf(record.ownerCode)!
  const timestamp = now()
  const { labelHash: lh, length, duration, commitment, sealed } = built.request
  const message = `simplex.domains name ${record.registrationId} ${lh} ${length} ${duration} ${commitment} ${await sha256Hex(sealed)} ${terms} ${timestamp}`
  const view = await api.retarget(record.registrationId, { labelHash: lh, length, duration, commitment, sealed, terms, timestamp, signature: hex(signDigest(wallet.privateKey, personalDigest(message))) })
  store.saveOrder({ ...record, label, ...links, paid: view.price, request: built.request, terms, linksRefused: undefined })
  return view
}

// what an order from a balance needs of the name's search answer: its price and term, and the chain
export type Priced = Pick<Quote, "price" | "years" | "termStart"> & api.ChainInfo

export type BuiltSpend = BuiltOrder & { spend: api.SpendRequest }
// the order whose balance pays, and its name code, which signs the spend
export type BalanceSource = Pick<store.OrderRecord, "registrationId" | "ownerCode">

// the order of another name under the record's code, as the service makes the paying order's owner the new order's
export const spendDraft = (record: BalanceSource, label: string, links: api.Links, quote: Priced, terms: string): Draft =>
  ({ label, links, chain: chainOf(quote), years: quote.years, termStart: quote.termStart, ownerCode: record.ownerCode, terms })

// Another name paid from the record's balance as the page read it, `draft` being spendDraft's: the order and the spend,
// signed by the record's code. When the balance does not cover the price, all of it pays and an invoice in `method` is
// made for the rest.
export async function spendRequest(record: BalanceSource, draft: Draft, price: number, balance: number, method: api.Method): Promise<BuiltSpend> {
  const built = await orderRequest(draft)
  const wallet = walletOf(record.ownerCode)!
  const timestamp = now()
  const { labelHash: lh, length, duration, commitment, sealed, terms } = built.request
  const message = `simplex.domains spend ${record.registrationId} ${lh} ${length} ${duration} ${commitment} ${await sha256Hex(sealed)} ${terms} ${timestamp}`
  const covered = price <= balance
  return { ...built, spend: {
    labelHash: lh, length, duration, commitment, sealed, price, balance, ...covered ? {} : { method }, terms, timestamp,
    signature: hex(signDigest(wallet.privateKey, personalDigest(message))),
  } }
}

// The spend sent as it was built, so a resend after a lost answer is the same order; the new order is kept with the
// record's code. A balance changed since it was read throws BalanceChanged.
export async function sendSpend(record: BalanceSource, draft: Draft, built: BuiltSpend): Promise<store.OrderRecord> {
  const res = await api.spend(record.registrationId, built.spend)
  const paidBy = "invoiceId" in res
    ? { ...paidWith(res), ids: { registrationId: res.registration.id, invoiceId: res.invoiceId } }
    : { method: "balance" as const, paid: built.spend.price, ids: { registrationId: res.registrationId, invoiceId: null } }
  const next = { ...recordFor(draft, built, paidBy.method, paidBy.paid, paidBy.ids), balanceSource: record.registrationId }
  store.saveOrder(next)
  return next
}

export async function spendBalance(record: BalanceSource, label: string, links: api.Links, quote: Priced, balance: number, method: api.Method, terms: string): Promise<store.OrderRecord> {
  const draft = spendDraft(record, label, links, quote, terms)
  return sendSpend(record, draft, await spendRequest(record, draft, quote.price, balance, method))
}

// The order whose invoice holds a balance now, as the code's find names it, kept in this browser's records; null when
// none holds it. A record of this browser is never taken for the holder on its own: its invoice may have closed.
export async function balanceHolder(source: BalanceSource): Promise<store.OrderRecord | null> {
  const wallet = walletOf(source.ownerCode)!
  const found = await findOrders(wallet)
  const heldBy = found.find((r) => r.registrationId === source.registrationId)?.heldBy
  const entry = heldBy ? found.find((r) => r.registrationId === heldBy) : undefined
  if (!entry) return null
  return store.orderByRegistration(entry.registrationId) ?? (await reopen(wallet, source.ownerCode, entry)).record
}

// The order whose balance paid part of the record's, as the code's find names it, kept with the record; null when none did.
export async function balanceSourceOf(record: store.OrderRecord): Promise<string | null> {
  const source = (await findOrders(walletOf(record.ownerCode)!)).find((r) => r.registrationId === record.registrationId)?.balanceSource ?? null
  if (source) store.updateOrder(record.registrationId, { balanceSource: source })
  return source
}

type RestoreResult = { record: store.OrderRecord; view: api.RegistrationView }

// The order's name and links, unsealed with the code, after checking that they rebuild the order's commitment.
async function openOrder(wallet: Wallet, view: api.RegistrationView): Promise<Pick<store.OrderRecord, "label" | "contact" | "channel" | "request" | "terms">> {
  const opened = await unseal(wallet.seed, view.sealed)
  if (!opened) throw new Error("the code does not open this order")
  const r = registrationOf(opened.label, wallet.address, commitmentSecret(wallet.seed, opened.label), opened, view, BigInt(view.duration))
  if (hex(makeCommitment(r)) !== view.commitment) throw new Error("the order's commitment does not match the code")
  const request = { labelHash: view.labelHash, length: opened.label.length, duration: view.duration, owner: checksumAddress(wallet.address), commitment: view.commitment, sealed: view.sealed }
  return { label: opened.label, contact: opened.contact, channel: opened.channel, request, terms: view.terms ?? undefined }
}

// An order moved to another name elsewhere (another browser, or a retarget whose answer was lost) is read back from the
// service; a move with other terms alone keeps the commitment.
export async function syncRecord(record: store.OrderRecord, view: api.RegistrationView): Promise<store.OrderRecord | null> {
  if (view.commitment === record.request.commitment) {
    const terms = view.terms ?? undefined
    if (terms === record.terms) return record
    const synced = { ...record, terms }
    store.saveOrder(synced)
    return synced
  }
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
// code and hashes to the order's label hash, with its name; null when find lists only orders of another code.
export async function codeOrderOf(text: string): Promise<CodeOrder | null> {
  const parsed = parseNameCode(text)
  if (parsed?.kind !== "owner") throw new Error("not an owner code")
  const wallet = walletFromEntropy(parsed.entropy)
  const opened = await Promise.all((await findOrders(wallet)).map(async (found) => ({ found, sealed: await unseal(wallet.seed, found.sealed) })))
  const open = opened.filter(({ found, sealed }) => sealed !== null && hex(labelHash(sealed.label)) === found.labelHash)
  if (open.length === 0) return null
  const order = chooseOrder(open.map(({ found }) => found))
  return { code: formatOwnerCode(parsed.entropy), name: open.find(({ found }) => found === order)!.sealed!.label, order }
}

export const addOrder = async ({ code, order }: CodeOrder) => (await reopen(walletOf(code)!, code, order)).record

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

// The order of this code for a name that a new order met, which find lists: one on its way, else the newest unpaid one.
export async function ownOrderFor(ownerCode: string, nameHash: string): Promise<store.OrderRecord | null> {
  const wallet = walletOf(ownerCode)!
  const found = (await findOrders(wallet)).filter((r) => r.labelHash === nameHash)
  const chosen = found.find((r) => !["unpaid", "taken"].includes(r.phase)) ?? found.find((r) => r.phase === "unpaid")
  return chosen ? (await reopen(wallet, ownerCode, chosen)).record : null
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
  let found: Found[]
  try {
    found = await findOrders(wallet)
  } catch (e) {
    if (e instanceof api.ApiError && e.code === "not_found") return none()
    throw e
  }
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

// When the service made one of the code's orders, which an adopted order's invoice does not say; null when the service does not list it.
export async function createdAtOf(record: store.OrderRecord, registrationId: string): Promise<string | null> {
  const wallet = walletOf(record.ownerCode)
  if (!wallet) return null
  return (await findOrders(wallet)).find((r) => r.registrationId === registrationId)?.createdAt ?? null
}

async function reopen(wallet: Wallet, code: string, chosen: Found): Promise<RestoreResult> {
  const owner = checksumAddress(wallet.address)
  const invoice = chosen.invoiceId ? await api.readInvoice(chosen.invoiceId) : null
  const view = invoice?.registration ?? await api.readRegistration(chosen.registrationId)
  const opened = await openOrder(wallet, view)
  // what only this browser knew about the order (a card in confirmation, a cancel, the prepaid code that paid) is kept
  const known = store.orderByRegistration(view.id)
  const record: store.OrderRecord = {
    ...known, registrationId: view.id, invoiceId: chosen.invoiceId, ownerCode: code, owner, ...opened,
    method: invoice ? invoice.cryptoCurrency ?? "card" : view.fromBalance > 0 ? "balance" : "code", paid: view.price, years: view.years,
    tld: view.tld, createdAt: chosen.createdAt, balanceSource: chosen.balanceSource ?? known?.balanceSource,
  }
  store.saveOrder(record)
  return { record, view }
}

export const KEYS = { contact: CONTACT_KEY, channel: CHANNEL_KEY } as const

// One signed SetText per changed key, in one request the service relays as one transaction. The resolver takes an
// owner's intents only in nonce order, so the second is signed with the nonce the first spends.
export async function saveLinks(record: store.OrderRecord, chain: { chainId: number; resolver: string; tld: string }, nonce: number, changes: Partial<api.Links>): Promise<string | null> {
  const wallet = walletOf(record.ownerCode)!
  const node = namehash(chain.tld, record.label)
  const deadline = now() + EDIT_DEADLINE_SECONDS
  const edits = api.LINK_KINDS.filter((kind) => changes[kind] !== undefined).map((kind, i) => {
    const value = changes[kind]!
    const digest = setTextDigest(BigInt(chain.chainId), fromHex(chain.resolver), node, KEYS[kind], value, BigInt(nonce + i), BigInt(deadline))
    return { key: KEYS[kind], value, nonce: nonce + i, deadline, signature: hex(signDigest(wallet.privateKey, digest)) }
  })
  const { tx } = await api.editRecords({ labelHash: hex(labelHash(record.label)), edits })
  return tx
}

