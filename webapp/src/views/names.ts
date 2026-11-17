// Your names: this browser's orders and codes, restoring an order with its name code, and editing a name's links.
import * as api from "../api.ts"
import { alertBox, announce, btn, chip, codeDisplay, copyButton, el, type Kid, nameCodeQr, nameText, nameTitle, reducedMotion, setAction, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dateOf, dollars, SEP } from "../format.ts"
import type { IconName } from "../icons.ts"
import {
  balanceRows, type BalanceRow, CODE_CHIPS, holderOf, EDIT_RETRY_MS, editable, editsLine, editsShort, hasLinks, linksAction, type EditEvent, type EditForm, type EditKind, type EditState, hasRecords, initialEdit, initialList,
  againLine, initialRestore, lapsed, lateLine, ranOut, moneyReached, nameRows, ORDER_CHIP_WORDS, paidLine, type ListEvent, type ListState, NOT_SAVED, phaseChip, reduceEdit,
  reduceList, reduceRestore, REFUSALS, ROW_CHIPS, rowsDrawn, unanswered, type RestoreEvent, type RestoreState, type RowSeen, type CodeCheck, screenOfEdit, type Stored, waitsToSign,
} from "../screens/names.ts"
import { codesOnly } from "../mode.ts"
import { heldWords } from "../screens/balance.ts"
import { checkoutUrl, CODE_URL, editUrl } from "../screens/routes.ts"
import * as session from "../session.ts"
import type { AppliedCode } from "../session.ts"
import * as store from "../store.ts"
import { chatButton } from "./chats.ts"
import { codeField, type CodeVerdict } from "./codes.ts"
import { CHECKING_LINK, type LinkFields, linkFieldsFor, linksSettled } from "./links.ts"
import {
  asStep, type Builder, CONTACT_EMAIL, currentRoute, draw, drawLoading, focusHeading, focusOn, go, isRedraw, isRoute, kept, keptLive, redirect, screen, showRefund,
  useBalance, whenLeaving,
} from "./shell.ts"
import { after } from "./effects.ts"
import { holdEnd, holdEnder, holdFrom, holding, holdNotice, secondsLeft, tabHold } from "./hold.ts"
import { rowName } from "./terms.ts"

const UNREAD_RETRY_MS = 5_000
const HOME = "/#/"
const NAMES_TITLE = "Your names"
const READING = "Reading your names…"
const CODE_CHECKING = "Checking"
const CODE_CHIP_WORDS = [CODE_CHECKING, ROW_CHIPS.unchecked, ...Object.values(CODE_CHIPS).map(([words]) => words)]
const NAMES = "/#/names"

// a row's action keeps focus over a redraw by its row's key and its own; one that opens a popup says so
const small = (text: string, key: string, onclick: () => void, popup = false) =>
  el("a", { href: "#", role: "button", "data-focus": key, "aria-haspopup": popup ? "dialog" : undefined, onclick: (e: Event) => { e.preventDefault(); onclick() } }, text)

function row(key: string, title: Node, sub: Kid, state: Node | null, acts: Kid[], ...below: Kid[]): HTMLElement {
  return el("div", { class: "list-row", "data-key": key },
    el("div", { class: "main" }, title, el("div", { class: "sub" }, sub)),
    state && el("span", { class: "state" }, state), el("div", { class: "acts" }, ...acts), ...below)
}

let list: ListState = initialList({ orders: [], pending: [], codes: [], canPersist: true }, null, {}, {}, 0)
let listRoute = -1
let listStop: AbortSignal = AbortSignal.abort()
let lastChecked: Record<string, CodeCheck> = {}
const readIds = new Set<string>()
const retried = new Set<string>()
const readCodes = new Set<string>()

// an order page that saw its name registered tells the list, which then draws the row registered from the start
export function seenRegistered(view: api.RegistrationView, invoice: api.InvoiceView | null): void {
  const seen = store.seen<RowSeen>()
  store.setSeen({ ...seen, [view.id]: { ...seen[view.id], view, invoice } })
}

const storedNow = (): Stored => ({ orders: store.orders(), pending: store.pendingCodes(), codes: store.codes(), canPersist: store.canPersist() })
const storedEvent = (): ListEvent => ({ type: "stored", ...storedNow(), hold: tabHold() })

const ROW_READ_BOUND_MS = 10_000
const drawnRows = new Set<string>()
// what each drawn row showed, for an order the list replaced while its successor is read
const drawnSeen = new Map<string, RowSeen>()
let listDone = false

