// The home: the landing's headline, the search box and every answer it can show.
import * as api from "../api.ts"
import { labelHash } from "../crypto/registration.ts"
import { hex } from "../crypto/wallet.ts"
import { alertBox, btn, el, icon, type Kid, line, link, nameText, NO_AUTOFILL, setAction, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dollars, letters } from "../format.ts"
import { codesOnly } from "../mode.ts"
import { foldLabel, MAX_LABEL_LENGTH } from "../names.ts"
import type { Hold } from "../screens/hold.ts"
import { againLine, ranOut } from "../screens/names.ts"
import { checkoutUrl, CODE_URL } from "../screens/routes.ts"
import {
  type Answer, balanceHint, codeCover, coverOf, initialSearch, keptWords, moveBar, moveHint, type Moved, type Opening, reduce, returnedTo, screenOf, searchDue, type SearchEvent,
  orderCode, type OrderRead, ownOrders, type OwnOrders, type SearchKind, searchLocked, type SearchState, type CodeLoss,
} from "../screens/search.ts"
import type { Note } from "../screens/order.ts"
import { ticked } from "../screens/terms.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { type Builder, CONTACT_EMAIL, currentRoute, draw, go, historyPlace, isRedraw, isRoute, kept, keptLive, throughHistory } from "./shell.ts"
import { chatButton } from "./chats.ts"
import { CODES_ONLY_LINE, STATE_LINES } from "./codes.ts"
import { moveLimitNote, noteBox } from "./order.ts"
import { holdEnd, holdEnder, holdFrom, holdNotice, secondsLeft, tabHold } from "./hold.ts"
import { NO_ORDERS, rowName, termsChangedLine, termsChecks } from "./terms.ts"

// word joiners keep "a–z" and "0–9" whole: a line may otherwise break after their dash
const RANGES = "a\u2060–\u2060z, 0\u2060–\u20609"
const RULE = `A name has 6 letters or more: ${RANGES} and single hyphens between them.`

// the landing's words (simplex.domains index.html:287-288)
const HEADLINE = "Your SimpleX domain"
const SUB = "One name for your public channel and contact address"

let state: SearchState = initialSearch()
let shown: SearchKind | null = null
let opens = 0
let pageRoute = -1
let field: HTMLInputElement | null = null

const onPage = (page: number) => page === opens && isRoute(pageRoute)

export function searchPage(params: URLSearchParams): void {
  const name = foldLabel(params.get("name") ?? "")
  const retargetId = params.get("retarget")
  const retarget = retargetId ? store.orderByRegistration(retargetId) ?? null : null
  const opening: Opening = retarget ? "retarget" : "plain"
  const fresh = !isRedraw() || shown === null || state.opening !== opening
  const returned = fresh && throughHistory()
  if (fresh) {
    state = returned ? returnedTo(state, opening, name, store.orders()) : initialSearch()
    shown = null
    opens += 1
  }
  pageRoute = currentRoute()
  dispatch({ type: "opened", opening, name, retarget, balance: retarget ? null : session.activeBalance(), hold: tabHold() })
  if (state.retarget) void checkRetarget(state.retarget)
  if (state.balance) void checkBalance(state.balance.source)
  if (searchDue(state)) submit()
  else if (returned && state.answer) void runSearch(state.name, state.seq)
  // WebKit scrolls a focused field into view when a web font loaded later resizes its text, so focus is taken after the fonts.
  const page = opens
  void document.fonts.ready.then(() => { if (onPage(page) && document.activeElement === document.body) field?.focus({ preventScroll: true }) })
}

function dispatch(event: SearchEvent): void {
  state = reduce(state, event)
  if (!isRoute(pageRoute)) return
  const kind = screenOf(state)
  shown = kind
  draw(kind, (signal) => BUILDERS[kind](state, signal))
}

// what is typed is shown by the field itself, so the page takes it without drawing
function typed(input: HTMLInputElement): void {
  state = reduce(state, { type: "typed", text: input.value })
  input.closest(".field")!.classList.remove("bad")
}

