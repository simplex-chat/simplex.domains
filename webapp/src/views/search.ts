// The home: the landing's headline, the search box and every answer it can show.
import * as api from "../api.ts"
import { heldPrice, SITE } from "../config.ts"
import { labelHash } from "../crypto/registration.ts"
import { hex } from "../crypto/wallet.ts"
import { btn, el, icon, type Kid, line, link, NO_AUTOFILL, setAction, waitOut } from "../dom.ts"
import * as flow from "../flow.ts"
import { dollars, letters } from "../format.ts"
import { codesOnly } from "../mode.ts"
import { foldLabel, MAX_LABEL_LENGTH } from "../names.ts"
import type { Hold } from "../screens/hold.ts"
import { againLine, ranOut } from "../screens/names.ts"
import { checkoutUrl, CODE_URL } from "../screens/routes.ts"
import {
  type Answer, codeCover, coverOf, initialSearch, type Opening, reduce, returnedTo, screenOf, searchDue, type SearchEvent,
  orderCode, type OrderRead, ownOrders, type OwnOrders, type SearchKind, searchLocked, type SearchState,
} from "../screens/search.ts"
import * as session from "../session.ts"
import * as store from "../store.ts"
import { type Builder, CONTACT_EMAIL, currentRoute, draw, go, historyPlace, isRedraw, isRoute, kept, keptLive, throughHistory } from "./shell.ts"
import { chatButton } from "./chats.ts"
import { CODES_ONLY_LINE } from "./codes.ts"
import { holdEnd, holdEnder, holdFrom, holdNotice, secondsLeft, tabHold } from "./hold.ts"
import { inDowntime } from "./served-mode.ts"
import { NO_ORDERS, rowName } from "./terms.ts"

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
  const orderId = params.get("order")
  const order = orderId ? store.orderByRegistration(orderId) ?? null : null
  const opening: Opening = order ? "order" : "plain"
  const fresh = !isRedraw() || shown === null || state.opening !== opening
  const returned = fresh && throughHistory()
  if (fresh) {
    state = returned ? returnedTo(state, opening, name, SITE.tld, store.orders()) : initialSearch()
    shown = null
    opens += 1
  }
  pageRoute = currentRoute()
  dispatch({ type: "opened", opening, name, order, hold: tabHold(), downtime: inDowntime() })
  if (state.order) void checkOrder(state.order)
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
  // the name searched is in the URL, which a reload draws again, so the field holds nothing a reload would lose
  if (field) field.defaultValue = label
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
  dispatch({ type: "answered", seq, label, answer, mine: mineFor(hash, answer), now: api.serviceNow(), downtime: inDowntime() })
  if (answer.found.type === "available" || answer.found.type === "taken") void pointAtOwnOrder(label, hash, page)
}

function mineFor(hash: string, { found }: api.SearchAnswer): boolean {
  if (found.type !== "registered") return false
  const owner = found.owner.toLowerCase()
  return store.orders().some((o) => o.request.labelHash === hash && o.owner.toLowerCase() === owner)
}

// the reads of this browser's orders for the name last answered available, which Register waits for
let ownRead: { label: string; orders: Promise<OwnOrders> } | null = null

async function pointAtOwnOrder(label: string, hash: string, page: number): Promise<void> {
  const read = async (o: store.OrderRecord): Promise<OrderRead | null> => {
    if (!onPage(page)) return null
    const invoice = o.invoiceId ? await api.readInvoice(o.invoiceId).catch(() => null) : null
    const reg = invoice?.registration ?? (o.invoiceId ? null : await api.readRegistration(o.registrationId).catch(() => null))
    return reg && { phase: reg.phase.type, failure: reg.phase.type === "failed" ? reg.phase.reason : null, invoice: invoice?.status ?? null }
  }
  const orders = ownOrders(store.orders().filter((r) => r.request.labelHash === hash), read)
  ownRead = { label, orders }
  const { open } = await orders
  if (!onPage(page)) return
  if (open) return dispatch({ type: "own-order-seen", label, url: store.orderUrl(open) })
  if (state.ownOrder !== null) dispatch({ type: "own-order-seen", label, url: null })
}