export function historyPage(): void {
  listRoute = currentRoute()
  const reads = new AbortController()
  listStop = reads.signal
  whenLeaving(() => reads.abort())
  readIds.clear()
  retried.clear()
  readCodes.clear()
  drawnRows.clear()
  drawnSeen.clear()
  listDone = false
  list = initialList(storedNow(), tabHold(), store.seen<RowSeen>(), lastChecked, api.serviceNow())
  after(ROW_READ_BOUND_MS, () => {
    for (const id of unanswered(list)) dispatchList({ type: "row-unread", id })
  }, reads.signal)
  showList()
}

function dispatchList(event: ListEvent): void {
  list = reduceList(list, event)
  showList()
}

function showList(): void {
  store.setSeen(list.seen)
  lastChecked = list.checked
  if (!isRoute(listRoute)) return
  draw("names", (signal) => buildNames(list, signal))
  readRows()
}

const answerList = (route: number, event: ListEvent) => { if (isRoute(route)) dispatchList(event) }

// each order and code is read once per opening; a record stored meanwhile, as a newer order found, is read as it comes
function readRows(): void {
  for (const { registrationId } of list.orders) {
    if (readIds.has(registrationId)) continue
    readIds.add(registrationId)
    void readOrder(registrationId, listRoute)
  }
  for (const { code } of list.codes) {
    if (readCodes.has(code)) continue
    readCodes.add(code)
    void readCode(code, listRoute)
  }
}

// a row whose read failed is read once more, after the wait the service asked for
function retryOnce(e: unknown, key: string, route: number, read: () => void): void {
  const wait = api.retryDelay(e, UNREAD_RETRY_MS)
  if (wait === null || retried.has(key) || !isRoute(route)) return
  retried.add(key)
  after(wait, read, listStop)
}

async function readCode(code: string, route: number): Promise<void> {
  try {
    const answer = await api.checkCode(code)
    answerList(route, { type: "code-read", code, state: answer.state })
  } catch (e) {
    if (e instanceof api.ApiError && e.code === "code_invalid") return answerList(route, { type: "code-read", code, state: "revoked" })
    // a rate limit is waited out as often as it is met, the row counting down to its next check
    if (e instanceof api.ApiError && e.code === "rate_limited") {
      const wait = (e.retryAfter ?? api.LIMITED_WAIT_S) * 1000
      answerList(route, { type: "code-read", code, state: "unchecked", checkAgainAt: api.serviceNow() + wait })
      if (isRoute(route)) after(wait, () => void readCode(code, route), listStop)
      return
    }
    answerList(route, { type: "code-read", code, state: "unchecked" })
    retryOnce(e, code, route, () => void readCode(code, route))
  }
}

async function readOrder(id: string, route: number): Promise<void> {
  const o = list.orders.find((r) => r.registrationId === id)
  if (!o) return
  let view: api.RegistrationView
  let invoice: api.InvoiceView | null = null
  try {
    if (o.invoiceId) {
      invoice = await api.readInvoice(o.invoiceId)
      view = invoice.registration
    } else view = await api.readRegistration(o.registrationId)
  } catch (e) {
    // the service forgets an unpaid order some time after it closes
    if (e instanceof api.ApiError && e.code === "not_found" && await replaceWithNewer(o, route)) return
    answerList(route, { type: "row-unread", id })
    return retryOnce(e, id, route, () => void readOrder(id, route))
  }
  const synced = await flow.syncRecord(o, view) ?? o
  if (!isRoute(route)) return
  if (synced !== o) dispatchList(storedEvent())
  if (synced.replacedBy && !moneyReached(invoice)) return
  if (api.closedEmpty(invoice) && await replaceWithNewer(synced, route)) return
  if (!isRoute(route)) return
  dispatchList({ type: "row-read", id, view, invoice, now: api.serviceNow() })
  if (view.phase !== "registered") return
  const answer = await api.searchName(view.labelHash, (view.label ?? synced.label).length).catch(() => null)
  answerList(route, { type: "row-answered", id, answer })
}

async function replaceWithNewer(o: store.OrderRecord, route: number): Promise<boolean> {
  const next = !o.replacedBy ? await flow.newerOrder(o).catch(() => null) : null
  if (!next || !isRoute(route)) return false
  dispatchList(storedEvent())
  return true
}

async function findOrder(p: store.PendingCode): Promise<void> {
  const route = listRoute
  const { ownerCode } = p
  if (list.finding[ownerCode] === "finding" || list.hold) return
  if (holding()) return dispatchList({ type: "find-held", ownerCode, until: holdEnd() })
  dispatchList({ type: "find-started", ownerCode })
  try {
    const { record } = await flow.restore(ownerCode)
    if (isRoute(route)) go(store.orderUrl(record))
  } catch (e) {
    if (holdFrom(e)) return answerList(route, { type: "find-held", ownerCode, until: holdEnd() })
    answerList(route, { type: "find-ended", ownerCode, outcome: e instanceof api.ApiError && e.code === "not_found" ? "none" : "unchecked" })
  }
}