function submit(): void {
  const code = session.activeCode()
  if (searchLocked(codesOnly(), state, code)) return
  const label = foldLabel(state.typed)
  const seq = state.seq
  dispatch({ type: "searched", label, hold: tabHold(), minLength: coverOf(codesOnly(), state, code) })
  if (state.seq === seq || state.paused) return
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "")
  if (params.get("name") !== label) {
    params.set("name", label)
    history.replaceState(history.state, "", `/#/?${params}`)
  }
  if (state.searching) void runSearch(label, state.seq)
}

async function runSearch(label: string, seq: number): Promise<void> {
  const page = opens
  const awaited = () => onPage(page) && seq === state.seq
  const hash = hex(labelHash(label))
  let answer: api.SearchAnswer
  try {
    answer = await api.searchName(hash, label.length)
  } catch (e) {
    if (!awaited()) return
    if (holdFrom(e)) return dispatch({ type: "search-held", seq, until: holdEnd() })
    return dispatch({ type: "unanswered", seq })
  }
  if (!awaited()) return
  dispatch({ type: "answered", seq, label, answer, mine: mineFor(hash, answer), now: api.serviceNow() })
  if (answer.status === "available") void pointAtOwnOrder(label, hash, page)
}

function mineFor(hash: string, answer: api.SearchAnswer): boolean {
  if (answer.status !== "registered" || answer.owner === undefined) return false
  const owner = answer.owner.toLowerCase()
  return store.orders().some((o) => o.request.labelHash === hash && o.owner.toLowerCase() === owner)
}

// the reads of this browser's orders for the name last answered available, which Register waits for
let ownRead: { label: string; orders: Promise<OwnOrders> } | null = null

async function pointAtOwnOrder(label: string, hash: string, page: number): Promise<void> {
  const read = async (o: store.OrderRecord): Promise<OrderRead | null> => {
    if (!onPage(page)) return null
    const invoice = o.invoiceId ? await api.readInvoice(o.invoiceId).catch(() => null) : null
    const reg = invoice?.registration ?? (o.invoiceId ? null : await api.readRegistration(o.registrationId).catch(() => null))
    return reg && { phase: reg.phase, invoice: invoice?.status ?? null }
  }
  const orders = ownOrders(store.orders().filter((r) => r.request.labelHash === hash), read)
  ownRead = { label, orders }
  const { open } = await orders
  if (!onPage(page)) return
  if (open) return dispatch({ type: "own-order-seen", label, url: store.orderUrl(open) })
  if (state.ownOrder !== null) dispatch({ type: "own-order-seen", label, url: null })
}

async function readOrder(record: store.OrderRecord): Promise<{ view: api.RegistrationView; synced: store.OrderRecord } | null> {
  const view = await (record.invoiceId ? api.readInvoice(record.invoiceId).then((i) => i.registration) : api.readRegistration(record.registrationId)).catch(() => null)
  if (!view) return null
  const synced = await flow.syncRecord(record, view) ?? record
  return { view, synced: { ...synced, paid: view.price, linksRefused: view.linksRefused || synced.linksRefused } }
}

// an order moves from a failed registration, or from links the service refused; a name taken first keeps its payment as a balance
const movable = (view: api.RegistrationView, record: store.OrderRecord) =>
  view.phase === "failed" || (view.phase === "committed" && (view.linksRefused || record.linksRefused === true))

function movedOf(view: api.RegistrationView, record: store.OrderRecord): Moved | null {
  if (movable(view, record)) return null
  return { url: store.orderUrl(record), label: record.label, tld: record.tld }
}

async function checkRetarget(record: store.OrderRecord): Promise<void> {
  const page = opens
  const read = await readOrder(record)
  if (read && onPage(page)) dispatch({ type: "retarget-read", record: read.synced, moved: movedOf(read.view, read.synced) })
}

// The tab's balance as its order reads now; one spent or refunded meanwhile, or whose order this browser no longer
// keeps, pays no more. One that could not be read is shown as last read.
async function checkBalance(source: string): Promise<void> {
  const page = opens
  const record = store.orderByRegistration(source)
  const read = record ? await readOrder(record) : null
  if (!onPage(page) || (record && !read)) return
  const balance = session.appliedBalance(source, read?.view.balance ?? null)
  session.updateActiveBalance(source, balance)
  if (state.balance?.source === source) dispatch({ type: "balance-read", balance })
}