export async function readOrder(record: store.OrderRecord): Promise<{ view: api.RegistrationView; synced: store.OrderRecord } | null> {
  const view = await (record.invoiceId ? api.readInvoice(record.invoiceId).then((i) => i.registration) : api.readRegistration(record.registrationId)).catch(() => null)
  if (!view) return null
  const synced = await flow.syncRecord(record, view) ?? record
  return { view, synced: { ...synced, paid: view.price } }
}

async function checkOrder(record: store.OrderRecord): Promise<void> {
  const page = opens
  const read = await readOrder(record)
  if (!read || !onPage(page)) return
  if (!api.selectable(read.view)) return go(store.orderUrl(read.synced))
  dispatch({ type: "order-read", record: read.synced })
}

// a search the wait paused is sent once it ends; one already on its way, as Back sends, is not sent again
function holdEnded(): void {
  const paused = state.paused
  dispatch({ type: "hold-ended" })
  if (paused && state.answer?.kind === "checking") submit()
}

type Found = Extract<Answer, { kind: "found" }>

function offered({ answer }: SearchState): { label: string; answer: flow.Available } | null {
  const available = answer?.kind === "found" ? flow.availableOf(answer.answer) : null
  return answer?.kind === "found" && available ? { label: answer.label, answer: available } : null
}

async function register(): Promise<void> {
  const shown = offered(state)
  if (!shown || !orderableBy(state, shown.label, shown.answer)) return
  const page = opens
  const closed = ownRead?.label === shown.label ? (await ownRead.orders).closed : null
  const still = offered(state)
  // an order of the name that the reads found still open is the buyer's, which the page points at instead
  if (!onPage(page) || still?.label !== shown.label || state.ownOrder !== null || !orderableBy(state, still.label, still.answer)) return
  checkOut(state, still.label, still.answer, closed?.ownerCode ?? null)
}

function checkOut(s: SearchState, label: string, answer: flow.Quote, closedCode: string | null): void {
  const code = codeFor(s, label)
  const taken = s.order
  const { ownerCode, saved } = taken ? { ownerCode: taken.ownerCode, saved: true } : orderCode(closedCode)
  const order = taken ? { registrationId: taken.registrationId, method: taken.method, paid: taken.paid } : undefined
  const started = session.checkout()
  const price = heldPrice(label.length)
  const quote = { price, years: taken?.years ?? answer.years, terms: answer.terms, community: answer.community }
  const sameCode = !ownerCode || started?.ownerCode == null || started.ownerCode === ownerCode
  if (started && started.label === label && started.price === price && !session.isSending(started) && sameCode) {
    const agreed = started.agreed && api.currentTerms(started) === api.currentTerms(answer)
    const accepted = started.accepted && api.currentTerms(started) === api.currentTerms(answer)
    session.updateCheckout(label, {
      ...quote, agreed, accepted, termsChanged: undefined, searchAt: historyPlace(), code, codeError: undefined, codeHere: undefined, ownerCode: ownerCode ?? started.ownerCode,
      saved: started.saved || saved, order,
    })
    return go(checkoutUrl("links"))
  }
  session.setCheckout({
    label, ...quote, contact: taken?.contact ?? "", channel: taken?.channel ?? "", method: "btc", code, ownerCode, saved, agreed: false,
    searchAt: historyPlace(), step: "links", order,
  })
  go(checkoutUrl("links"))
}

const BUILDERS: Record<SearchKind, Builder<SearchState>> = {
  "search:plain": buildSearch,
  "search:order": buildSearch,
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
    el("div", { class: "search" }, box, keptLive("search-answer", "answer", locked ? codesOnlyAnswer() : answerOf(s, retry, signal))))
}