function removePending(p: store.PendingCode): void {
  store.dropPending(p.ownerCode)
  dispatchList(storedEvent())
}

function forgetEverything(): void {
  store.forgetEverything()
  session.setCheckout(null)
  dispatchList({ type: "forget-confirmed" })
  focusHeading()
}

const pendingKey = (p: store.PendingCode) => `${p.label}@${p.createdAt}`
const leadOf = (canPersist: boolean) => canPersist ? "This list is kept only in this browser." : "This browser cannot keep this list: it empties when the page reloads."
const FORGET = "forget"
const KEEP = "keep"

const forgetLink = () => el("a", { class: "danger-link", href: "#", role: "button", "data-focus": FORGET, onclick: (e: Event) => {
  e.preventDefault()
  // the question is asked over the records as stored now, another tab's included
  dispatchList(storedEvent())
  dispatchList({ type: "forget-asked" })
  focusOn(KEEP)
  // the question and both its answers come into view, as focus does not scroll, gliding there unless asked not to
  document.querySelector(".forget")?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "instant" : "smooth" })
} }, "Forget everything in this browser")

function forgetQuestion(s: ListState): HTMLElement | null {
  if (!s.asking) return null
  const keep = btn("Keep them", "quiet", () => {
    dispatchList({ type: "forget-kept" })
    focusOn(FORGET)
  })
  keep.dataset.focus = KEEP
  return el("div", { class: "forget" }, alertBox("danger", "alert", "Forget every name and code in this browser?",
    "Everything listed here is removed from this browser. Without your saved copies, the name codes and codes cannot be restored."),
  el("div", { class: "actions" }, btn("Forget everything", "danger", forgetEverything), keep))
}

// nothing kept yet: the ways to a first name, as a step
const emptyNames = (s: ListState) => asStep(screen({ title: NAMES_TITLE, lead: leadOf(s.canPersist), back: HOME,
  action: btn("Find a name", "", () => go(HOME)), alt: el("a", { href: CODE_URL }, "Add a name code") },
  el("div", { class: "card none" }, el("b", {}, "No names in this browser yet"),
    el("p", { class: "note center" }, "A name you register here shows in this list. To see a name you registered in another browser, add its name code."))))

function buildNames(s: ListState, signal: AbortSignal): HTMLElement {
  holdEnder(signal, () => dispatchList({ type: "hold-ended" }))(s.hold !== null)
  const open = session.checkout()
  const orders = nameRows(s)
  const { rows, done: read } = rowsDrawn(s, drawnRows)
  listDone ||= read
  const done = listDone
  for (const o of rows) {
    drawnRows.add(o.registrationId)
    const seen = s.seen[o.registrationId]
    if (seen) drawnSeen.set(o.registrationId, seen)
  }
  const asDrawn = (o: store.OrderRecord) => s.seen[o.registrationId] || !drawnSeen.has(o.registrationId) ? s : { ...s, seen: { ...s.seen, [o.registrationId]: drawnSeen.get(o.registrationId)! } }
  const names = [...s.pending.map((p) => pendingRow(p, s, open, signal)), ...rows.map((o) => orderRow(o, asDrawn(o)))]
  const balances = balanceRows(s)
  if (!names.length && !orders.length && !balances.length && !s.codes.length) return emptyNames(s)
  return screen({ title: NAMES_TITLE, lead: leadOf(s.canPersist), back: HOME },
    names.length || done ? el("div", { class: "card list" }, names.length ? names : el("p", { class: "note" }, "No names in this browser yet.")) : null,
    done ? null : el("p", { class: "note reading", role: "status" }, READING),
    done && balances.length ? [el("h2", { class: "label" }, "Balance"), el("div", { class: "card list" }, balances.map((b) => balanceRow(b, s)))] : null,
    done && s.codes.length ? [el("h2", { class: "label" }, "Codes"), el("div", { class: "card list" }, s.codes.map((c) => codeRow(c, s, signal)))] : null,
    done ? el("div", { class: "end-links" }, el("a", { href: CODE_URL }, "Add a code"), s.asking || !hasRecords(s) ? null : forgetLink()) : null,
    forgetQuestion(s))
}

const PROGRESS: Partial<Record<api.Phase, string>> = {
  queued: "Paid, waiting to commit",
  committing: "Committing",
  committed: "Committed, waiting before it can register",
  registering: "Registering on chain",
}

// a row's line goes on after a separator in lower case, as "registered with a code" after the date
const continued = (text: string | null) => text ? text.charAt(0).toLowerCase() + text.slice(1) : text