// a search the wait paused is sent once it ends; one already on its way, as Back sends, is not sent again
function holdEnded(): void {
  const paused = state.paused
  dispatch({ type: "hold-ended" })
  if (paused && state.answer?.kind === "checking") submit()
}

type Found = Extract<Answer, { kind: "found" }>
type Available = Extract<api.SearchAnswer, { status: "available" }>

// an order this browser has for the name, which the search found or the service named in refusing a second one
const ownOrderOf = ({ ownOrder, register: { refusal } }: SearchState) => ownOrder ?? (refusal?.why === "other" ? refusal.url : null)

const offered = ({ answer }: SearchState) => answer?.kind === "found" && answer.answer.status === "available" ? { label: answer.label, answer: answer.answer } : null

async function register(): Promise<void> {
  const shown = offered(state)
  if (!shown || !flow.orderable(shown.answer)) return
  if (state.retarget) return void retarget(state.retarget, shown.label, shown.answer)
  const page = opens
  const closed = ownRead?.label === shown.label ? (await ownRead.orders).closed : null
  const still = offered(state)
  // an order of the name that the reads found still open is the buyer's, which the page points at instead
  if (!onPage(page) || still?.label !== shown.label || ownOrderOf(state) !== null || !flow.orderable(still.answer)) return
  checkOut(state, still.label, still.answer, closed?.ownerCode ?? null)
}

function checkOut(s: SearchState, label: string, answer: flow.Quote, closedCode: string | null): void {
  const chain = flow.chainOf(answer)
  const code = codeFor(s, label)
  // a balance pays under its order's name code, which then owns this name too
  const source = s.balance && store.orderByRegistration(s.balance.source)
  const balance = source ? s.balance : null
  const { ownerCode, saved } = orderCode(source ? source.ownerCode : null, closedCode)
  const started = session.checkout()
  const quote = { price: answer.price, years: answer.years, termStart: answer.termStart, chain, terms: answer.terms, community: answer.community }
  const sameCode = !ownerCode || started?.ownerCode == null || started.ownerCode === ownerCode
  if (started && started.label === label && started.price === answer.price && started.chain.chainId === chain.chainId && !session.isSending(started) && sameCode) {
    const agreed = started.agreed && api.currentTerms(started) === api.currentTerms(answer)
    const accepted = started.accepted && api.currentTerms(started) === api.currentTerms(answer)
    session.updateCheckout(label, {
      ...quote, agreed, accepted, termsChanged: undefined, searchAt: historyPlace(), code, codeError: undefined, codeHere: undefined, balance, balanceChange: undefined, ownerCode: ownerCode ?? started.ownerCode,
      saved: started.saved || saved,
    })
    return go(checkoutUrl("links"))
  }
  session.setCheckout({
    label, ...quote, contact: "", channel: "", method: "btc", code, balance, ownerCode, saved, agreed: false,
    searchAt: historyPlace(), step: "links",
  })
  go(checkoutUrl("links"))
}