function answerOf(s: SearchState, retry: () => void, signal: AbortSignal): Kid {
  if (s.paused && s.hold) return pauseLine(s.hold, signal)
  const answer = s.answer
  if (answer?.kind === "rule") return ruleLine(answer)
  if (answer?.kind === "uncovered") return line("bad", "alert", `${letters(answer.label.length)}. Your code covers names of ${answer.minLength} or more letters.`)
  if (answer?.kind === "unchecked") return line("warn", "alert", "This name could not be checked. ", link("Try again", retry))
  if (answer?.kind !== "found") return answer?.kind === "checking" ? line("", "clock", "Checking the name…") : null
  const available = flow.availableOf(answer.answer)
  if (available) return availableAnswer(s, answer.label, available, signal)
  if (answer.answer.found.type === "reserved") {
    return line("info", "info", "Reserved names are not sold here. If it is yours to use, write to ", el("a", { href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), ".")
  }
  return takenAnswer(s, answer, answer.answer)
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

// a name the tab's active code covers is registered with it for free; a name selected for an order uses the order's own code or payment
const usesCode = (s: SearchState) => s.order === null
const codeFor = (s: SearchState, label: string) => {
  const code = session.activeCode()
  return code && usesCode(s) && label.length >= code.minLength ? code : null
}
const freeBy = (s: SearchState, label: string) => codeFor(s, label) ?? (s.order && codeCover(s.order))
const orderableBy = (s: SearchState, label: string, answer: flow.Available): answer is flow.Quote =>
  flow.orderable(answer) && (freeBy(s, label) !== null || answer.price === heldPrice(label.length))

function availableAnswer(s: SearchState, label: string, answer: flow.Available, signal: AbortSignal): Kid[] {
  const cover = s.order && codeCover(s.order)
  const own = s.ownOrder
  const free = freeBy(s, label)
  const paid = s.order && !cover && s.order.paid === answer.price ? s.order : null
  const short = usesCode(s) ? session.activeCode() : cover
  const orderable = orderableBy(s, label, answer)
  const button = setAction(btn("Register", "small", () => void register()), false, own !== null || s.hold !== null || !orderable)
  button.dataset.focus = "register"
  const deal = [el("b", { class: "price" }, free ? "Free" : paid ? "Paid" : dollars(answer.price)),
    el("span", { class: "soft" }, ` / ${api.termYears(answer.community, (free ?? paid)?.years ?? answer.years)} years`)]
  return [
    el("div", { class: "card row buy" }, rowName(label, SITE.tld, answer.community, "community"), el("div", { class: "offer" }, el("span", { class: "deal" }, deal), button)),
    !free && short ? el("p", { class: "hint" }, `Your code allows you to register a free name of ${short.minLength} or more letters. `,
      el("span", { class: "nowrap" }, `This name has ${label.length}.`)) : null,
    own ? line("", "info", "You already have an order for this name. ", el("a", { class: "nowrap", href: own }, "Open that order")) : null,
    orderable ? null : line("warn", "alert", `${NO_ORDERS}. Try again later.`),
    own || !s.hold ? null : holdNotice(s.hold, signal),
  ]
}

// One row as the app lists a chat: the name, the chats it opens as the app's own pictures, and whose it is.
function takenAnswer(s: SearchState, found: Found, answer: api.SearchAnswer): Kid[] {
  const { label, mine } = found
  const registered = answer.found.type === "registered" ? answer.found : null
  // there are no renewals, so a name of ours past its expiry is over here, though the chain keeps it ours in its grace period
  const expiresAt = registered?.expiresAt ?? null
  const lapsed = mine && expiresAt !== null && expiresAt < found.now / 1000 ? `${ranOut(expiresAt)} ${againLine(expiresAt, answer, found.now)}` : null
  const own = answer.found.type === "taken" ? s.ownOrder : null
  const whose = own ? null : mine ? (lapsed ? el("span", { class: "soft" }, "Expired") : el("a", { class: "nowrap", href: "/#/names" }, "Your name"))
    : el("span", { class: "soft" }, "Taken")
  const { tld } = SITE
  const name = `${label}.${tld}`
  const entities = registered?.entities ?? []
  return [
    el("div", { class: "card row" }, rowName(label, tld, answer.community, "community"),
      entities.length ? el("span", { class: "chats" }, entities.map((e, i) => chatButton(e, name, `chat-${i}`, answer.community !== null))) : null, whose),
    lapsed ? line("", "clock", lapsed) : own ? line("", "info", "You already have an order for this name. ", el("a", { class: "nowrap", href: own }, "Open that order")) : null,
  ]
}