// the reference support asks for, in a face where l and I differ
const reference = (id: string) => [`${SEP}reference `, el("span", { class: "mono" }, id)]

function subLine(o: store.OrderRecord, { view, invoice, answer }: RowSeen, now: number): string | (Node | string)[] {
  // what was paid, from the invoice; the record's amount is the order's worth, lower after a move to a cheaper name
  const paid = paidLine(o, view, invoice)
  if (lapsed({ view, answer }, now)) return `Expired ${view.expiresAt ? dateOf(view.expiresAt) : ""}`.trim()
  if (view.phase === "registered") return view.expiresAt ? `Until ${dateOf(view.expiresAt)}` : paid
  if (invoice && invoice.status !== "open" && view.phase === "unpaid") {
    const late = lateLine(invoice)
    return late ? [late, ...reference(invoice.invoiceId)] : `Nothing was charged${SEP}${dateOf(Date.parse(o.createdAt) / 1000)}`
  }
  if (view.phase === "taken" && o.method === "code") return paid
  if (waitsToSign(view, now)) return `Open the order so this browser can sign it${SEP}${continued(paid)}`
  return PROGRESS[view.phase] ? `${PROGRESS[view.phase]}${SEP}${continued(paid)}` : paid
}

function codeToggle(id: string, shown: boolean): HTMLElement {
  const toggle = small("Name code", `${id}-code`, () => dispatchList({ type: "code-toggled", id }))
  toggle.setAttribute("aria-expanded", String(shown))
  return toggle
}

const rowCode = (code: string) => el("div", { class: "row-code" },
  el("p", { class: "note" }, "The name code owns the name and edits its links. Keep it safe."),
  codeDisplay(code), nameCodeQr(code))

function orderRow(o: store.OrderRecord, s: ListState): HTMLElement {
  const id = o.registrationId
  const seen = s.seen[id]
  // the order may have moved to another name since it was stored
  const label = seen?.view.label ?? o.label
  const tld = seen?.view.tld ?? o.tld
  // a registered row takes its final shape at once; its name's answer, read after it, only takes Edit links away
  const registered = seen?.view.phase === "registered"
  const code = registered ? o.ownerCode : null
  const shown = code !== null && s.shownCode === id
  const edits = registered && !lapsed(seen, s.now) && (!seen.answer || editable(seen.answer, o.owner))
  const acts = code === null ? [small("Open", `${id}-open`, () => go(store.orderUrl(o)))]
    : [codeToggle(id, shown), edits ? small(linksAction(hasLinks(o, seen.answer)), `${id}-edit`, () => go(editUrl(id))) : null]
  const community = seen?.view.community ?? null
  // a registered name shows the chats it opens, each opening its popup as the home's answer does
  const chats = registered && seen.answer?.status === "registered"
    ? seen.answer.entities.map((e, i) => chatButton(e, `${label}.${tld}`, `${id}-chat-${i}`, community !== null)) : []
  const listed = seen ? community !== null : api.communityAgreed(o.terms)
  const state = rowChip(s, o, seen)
  const title = rowName(label, tld, community, `${id}-community`, listed)
  if (chats.length) opensFirstChat(title, chats[0])
  return row(id, title, seen ? subLine(o, seen, s.now) : paidLine(o, null, null), state && chipRoom(state),
    [chats.length ? el("span", { class: "chats" }, chats) : null, ...acts], shown ? rowCode(code) : null)
}

// A pointer on the name opens its first chat as its picture does; the picture is the control a keyboard reaches, as a
// button in the name could hold no community marker's button.
function opensFirstChat(title: HTMLElement, first: HTMLButtonElement): void {
  title.classList.add("opens")
  title.addEventListener("click", (e) => { if (!(e.target as Element).closest("button")) first.click() })
}

const sizer = (...kids: Kid[]) => el("span", { class: "sizer", "aria-hidden": "true" }, ...kids)
const chipRoom = (shown: HTMLElement, words = ORDER_CHIP_WORDS) => el("span", { class: "room" }, shown, ...words.map((w) => sizer(el("span", { class: "dot" }), w)))

function rowChip(s: ListState, o: store.OrderRecord, seen: RowSeen | undefined): HTMLElement | null {
  if (s.unread.includes(o.registrationId) || !seen) return chip(ROW_CHIPS.unchecked, "warn")
  if (lapsed(seen, s.now)) return chip(ROW_CHIPS.lapsed, "bad")
  // a registered name says so by its date
  if (seen.view.phase === "registered") return null
  const [text, tone] = phaseChip(seen.view, seen.invoice, o, s.now)
  return chip(text, tone, tone !== "bad")
}