async function retarget(record: store.OrderRecord, label: string, quote: flow.Quote): Promise<void> {
  const page = opens
  if (!ticked({ ...state, community: quote.community })) return
  dispatch({ type: "register-started" })
  try {
    // links the service refused at the reveal would be refused again
    const links = record.linksRefused ? { contact: "", channel: "" } : { contact: record.contact, channel: record.channel }
    await flow.retargetOrder(record, label, links, quote, api.currentTerms(quote))
    if (onPage(page)) go(store.orderUrl(record))
  } catch (e) {
    const read = await readOrder(record)
    const limited = holdFrom(e)
    if (!onPage(page)) return
    if (read?.synced.label === label) return go(store.orderUrl(record))
    if (read && !movable(read.view, read.synced)) return dispatch({ type: "retarget-read", record: read.synced, moved: movedOf(read.view, read.synced) })
    if (limited) return dispatch({ type: "register-held", until: holdEnd() })
    if (e instanceof api.TermsChanged) return dispatch({ type: "terms-changed", label, terms: e.terms, community: e.community })
    const code = e instanceof api.ApiError ? e.code : null
    const reference = record.invoiceId ?? record.registrationId
    if (code === "move_limit") return dispatch({ type: "register-refused", refusal: { why: "limit", reference } })
    if (code && code in CODE_LOSSES) return dispatch({ type: "register-refused", refusal: { why: "code", state: CODE_LOSSES[code], reference } })
    // the code's own order for the new name is the one the move met
    const other = code === "order_exists" ? await flow.ownOrderFor(record.ownerCode, hex(labelHash(label))).catch(() => null) : null
    if (!onPage(page)) return
    dispatch({ type: "register-refused", refusal: other ? { why: "other", url: store.orderUrl(other) } : { why: REFUSALS[code ?? ""] ?? "failed" } })
  }
}

const REFUSALS: Record<string, "taken" | "dearer" | "uncovered" | "unavailable"> = { name_taken: "taken", price_too_high: "dearer", code_not_covering: "uncovered", terms_unavailable: "unavailable" }
const CODE_LOSSES: Record<string, CodeLoss> = { code_used: "used", code_reserved: "reserved", code_expired: "expired", code_invalid: "revoked" }

const BUILDERS: Record<SearchKind, Builder<SearchState>> = {
  "search:plain": buildSearch,
  "search:retarget": buildSearch,
}

function searchBox(): HTMLElement {
  const input = el("input", { type: "text", placeholder: "yourname", "aria-label": "Name", ...NO_AUTOFILL })
  field = input
  const search = el("button", { class: "btn lens", type: "button", "aria-label": "Search", "data-focus": "search", onclick: () => submit() }, icon("search"))
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit() })
  // names are lower case, so upper case folds as it is typed; the caret stays where it was
  const fold = () => {
    const lower = input.value.toLowerCase()
    if (lower === input.value) return
    const caret = input.selectionStart
    input.value = lower
    input.setSelectionRange(caret, caret)
  }
  // a keyboard composing a character would restart and repeat it if the value changed under it
  input.addEventListener("compositionend", () => {
    fold()
    typed(input)
  })
  input.addEventListener("input", (e) => {
    if (!(e as InputEvent).isComposing) fold()
    typed(input)
  })
  return el("label", { class: "field search-field" }, input, el("span", { class: "tld" }, ".simplex"), search)
}

const CODES_ONLY_LINE_ID = "codes-only-note"

// In codes-only mode without a code, the search is off, saying why, and the code is the way in.
function codesOnlyAnswer(): Kid[] {
  const register = btn("Register with code", "", () => go(CODE_URL))
  register.dataset.focus = "register-code"
  return [el("p", { class: "hint soft", id: CODES_ONLY_LINE_ID }, CODES_ONLY_LINE), register]
}

function buildSearch(s: SearchState, signal: AbortSignal): HTMLElement {
  const box = kept("search-field", searchBox)
  const input = box.querySelector("input")!
  const search = box.querySelector("button")!
  const locked = searchLocked(codesOnly(), s, session.activeCode())
  if (input.value !== s.typed) input.value = s.typed
  box.classList.toggle("bad", s.bad)
  box.classList.toggle("off", locked)
  input.disabled = locked
  if (locked) input.setAttribute("aria-describedby", CODES_ONLY_LINE_ID)
  else input.removeAttribute("aria-describedby")
  search.disabled = locked || s.paused
  if (s.searching) search.setAttribute("aria-busy", "true")
  else search.removeAttribute("aria-busy")
  const retry = () => {
    search.focus({ preventScroll: true })
    submit()
  }
  holdEnder(signal, holdEnded)(s.hold !== null)
  // the answer's room is kept from the start, so the headline and the field never move as an answer comes
  return el("section", { class: "home" },
    el("h1", {}, HEADLINE), el("p", { class: "sub" }, SUB),
    openingLine(s),
    el("div", { class: "search" }, box, keptLive("search-answer", "answer", locked ? codesOnlyAnswer() : answerOf(s, retry, signal))))
}