// a checkout this tab still holds is continued rather than looked for
function pendingRow(p: store.PendingCode, s: ListState, open: session.Checkout | null, signal: AbortSignal): HTMLElement {
  const key = pendingKey(p)
  const finding = s.finding[p.ownerCode]
  const resume = open?.ownerCode === p.ownerCode ? small("Continue checkout", `${key}-continue`, () => session.checkout()?.ownerCode === p.ownerCode ? go(checkoutUrl(open.step)) : dispatchList(storedEvent())) : null
  const findable = resume === null && finding !== "none"
  const hold = findable ? s.hold : null
  const find = findable ? small("Find the order", `${key}-find`, () => void findOrder(p)) : null
  if (find && (finding === "finding" || s.hold)) find.setAttribute("aria-disabled", "true")
  const state = hold ? chip("", "warn")
    : finding === "none" ? chip("No order was made", "bad")
      : finding === "unchecked" ? chip("Not checked", "bad") : chip("Checkout not finished", "warn")
  const node = row(key, nameTitle(p.label, "name", p.tld), `Name code made ${dateOf(Date.parse(p.createdAt) / 1000)}`, state,
    [resume ?? find, small("Remove", `${key}-remove`, () => removePending(p))])
  // the count goes in once the chip is in its row, where its spoken copy goes beside it
  if (hold) waitOut(state, secondsLeft(hold), (left) => `Try again in ${left}`, () => undefined, signal)
  return node
}

const BALANCE_FROM: Record<BalanceRow["from"], string> = {
  taken: "registered by someone else first", late: "paid after its invoice closed", rest: "left after a cheaper name",
}

// A balance pays for another name, or support refunds it; while an open invoice holds it, neither, and the order that
// holds it, which only this browser's records name, is a link away.
function balanceRow(b: BalanceRow, s: ListState): HTMLElement {
  const o = s.orders.find((r) => r.registrationId === b.id)!
  const { view } = s.seen[b.id]
  const holder = b.held ? holderOf(s, b.id) : undefined
  const acts = b.held ? [holder ? small("Open that order", `${b.id}-holder`, () => go(store.orderUrl(holder))) : null]
    : b.amount > 0 ? [codesOnly() ? null : small("Use", `${b.id}-use`, () => useBalance({ source: b.id, amount: b.amount, held: false, heldUntil: null })),
      small("Refund", `${b.id}-refund`, () => showRefund(o.invoiceId ?? o.registrationId, `${b.id}-refund`), true)] : []
  const sub = ["From ", nameText(view.label ?? o.label, view.tld), ", ", el("span", { class: "nowrap" }, BALANCE_FROM[b.from]),
    b.refunded ? `${SEP}refunded ${dollars(b.refunded)} by support` : null,
    b.held ? `${SEP}in use by another order ${heldWords(b.heldUntil)}` : null]
  const node = row(`balance-${b.id}`, el("b", { class: "price" }, dollars(b.amount)), sub, b.held ? chip("In use", "brand", true) : null, acts)
  node.classList.add("balance-row")
  return node
}

function codeRow(c: store.CodeRecord, s: ListState, signal: AbortSignal): HTMLElement {
  const check = s.checked[c.code]
  const checkAgainAt = s.checkAgainAt[c.code]
  const copy = copyButton(c.code, "text-link")
  copy.dataset.focus = `${c.code}-copy`
  const [text, tone] = check === undefined ? [CODE_CHECKING, ""] : check === "unchecked" ? [ROW_CHIPS.unchecked, "warn"] : CODE_CHIPS[check]
  // an unused code registers the names this tab finds from now on
  const use = check === "unused" ? small("Use", `${c.code}-use`, () => { session.setActiveCode({ display: c.code, minLength: c.minLength, years: c.years }); go(HOME) }) : null
  const state = checkAgainAt === undefined ? chip(text, tone, check === undefined || check === "unused") : chip("", "warn")
  const node = row(c.code, el("b", { class: "mono" }, c.code), [`A free name of ${c.minLength} or more letters, for ${c.years} years${SEP}`, el("span", { class: "nowrap" }, `added ${dateOf(Date.parse(c.addedAt) / 1000)}`)],
    chipRoom(state, CODE_CHIP_WORDS), [use, copy])
  node.classList.add("code-row")
  // the count goes in once the chip is in its row, as a held row's does
  if (checkAgainAt !== undefined) waitOut(state, Math.max(1, Math.ceil((checkAgainAt - api.serviceNow()) / 1000)), (left) => `Checking again in ${left}`, () => undefined, signal)
  return node
}