function openingLine(s: SearchState): HTMLElement | null {
  if (s.moved) return alertBox("info", "info", "Your order already went to another name.", el("a", { href: s.moved.url }, "Open ", nameText(s.moved.label, s.moved.tld)))
  if (!s.retarget) return null
  const [kept, choose] = keptWords(s.retarget)
  return alertBox("info", codeCover(s.retarget) ? "key" : "wallet", kept, choose)
}

function answerOf(s: SearchState, retry: () => void, signal: AbortSignal): Kid {
  if (s.paused && s.hold) return pauseLine(s.hold, signal)
  const answer = s.answer
  if (answer?.kind === "rule") return ruleLine(answer)
  if (answer?.kind === "uncovered") return line("bad", "alert", `${letters(answer.label.length)}. Your code covers names of ${answer.minLength} or more letters.`)
  if (answer?.kind === "unchecked") return line("warn", "alert", "This name could not be checked. ", link("Try again", retry))
  if (answer?.kind !== "found") return answer?.kind === "checking" ? line("", "clock", "Checking the name…") : null
  const found = answer.answer
  if (found.status === "available") return availableAnswer(s, answer.label, found, signal)
  if (found.status === "reserved") {
    return line("info", "info", "Reserved names are not sold here. If it is yours to use, write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), ".")
  }
  return takenAnswer(answer, found)
}

function ruleLine({ label, problem }: Extract<Answer, { kind: "rule" }>): HTMLElement {
  const text = problem === "short" ? `${letters(label.length)}. ${RULE}` : problem === "long" ? `${letters(label.length)}. A name has at most ${MAX_LABEL_LENGTH}.` : `Use only ${RANGES} and single hyphens between them.`
  return line("bad", "alert", text)
}

function pauseLine(hold: Hold, signal: AbortSignal): HTMLElement {
  const count = el("span", {})
  const node = el("p", { class: "line warn" }, icon("clock"), count)
  waitOut(count, secondsLeft(hold), (left) => `Searching is paused: try again in ${left}.`, () => undefined, signal)
  return node
}

// the tab's active code registers a name it covers for free; a paid order's move pays its own way, as a balance does
const usesCode = (s: SearchState) => s.retarget === null && s.balance === null
const codeFor = (s: SearchState, label: string) => {
  const code = session.activeCode()
  return code && usesCode(s) && label.length >= code.minLength ? code : null
}

function availableAnswer(s: SearchState, label: string, answer: Available, signal: AbortSignal): Kid[] {
  const retarget = s.retarget
  const cover = retarget && codeCover(retarget)
  const unpayable = retarget !== null && moveBar(retarget, label, answer.price) !== null
  const hint = retarget && moveHint(retarget, label, answer.price)
  const own = ownOrderOf(s)
  const code = codeFor(s, label)
  const free = code ?? (cover && !unpayable ? cover : null)
  const short = usesCode(s) ? session.activeCode() : null
  const orderable = flow.orderable(answer)
  const asks = retarget !== null && !unpayable && own === null && orderable
  const words = !retarget ? "Register" : cover ? "Register with your code" : "Register with your payment"
  const button = setAction(btn(words, "small", () => void register()), s.register.busy, unpayable || own !== null || s.hold !== null || !orderable || (asks && !ticked({ ...s, community: answer.community })))
  button.dataset.focus = "register"
  const deal = free ? [el("b", { class: "price" }, "Free"), el("span", { class: "soft" }, ` / ${api.termYears(answer.community, free.years)} years`)]
    : [el("b", { class: "price" }, dollars(answer.price)), el("span", { class: "soft" }, ` / ${api.termYears(answer.community, answer.years)} years`)]
  return [
    el("div", { class: "card row buy" }, rowName(label, answer.tld, answer.community, "community"), el("div", { class: "offer" }, el("span", { class: "deal" }, deal), button)),
    !code && short ? el("p", { class: "hint" }, `Your code allows you to register a free name of ${short.minLength} or more letters. `,
      el("span", { class: "nowrap" }, `This name has ${label.length}.`)) : null,
    s.balance ? balanceLine(s.balance, answer.price) : null,
    hint ? line("", cover ? "key" : "wallet", hint[0], hint[1] ? [" ", el("span", { class: "nowrap" }, hint[1])] : null) : null,
    own ? line("", "info", "You already have an order for this name. ", el("a", { class: "nowrap", href: own }, "Open that order")) : null,
    orderable ? null : line("warn", "alert", `${NO_ORDERS}. Try again later.`),
    // under the box, so nothing above it moves
    asks ? moveAgreement(s, label, answer) : null,
    asks && s.termsChanged ? termsChangedLine("register") : null,
    unpayable || own ? null : registerNote(s, signal),
  ]
}

function moveAgreement(s: SearchState, label: string, answer: flow.Quote): HTMLElement {
  const agree = (agreed: boolean) => dispatch({ type: "agreed", agreed })
  const accept = (accepted: boolean) => dispatch({ type: "accepted", accepted })
  return termsChecks({ terms: answer.terms, community: answer.community, agreed: s.agreed, accepted: s.accepted, changed: s.termsChanged, label, tld: answer.tld, chainId: answer.chainId, disabled: s.register.busy }, agree, accept)
}

function balanceLine(balance: session.AppliedBalance, price: number): HTMLElement {
  const [first, second] = balanceHint(balance, price)
  return el("p", { class: "hint soft" }, first, second ? [" ", el("span", { class: "nowrap" }, second)] : null)
}

function registerNote({ hold, register: { refusal } }: SearchState, signal: AbortSignal): HTMLElement | null {
  if (hold) return holdNotice(hold, signal)
  if (!refusal) return null
  if (refusal.why === "limit") return noteBox(moveLimitNote(refusal.reference))
  if (refusal.why === "code") return noteBox(codeLossNote(refusal.state, refusal.reference))
  const words = refusal.why === "taken" ? "This name is no longer available. Search another one."
    : refusal.why === "dearer" ? "This name now costs more than your order is worth. Search another one."
    : refusal.why === "uncovered" ? "Your code does not pay for this name. Search another one."
    : refusal.why === "unavailable" ? `${NO_ORDERS}. Nothing changed. Try again later.` : "Nothing changed. Try again in a moment."
  return alertBox("danger", "alert", "That did not go through", words)
}

function codeLossNote(state: CodeLoss, reference: string): Note {
  const [title, line] = STATE_LINES[state]
  return { tone: "danger", icon: "key", title, text: `${line ? `${line} ` : ""}Write to SimpleX support with this order's reference, `,
    link: { text: CONTACT_EMAIL, href: `mailto:${CONTACT_EMAIL}`, after: `: ${reference}.` } }
}

// One row as the app lists a chat: the name, the chats it opens as the app's own pictures, and whose it is.
function takenAnswer(found: Found, answer: Extract<api.SearchAnswer, { status: "registered" }>): Kid[] {
  const { label, mine } = found
  // there are no renewals, so a name of ours past its expiry is over here, though the chain keeps it ours in its grace period
  const expiresAt = answer.expiresAt ?? null
  const lapsed = mine && expiresAt !== null && expiresAt < found.now / 1000 ? `${ranOut(expiresAt)} ${againLine(expiresAt, answer, found.now)}` : null
  // a name whose registration is being mined has no owner on chain yet
  const registering = answer.owner === undefined
  const whose = mine ? (lapsed ? el("span", { class: "soft" }, "Expired") : el("a", { class: "nowrap", href: "/#/names" }, "Your name"))
    : el("span", { class: "soft" }, registering ? "Being registered" : "Taken")
  const name = `${label}.${answer.tld}`
  return [
    el("div", { class: "card row" }, rowName(label, answer.tld, answer.community, "community"),
      answer.entities.length ? el("span", { class: "chats" }, answer.entities.map((e, i) => chatButton(e, name, `chat-${i}`, answer.community !== null))) : null, whose),
    lapsed ? line("", "clock", lapsed) : registering ? line("", "clock", "Someone is registering it right now. Its owner and links show once it is on chain.") : null,
  ]
}