// Check your code: a prepaid code registers the names this tab finds for free; a name code finds its order and adds it to Your names.
let check: { verdict: CodeVerdict | null; restore: RestoreState } = { verdict: null, restore: initialRestore(null) }
let checkRoute = -1
// opened from an order's page, to which a name code added here goes back
let checkFromOrder = false
const CHECK_CODE = "check-code"
const ADDING = "add"

export function checkCodePage(fromOrder: boolean): void {
  // a page drawn again, as the header's code taken off draws it, keeps what its field judged
  const fresh = !isRedraw()
  if (fresh) check = { verdict: null, restore: initialRestore(tabHold()) }
  checkFromOrder = fromOrder
  checkRoute = currentRoute()
  showCheck()
  if (!fresh) return
  const input = codeField(`${CHECK_CODE}-field`, "Code", heard).querySelector("input")!
  // Enter does what the screen's button does
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") document.querySelector<HTMLButtonElement>("body > main .actions-row .btn")?.click() })
  input.focus()
}

function dispatchRestore(event: RestoreEvent): void {
  check = { ...check, restore: reduceRestore(check.restore, event) }
  showCheck()
}

const showCheck = () => { if (isRoute(checkRoute)) draw(CHECK_CODE, (signal) => asStep(buildCheck(check, signal))) }

function heard(v: CodeVerdict | null): void {
  check = { verdict: v, restore: reduceRestore(check.restore, { type: "edited" }) }
  showCheck()
}

// the code registers names from now on, and is kept in Your names
function useCode(code: AppliedCode): void {
  if (!store.codes().some((c) => c.code === code.display)) store.addCode({ code: code.display, minLength: code.minLength, years: code.years, addedAt: new Date().toISOString() })
  session.setActiveCode(code)
  go(HOME)
}

async function addNameCode(verdict: Extract<CodeVerdict, { kind: "owner" }>): Promise<void> {
  // focus on Add, which a refusal keeps off, goes back to the code
  const pressed = document.activeElement instanceof HTMLElement && document.activeElement.dataset.focus === ADDING
  const refuse = (why: Extract<RestoreEvent, { type: "refused" }>["why"]) => {
    dispatchRestore({ type: "refused", why })
    if (pressed && !REFUSALS[why].again) document.querySelector<HTMLInputElement>(".code-input input")?.focus({ preventScroll: true })
  }
  dispatchRestore({ type: "find-started" })
  try {
    const record = await flow.addOrder(verdict.found)
    if (isRoute(checkRoute)) go(checkFromOrder ? store.orderUrl(record) : NAMES)
  } catch (e) {
    if (!isRoute(checkRoute)) return
    if (e instanceof api.ApiError && e.code === "not_found") return refuse("none")
    // the service asks for a wait before the next lookup; the button stays off until then, whatever is typed meanwhile
    if (holdFrom(e)) return dispatchRestore({ type: "held", until: holdEnd(), lead: "Your code is fine. " })
    refuse(e instanceof api.ApiError ? "unasked" : "other")
  }
}

// a refusal of the code holds Add until the code is edited; one of the service can be tried again
const addOff = ({ busy, hold, refusal }: RestoreState) => busy || hold !== null || (refusal !== null && !REFUSALS[refusal].again)

function checkAction({ verdict, restore }: typeof check): HTMLElement {
  if (verdict?.kind === "owner") {
    const add = setAction(btn(restore.busy ? "Finding the code's orders…" : "Add to Your names", "", () => void addNameCode(verdict)), restore.busy, addOff(restore))
    add.dataset.focus = ADDING
    return add
  }
  const find = setAction(btn("Find a name", "", () => { if (verdict?.kind === "prepaid") useCode(verdict.code) }), false, verdict?.kind !== "prepaid")
  find.dataset.focus = "find"
  return find
}

const checkLead = () => ["A code from SimpleX lets you register a free name.", el("br"), "A name code brings a name you own ", el("span", { class: "nowrap" }, "to this browser.")]

function buildCheck(c: typeof check, signal: AbortSignal): HTMLElement {
  const refusal = c.restore.refusal && REFUSALS[c.restore.refusal]
  holdEnder(signal, () => dispatchRestore({ type: "hold-ended" }))(c.restore.hold !== null)
  const note = c.restore.hold ? holdNotice(c.restore.hold, signal) : refusal ? alertBox("danger", "alert", refusal.title, refusal.text)
    : c.verdict?.kind === "prepaid" ? el("p", { class: "note center" }, "Search for a name; it shows as Free.") : null
  return screen({ title: "Check your code", lead: checkLead(), back: HOME, action: checkAction(c) },
    codeField(`${CHECK_CODE}-field`, "Code", heard), keptLive("check-note", undefined, note))
}

let edit: EditState = initialEdit("", null)
let editRoute = -1

export function editPage(registrationId: string): void {
  edit = initialEdit(registrationId, store.orderByRegistration(registrationId) ?? null)
  editRoute = currentRoute()
  if (screenOfEdit(edit) === "edit-no-code") return dispatchEdit({ type: "opened" })
  drawLoading("Reading the name…", asStep)
  void readEdit(editRoute)
}

function dispatchEdit(event: EditEvent): void {
  edit = reduceEdit(edit, event)
  showEdit()
}

function showEdit(): void {
  if (!isRoute(editRoute)) return
  const kind = screenOfEdit(edit)
  draw(kind, (signal) => asStep(EDIT_BUILDERS[kind](edit, signal)))
}

const answerEdit = (route: number, event: EditEvent) => { if (isRoute(route)) dispatchEdit(event) }

async function readEdit(route: number): Promise<void> {
  const stored = edit.record!
  let view: api.RegistrationView
  let answer: api.SearchAnswer
  let record = stored
  try {
    view = stored.invoiceId ? (await api.readInvoice(stored.invoiceId)).registration : await api.readRegistration(stored.registrationId)
    record = await flow.syncRecord(stored, view) ?? stored
    answer = await api.searchName(record.request.labelHash, record.label.length)
  } catch (e) {
    // a forgotten unpaid order may have a newer one, found with the code
    const newer = e instanceof api.ApiError && e.code === "not_found" ? await flow.newerOrder(stored).catch(() => null) : null
    if (!isRoute(route)) return
    if (newer) return redirect(editUrl(newer.registrationId))
    return dispatchEdit({ type: "read-failed" })
  }
  if (!isRoute(route)) return
  if (view.phase === "unpaid") {
    // the name may have been registered through a newer invoice that another browser made, perhaps under another name
    const newer = await flow.newerOrder(record).catch(() => null)
    if (!isRoute(route)) return
    if (newer) return redirect(editUrl(newer.registrationId))
  }
  dispatchEdit({ type: "answered", view, answer, record, now: api.serviceNow(), hold: tabHold() })
}

function readAgain(): void {
  if (edit.reading) return
  dispatchEdit({ type: "read-started" })
  void readEdit(editRoute)
}

const EDIT_TITLE = "Edit links"
const nameOf = ({ record }: EditState) => record ? nameText(record.label, record.tld) : null

const editNotice = (s: EditState, ...content: Kid[]): HTMLElement => screen({ title: EDIT_TITLE, back: NAMES, lead: nameOf(s) }, ...content)

const notice = (ic: IconName, title: string, text: string): Builder<EditState> => (s) => editNotice(s, alertBox("info", ic, title, text))

// The chain takes an expired name's link edits from its holder until someone registers it again; this page sends none.
function buildExpired(s: EditState): HTMLElement {
  const { view, answer, now } = s.read!
  return editNotice(s, alertBox("info", "clock", "This name has expired",
    `${ranOut(view.expiresAt)} Names are not renewed, so this page no longer edits its links. ${againLine(view.expiresAt, answer, now)}`))
}

function buildUnreadable(s: EditState, signal: AbortSignal): HTMLElement {
  if (!s.reading) after(EDIT_RETRY_MS, readAgain, signal)
  return screen({ title: EDIT_TITLE, back: NAMES, lead: nameOf(s), action: setAction(btn("Try again", "", readAgain), s.reading, false) },
    alertBox("warn", "alert", "The name could not be read now", "This page tries again by itself."))
}

function resultNode(f: EditForm, signal: AbortSignal): HTMLElement | null {
  if (f.hold) return holdNotice(f.hold, signal)
  switch (f.result) {
    case null: return null
    case "sending": return el("p", { class: "note" }, "Signing and sending…")
    case "nothing": return alertBox("info", "info", null, "Nothing has changed.")
    case "saved": return alertBox("ok", "check", "Links saved", "The change is on chain; the app shows it within a few minutes.")
    case "unanswered": return alertBox("warn", "clock", "No answer yet", "The change may still go through. Reload this page in a few minutes to see whether it did before saving again.")
    case "moved": return alertBox("warn", "clock", "An earlier save got there first",
      "It was still on its way when this one was signed. The fields now show the links on chain: change them and save again.")
    case "refused": return alertBox("danger", "alert", NOT_SAVED, "Try again in a moment.")
  }
}

// a Save pressed while a link is checked waits for its check, once, busy and saying so
let awaitingChecks = false

async function saveLinks(links: LinkFields): Promise<void> {
  if (awaitingChecks) return
  const route = editRoute
  const settled = await linksSettled(links.fields(), () => {
    awaitingChecks = true
    announce(CHECKING_LINK)
    showEdit()
  }).finally(() => { awaitingChecks = false })
  if (!settled || !isRoute(route)) return showEdit()
  dispatchEdit({ type: "save-started" })
  const { record, read, form } = edit
  if (!form?.saving) return
  try {
    await flow.saveLinks(record!, read!.view, form.nonce, form.changes)
    answerEdit(route, { type: "save-done", at: api.serviceSeconds() })
  } catch (e) {
    // no answer is not a refusal: the edit may still be mined, and sending it again would pay for it twice
    if (e instanceof api.ApiError && (e.code === "network" || e.code === "edit_pending")) {
      return answerEdit(route, { type: "save-unanswered", counted: e.code === "edit_pending", at: api.serviceSeconds() })
    }
    // a tab opened before the name's edits ran out
    if (e instanceof api.EditLimited) return answerEdit(route, { type: "save-limited", nextAt: e.nextAt })
    // Save stays off for the wait the service asked for, whatever the fields do meanwhile
    if (holdFrom(e)) return answerEdit(route, { type: "save-held", until: holdEnd() })
    // A refused edit may mean the nonce moved: an earlier save, from a page reloaded before it was mined, or from
    // another browser. The next save signs with the fresh one, and the page says why this one did not go.
    const fresh = await api.searchName(record!.request.labelHash, record!.label.length).catch(() => null)
    if (!isRoute(route)) return
    const now = edit.form!
    const nonce = fresh?.status === "registered" && fresh.recordsNonce != null && fresh.recordsNonce > now.nonce ? fresh.recordsNonce : null
    const records = nonce !== null && fresh?.status === "registered" && fresh.records ? fresh.records : null
    if (records) for (const kind of api.LINK_KINDS) links.show(kind, records[kind])
    dispatchEdit({ type: "save-refused", moved: nonce === null ? null : { nonce, records }, edits: fresh?.status === "registered" ? fresh.recordEdits : null })
  }
}

function buildEditForm(s: EditState, signal: AbortSignal): HTMLElement {
  const f = s.form!
  // the fields check the links they open with as they are made, which is no change to send
  const links = kept("edit-links", () => linkFieldsFor(f.current, (kind, value) => dispatchEdit({ type: "field-changed", kind, value })))
  const save = setAction(btn(awaitingChecks ? CHECKING_LINK : "Save links", "", () => void saveLinks(links)), f.saving || awaitingChecks,
    f.hold !== null || f.unanswered || f.settled || editsShort(f))
  save.dataset.focus = "save"
  const answer = resultNode(f, signal)
  // Save, turned off by its answer, hands focus to the answer, which shares its key
  if (answer && ((f.result === "saved" && f.settled) || f.result === "unanswered")) {
    answer.tabIndex = -1
    answer.dataset.focus = "save"
  }
  holdEnder(signal, () => dispatchEdit({ type: "hold-ended" }))(f.hold !== null)
  // one line under Save, kept for the route, which says why Save is off when the edits left do not cover the change
  const count = keptLive("edit-count", "note edit-count", editsLine(f))
  // Save, turned off by the edits left, hands focus to this line
  if (editsShort(f)) {
    count.tabIndex = -1
    count.dataset.focus = "save"
  } else {
    count.removeAttribute("tabindex")
    delete count.dataset.focus
  }
  return screen({ title: EDIT_TITLE, back: NAMES, lead: [nameText(s.record!.label, s.record!.tld, "."), " Your name code signs the change; ", el("span", { class: "nowrap" }, "nothing to pay.")], action: save, alt: count },
    el("span", { class: "label" }, "Link"), links.node, keptLive("edit-answer", undefined, answer))
}

const EDIT_BUILDERS: Record<EditKind, Builder<EditState>> = {
  "edit-no-code": (s) => editNotice(s, alertBox("info", "key", "The name code is not in this browser", "Add it in Check your code to edit this name's links.")),
  "edit-unreadable": buildUnreadable,
  "edit-expired": buildExpired,
  "edit-in-app": notice("key", "This name has another owner", "Its owner changed, so this browser can no longer edit its links."),
  "edit-elsewhere": notice("link", "This name's links are kept elsewhere", "It points at another resolver, so its links are not edited here."),
  "edit-not-registered": notice("clock", "The name is not registered yet", "Its links can be edited once the registration is final."),
  edit: buildEditForm,
}

export function trademarksPage(): void {
  draw("trademarks", () => screen({ title: "Trademark owners", lead: "Some names are reserved and cannot be bought.", back: HOME },
    el("p", {}, "If you own a trademark and want the matching name reserved for you, write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL),
      " with the name and proof that you own the mark. A reserved name can only be registered by the SimpleX team for its owner.")))
}
